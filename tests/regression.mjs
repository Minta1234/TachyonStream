import assert from 'node:assert/strict';
import { parseByteRange } from '../lib/http-range.js';
assert.deepEqual(parseByteRange('bytes=10-', 100), { start: 10, end: 99 });
assert.deepEqual(parseByteRange('bytes=-20', 100), { start: 80, end: 99 });
assert.deepEqual(parseByteRange('bytes=0-999', 100), { start: 0, end: 99 });
for (const range of ['bytes=-0', 'bytes=100-', 'bytes=5-2', 'bytes=0-1,3-4', 'bytes=-', 'bytes=99999999999999999999-']) assert.equal(parseByteRange(range, 100), null);
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import WebSocket from 'ws';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tachyon-test-'));
const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DATA_DIR: temp, STREAM_DOMAIN: 'stream.test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const activeSockets = [];
let diagnostics = '';
child.stderr.on('data', data => diagnostics += data);
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server timeout: ' + diagnostics)), 10000);
    child.stdout.on('data', data => { const match = data.toString().match(/localhost:(\d+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${diagnostics}`)); });
  });
  const base = `http://localhost:${port}`;
  const ws = new WebSocket(`ws://localhost:${port}/socket.io/?EIO=4&transport=websocket`, { origin: base });
  activeSockets.push(ws);
  await once(ws, 'open');
  const sid = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket timeout')), 5000);
    ws.on('message', data => { const message = data.toString(); if (message.startsWith('0')) ws.send('40'); if (message.startsWith('40')) { clearTimeout(timeout); resolve(JSON.parse(message.slice(2)).sid); } if (message === '2') ws.send('3'); });
  });
  const request = (url, body, authorized = true, method = 'POST') => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(authorized ? { 'X-Playback-Session': sid } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await request('/api/folders', { name: 'blocked' }, false)).status, 401);
  assert.equal((await request('/api/videos/test.mp4', undefined, false, 'DELETE')).status, 401);
  const crossSite = await fetch(base + '/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid', 'X-Playback-Session': sid }, body: JSON.stringify({ name: 'blocked-origin' }) });
  assert.equal(crossSite.status, 403);
  const wrongSocket = new WebSocket(`ws://localhost:${port}/socket.io/?EIO=4&transport=websocket`, { origin: 'https://untrusted.invalid' });
  activeSockets.push(wrongSocket);
  const socketRejection = await new Promise((resolve, reject) => { wrongSocket.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); }); wrongSocket.once('error', reject); });
  assert.ok([400, 403].includes(socketRejection)); wrongSocket.terminate();
  const staticVideo = (await fs.readdir('public/uploads')).find(name => /\.mp4$/i.test(name)) || 'test.mp4';
  for (const url of ['/uploads/' + encodeURIComponent(staticVideo), '/%75ploads/' + encodeURIComponent(staticVideo), '/UPLOADS/' + encodeURIComponent(staticVideo), '/%74emp_chunks/test/chunk_0']) {
    assert.ok([403, 404].includes((await fetch(base + url)).status));
  }
  assert.equal((await request('/api/folders', { name: '100% movies' })).status, 200);
  assert.equal((await request('/api/folders', { name: [] })).status, 400);
  const chunkFolder = path.join(temp, 'temp_chunks', 'testupload');
  await fs.mkdir(chunkFolder, { recursive: true });
  const bytes = Buffer.alloc(32, 0);
  await fs.writeFile(path.join(chunkFolder, 'chunk_0'), bytes);
  assert.equal((await request('/api/complete-upload', { uploadId: 'testupload', fileName: 'movie.mp4', totalChunks: '1junk' })).status, 400);
  assert.equal((await fs.readFile(path.join(chunkFolder, 'chunk_0'))).length, 32);
  assert.equal((await request('/api/complete-upload', { uploadId: 'testupload', fileName: 'movie.mp4', totalChunks: 2 })).status, 500);
  assert.equal((await fs.readdir(path.join(temp, 'uploads'))).filter(name => name.endsWith('.mp4') || name.endsWith('.part')).length, 0);
  const upload = await request('/api/complete-upload', { uploadId: 'testupload', fileName: 'movie.mp4', totalChunks: 1 });
  assert.equal(upload.status, 200); const movie = await upload.json();
  assert.deepEqual(await fs.readFile(path.join(temp, 'uploads', movie.filename)), bytes);
  const fakeHeaders = { referer: 'http://localhost/', 'sec-fetch-dest': 'video', Range: 'bytes=0-15' };
  assert.equal((await fetch(base + movie.url, { headers: fakeHeaders })).status, 403);
  ws.send('42["delete-video",{"filename":"' + movie.filename + '"}]');
  ws.send('42["join-room",null]');
  ws.send('42["video-play",{"time":"bad"}]');
  ws.send('42["join-room",{"roomId":"test","user":"test"}]');
  const response = await fetch(base + movie.url + '?sid=' + sid, { headers: fakeHeaders });
  assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 16);
  const suffixResponse = await fetch(base + movie.url + '?sid=' + sid, { headers: { ...fakeHeaders, Range: 'bytes=-8' } });
  assert.equal(suffixResponse.status, 206);
  assert.equal(suffixResponse.headers.get('content-range'), 'bytes 24-31/32');
  assert.equal((await suffixResponse.arrayBuffer()).byteLength, 8);
  const headResponse = await fetch(base + movie.url + '?sid=' + sid, { method: 'HEAD', headers: fakeHeaders });
  assert.equal(headResponse.status, 206); assert.equal(headResponse.headers.get('content-length'), '16');
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0);
  const largeBytes = Buffer.alloc(4 * 1024 * 1024, 7);
  await fs.writeFile(path.join(temp, 'uploads', 'large.mp4'), largeBytes);
  const openRange = await fetch(base + '/api/stream/large.mp4?sid=' + sid, { headers: { ...fakeHeaders, Range: 'bytes=0-' } });
  assert.equal(openRange.status, 206);
  assert.equal(openRange.headers.get('content-length'), String(largeBytes.length));
  assert.deepEqual(Buffer.from(await openRange.arrayBuffer()), largeBytes);
  const domainStream = await fetch(base + movie.url + '?sid=' + sid, { headers: { ...fakeHeaders, referer: 'https://stream.test/' } });
  assert.equal(domainStream.status, 206); assert.equal((await domainStream.arrayBuffer()).byteLength, 16);
  assert.equal((await fetch(base + movie.url + '?sid=' + sid, { headers: { ...fakeHeaders, referer: 'https://untrusted.invalid/' } })).status, 403);
  for (const blocked of ['/server.js', '/.env', '/server.log', '/package.json']) {
    assert.equal((await fetch(base + blocked)).status, 404);
  }

  assert.equal((await fetch(base + movie.url + '?sid=' + sid, { headers: { ...fakeHeaders, Range: 'bytes=0-nope' } })).status, 416);
  const thumbnail = await fetch(base + '/api/save-thumbnail', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Playback-Session': sid }, body: JSON.stringify({ videoPath: movie.filename, dataUrl: 'data:image/jpeg;base64,/9j/2Q==', duration: 1 }) });
  assert.equal(thumbnail.status, 200);
  assert.equal((await fetch(base + '/api/library')).status, 200);
  assert.deepEqual(await fs.readFile(path.join(temp, 'uploads', movie.filename)), bytes);
  await fs.mkdir(path.join(temp, 'uploads', 'destination'));
  await fs.writeFile(path.join(temp, 'uploads', 'destination', movie.filename), Buffer.from('keep'));
  assert.equal((await request('/api/move-video', { videoPath: movie.filename, targetFolder: 'destination' })).status, 409);
  assert.equal(await fs.readFile(path.join(temp, 'uploads', 'destination', movie.filename), 'utf8'), 'keep');
  assert.equal((await request('/api/folders', { name: 'New series' })).status, 200);
  assert.equal((await request('/api/folders', { name: 'Season 1', parent: 'New series' })).status, 200);
  const fixture = path.join(temp, 'new-movie.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', '-metadata', 'title=Private Title', '-metadata', 'artist=Private Author', '-metadata', 'comment=Secret Note', '-metadata', 'creation_time=2025-01-01T00:00:00Z', '-metadata', 'location=+35.6895+139.6917/', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', fixture]);
  const videoBytes = await fs.readFile(fixture);
  const chunkResponse = await fetch(base + '/api/upload-chunk?uploadId=freshupload&chunkIndex=0&fileName=new-movie.mp4', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'X-Playback-Session': sid }, body: videoBytes });
  assert.equal(chunkResponse.status, 200);
  const completed = await request('/api/complete-upload', { uploadId: 'freshupload', fileName: 'new-movie.mp4', totalChunks: 1, folder: 'New series/Season 1' });
  assert.equal(completed.status, 200);
  const freshMovie = await completed.json();
  const probed = JSON.parse((await promisify(execFile)(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', path.join(temp, 'uploads', 'New series', 'Season 1', freshMovie.filename)])).stdout);
  for (const key of ['title', 'artist', 'comment', 'creation_time', 'location', 'encoder']) {
    assert.equal(probed.format?.tags?.[key], undefined);
    for (const stream of probed.streams || []) assert.equal(stream.tags?.[key], undefined);
  }
  let library = await (await fetch(base + '/api/library')).json();
  const series = library.folders.find(folder => folder.name === 'New series');
  const season = series.subfolders[0];
  assert.ok(series.thumbnailUrl);
  assert.equal(series.thumbnailUrl, season.thumbnailUrl);
  assert.equal(season.thumbnailUrl, season.videos[0].thumbnailUrl);
  assert.ok(season.videos[0].duration > 0);
  const jpgResponse = await fetch(base + season.thumbnailUrl);
  assert.equal(jpgResponse.status, 200);
  assert.deepEqual(Buffer.from(await jpgResponse.arrayBuffer()).subarray(0, 2), Buffer.from([0xff, 0xd8]));
  assert.equal((await request('/api/move-video', { videoPath: 'New series/Season 1/' + freshMovie.filename, targetFolder: 'New series' })).status, 200);
  library = await (await fetch(base + '/api/library')).json();
  const movedSeries = library.folders.find(folder => folder.name === 'New series');
  assert.ok(movedSeries.videos[0].thumbnailUrl);
  assert.ok(movedSeries.videos[0].duration > 0);
  assert.equal((await fetch(base + movedSeries.videos[0].thumbnailUrl)).status, 200);
  assert.deepEqual(await fs.readFile('public/vendor/treeselectjs/treeselectjs.umd.js'), await fs.readFile('node_modules/treeselectjs/dist/treeselectjs.umd.js'));
  const app = await fs.readFile('public/app.js', 'utf8');
  const playbackNodes = new Map();
  const playbackContext = {SVG_PLAY_BTN:'play-svg',SVG_PAUSE_BTN:'pause-svg',document:{getElementById(id){
    if(!playbackNodes.has(id))playbackNodes.set(id,{attributes:{},setAttribute(name,value){this.attributes[name]=value;}});
    return playbackNodes.get(id);
  }}};
  vm.createContext(playbackContext);
  vm.runInContext(app.slice(app.indexOf('function updatePlayButtonUI'),app.indexOf('customVideo.addEventListener("ended", () => updatePlayButtonUI')),playbackContext);
  for(const playing of [true,false,true,false]) {
    playbackContext.updatePlayButtonUI(playing);
    assert.equal(playbackNodes.get('hero-play-label').textContent,playing?'Pause':'Play');
    assert.equal(playbackNodes.get('hero-playback-status').textContent,playing?'Playing':'Paused');
    assert.equal(playbackNodes.get('hero-play-icon').innerHTML,playing?'pause-svg':'play-svg');
    assert.equal(playbackNodes.get('btn-toggle-play').attributes['aria-label'],playing?'Pause':'Play');
  }

  const iconContext = {};
  vm.runInNewContext(app.slice(0, app.indexOf('// ==========================================================================')), iconContext);
  for (const name of ['folder', 'repeat', 'film', 'upload']) {
    assert.match(iconContext.uiIcon(name), /<svg/);
    assert.match(iconContext.uiIcon(name), /aria-hidden="true"/);
    assert.ok(!iconContext.uiIcon(name).includes('undefined'));
  }
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(app));
  const shortcutCode = app.slice(app.indexOf('function showShortcutHelp'), app.indexOf('// Hero Billboard Updating'));
  const calls = [];
  let uploadActive = false;
  let cinemaActive = false;
  const shortcuts = {
    activeModalResolve: null, currentPlayingSource: '/api/stream/test.mp4',
    document: { fullscreenElement: null, addEventListener() { }, getElementById: () => ({ addEventListener() { } }) },
    viewUpload: { classList: { contains: () => uploadActive } },
    viewCinema: { classList: { contains: () => cinemaActive } },
    customVideo: { volume: 0.98, muted: true },
    togglePlayPause: () => calls.push('play'), seekRelative: n => calls.push(n),
    toggleAudioMute: () => calls.push('mute'), toggleAppFullscreen: () => calls.push('fullscreen'),
    showAlertModal: data => calls.push(data.title), closeModal: () => calls.push('close'),
    closeAllPopovers() { }, switchView: view => calls.push(view), resetIdleTimer() { }, showToast() { }
  };
  vm.createContext(shortcuts); vm.runInContext(shortcutCode, shortcuts);
  const key = (code, extra = {}) => {
    const event = { code, key: '', target: { closest: () => null }, preventDefault() { this.prevented = true; }, ...extra };
    shortcuts.handlePlayerShortcut(event); return event;
  };
  key('KeyK'); key('ArrowLeft'); key('KeyL');
  assert.deepEqual(calls.splice(0), ['play', -10, 10]);
  key('ArrowUp'); assert.equal(shortcuts.customVideo.volume, 1); assert.equal(shortcuts.customVideo.muted, false);
  shortcuts.customVideo.volume = 0.02; key('ArrowDown'); assert.equal(shortcuts.customVideo.volume, 0);
  for (const extra of [{ ctrlKey: true }, { isComposing: true }, { defaultPrevented: true }, { repeat: true }, { target: { closest: () => ({}) } }]) {
    key('KeyK', extra);
  }
  uploadActive = true; key('KeyK'); uploadActive = false;
  shortcuts.activeModalResolve = () => { }; key('KeyK'); key('Escape'); shortcuts.activeModalResolve = null;
  assert.deepEqual(calls.splice(0), ['close']);
  shortcuts.currentPlayingSource = ''; key('KeyK'); key('KeyF'); key('Slash', { key: '?' });
  assert.deepEqual(calls.splice(0), ['fullscreen', 'Keyboard shortcuts']);
  cinemaActive = true; key('Escape'); assert.deepEqual(calls.splice(0), ['browse']);
  shortcuts.document.fullscreenElement = {}; assert.equal(key('Escape').prevented, undefined);
  const views = ['browse', 'cinema', 'upload'].map(() => {
    const classes = new Set();
    return { classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } };
  });
  const viewContext = {
    viewBrowse: views[0], viewCinema: views[1], viewUpload: views[2],
    navBtnBrowse: views[0], navBtnCinema: views[1], navBtnUpload: views[2],
    folderTreeselectInstance: null, heroVideoDock: null, playerContainer: null, cinemaVideoHolder: null,
    currentFolderView: null, resetIdleTimer() { }, closeAllPopovers() { },
    document:{getElementById:()=>({classList:{toggle(){}}})},clearTimeout(){},idleTimer:null
  };
  vm.createContext(viewContext);
  vm.runInContext(app.slice(app.indexOf('function switchView'), app.indexOf('navBtnBrowse.addEventListener')), viewContext);
  for (const [index, name] of ['browse', 'cinema', 'upload', 'browse'].entries()) {
    viewContext.switchView(name);
    views.forEach((view, i) => assert.equal(view.inert, i !== index % 3));
  }
  let idleCallback;
  let hidden=false;
  const huds=[{inert:false},{inert:false}];
  const idleContext={cinemaKeyboardFocus:false,isScrubbingTimeline:false,idleTimer:null,
    active:true,interacting:false,customVideo:{paused:false},document:{activeElement:{}},
    cinemaTheater:{classList:{toggle(_name,value){hidden=value;}},querySelectorAll:()=>huds,
      querySelector:()=>idleContext.interacting?{}:null,contains:()=>true},
    viewCinema:{classList:{contains:()=>idleContext.active}},
    clearTimeout(){idleCallback=null;},setTimeout(callback,delay){assert.equal(delay,2500);idleCallback=callback;return 1;}};
  vm.createContext(idleContext);
  const idleStart=app.indexOf('function setCinemaControlsVisible');
  vm.runInContext(app.slice(idleStart,app.indexOf('\nif (cinemaTheater) {',idleStart)),idleContext);
  idleContext.resetIdleTimer();assert.equal(hidden,false);idleCallback();assert.equal(hidden,true);assert.ok(huds.every(hud=>hud.inert));
  for(const reason of ['paused','keyboard','drawer','scrubbing']) {
    idleContext.customVideo.paused=reason==='paused';idleContext.cinemaKeyboardFocus=reason==='keyboard';
    idleContext.interacting=reason==='drawer';idleContext.isScrubbingTimeline=reason==='scrubbing';
    idleContext.resetIdleTimer();idleCallback();assert.equal(hidden,false);assert.ok(huds.every(hud=>!hud.inert));
  }
  idleContext.active=false;idleContext.resetIdleTimer();assert.equal(idleCallback,null);
  let touchHidden=false;
  const touchHandlers=new Map();
  const touchContext={cinemaKeyboardFocus:false,cinemaPointerType:'mouse',cinemaTouchStartedHidden:false,idleTimer:null,
    viewCinema:{classList:{contains:()=>true}},customVideo:{paused:false,addEventListener(){}},document:{addEventListener(){}},clearTimeout(){},
    cinemaTheater:{addEventListener(name,handler){touchHandlers.set(name,handler);},classList:{contains:()=>touchHidden}},
    resetIdleTimer(){touchHidden=false;},setCinemaControlsVisible(visible){touchHidden=!visible;}};
  vm.createContext(touchContext);
  vm.runInContext(app.slice(app.indexOf('\nif (cinemaTheater) {',idleStart),app.indexOf('// Keyboard shortcuts')),touchContext);
  const videoTap={pointerType:'touch',target:{closest:()=>null}};
  touchHandlers.get('pointerdown')(videoTap);touchHandlers.get('click')(videoTap);assert.equal(touchHidden,true);
  touchHandlers.get('focusout')();assert.equal(touchHidden,true);
  touchHandlers.get('pointerdown')(videoTap);
  touchContext.resetIdleTimer(); // Compatibility pointer activity can reveal the HUD before click.
  touchHandlers.get('click')(videoTap);assert.equal(touchHidden,false);
  let previewDelay;
  const previewContext = {
    hoverPreviewTimer: null, removeActiveHoverPreview() { }, clearTimeout() { },
    setTimeout(_callback, delay) { previewDelay = delay; }, navigator: { connection: {} }, document: { hidden: false }, customVideo: { src: 'movie', paused: false }
  };
  vm.createContext(previewContext);
  vm.runInContext(app.slice(app.indexOf('function attachHoverPreview'), app.indexOf('customVideo.addEventListener("play", removeActiveHoverPreview)')), previewContext);
  previewContext.attachHoverPreview({}, 'movie'); assert.equal(previewDelay, undefined);
  previewContext.customVideo.paused = true; previewContext.navigator.connection.saveData = true;
  previewContext.attachHoverPreview({}, 'movie'); assert.equal(previewDelay, undefined);
  previewContext.navigator.connection = { effectiveType: '2g' };
  previewContext.attachHoverPreview({}, 'movie'); assert.equal(previewDelay, undefined);
  previewContext.navigator.connection = {}; previewContext.attachHoverPreview({}, 'movie'); assert.equal(previewDelay, 700);
  const libraryRequests = [];
  let libraryRenders = 0;
  const libraryContext = {
    apiFetch: () => new Promise(resolve => libraryRequests.push(resolve)), console,
    updateFolderSelectDropdown() { }, renderCatalogue() { libraryRenders++; }, updateHeroBillboard() { }, renderEpisodesDrawer() { }
  };
  vm.createContext(libraryContext);
  vm.runInContext(app.slice(app.indexOf('let libraryLoadPromise'), app.indexOf('function findFolderByPath')), libraryContext);
  const firstLoad = libraryContext.loadLibrary();
  assert.equal(firstLoad, libraryContext.loadLibrary());
  assert.equal(libraryRequests.length, 1);
  const sameLibrary = { ok: true, json: async () => ({ folders: [], rootVideos: [] }) };
  libraryRequests[0](sameLibrary);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(libraryRequests.length, 2);
  libraryRequests[1](sameLibrary); await firstLoad;
  assert.equal(libraryRenders, 1);
  const billboardCode = app.slice(app.indexOf('function updateHeroBillboard'), app.indexOf('// Catalogue & Netflix/Apple TV Folder Navigation'));
  const labels = new Map();
  const billboardContext = { customVideo: { src: '/api/stream/movie.mp4' }, roomId: 'test', pathBasename: () => 'movie.mp4', formatMediaTitle: () => 'Movie', document: { getElementById: id => { if (!labels.has(id)) labels.set(id, { style: {} }); return labels.get(id); } } };
  vm.createContext(billboardContext); vm.runInContext(billboardCode, billboardContext);
  for (const folder of ['Alya Sometimes Hides Her Feelings In Russian [Thai Dub]13Ep', 'ชื่อ โฟลเดอร์', '100% real #1', 'literal%20name']) {
    billboardContext.currentPlayingFolder = 'Anime/' + folder;
    vm.runInContext('updateHeroBillboard()', billboardContext);
    assert.equal(labels.get('hero-folder-tag').textContent, folder);
    assert.equal(labels.get('cinema-folder-name').textContent, folder);
  }
  const titleCode = app.slice(app.indexOf('function formatMediaTitle'), app.indexOf('// Dynamic gradient generator'));
  const titleContext = {};
  vm.createContext(titleContext); vm.runInContext(titleCode, titleContext);
  assert.equal(titleContext.formatMediaTitle('New_Movie_0123456789abcdef.mp4'), 'New Movie');
  const fn = app.slice(app.indexOf('function applyThumbnailToContainer'), app.indexOf('// Active single hover preview manager'));
  let image;
  const detached = { querySelector: () => null, appendChild: img => image = img };
  vm.runInNewContext(fn + ';applyThumbnailToContainer(container,"/poster.jpg",null,null,0);', { container: detached, document: { createElement: () => ({ classList: { add() { } }, complete: false }) }, formatTime: () => '' });
  assert.equal(image.src, '/poster.jpg');
  ws.close();
  console.log('PASS: continuous/suffix/HEAD streaming, preview bandwidth safeguards, coalesced library refresh, keyboard shortcut safeguards, inactive view isolation, password-free session requests, blocked cross-site HTTP/WebSocket, blocked encoded static upload URLs, malformed socket packets, literal %, upload validation/assembly/cleanup, session enforcement, streaming body/ranges, thumbnail persistence, detached-card thumbnail regression; real new upload, nested folder covers, preserved thumbnail after move.');
} finally {
  for (const socket of activeSockets) socket.terminate();
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
  // This directory was created by this test under the OS temp directory.
  assert.ok(temp.startsWith(path.join(os.tmpdir(), 'tachyon-test-')));
  await fs.rm(temp, { recursive: true, force: true });
}
