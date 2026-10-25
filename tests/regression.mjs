import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import WebSocket from 'ws';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tachyon-test-'));
const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DATA_DIR: temp, STREAM_DOMAIN: 'stream.test' }, stdio: ['ignore','pipe','pipe'] });
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
  await once(ws,'open');
  const sid = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket timeout')),5000);
    ws.on('message', data => { const message = data.toString(); if (message.startsWith('0')) ws.send('40'); if (message.startsWith('40')) { clearTimeout(timeout); resolve(JSON.parse(message.slice(2)).sid); } if (message === '2') ws.send('3'); });
  });
  const request = (url, body, authorized = true, method = 'POST') => fetch(base + url, { method, headers: { 'Content-Type':'application/json', Origin:base, ...(authorized ? { 'X-Playback-Session': sid } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await request('/api/folders', { name:'blocked' }, false)).status, 401);
  assert.equal((await request('/api/videos/test.mp4', undefined, false, 'DELETE')).status, 401);
  const crossSite = await fetch(base+'/api/folders',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.invalid','X-Playback-Session':sid},body:JSON.stringify({name:'blocked-origin'})});
  assert.equal(crossSite.status,403);
  const wrongSocket = new WebSocket(`ws://localhost:${port}/socket.io/?EIO=4&transport=websocket`,{origin:'https://untrusted.invalid'});
  activeSockets.push(wrongSocket);
  const socketRejection = await new Promise((resolve,reject) => { wrongSocket.once('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode);});wrongSocket.once('error',reject); });
  assert.ok([400,403].includes(socketRejection));wrongSocket.terminate();
  const staticVideo = (await fs.readdir('public/uploads')).find(name => /\.mp4$/i.test(name)) || 'test.mp4';
  for(const url of ['/uploads/'+encodeURIComponent(staticVideo),'/%75ploads/'+encodeURIComponent(staticVideo),'/UPLOADS/'+encodeURIComponent(staticVideo),'/%74emp_chunks/test/chunk_0']) {
    assert.ok([403,404].includes((await fetch(base+url)).status));
  }
  assert.equal((await request('/api/folders', { name:'100% movies' })).status, 200);
  assert.equal((await request('/api/folders', { name:[] })).status, 400);
  const chunkFolder = path.join(temp,'temp_chunks','testupload');
  await fs.mkdir(chunkFolder, { recursive:true });
  const bytes = Buffer.alloc(32,0);
  await fs.writeFile(path.join(chunkFolder,'chunk_0'),bytes);
  assert.equal((await request('/api/complete-upload', { uploadId:'testupload',fileName:'movie.mp4',totalChunks:'1junk' })).status,400);
  assert.equal((await fs.readFile(path.join(chunkFolder,'chunk_0'))).length,32);
  assert.equal((await request('/api/complete-upload', { uploadId:'testupload',fileName:'movie.mp4',totalChunks:2 })).status,500);
  assert.equal((await fs.readdir(path.join(temp,'uploads'))).filter(name => name.endsWith('.mp4') || name.endsWith('.part')).length,0);
  const upload = await request('/api/complete-upload', { uploadId:'testupload',fileName:'movie.mp4',totalChunks:1 });
  assert.equal(upload.status,200); const movie = await upload.json();
  assert.deepEqual(await fs.readFile(path.join(temp,'uploads',movie.filename)),bytes);
  const fakeHeaders = { referer:'http://localhost/','sec-fetch-dest':'video',Range:'bytes=0-15' };
  assert.equal((await fetch(base+movie.url,{headers:fakeHeaders})).status,403);
  ws.send('42["delete-video",{"filename":"' + movie.filename + '"}]');
  ws.send('42["join-room",null]');
  ws.send('42["video-play",{"time":"bad"}]');
  ws.send('42["join-room",{"roomId":"test","user":"test"}]');
  const response = await fetch(base+movie.url+'?sid='+sid,{headers:fakeHeaders});
  assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,16);
  const domainStream = await fetch(base+movie.url+'?sid='+sid,{headers:{...fakeHeaders,referer:'https://stream.test/'}});
  assert.equal(domainStream.status,206);assert.equal((await domainStream.arrayBuffer()).byteLength,16);
  assert.equal((await fetch(base+movie.url+'?sid='+sid,{headers:{...fakeHeaders,referer:'https://untrusted.invalid/'}})).status,403);
  for(const blocked of ['/server.js','/.env','/server.log','/package.json']) {
    assert.equal((await fetch(base+blocked)).status,404);
  }

  assert.equal((await fetch(base+movie.url+'?sid='+sid,{headers:{...fakeHeaders,Range:'bytes=0-nope'}})).status,416);
  const thumbnail = await fetch(base+'/api/save-thumbnail',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Playback-Session':sid},body:JSON.stringify({videoPath:movie.filename,dataUrl:'data:image/jpeg;base64,/9j/2Q==',duration:1})});
  assert.equal(thumbnail.status,200);
  assert.equal((await fetch(base+'/api/library')).status,200);
  assert.deepEqual(await fs.readFile(path.join(temp,'uploads',movie.filename)),bytes);
  await fs.mkdir(path.join(temp,'uploads','destination'));
  await fs.writeFile(path.join(temp,'uploads','destination',movie.filename),Buffer.from('keep'));
  assert.equal((await request('/api/move-video',{videoPath:movie.filename,targetFolder:'destination'})).status,409);
  assert.equal(await fs.readFile(path.join(temp,'uploads','destination',movie.filename),'utf8'),'keep');
  assert.equal((await request('/api/folders', {name:'New series'})).status,200);
  assert.equal((await request('/api/folders', {name:'Season 1',parent:'New series'})).status,200);
  const fixture = path.join(temp,'new-movie.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:d=1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',fixture]);
  const videoBytes = await fs.readFile(fixture);
  const chunkResponse = await fetch(base+'/api/upload-chunk?uploadId=freshupload&chunkIndex=0&fileName=new-movie.mp4', {method:'POST',headers:{'Content-Type':'application/octet-stream',Origin:base,'X-Playback-Session':sid},body:videoBytes});
  assert.equal(chunkResponse.status,200);
  const completed = await request('/api/complete-upload',{uploadId:'freshupload',fileName:'new-movie.mp4',totalChunks:1,folder:'New series/Season 1'});
  assert.equal(completed.status,200);
  const freshMovie = await completed.json();
  let library = await (await fetch(base+'/api/library')).json();
  const series = library.folders.find(folder => folder.name === 'New series');
  const season = series.subfolders[0];
  assert.ok(series.thumbnailUrl);
  assert.equal(series.thumbnailUrl,season.thumbnailUrl);
  assert.equal(season.thumbnailUrl,season.videos[0].thumbnailUrl);
  assert.ok(season.videos[0].duration > 0);
  const jpgResponse = await fetch(base+season.thumbnailUrl);
  assert.equal(jpgResponse.status,200);
  assert.deepEqual(Buffer.from(await jpgResponse.arrayBuffer()).subarray(0,2),Buffer.from([0xff,0xd8]));
  assert.equal((await request('/api/move-video',{videoPath:'New series/Season 1/'+freshMovie.filename,targetFolder:'New series'})).status,200);
  library = await (await fetch(base+'/api/library')).json();
  const movedSeries = library.folders.find(folder => folder.name === 'New series');
  assert.ok(movedSeries.videos[0].thumbnailUrl);
  assert.ok(movedSeries.videos[0].duration > 0);
  assert.equal((await fetch(base+movedSeries.videos[0].thumbnailUrl)).status,200);
  assert.deepEqual(await fs.readFile('public/vendor/treeselectjs/treeselectjs.umd.js'),await fs.readFile('node_modules/treeselectjs/dist/treeselectjs.umd.js'));
  const app = await fs.readFile('public/app.js','utf8');
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
    document: { fullscreenElement: null, addEventListener() {}, getElementById: () => ({addEventListener() {}}) },
    viewUpload: {classList: {contains: () => uploadActive}},
    viewCinema: {classList: {contains: () => cinemaActive}},
    customVideo: {volume: 0.98, muted: true},
    togglePlayPause: () => calls.push('play'), seekRelative: n => calls.push(n),
    toggleAudioMute: () => calls.push('mute'), toggleAppFullscreen: () => calls.push('fullscreen'),
    showAlertModal: data => calls.push(data.title), closeModal: () => calls.push('close'),
    closeAllPopovers() {}, switchView: view => calls.push(view), resetIdleTimer() {}, showToast() {}
  };
  vm.createContext(shortcuts); vm.runInContext(shortcutCode, shortcuts);
  const key = (code, extra = {}) => {
    const event = {code, key: '', target: {closest: () => null}, preventDefault() {this.prevented = true;}, ...extra};
    shortcuts.handlePlayerShortcut(event); return event;
  };
  key('KeyK'); key('ArrowLeft'); key('KeyL');
  assert.deepEqual(calls.splice(0), ['play', -10, 10]);
  key('ArrowUp'); assert.equal(shortcuts.customVideo.volume, 1); assert.equal(shortcuts.customVideo.muted, false);
  shortcuts.customVideo.volume = 0.02; key('ArrowDown'); assert.equal(shortcuts.customVideo.volume, 0);
  for (const extra of [{ctrlKey:true}, {isComposing:true}, {defaultPrevented:true}, {repeat:true}, {target:{closest:()=>({})}}]) {
    key('KeyK', extra);
  }
  uploadActive = true; key('KeyK'); uploadActive = false;
  shortcuts.activeModalResolve = () => {}; key('KeyK'); key('Escape'); shortcuts.activeModalResolve = null;
  assert.deepEqual(calls.splice(0), ['close']);
  shortcuts.currentPlayingSource = ''; key('KeyK'); key('KeyF'); key('Slash', {key:'?'});
  assert.deepEqual(calls.splice(0), ['fullscreen', 'Keyboard shortcuts']);
  cinemaActive = true; key('Escape'); assert.deepEqual(calls.splice(0), ['browse']);
  shortcuts.document.fullscreenElement = {}; assert.equal(key('Escape').prevented, undefined);
  const views = ['browse', 'cinema', 'upload'].map(() => {
    const classes = new Set();
    return {classList: {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value)}};
  });
  const viewContext = {viewBrowse:views[0], viewCinema:views[1], viewUpload:views[2],
    navBtnBrowse:views[0], navBtnCinema:views[1], navBtnUpload:views[2],
    folderTreeselectInstance:null, heroVideoDock:null, playerContainer:null, cinemaVideoHolder:null,
    currentFolderView:null, resetIdleTimer(){}, closeAllPopovers(){}};
  vm.createContext(viewContext);
  vm.runInContext(app.slice(app.indexOf('function switchView'), app.indexOf('navBtnBrowse.addEventListener')), viewContext);
  for (const [index, name] of ['browse', 'cinema', 'upload', 'browse'].entries()) {
    viewContext.switchView(name);
    views.forEach((view, i) => assert.equal(view.inert, i !== index % 3));
  }
  const billboardCode = app.slice(app.indexOf('function updateHeroBillboard'),app.indexOf('// Catalogue & Netflix/Apple TV Folder Navigation'));
  const labels = new Map();
  const billboardContext = { customVideo:{src:'/api/stream/movie.mp4'},roomId:'test',pathBasename:()=> 'movie.mp4',formatMediaTitle:()=> 'Movie',document:{getElementById:id=>{if(!labels.has(id))labels.set(id,{style:{}});return labels.get(id);}} };
  vm.createContext(billboardContext);vm.runInContext(billboardCode,billboardContext);
  for (const folder of ['Alya Sometimes Hides Her Feelings In Russian [Thai Dub]13Ep','ชื่อ โฟลเดอร์','100% real #1','literal%20name']) {
    billboardContext.currentPlayingFolder = 'Anime/'+folder;
    vm.runInContext('updateHeroBillboard()',billboardContext);
    assert.equal(labels.get('hero-folder-tag').textContent,folder);
    assert.equal(labels.get('cinema-folder-name').textContent,folder);
  }
  const titleCode = app.slice(app.indexOf('function formatMediaTitle'),app.indexOf('// Dynamic gradient generator'));
  const titleContext = {};
  vm.createContext(titleContext); vm.runInContext(titleCode,titleContext);
  assert.equal(titleContext.formatMediaTitle('New_Movie_0123456789abcdef.mp4'),'New Movie');
  const fn = app.slice(app.indexOf('function applyThumbnailToContainer'),app.indexOf('// Active single hover preview manager'));
  let image;
  const detached = {querySelector:()=>null,appendChild:img=>image=img};
  vm.runInNewContext(fn+';applyThumbnailToContainer(container,"/poster.jpg",null,null,0);',{container:detached,document:{createElement:()=>({classList:{add(){}},complete:false})},formatTime:()=>''});
  assert.equal(image.src,'/poster.jpg');
  ws.close();
  console.log('PASS: keyboard shortcut safeguards, inactive view isolation, password-free session requests, blocked cross-site HTTP/WebSocket, blocked encoded static upload URLs, malformed socket packets, literal %, upload validation/assembly/cleanup, session enforcement, streaming body/ranges, thumbnail persistence, detached-card thumbnail regression; real new upload, nested folder covers, preserved thumbnail after move.');
} finally {
  for (const socket of activeSockets) socket.terminate();
  child.kill();
  if (child.exitCode === null) await once(child,'exit');
  // This directory was created by this test under the OS temp directory.
  assert.ok(temp.startsWith(path.join(os.tmpdir(),'tachyon-test-')));
  await fs.rm(temp,{recursive:true,force:true});
}
