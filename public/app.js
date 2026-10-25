function uiIcon(name) {
  const paths = {"folder": "<path d=\"M3 7V5h6l2 2h10v13H3z\"/>", "repeat": "<path d=\"m17 2 4 4-4 4M3 11V6h18M7 22l-4-4 4-4m14-1v5H3\"/>", "film": "<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M7 3v18M17 3v18M3 8h4m-4 8h4m10-8h4m-4 8h4\"/>", "upload": "<path d=\"M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5\"/>"};
  return `<svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

// ==========================================================================
// TachyonStream - Apple TV & Netflix Frontend Application
const socket = io();
async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  if (!["GET", "HEAD"].includes((options.method || "GET").toUpperCase()) && !socket.connected) {
    await new Promise((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        socket.off("connect", ready);
        reject(new Error("Player is disconnected. Please reconnect and try again."));
      }, 10000);
      socket.once("connect", ready);
    });
  }
  if (socket.id) headers.set("X-Playback-Session", socket.id);
  return fetch(url, { ...options, headers });
}

// State variables
const customVideo = document.getElementById("custom-video");
const customBox = document.getElementById("custom-player-box");
const playerContainer = document.getElementById("player-container");
const heroVideoDock = document.getElementById("hero-video-dock");
const cinemaVideoHolder = document.getElementById("cinema-video-holder");

let autoNextEnabled = false;
let currentPlayingFolder = null;
let currentPlayingSource = "";
let currentLibraryData = { folders: [], rootVideos: [], allFoldersList: [] };
let currentFolderView = null; // null = Root library, string = folder path
let searchQuery = "";
let isTransitioningNext = false;
let idleTimer = null;
let lastProgressTime = 0;

// Remote action lock to eliminate event feedback loops
let isRemoteAction = false;
let remoteActionTimer = null;

function setRemoteAction(durationMs = 1200) {
  isRemoteAction = true;
  clearTimeout(remoteActionTimer);
  remoteActionTimer = setTimeout(() => {
    isRemoteAction = false;
  }, durationMs);
}

// Connect to room (Discord voice channel or default)
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("channel_id") || "default-voice-room";

// Secure Video Streaming & Session Authentication Helper
function getSecuredVideoUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl, window.location.origin);
    // Eliminate any double slashes (e.g. /uploads//Anime -> /uploads/Anime)
    u.pathname = u.pathname.replace(/\/+/g, "/");
    if (socket && socket.id) {
      u.searchParams.set("sid", socket.id);
      u.searchParams.set("t", Date.now()); // Bypass any stale CDN / Cloudflare edge cache
    }
    return u.pathname + u.search;
  } catch {
    return rawUrl;
  }
}

function isSameVideoSource(srcA, srcB) {
  if (!srcA || !srcB) return false;
  try {
    const pathA = new URL(srcA, window.location.origin).pathname.replace(/\/+/g, "/");
    const pathB = new URL(srcB, window.location.origin).pathname.replace(/\/+/g, "/");
    return pathA === pathB || decodeURIComponent(pathA) === decodeURIComponent(pathB);
  } catch {
    return srcA.includes(srcB) || srcB.includes(srcA);
  }
}

function joinRoom() {
  socket.emit("join-room", {
    roomId,
    user: "User-" + Math.floor(Math.random() * 1000)
  });
}

socket.on("connect", () => {
  joinRoom();
  updateStatus("Synced");

  // Re-bind active socket session if already playing
  if (customVideo && customVideo.src && currentPlayingSource && socket.id) {
    if (!customVideo.src.includes(`sid=${socket.id}`)) {
      const savedTime = customVideo.currentTime;
      const wasPlaying = !customVideo.paused;
      customVideo.src = getSecuredVideoUrl(currentPlayingSource);
      customVideo.currentTime = savedTime;
      if (wasPlaying) customVideo.play().catch(() => {});
    }
  }
});

// Suppress right-click context menu on video to prevent "Open video in new tab"
if (customVideo) {
  customVideo.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ==========================================================================
// Video Player Events & Room Synchronization
customVideo.addEventListener("play", () => {
  updatePlayButtonUI(true);
  updateSoundUI();
  if (isRemoteAction) return;
  socket.emit("video-play", { time: customVideo.currentTime });
  updateStatus("Playing");
});

customVideo.addEventListener("pause", () => {
  updatePlayButtonUI(false);
  if (isRemoteAction) return;
  socket.emit("video-pause", { time: customVideo.currentTime });
  updateStatus("Paused");
});

customVideo.addEventListener("seeked", () => {
  if (isRemoteAction) return;
  socket.emit("video-seek", { time: customVideo.currentTime });
});

let isScrubbing = false;

function updateProgressBarUI(currentTime, duration) {
  if (!duration) return;
  const pct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
  const playedEl = document.getElementById("yt-progress-played");
  const handleEl = document.getElementById("yt-progress-handle");
  const scrubber = document.getElementById("cinema-scrubber");

  if (playedEl) playedEl.style.width = `${pct}%`;
  if (handleEl) handleEl.style.left = `${pct}%`;
  if (scrubber && !isScrubbing) scrubber.value = pct;

  const currentEl = document.getElementById("cinema-time-current");
  const totalEl = document.getElementById("cinema-time-total");
  if (currentEl) currentEl.textContent = formatTime(currentTime);
  if (totalEl) totalEl.textContent = formatTime(duration);
}

function updateBufferedBar() {
  const bufferedEl = document.getElementById("yt-progress-buffered");
  if (!bufferedEl || !customVideo.duration) return;
  const buffered = customVideo.buffered;
  if (buffered && buffered.length > 0) {
    const duration = customVideo.duration;
    const currentTime = customVideo.currentTime || 0;
    let end = 0;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
        end = buffered.end(i);
        break;
      }
    }
    if (end === 0 && buffered.length > 0) {
      end = buffered.end(buffered.length - 1);
    }
    const pct = Math.min(100, Math.max(0, (end / duration) * 100));
    bufferedEl.style.width = `${pct}%`;
  }
}

customVideo.addEventListener("progress", updateBufferedBar);
customVideo.addEventListener("loadedmetadata", () => {
  updateProgressBarUI(customVideo.currentTime || 0, customVideo.duration || 0);
  updateBufferedBar();
});

// Update timeline scrubber and readouts + progress heartbeat
customVideo.addEventListener("timeupdate", () => {
  const current = customVideo.currentTime || 0;
  const duration = customVideo.duration || 0;

  if (!isScrubbing) {
    updateProgressBarUI(current, duration);
  }
  updateBufferedBar();

  // Periodic heartbeat sync to room state every 4s
  if (!isRemoteAction && !customVideo.paused && Math.abs(current - lastProgressTime) >= 4) {
    lastProgressTime = current;
    socket.emit("video-progress", { time: current });
  }
});

// Video ended -> Auto Next
customVideo.addEventListener("ended", () => {
  updateStatus("Video ended");
  if (autoNextEnabled && currentPlayingFolder) {
    playNextInFolder(currentPlayingFolder);
  }
});

customVideo.addEventListener("error", () => {
  const err = customVideo.error;
  let msg = "Error loading video";
  if (err) {
    if (err.code === 1) msg = "Video loading aborted";
    if (err.code === 2) msg = "Network error while loading video";
    if (err.code === 3) msg = "Video decoding failed (Unsupported Codec)";
    if (err.code === 4) msg = "Video format not supported";
  }
  updateStatus(msg);
});

// Volume change listener
customVideo.addEventListener("volumechange", () => {
  updateSoundUI();
});

// Socket Sync Listeners
socket.on("sync-state", (state) => {
  if (!state) return;
  if (state.autoNext !== undefined) autoNextEnabled = !!state.autoNext;
  if (state.currentFolder !== undefined) currentPlayingFolder = state.currentFolder;
  updateAutoNextButtonsUI();

  if (!state.source) {
    renderCatalogue();
    updateHeroBillboard();
    return;
  }

  setRemoteAction(1600);
  currentPlayingSource = state.source;
  const isDifferentSource = !customVideo.src || !isSameVideoSource(customVideo.src, state.source);

  if (isDifferentSource) {
    customVideo.src = getSecuredVideoUrl(state.source);
    customVideo.currentTime = state.currentTime || 0;
  } else {
    alignPlaybackTime(state.currentTime || 0);
  }

  if (state.isPlaying) {
    customVideo.muted = false;
    customVideo.volume = (customVideo.volume > 0) ? customVideo.volume : 1.0;
    customVideo.play().then(() => {
      showUnmuteAlert(false);
      updateSoundUI();
    }).catch(() => {
      customVideo.muted = true;
      customVideo.play().catch(() => { });
      showUnmuteAlert(true);
      updateSoundUI();
    });
  } else {
    customVideo.pause();
  }

  updateStatus("Synced");
  updateHeroBillboard();
  renderCatalogue();
  renderEpisodesDrawer();
});

// Balanced Micro-Drift Correction
// Nudges playback rate by +/- 5% for minor network jitter (0.35s - 1.2s) instead of jarring hard seeks
let driftRateTimeout = null;
function alignPlaybackTime(targetTime) {
  if (isNaN(targetTime) || targetTime < 0) return;
  const drift = targetTime - customVideo.currentTime;
  const absDrift = Math.abs(drift);

  if (absDrift > 1.2) {
    customVideo.currentTime = targetTime;
  } else if (absDrift >= 0.35 && !customVideo.paused) {
    clearTimeout(driftRateTimeout);
    customVideo.playbackRate = drift > 0 ? 1.05 : 0.95;
    driftRateTimeout = setTimeout(() => {
      customVideo.playbackRate = 1.0;
    }, 1200);
  }
}

socket.on("change-source", ({ source, folder }) => {
  setRemoteAction(1600);
  isTransitioningNext = false;
  if (folder !== undefined) currentPlayingFolder = folder;
  currentPlayingSource = source || "";

  if (!source) {
    customVideo.src = "";
    updateStatus("No video playing");
    updateHeroBillboard();
    renderCatalogue();
    renderEpisodesDrawer();
    return;
  }

  const isDifferentSource = !customVideo.src || !isSameVideoSource(customVideo.src, source);
  if (isDifferentSource) {
    customVideo.src = getSecuredVideoUrl(source);
    customVideo.load();
    customVideo.muted = false;
    customVideo.volume = (customVideo.volume > 0) ? customVideo.volume : 1.0;
    customVideo.play().then(() => {
      showUnmuteAlert(false);
      updateSoundUI();
    }).catch(() => {
      customVideo.muted = true;
      customVideo.play().catch(() => { });
      showUnmuteAlert(true);
      updateSoundUI();
    });
  }

  const rawName = decodeURIComponent(pathBasename(source));
  const cleanName = formatMediaTitle(rawName);
  updateStatus(`Playing: ${cleanName}`);
  showToast(`Now Playing: ${cleanName}`);
  updateHeroBillboard();
  renderCatalogue();
  renderEpisodesDrawer();
});

socket.on("auto-next-changed", ({ autoNext, currentFolder }) => {
  autoNextEnabled = !!autoNext;
  if (currentFolder !== undefined) currentPlayingFolder = currentFolder;
  updateAutoNextButtonsUI();
  updateHeroBillboard();
  renderCatalogue();
});

socket.on("library-updated", () => {
  loadLibrary();
});

socket.on("video-deleted", () => {
  loadLibrary();
});

socket.on("video-play", ({ time }) => {
  setRemoteAction(1200);
  alignPlaybackTime(time);
  customVideo.play().catch(() => {
    customVideo.muted = true;
    customVideo.play().catch(() => { });
    showUnmuteAlert(true);
    updateSoundUI();
  });
  updateStatus("Synced: Playing");
  showToast("Room Playing");
});

socket.on("video-pause", ({ time }) => {
  setRemoteAction(1200);
  alignPlaybackTime(time);
  customVideo.pause();
  updateStatus("Synced: Paused");
  showToast("Room Paused");
});

socket.on("video-seek", ({ time }) => {
  setRemoteAction(1200);
  customVideo.currentTime = time;
  updateStatus("Synced: Seeked");
  showToast(`Seeked to ${formatTime(time)}`);
});

socket.on("user-joined", ({ count }) => {
  const el = document.getElementById("user-count");
  if (el) el.textContent = `${count} ${count > 1 ? "users" : "user"}`;
});

socket.on("user-left", ({ count }) => {
  const el = document.getElementById("user-count");
  if (el) el.textContent = `${count} ${count > 1 ? "users" : "user"}`;
});

function updateStatus(text) {
  const statusEl = document.getElementById("sync-status");
  if (statusEl) statusEl.textContent = text;
}

// Click to manually re-sync with room
const btnSyncRoom = document.getElementById("btn-sync-room");
if (btnSyncRoom) {
  btnSyncRoom.addEventListener("click", () => {
    updateStatus("Syncing...");
    showToast("Syncing with room...");
    socket.emit("request-sync");
  });
}

// ==========================================================================
// Toast & Sound Management Helpers
const SVG_VOL_ON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
const SVG_VOL_MUTED = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;

function showToast(message) {
  const toast = document.getElementById("app-toast");
  const text = document.getElementById("toast-text");
  if (toast && text) {
    text.textContent = message;
    toast.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove("show");
    }, 2800);
  }
}

function showUnmuteAlert(show) {
  const banner = document.getElementById("unmute-alert");
  if (banner) {
    banner.style.display = show ? "flex" : "none";
  }
}

function updateSoundUI() {
  const isMuted = customVideo.muted || customVideo.volume === 0;
  const soundIconHtml = isMuted ? SVG_VOL_MUTED : SVG_VOL_ON;
  const soundText = isMuted ? "Muted" : "Sound ON";

  const navBtnSound = document.getElementById("nav-btn-sound");
  const navIcon = document.getElementById("nav-sound-icon");
  const navText = document.getElementById("nav-sound-text");
  if (navBtnSound) {
    navBtnSound.classList.toggle("muted", isMuted);
    if (navIcon) navIcon.innerHTML = soundIconHtml;
    if (navText) navText.textContent = soundText;
  }

  const heroBtn = document.getElementById("btn-hero-sound");
  const heroIcon = document.getElementById("hero-sound-icon");
  const heroText = document.getElementById("hero-sound-text");
  if (heroBtn) {
    heroBtn.classList.toggle("muted", isMuted);
    if (heroIcon) heroIcon.innerHTML = soundIconHtml;
    if (heroText) heroText.textContent = soundText;
  }

  const volumeIcon = document.getElementById("volume-icon");
  if (volumeIcon) volumeIcon.innerHTML = soundIconHtml;

  const cinemaVolume = document.getElementById("cinema-volume");
  if (cinemaVolume && !cinemaVolume.matches(":active")) {
    cinemaVolume.value = isMuted ? 0 : customVideo.volume;
  }
}

function toggleAudioMute() {
  if (customVideo.muted || customVideo.volume === 0) {
    customVideo.muted = false;
    customVideo.volume = (customVideo.volume > 0) ? customVideo.volume : 1.0;
    showUnmuteAlert(false);
    showToast("Audio Unmuted");
  } else {
    customVideo.muted = true;
    showToast("Audio Muted");
  }
  updateSoundUI();
}

// Unmute banner click
const unmuteAlertEl = document.getElementById("unmute-alert");
if (unmuteAlertEl) {
  unmuteAlertEl.addEventListener("click", () => {
    customVideo.muted = false;
    customVideo.volume = 1.0;
    showUnmuteAlert(false);
    updateSoundUI();
    showToast("Sound Unmuted");
  });
}

// Sound toggle buttons
const navBtnSound = document.getElementById("nav-btn-sound");
if (navBtnSound) navBtnSound.addEventListener("click", toggleAudioMute);

const heroBtnSound = document.getElementById("btn-hero-sound");
if (heroBtnSound) heroBtnSound.addEventListener("click", toggleAudioMute);

// Global user gesture listener: if user clicks anywhere while playing muted, auto-unmute
document.addEventListener("click", () => {
  if (customVideo.src && !customVideo.paused && customVideo.muted) {
    customVideo.muted = false;
    customVideo.volume = 1.0;
    showUnmuteAlert(false);
    updateSoundUI();
  }
}, { once: false });

// ==========================================================================
// View Routing & Player Docking (Browse / Cinema / Upload)
const viewBrowse = document.getElementById("view-browse");
const viewCinema = document.getElementById("view-cinema");
const viewUpload = document.getElementById("view-upload");

const navBtnBrowse = document.getElementById("nav-btn-browse");
const navBtnCinema = document.getElementById("nav-btn-cinema");
const navBtnUpload = document.getElementById("nav-btn-upload");

function switchView(viewName) {
  if (folderTreeselectInstance?.isListOpened) folderTreeselectInstance.toggleOpenClose();
  [viewBrowse, viewCinema, viewUpload].forEach(v => v.classList.remove("active"));
  [navBtnBrowse, navBtnCinema, navBtnUpload].forEach(b => b.classList.remove("active"));

  if (viewName === "browse") {
    viewBrowse.classList.add("active");
    navBtnBrowse.classList.add("active");
    // Dock player container inside hero dock
    if (heroVideoDock && playerContainer && playerContainer.parentElement !== heroVideoDock) {
      heroVideoDock.appendChild(playerContainer);
    }
  } else if (viewName === "cinema") {
    viewCinema.classList.add("active");
    navBtnCinema.classList.add("active");
    // Dock player container inside cinema theater
    if (cinemaVideoHolder && playerContainer && playerContainer.parentElement !== cinemaVideoHolder) {
      cinemaVideoHolder.appendChild(playerContainer);
    }
    resetIdleTimer();
  } else if (viewName === "upload") {
    viewUpload.classList.add("active");
    navBtnUpload.classList.add("active");
    if (currentFolderView) {
      currentSelectedUploadFolder = currentFolderView;
      updateFolderSelectDropdown();
    }
  }
  [viewBrowse, viewCinema, viewUpload].forEach(view => {
    view.inert = !view.classList.contains("active");
  });
  closeAllPopovers();
}

navBtnBrowse.addEventListener("click", () => switchView("browse"));
navBtnCinema.addEventListener("click", () => switchView("cinema"));
navBtnUpload.addEventListener("click", () => switchView("upload"));

document.getElementById("brand-logo").addEventListener("click", () => {
  currentFolderView = null;
  searchQuery = "";
  const sInput = document.getElementById("library-search");
  if (sInput) sInput.value = "";
  renderCatalogue();
  switchView("browse");
});

document.getElementById("btn-hero-watch").addEventListener("click", () => {
  switchView("cinema");
});

if (heroVideoDock) {
  heroVideoDock.addEventListener("click", () => {
    switchView("cinema");
  });
}

document.getElementById("btn-cinema-back-browse").addEventListener("click", () => {
  switchView("browse");
});

document.getElementById("btn-close-upload").addEventListener("click", () => {
  switchView("browse");
});

// Fullscreen toggle
const btnFullscreen = document.getElementById("btn-fullscreen-toggle");
const btnCinemaFullscreen = document.getElementById("btn-cinema-fullscreen");

function toggleAppFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => { });
  } else {
    document.exitFullscreen().catch(() => { });
  }
}

if (btnFullscreen) btnFullscreen.addEventListener("click", toggleAppFullscreen);
if (btnCinemaFullscreen) btnCinemaFullscreen.addEventListener("click", toggleAppFullscreen);

// ==========================================================================
// Playback Controls (Hero + Cinema HUD)
function playVideo(videoUrl, folderPath = null, clickedCard = null) {
  currentPlayingFolder = folderPath || null;
  currentPlayingSource = videoUrl;
  customVideo.src = getSecuredVideoUrl(videoUrl);
  customVideo.load();

  // Explicit user gesture: Unmute audio and set volume to 100%!
  customVideo.muted = false;
  customVideo.volume = 1.0;

  customVideo.play().then(() => {
    showUnmuteAlert(false);
    updateSoundUI();
  }).catch((err) => {
    console.warn("Autoplay with sound restricted, playing muted with unmute banner:", err);
    customVideo.muted = true;
    customVideo.play().catch(() => { });
    showUnmuteAlert(true);
    updateSoundUI();
  });

  const rawFilename = decodeURIComponent(pathBasename(videoUrl));
  const cleanTitle = formatMediaTitle(rawFilename);

  // Trigger click animation on card
  if (clickedCard) {
    clickedCard.classList.add("card-just-played");
    setTimeout(() => clickedCard.classList.remove("card-just-played"), 500);
  }

  // Show Netflix/Apple TV animated toast
  showToast(`Now Playing: ${cleanTitle}`);

  socket.emit("change-source", { source: videoUrl, folder: folderPath || null });
  updateHeroBillboard();
  renderCatalogue();
  renderEpisodesDrawer();
}

function togglePlayPause() {
  if (!customVideo.src) return;
  if (customVideo.paused) {
    // Unmute on explicit play click
    customVideo.muted = false;
    customVideo.volume = (customVideo.volume > 0) ? customVideo.volume : 1.0;
    customVideo.play().then(() => {
      showUnmuteAlert(false);
      updateSoundUI();
    }).catch(() => {
      customVideo.muted = true;
      customVideo.play().catch(() => { });
      showUnmuteAlert(true);
      updateSoundUI();
    });
    socket.emit("video-play", { time: customVideo.currentTime });
    showToast("Playing");
  } else {
    customVideo.pause();
    socket.emit("video-pause", { time: customVideo.currentTime });
    showToast("Paused");
  }
}

function seekRelative(delta) {
  if (!customVideo.src) return;
  const newTime = Math.max(0, Math.min(customVideo.duration || Infinity, customVideo.currentTime + delta));
  customVideo.currentTime = newTime;
  socket.emit("video-seek", { time: newTime });
  showToast(delta > 0 ? `+${delta}s` : `${delta}s`);
}

const SVG_PLAY_BTN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
const SVG_PAUSE_BTN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;

function updatePlayButtonUI(isPlaying) {
  const heroPlayIcon = document.getElementById("hero-play-icon");
  const cinemaPlayIcon = document.getElementById("cinema-play-icon");
  if (heroPlayIcon) heroPlayIcon.innerHTML = isPlaying ? SVG_PAUSE_BTN : SVG_PLAY_BTN;
  if (cinemaPlayIcon) cinemaPlayIcon.innerHTML = isPlaying ? SVG_PAUSE_BTN : SVG_PLAY_BTN;
}

document.getElementById("btn-hero-playpause").addEventListener("click", togglePlayPause);
document.getElementById("btn-toggle-play").addEventListener("click", togglePlayPause);

document.getElementById("btn-hero-back10").addEventListener("click", () => seekRelative(-10));
document.getElementById("btn-backward-10").addEventListener("click", () => seekRelative(-10));

document.getElementById("btn-hero-fwd10").addEventListener("click", () => seekRelative(10));
document.getElementById("btn-forward-10").addEventListener("click", () => seekRelative(10));

// ==========================================================================
// YouTube-Grade Interactive Time Bar & Preview Tooltip
const ytProgressContainer = document.getElementById("yt-progress-container");
const ytTooltip = document.getElementById("yt-progress-tooltip");
const ytHoverLine = document.getElementById("yt-progress-hover-line");
const cinemaScrubber = document.getElementById("cinema-scrubber");

let isScrubbingTimeline = false;

function getTimeFromPointerEvent(e) {
  if (!ytProgressContainer || !customVideo.duration) return { pct: 0, time: 0, offsetX: 0, totalWidth: 1 };
  const rect = ytProgressContainer.getBoundingClientRect();
  const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
  const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const pct = rect.width > 0 ? (offsetX / rect.width) : 0;
  return { pct, time: pct * customVideo.duration, offsetX, totalWidth: rect.width };
}

if (ytProgressContainer) {
  // Mousemove for hover line and floating timestamp tooltip
  ytProgressContainer.addEventListener("mousemove", (e) => {
    if (!customVideo.duration) return;
    const { pct, time, offsetX, totalWidth } = getTimeFromPointerEvent(e);

    // Update hover line
    if (ytHoverLine) {
      ytHoverLine.style.width = `${pct * 100}%`;
    }

    // Update floating tooltip
    if (ytTooltip) {
      ytTooltip.textContent = formatTime(time);
      const clampX = Math.max(26, Math.min(totalWidth - 26, offsetX));
      ytTooltip.style.left = `${clampX}px`;
    }

    // If actively dragging, update scrubber UI in real time
    if (isScrubbingTimeline) {
      updateProgressBarUI(time, customVideo.duration);
      const currentEl = document.getElementById("cinema-time-current");
      if (currentEl) currentEl.textContent = formatTime(time);
    }
  });

  ytProgressContainer.addEventListener("mouseleave", () => {
    if (!isScrubbingTimeline && ytHoverLine) {
      ytHoverLine.style.width = "0%";
    }
  });

  // Mouse down / Drag start
  ytProgressContainer.addEventListener("mousedown", (e) => {
    if (!customVideo.duration) return;
    isScrubbingTimeline = true;
    isScrubbing = true;
    ytProgressContainer.classList.add("scrubbing");

    const { time } = getTimeFromPointerEvent(e);
    updateProgressBarUI(time, customVideo.duration);
    const currentEl = document.getElementById("cinema-time-current");
    if (currentEl) currentEl.textContent = formatTime(time);
  });

  // Global mousemove & mouseup for drag scrubbing outside container
  window.addEventListener("mousemove", (e) => {
    if (!isScrubbingTimeline || !customVideo.duration) return;
    const { time } = getTimeFromPointerEvent(e);
    updateProgressBarUI(time, customVideo.duration);
    const currentEl = document.getElementById("cinema-time-current");
    if (currentEl) currentEl.textContent = formatTime(time);
  });

  window.addEventListener("mouseup", (e) => {
    if (isScrubbingTimeline) {
      isScrubbingTimeline = false;
      isScrubbing = false;
      ytProgressContainer.classList.remove("scrubbing");
      if (customVideo.duration) {
        const { time } = getTimeFromPointerEvent(e);
        customVideo.currentTime = time;
        socket.emit("video-seek", { time });
        showToast(`Seeked to ${formatTime(time)}`);
      }
    }
  });
}

// Fallback for native range inputs
if (cinemaScrubber) {
  cinemaScrubber.addEventListener("input", () => {
    if (customVideo.duration) {
      const pct = parseFloat(cinemaScrubber.value);
      const newTime = (pct / 100) * customVideo.duration;
      const currentEl = document.getElementById("cinema-time-current");
      if (currentEl) currentEl.textContent = formatTime(newTime);
    }
  });

  cinemaScrubber.addEventListener("change", () => {
    if (customVideo.duration) {
      const pct = parseFloat(cinemaScrubber.value);
      const newTime = (pct / 100) * customVideo.duration;
      customVideo.currentTime = newTime;
      socket.emit("video-seek", { time: newTime });
    }
  });
}

// Volume & Mute Controls in Cinema View
const cinemaVolume = document.getElementById("cinema-volume");
const btnCinemaMute = document.getElementById("btn-cinema-mute");

if (cinemaVolume) {
  cinemaVolume.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    customVideo.volume = val;
    customVideo.muted = (val === 0);
    updateSoundUI();
  });
}

if (btnCinemaMute) {
  btnCinemaMute.addEventListener("click", toggleAudioMute);
}

// Auto-Next Toggles
function toggleAutoNext(folderPath = null) {
  const targetFolder = folderPath || currentPlayingFolder || currentFolderView || null;
  const newState = !autoNextEnabled;
  autoNextEnabled = newState;
  if (targetFolder) currentPlayingFolder = targetFolder;

  socket.emit("set-auto-next", { enabled: newState, folder: targetFolder });
  updateAutoNextButtonsUI();
  updateStatus(`Auto Next ${newState ? "ON" : "OFF"}`);
  showToast(newState ? "Auto-Next Enabled" : "Auto-Next Disabled");
  renderCatalogue();
}

function updateAutoNextButtonsUI() {
  const text = autoNextEnabled ? "Auto-Next: ON" : "Auto-Next: OFF";

  const heroBtn = document.getElementById("btn-hero-autonext");
  if (heroBtn) {
    heroBtn.innerHTML = uiIcon("repeat") + text;
    heroBtn.classList.toggle("active", autoNextEnabled);
  }

  const cinemaBtn = document.getElementById("btn-cinema-autonext");
  if (cinemaBtn) {
    cinemaBtn.innerHTML = uiIcon("repeat") + text;
    cinemaBtn.classList.toggle("active", autoNextEnabled);
  }

  const folderBarBtn = document.getElementById("btn-folder-autonext-toggle");
  if (folderBarBtn) {
    folderBarBtn.innerHTML = uiIcon("repeat") + text;
    folderBarBtn.classList.toggle("accent-pill", autoNextEnabled);
  }
}

document.getElementById("btn-hero-autonext").addEventListener("click", () => toggleAutoNext());
document.getElementById("btn-cinema-autonext").addEventListener("click", () => toggleAutoNext());
document.getElementById("btn-folder-autonext-toggle").addEventListener("click", () => toggleAutoNext(currentFolderView));

// Next Episode button in transport bar
document.getElementById("btn-next-episode").addEventListener("click", () => {
  if (currentPlayingFolder) {
    playNextInFolder(currentPlayingFolder, true);
  }
});

// Cinema Idle HUD Auto-Hide
const cinemaTheater = document.getElementById("cinema-theater");

function resetIdleTimer() {
  if (!cinemaTheater) return;
  cinemaTheater.classList.remove("idle-hidden");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!customVideo.paused && viewCinema.classList.contains("active")) {
      cinemaTheater.classList.add("idle-hidden");
    }
  }, 3500);
}

if (cinemaTheater) {
  cinemaTheater.addEventListener("mousemove", resetIdleTimer);
  cinemaTheater.addEventListener("click", resetIdleTimer);
}

// ==========================================================================
// Keyboard shortcuts
function showShortcutHelp() {
  showAlertModal({
    title: "Keyboard shortcuts",
    message: [
      "Space / K — Play / Pause",
      "Left / J — Back 10 seconds",
      "Right / L — Forward 10 seconds",
      "Up / Down — Volume ±5%",
      "M — Mute / Unmute",
      "F — Toggle fullscreen",
      "Esc — Back to Library / close dialog",
      "? — Show keyboard shortcuts",
      "Player shortcuts are paused while typing or using Upload."
    ].join("\n")
  });
}

function handlePlayerShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
  if (activeModalResolve) {
    if (event.code === "Escape") { event.preventDefault(); closeModal(null); }
    return;
  }
  // Preserve native typing and keyboard interaction with focused controls.
  if (event.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], .treeselect, .treeselect-list, .card-popover-menu")) return;
  if (event.code === "Escape") {
    if (document.fullscreenElement) return;
    closeAllPopovers();
    if (viewCinema.classList.contains("active") || viewUpload.classList.contains("active")) {
      event.preventDefault();
      switchView("browse");
    }
    return;
  }
  if (event.target?.closest?.("button, a")) return;
  if (viewUpload.classList.contains("active")) return;
  const code = event.key === "?" ? "Help" : event.code;
  if (!["Space", "KeyK", "KeyJ", "KeyL", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyM", "KeyF", "Help"].includes(code)) return;
  if (!currentPlayingSource && !["KeyF", "Help"].includes(code)) return;
  event.preventDefault();
  if (event.repeat && ["Space", "KeyK", "KeyM", "KeyF", "Help"].includes(code)) return;
  switch (code) {
    case "Space": case "KeyK": togglePlayPause(); break;
    case "ArrowLeft": case "KeyJ": seekRelative(-10); break;
    case "ArrowRight": case "KeyL": seekRelative(10); break;
    case "ArrowUp": case "ArrowDown":
      customVideo.volume = Math.max(0, Math.min(1, customVideo.volume + (code === "ArrowUp" ? 0.05 : -0.05)));
      customVideo.muted = false;
      showToast(`Volume: ${Math.round(customVideo.volume * 100)}%`);
      break;
    case "KeyM": toggleAudioMute(); break;
    case "KeyF": toggleAppFullscreen(); break;
    case "Help": showShortcutHelp(); break;
  }
  resetIdleTimer();
}

document.addEventListener("keydown", handlePlayerShortcut);
document.getElementById("btn-shortcuts").addEventListener("click", showShortcutHelp);

// ==========================================================================
// Hero Billboard Updating
function updateHeroBillboard() {
  const heroTitle = document.getElementById("hero-title");
  const heroSubtitle = document.getElementById("hero-subtitle");
  const heroFolderTag = document.getElementById("hero-folder-tag");
  const heroLiveBadge = document.getElementById("hero-live-badge");
  const cinemaVideoTitle = document.getElementById("cinema-video-title");
  const cinemaFolderName = document.getElementById("cinema-folder-name");

  if (!customVideo.src) {
    if (heroTitle) heroTitle.textContent = "Select a video or series to begin";
    if (heroSubtitle) heroSubtitle.textContent = "Stream videos together in real-time with synchronized playback and auto-next support.";
    if (heroFolderTag) heroFolderTag.textContent = "Library";
    if (heroLiveBadge) heroLiveBadge.style.display = "none";
    if (cinemaVideoTitle) cinemaVideoTitle.textContent = "No Video Selected";
    if (cinemaFolderName) cinemaFolderName.textContent = "Library";
    return;
  }

  const rawFilename = decodeURIComponent(pathBasename(customVideo.src));
  const cleanTitle = formatMediaTitle(rawFilename);
  const folderName = currentPlayingFolder ? currentPlayingFolder.split("/").filter(Boolean).pop() : "Standalone Video";

  if (heroTitle) heroTitle.textContent = cleanTitle;
  if (heroSubtitle) heroSubtitle.textContent = `Streaming in synchronized room "${roomId}".`;
  if (heroFolderTag) heroFolderTag.textContent = folderName;
  if (heroLiveBadge) heroLiveBadge.style.display = "inline-flex";

  if (cinemaVideoTitle) cinemaVideoTitle.textContent = cleanTitle;
  if (cinemaFolderName) cinemaFolderName.textContent = folderName;
}

// ==========================================================================
// Catalogue & Netflix/Apple TV Folder Navigation
function navigateToFolder(folderPath) {
  currentFolderView = folderPath;
  searchQuery = "";
  const sInput = document.getElementById("library-search");
  if (sInput) sInput.value = "";
  renderCatalogue();

  // Scroll smoothly to top of catalogue
  const browsePanel = document.getElementById("view-browse");
  if (browsePanel) browsePanel.scrollTo({ top: 0, behavior: "smooth" });
}

function navigateUpFolder() {
  if (!currentFolderView) return;
  const parts = currentFolderView.split("/").filter(Boolean);
  if (parts.length <= 1) {
    currentFolderView = null; // back to root
  } else {
    parts.pop();
    currentFolderView = parts.join("/");
  }
  renderCatalogue();

  const browsePanel = document.getElementById("view-browse");
  if (browsePanel) browsePanel.scrollTo({ top: 0, behavior: "smooth" });
}

// Render the entire Netflix / Apple TV catalogue
function renderCatalogue() {
  const container = document.getElementById("catalogue-container");
  if (!container) return;

  renderBreadcrumbs();
  renderFolderBarActions();

  const { folders = [], rootVideos = [] } = currentLibraryData;

  // Search filter helper
  const matchesSearch = (text) => {
    if (!searchQuery) return true;
    return (text || "").toLowerCase().includes(searchQuery.toLowerCase());
  };

  container.innerHTML = "";

  // ------------------------------------------------------------------------
  // ROOT VIEW (currentFolderView == null): Show Folders & Standalone Videos
  if (!currentFolderView) {
    const visibleFolders = folders.filter(f => matchesSearch(f.name) || (f.videos && f.videos.some(v => matchesSearch(v.name))));
    const visibleVideos = rootVideos.filter(v => matchesSearch(v.name));

    if (visibleFolders.length === 0 && visibleVideos.length === 0) {
      container.innerHTML = `
        <div class="empty-catalogue-box">
          <span class="empty-icon">${uiIcon("folder")}</span>
          <h3 class="empty-title">${searchQuery ? `No matches found for "${escapeHtml(searchQuery)}"` : "Your library is empty"}</h3>
          <p class="empty-desc">${searchQuery ? "Try searching for a different title or keyword." : "Upload your favorite anime, movies, or series above to get started!"}</p>
        </div>
      `;
      return;
    }

    // 1. Folders Shelf (Series / Shows)
    if (visibleFolders.length > 0) {
      const folderShelf = document.createElement("section");
      folderShelf.className = "catalogue-shelf";

      const header = document.createElement("div");
      header.className = "shelf-header";
      header.innerHTML = `
        <div class="shelf-title-group">
          <h2 class="shelf-title">Folders & Series</h2>
          <span class="shelf-count-badge">${visibleFolders.length}</span>
        </div>
      `;
      folderShelf.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "shelf-grid";

      visibleFolders.forEach(folder => {
        const card = createFolderPosterCard(folder);
        grid.appendChild(card);
      });

      folderShelf.appendChild(grid);
      container.appendChild(folderShelf);
    }

    // 2. Standalone Videos Shelf (Movies)
    if (visibleVideos.length > 0) {
      const videoShelf = document.createElement("section");
      videoShelf.className = "catalogue-shelf";

      const header = document.createElement("div");
      header.className = "shelf-header";
      header.innerHTML = `
        <div class="shelf-title-group">
          <h2 class="shelf-title">Movies & Standalone Videos</h2>
          <span class="shelf-count-badge">${visibleVideos.length}</span>
        </div>
      `;
      videoShelf.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "shelf-grid";

      visibleVideos.forEach(video => {
        const card = createVideoCard(video, null);
        grid.appendChild(card);
      });

      videoShelf.appendChild(grid);
      container.appendChild(videoShelf);
    }

    return;
  }

  // ------------------------------------------------------------------------
  // INSIDE FOLDER VIEW (currentFolderView != null): Show Subfolders & Episodes
  const currentFolder = findFolderByPath(folders, currentFolderView);
  if (!currentFolder) {
    container.innerHTML = `
      <div class="empty-catalogue-box">
        <span class="empty-icon">${uiIcon("folder")}</span>
        <h3 class="empty-title">Folder not found</h3>
        <p class="empty-desc">This folder may have been moved or deleted.</p>
        <button class="folder-action-pill accent-pill" onclick="currentFolderView=null;renderCatalogue();">Return to Library</button>
      </div>
    `;
    return;
  }

  const subfolders = (currentFolder.subfolders || []).filter(sf => matchesSearch(sf.name));
  const episodes = (currentFolder.videos || []).filter(v => matchesSearch(v.name));

  if (subfolders.length === 0 && episodes.length === 0) {
    container.innerHTML = `
      <div class="empty-catalogue-box">
        <span class="empty-icon">${uiIcon("folder")}</span>
        <h3 class="empty-title">This folder is empty</h3>
        <p class="empty-desc">Create a subfolder or upload/move videos into "${escapeHtml(currentFolder.name)}".</p>
      </div>
    `;
    return;
  }

  // 1. Subfolders shelf (if any exist inside this folder)
  if (subfolders.length > 0) {
    const subShelf = document.createElement("section");
    subShelf.className = "catalogue-shelf";

    const header = document.createElement("div");
    header.className = "shelf-header";
    header.innerHTML = `
      <div class="shelf-title-group">
        <h2 class="shelf-title">Subfolders & Seasons</h2>
        <span class="shelf-count-badge">${subfolders.length}</span>
      </div>
    `;
    subShelf.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "shelf-grid";

    subfolders.forEach(sub => {
      const card = createFolderPosterCard(sub);
      grid.appendChild(card);
    });

    subShelf.appendChild(grid);
    container.appendChild(subShelf);
  }

  // 2. Episodes / Videos shelf
  if (episodes.length > 0) {
    const epShelf = document.createElement("section");
    epShelf.className = "catalogue-shelf";

    const header = document.createElement("div");
    header.className = "shelf-header";
    header.innerHTML = `
      <div class="shelf-title-group">
        <h2 class="shelf-title">Episodes & Videos</h2>
        <span class="shelf-count-badge">${episodes.length}</span>
      </div>
    `;
    epShelf.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "shelf-grid";

    episodes.forEach(video => {
      const card = createVideoCard(video, currentFolder.path);
      grid.appendChild(card);
    });

    epShelf.appendChild(grid);
    container.appendChild(epShelf);
  }
}

// Helper: Close any open popover menus
function closeAllPopovers() {
  document.querySelectorAll(".card-popover-menu").forEach(menu => {
    menu._trigger?.setAttribute("aria-expanded", "false");
    menu.remove();
  });
}
document.addEventListener("click", closeAllPopovers);

function openVideoContextMenu(e, video) {
  closeAllPopovers();
  removeActiveHoverPreview();
  const menu = document.createElement("div");
  menu.className = "card-popover-menu";
  menu.innerHTML = `
    <button class="card-popover-item btn-pop-move">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
      Move to Folder
    </button>
    <button class="card-popover-item danger btn-pop-del">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      Delete Video
    </button>
  `;

  const rect = e.currentTarget.getBoundingClientRect();
  menu.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;

  menu.querySelector(".btn-pop-move").addEventListener("click", (evt) => {
    evt.stopPropagation();
    closeAllPopovers();
    moveVideoPrompt(video);
  });

  menu.querySelector(".btn-pop-del").addEventListener("click", async (evt) => {
    evt.stopPropagation();
    closeAllPopovers();
    await deleteVideoPrompt(video);
  });

  menu._trigger = e.currentTarget;
  menu._trigger.setAttribute("aria-expanded", "true");
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "Card options");
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const trigger = menu._trigger;
      closeAllPopovers();
      trigger.focus();
    }
  });
  document.body.appendChild(menu);
  menu.style.top = `${Math.max(8, Math.min(rect.top - menu.offsetHeight - 6, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button").focus();
}

function openFolderContextMenu(e, folder) {
  closeAllPopovers();
  removeActiveHoverPreview();
  const menu = document.createElement("div");
  menu.className = "card-popover-menu";
  menu.innerHTML = `
    <button class="card-popover-item btn-pop-play">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
      Play from Start
    </button>
    <button class="card-popover-item btn-pop-sub">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      New Subfolder
    </button>
    <button class="card-popover-item danger btn-pop-del">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      Delete Folder
    </button>
  `;

  const rect = e.currentTarget.getBoundingClientRect();
  menu.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;

  menu.querySelector(".btn-pop-play").addEventListener("click", (evt) => {
    evt.stopPropagation();
    closeAllPopovers();
    playFolderFromStart(folder);
  });

  menu.querySelector(".btn-pop-sub").addEventListener("click", async (evt) => {
    evt.stopPropagation();
    closeAllPopovers();
    await createSubfolderPrompt(folder.path, folder.name);
  });

  menu.querySelector(".btn-pop-del").addEventListener("click", async (evt) => {
    evt.stopPropagation();
    closeAllPopovers();
    await deleteFolderPrompt(folder.path, folder.name);
  });

  menu._trigger = e.currentTarget;
  menu._trigger.setAttribute("aria-expanded", "true");
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "Card options");
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const trigger = menu._trigger;
      closeAllPopovers();
      trigger.focus();
    }
  });
  document.body.appendChild(menu);
  menu.style.top = `${Math.max(8, Math.min(rect.top - menu.offsetHeight - 6, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button").focus();
}

function getFirstVideoInFolder(folder) {
  if (!folder) return null;
  if (folder.videos && folder.videos.length > 0) return folder.videos[0];
  if (folder.subfolders && folder.subfolders.length > 0) {
    for (const sf of folder.subfolders) {
      const v = getFirstVideoInFolder(sf);
      if (v) return v;
    }
  }
  return null;
}

// ==========================================================================
// High-Performance Multi-Tier Thumbnail Storage & Lazy Loader
// Tier 1: Instant Server Disk HTTP Cache (/thumbnails/[sha1].jpg)
// Tier 2: Instant Client-Side IndexedDB Temporary/Offline Storage
// Tier 3: Viewport Intersection Lazy Decoder (2 max decoders in flight)
// ==========================================================================
const IDB_NAME = "TachyonStream_Storage_v1";
const IDB_STORE_THUMBNAILS = "thumbnails";
let idbPromise = null;

function getThumbnailDB() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE_THUMBNAILS)) {
            db.createObjectStore(IDB_STORE_THUMBNAILS, { keyPath: "key" });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return idbPromise;
}

async function getStoredThumbnail(key) {
  if (!key) return null;
  try {
    const db = await getThumbnailDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE_THUMBNAILS, "readonly");
      const store = tx.objectStore(IDB_STORE_THUMBNAILS);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putStoredThumbnail(key, dataUrl, duration) {
  if (!key || !dataUrl) return;
  try {
    const db = await getThumbnailDB();
    if (!db) return;
    const tx = db.transaction(IDB_STORE_THUMBNAILS, "readwrite");
    const store = tx.objectStore(IDB_STORE_THUMBNAILS);
    store.put({
      key,
      dataUrl,
      duration: duration || null,
      savedAt: Date.now()
    });
  } catch {}
}

const thumbnailCache = new Map();
const thumbnailQueue = [];
let activeThumbnailJobs = 0;
const MAX_CONCURRENT_THUMBNAIL_JOBS = 2; // Strict limit: max 2 decoders in flight

const lazyCardObserver = (typeof IntersectionObserver !== "undefined")
  ? new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const card = entry.target;
          observer.unobserve(card);
          const task = card._lazyThumbnailTask;
          if (task) {
            enqueueThumbnailGeneration(task);
          }
        }
      });
    }, {
      root: null,
      rootMargin: "250px 0px",
      threshold: 0.01
    })
  : null;

function enqueueThumbnailGeneration(item) {
  const cacheKey = item.isFolder && item.folderKey ? item.folderKey : (item.videoPath || item.videoUrl);
  if (thumbnailCache.has(cacheKey) || thumbnailCache.has(item.videoUrl)) {
    const cached = thumbnailCache.get(cacheKey) || thumbnailCache.get(item.videoUrl);
    applyThumbnailToContainer(item.containerEl, cached.dataUrl, item.durationEl, item.badgeEl, cached.duration, item.isFolder);
    return;
  }
  thumbnailQueue.push(item);
  processThumbnailQueue();
}

function processThumbnailQueue() {
  if (activeThumbnailJobs >= MAX_CONCURRENT_THUMBNAIL_JOBS || thumbnailQueue.length === 0) {
    return;
  }

  const job = thumbnailQueue.shift();
  if (!job.containerEl || !document.body.contains(job.containerEl)) {
    processThumbnailQueue();
    return;
  }

  activeThumbnailJobs++;

  const tempVideo = document.createElement("video");
  tempVideo.muted = true;
  tempVideo.playsInline = true;
  tempVideo.preload = "auto";
  tempVideo.crossOrigin = "anonymous";

  let isCleanedUp = false;
  let seekAttempts = 0;
  const timeoutId = setTimeout(() => {
    cleanupJob();
  }, 45000); // Allow metadata and scene seeking over slower tunnels.

  function cleanupJob() {
    if (isCleanedUp) return;
    isCleanedUp = true;
    clearTimeout(timeoutId);
    try {
      tempVideo.pause();
      tempVideo.removeAttribute("src");
      tempVideo.load();
    } catch {}
    tempVideo.remove();
    activeThumbnailJobs--;
    setTimeout(processThumbnailQueue, 40);
  }

  tempVideo.addEventListener("loadedmetadata", () => {
    const dur = tempVideo.duration || 0;
    // Calculate first real movie scene time (avoid black screens / intro logos):
    // For movies > 10 mins (600s), target between 20s and 45s or 1.5% of movie
    let targetTime = 20;
    if (dur > 600) {
      targetTime = Math.min(45, Math.max(20, Math.floor(dur * 0.015)));
    } else if (dur > 60) {
      targetTime = Math.min(15, Math.max(5, Math.floor(dur * 0.05)));
    } else if (dur > 0) {
      targetTime = Math.max(1, Math.min(dur * 0.5, 5));
    }
    if (job.defaultTime && dur > job.defaultTime) {
      targetTime = job.defaultTime;
    }
    tempVideo.currentTime = Math.max(0, Math.min(targetTime, dur > 0 ? dur * 0.5 : 0));
  });

  tempVideo.addEventListener("seeked", () => {
    if (isCleanedUp) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(tempVideo, 0, 0, 320, 180);

      // Smart First Scene / Black Frame Detection
      // Check if the frame is completely black (e.g. Warner/Universal logo or black intro screen)
      const imgData = ctx.getImageData(0, 0, 320, 180).data;
      let totalBrightness = 0;
      const step = 32;
      let samples = 0;
      for (let i = 0; i < imgData.length; i += step * 4) {
        totalBrightness += (imgData[i] + imgData[i + 1] + imgData[i + 2]) / 3;
        samples++;
      }
      const avgBrightness = totalBrightness / samples;

      const dur = tempVideo.duration || 0;
      // If frame is almost pitch black (avgBrightness < 12) and we have time left, seek forward +15s to get first real scene!
      if (avgBrightness < 12 && seekAttempts < 2 && tempVideo.currentTime + 15 < dur) {
        seekAttempts++;
        tempVideo.currentTime = Math.min(dur - 2, tempVideo.currentTime + 15);
        return; // Wait for next seeked event with real scene
      }

      const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
      const duration = tempVideo.duration || 0;

      const cacheKey = job.isFolder && job.folderKey ? job.folderKey : (job.videoPath || job.videoUrl);
      thumbnailCache.set(cacheKey, { dataUrl, duration });
      thumbnailCache.set(job.videoUrl, { dataUrl, duration });

      // Save to client temporary/persistent IndexedDB storage
      putStoredThumbnail(cacheKey, dataUrl, duration);
      if (job.videoPath && job.videoPath !== cacheKey) {
        putStoredThumbnail(job.videoPath, dataUrl, duration);
      }

      // Persist to server disk storage for production & subsequent requests
      if (job.videoPath) {
        apiFetch("/api/save-thumbnail", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoPath: job.videoPath, dataUrl, duration })
        }).catch(() => {});
      }

      applyThumbnailToContainer(job.containerEl, dataUrl, job.durationEl, job.badgeEl, duration, job.isFolder);
    } catch (err) {
      console.warn("Snapshot capture failed, fallback:", err);
    }
    cleanupJob();
  });

  tempVideo.addEventListener("error", () => {
    cleanupJob();
  });

  // Load clean URL so currentTime change in loadedmetadata always triggers a genuine seeked event!
  const liveUrl = getSecuredVideoUrl(job.videoUrl);
  tempVideo.src = liveUrl;
}

function applyThumbnailToContainer(containerEl, dataUrl, durationEl, badgeEl, duration, isFolder = false) {
  if (!containerEl) return;

  if (duration && !isNaN(duration)) {
    const timeFormatted = formatTime(duration);
    if (durationEl) durationEl.textContent = timeFormatted;
    if (badgeEl) badgeEl.textContent = timeFormatted;
  }

  if (dataUrl) {
    const imgClass = isFolder ? "folder-poster-img" : "card-preview-img";
    let img = containerEl.querySelector(`.${imgClass}`);
    if (!img) {
      img = document.createElement("img");
      img.className = imgClass;
      img.alt = "Thumbnail";
      containerEl.appendChild(img);
    }
    img.onload = () => {
      img.classList.add("loaded");
      const placeholder = containerEl.querySelector(isFolder ? ".folder-poster-placeholder" : ".card-thumb-placeholder");
      if (placeholder) placeholder.style.opacity = "0";
    };
    img.onerror = () => {
      img.classList.remove("loaded");
      const placeholder = containerEl.querySelector(isFolder ? ".folder-poster-placeholder" : ".card-thumb-placeholder");
      if (placeholder) placeholder.style.opacity = "1";
    };
    img.src = dataUrl;
    if (img.complete && img.naturalWidth > 0) img.onload();
  }
}

// Active single hover preview manager
let activeHoverPreviewEl = null;
let hoverPreviewTimer = null;

function attachHoverPreview(containerEl, videoUrl, startTime = 15) {
  clearTimeout(hoverPreviewTimer);
  removeActiveHoverPreview();

  hoverPreviewTimer = setTimeout(() => {
    if (!containerEl || !document.body.contains(containerEl)) return;
    const hoverVideo = document.createElement("video");
    hoverVideo.className = "card-preview-hover-media";
    hoverVideo.muted = true;
    hoverVideo.playsInline = true;
    hoverVideo.loop = true;
    hoverVideo.autoplay = true;
    hoverVideo.src = `${getSecuredVideoUrl(videoUrl)}#t=${startTime}`;
    containerEl.appendChild(hoverVideo);
    activeHoverPreviewEl = hoverVideo;
    hoverVideo.play().catch(() => {});
  }, 200);
}

function removeActiveHoverPreview() {
  clearTimeout(hoverPreviewTimer);
  if (activeHoverPreviewEl) {
    try {
      activeHoverPreviewEl.pause();
      activeHoverPreviewEl.removeAttribute("src");
      activeHoverPreviewEl.load();
    } catch {}
    activeHoverPreviewEl.remove();
    activeHoverPreviewEl = null;
  }
}

// Create an Apple TV / Netflix Folder Poster Card with Real Video Preview
function createFolderPosterCard(folder) {
  const card = document.createElement("div");
  card.className = "folder-poster-card";
  card.title = `Open ${folder.name}`;

  const firstVideo = getFirstVideoInFolder(folder);
  const vidCount = folder.videos ? folder.videos.length : 0;
  const subCount = folder.subfolders ? folder.subfolders.length : 0;
  const totalCount = folder.totalVideos !== undefined ? folder.totalVideos : (vidCount + subCount);
  const countLabel = totalCount === 1 ? "1 item" : `${totalCount} items`;

  card.innerHTML = `
    <div class="folder-poster-placeholder">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
    </div>
    <div class="folder-poster-gradient"></div>
    <div class="folder-card-top-badge">${countLabel}</div>
    <button class="card-more-btn" title="Folder options" aria-label="More options" aria-expanded="false">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
    </button>
    <div class="folder-card-content">
      <span class="folder-card-tag">${subCount > 0 ? "Series" : "Folder"}</span>
      <h3 class="folder-card-title">${escapeHtml(folder.name)}</h3>
      <span class="folder-card-meta">${vidCount > 0 ? `${vidCount} episodes` : (subCount > 0 ? `${subCount} subfolders` : "Empty folder")}</span>
    </div>
  `;

  if (firstVideo) {
    const fullUrl = getSecuredVideoUrl(firstVideo.url);
    const folderStorageKey = `folder_${folder.path}`;
    const initialThumb = folder.thumbnailUrl || firstVideo.thumbnailUrl;

    // Tier 1: Check Server Disk Thumbnail from library or first video
    if (initialThumb) {
      applyThumbnailToContainer(card, initialThumb, null, null, null, true);
    } else if (thumbnailCache.has(folderStorageKey)) {
      const cached = thumbnailCache.get(folderStorageKey);
      applyThumbnailToContainer(card, cached.dataUrl, null, null, null, true);
    } else {
      // Tier 2: Check Client IndexedDB Temporary/Offline Storage
      getStoredThumbnail(folderStorageKey).then((stored) => {
        if (stored && stored.dataUrl) {
          thumbnailCache.set(folderStorageKey, { dataUrl: stored.dataUrl, duration: null });
          applyThumbnailToContainer(card, stored.dataUrl, null, null, null, true);
        } else {
          // Tier 3: Observe for viewport lazy generation
          card._lazyThumbnailTask = {
            videoUrl: fullUrl,
            videoPath: firstVideo.path,
            containerEl: card,
            durationEl: null,
            badgeEl: null,
            defaultTime: 20,
            isFolder: true,
            folderKey: folderStorageKey
          };

          if (lazyCardObserver) {
            lazyCardObserver.observe(card);
          } else {
            enqueueThumbnailGeneration(card._lazyThumbnailTask);
          }
        }
      });
    }

    // Single hover preview
    card.addEventListener("mouseenter", () => {
      attachHoverPreview(card, fullUrl, 15);
    });
    card.addEventListener("mouseleave", () => {
      removeActiveHoverPreview();
    });
  }

  // Click enters folder
  card.addEventListener("click", () => {
    navigateToFolder(folder.path);
  });

  const moreBtn = card.querySelector(".card-more-btn");
  if (moreBtn) {
    moreBtn.addEventListener("mouseenter", removeActiveHoverPreview);
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFolderContextMenu(e, folder);
    });
  }

  return card;
}

// Create a Minimal Video Card with Real Video Frame & Hover Preview
function createVideoCard(video, folderPath) {
  const isCurrentlyPlaying = customVideo.src && (
    customVideo.src.includes(encodeURIComponent(video.name)) ||
    decodeURIComponent(customVideo.src).includes(video.name)
  );

  const card = document.createElement("div");
  card.className = "video-card" + (isCurrentlyPlaying ? " playing" : "");
  card.title = video.name;

  const cleanTitle = formatMediaTitle(video.name);
  const ext = (video.name.split(".").pop() || "MP4").toUpperCase();

  card.innerHTML = `
    <div class="video-card-thumb-wrap">
      <div class="card-thumb-placeholder">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="3" ry="3"></rect><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"></path></svg>
      </div>
      <div class="video-card-play-overlay">
        <div class="play-circle-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>
        </div>
      </div>
      <span class="video-card-badge">${ext}</span>
      ${isCurrentlyPlaying ? `
        <div class="video-card-playing-badge">
          <span class="equalizer-wave">
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
          </span>
          PLAYING
        </div>
      ` : ""}
    </div>
    <div class="video-card-info">
      <button class="card-more-btn" title="Options" aria-label="More options" aria-expanded="false">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>

      <h4 class="video-card-title">${escapeHtml(cleanTitle)}</h4>
      <div class="video-card-meta">
        <span class="meta-tag">${ext}</span>
        <span class="meta-dot">•</span>
        <span class="meta-duration">Video</span>
      </div>
    </div>
  `;

  const thumbWrap = card.querySelector(".video-card-thumb-wrap");
  const durationEl = card.querySelector(".meta-duration");
  const badgeEl = card.querySelector(".video-card-badge");
  const fullVideoUrl = getSecuredVideoUrl(video.url);
  const videoStorageKey = video.path || video.url;

  // Tier 1: Check Server Disk Thumbnail from library
  if (video.thumbnailUrl) {
    thumbnailCache.set(videoStorageKey, { dataUrl: video.thumbnailUrl, duration: video.duration });
    applyThumbnailToContainer(thumbWrap, video.thumbnailUrl, durationEl, badgeEl, video.duration, false);
  } else if (thumbnailCache.has(videoStorageKey)) {
    const cached = thumbnailCache.get(videoStorageKey);
    applyThumbnailToContainer(thumbWrap, cached.dataUrl, durationEl, badgeEl, cached.duration, false);
  } else {
    // Tier 2: Check Client-Side IndexedDB Temporary Storage
    getStoredThumbnail(videoStorageKey).then((stored) => {
      if (stored && stored.dataUrl) {
        thumbnailCache.set(videoStorageKey, { dataUrl: stored.dataUrl, duration: stored.duration });
        applyThumbnailToContainer(thumbWrap, stored.dataUrl, durationEl, badgeEl, stored.duration, false);
        // Sync to server disk if missing
        if (!video.thumbnailUrl) {
          apiFetch("/api/save-thumbnail", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoPath: video.path, dataUrl: stored.dataUrl, duration: stored.duration })
          }).catch(() => {});
        }
      } else {
        // Tier 3: Observe for viewport lazy generation
        card._lazyThumbnailTask = {
          videoUrl: fullVideoUrl,
          videoPath: video.path,
          containerEl: thumbWrap,
          durationEl,
          badgeEl,
          defaultTime: 20,
          isFolder: false
        };

        if (lazyCardObserver) {
          lazyCardObserver.observe(card);
        } else {
          enqueueThumbnailGeneration(card._lazyThumbnailTask);
        }
      }
    });
  }

  // Hover video preview (Single active video decoder on hover only)
  thumbWrap.addEventListener("mouseenter", () => {
    attachHoverPreview(thumbWrap, fullVideoUrl, 15);
  });

  thumbWrap.addEventListener("mouseleave", () => {
    removeActiveHoverPreview();
  });

  // Click starts playback
  card.addEventListener("click", () => {
    playVideo(video.url, folderPath, card);
  });

  const moreBtn = card.querySelector(".card-more-btn");
  if (moreBtn) {
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openVideoContextMenu(e, video);
    });
  }

  return card;
}

// Render Minimal Breadcrumb Trail
function renderBreadcrumbs() {
  const container = document.getElementById("breadcrumb-container");
  if (!container) return;
  container.innerHTML = "";

  const rootCrumb = document.createElement("button");
  rootCrumb.className = "crumb-btn" + (!currentFolderView ? " active" : "");
  rootCrumb.textContent = "Library";
  rootCrumb.onclick = () => {
    currentFolderView = null;
    renderCatalogue();
  };
  container.appendChild(rootCrumb);

  if (currentFolderView) {
    const parts = currentFolderView.split("/").filter(Boolean);
    let accumPath = "";

    parts.forEach((part, index) => {
      accumPath += (accumPath ? "/" : "") + part;
      const isLast = index === parts.length - 1;

      const sep = document.createElement("span");
      sep.className = "crumb-separator";
      sep.textContent = "/";
      container.appendChild(sep);

      const crumb = document.createElement("button");
      crumb.className = "crumb-btn" + (isLast ? " active" : "");
      crumb.textContent = part;
      const targetPath = accumPath;

      if (!isLast) {
        crumb.onclick = () => {
          currentFolderView = targetPath;
          renderCatalogue();
        };
      }
      container.appendChild(crumb);
    });
  }
}

// Update Folder Bar Action Buttons based on current view
function renderFolderBarActions() {
  const btnBack = document.getElementById("btn-folder-back");
  const btnPlayAll = document.getElementById("btn-folder-playall");
  const btnAutoNext = document.getElementById("btn-folder-autonext-toggle");
  const btnNewSubfolder = document.getElementById("btn-new-subfolder");
  const btnDeleteFolder = document.getElementById("btn-delete-current-folder");

  if (currentFolderView) {
    if (btnBack) btnBack.style.display = "inline-flex";
    if (btnPlayAll) btnPlayAll.style.display = "inline-flex";
    if (btnAutoNext) btnAutoNext.style.display = "inline-flex";
    if (btnNewSubfolder) btnNewSubfolder.style.display = "inline-flex";
    if (btnDeleteFolder) btnDeleteFolder.style.display = "inline-flex";
  } else {
    if (btnBack) btnBack.style.display = "none";
    if (btnPlayAll) btnPlayAll.style.display = "none";
    if (btnAutoNext) btnAutoNext.style.display = "none";
    if (btnNewSubfolder) btnNewSubfolder.style.display = "none";
    if (btnDeleteFolder) btnDeleteFolder.style.display = "none";
  }
}

// Play folder from start with auto-next enabled
function playFolderFromStart(folder) {
  if (!folder || !folder.videos || folder.videos.length === 0) {
    alert("This folder has no videos to play.");
    return;
  }
  const firstVideo = folder.videos[0];
  autoNextEnabled = true;
  currentPlayingFolder = folder.path;
  socket.emit("set-auto-next", { enabled: true, folder: folder.path });

  playVideo(firstVideo.url, folder.path);
  updateAutoNextButtonsUI();
}

// Folder Action Buttons
document.getElementById("btn-folder-back").addEventListener("click", navigateUpFolder);

document.getElementById("btn-folder-playall").addEventListener("click", () => {
  if (!currentFolderView) return;
  const folder = findFolderByPath(currentLibraryData.folders || [], currentFolderView);
  if (folder) playFolderFromStart(folder);
});

document.getElementById("btn-new-folder").addEventListener("click", async () => {
  const name = await showPromptModal({
    title: "New Series / Folder",
    message: "Enter name for new top-level folder:",
    placeholder: "e.g. Anime, Movies, Marvel, Season 1",
    confirmText: "Create Folder"
  });
  if (!name) return;

  try {
    const res = await apiFetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() })
    });
    const data = await res.json();
    if (data.success) {
      loadLibrary();
      navigateToFolder(data.folder);
    } else {
      alert(data.error || "Failed to create folder");
    }
  } catch (err) {
    alert("Error creating folder: " + err.message);
  }
});

document.getElementById("btn-new-subfolder").addEventListener("click", async () => {
  if (!currentFolderView) return;
  const folder = findFolderByPath(currentLibraryData.folders || [], currentFolderView);
  if (folder) {
    await createSubfolderPrompt(folder.path, folder.name);
  }
});

document.getElementById("btn-delete-current-folder").addEventListener("click", async () => {
  if (!currentFolderView) return;
  const folder = findFolderByPath(currentLibraryData.folders || [], currentFolderView);
  if (folder) {
    await deleteFolderPrompt(folder.path, folder.name);
  }
});

document.getElementById("btn-refresh-library").addEventListener("click", () => {
  loadLibrary();
});

// Create Subfolder Prompt
async function createSubfolderPrompt(parentPath, parentName) {
  const subName = await showPromptModal({
    title: "New Subfolder",
    message: `Create a subfolder inside "${parentName}":`,
    placeholder: "e.g. Season 2, OVA, Extras",
    confirmText: "Create Subfolder"
  });
  if (!subName) return;

  try {
    const res = await apiFetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: subName.trim(), parent: parentPath })
    });
    const data = await res.json();
    if (data.success) {
      loadLibrary();
      navigateToFolder(data.folder);
    } else {
      alert(data.error || "Failed to create subfolder");
    }
  } catch (err) {
    alert("Error creating subfolder: " + err.message);
  }
}

// Delete Folder Prompt
async function deleteFolderPrompt(folderPath, folderName) {
  const confirmed = await showConfirmModal({
    title: "Delete Folder",
    message: `Are you sure you want to delete folder "${folderName}" and all contents? This cannot be undone.`,
    confirmText: "Delete Folder",
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await apiFetch(`/api/folders/${encodeURIComponent(folderPath)}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      navigateUpFolder();
      loadLibrary();
    } else {
      alert(data.error || "Failed to delete folder");
    }
  } catch (err) {
    alert("Error deleting folder: " + err.message);
  }
}

// Delete Video Prompt
async function deleteVideoPrompt(video) {
  const confirmed = await showConfirmModal({
    title: "Delete Video",
    message: `Are you sure you want to delete "${video.name}"?`,
    confirmText: "Delete Video",
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await apiFetch(`/api/videos/${encodeURIComponent(video.path)}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      loadLibrary();
      showToast(`Deleted ${formatMediaTitle(video.name)}`);
    } else {
      alert(data.error || "Failed to delete video");
    }
  } catch (err) {
    alert("Error deleting video: " + err.message);
  }
}

// Move Video Prompt
async function moveVideoPrompt(video) {
  const allList = currentLibraryData.allFoldersList || [];
  const options = [
    { value: "", label: "Root (No Folder / Standalone Movie)" }
  ];
  allList.forEach(f => {
    const indent = "  ".repeat(f.depth) + (f.depth > 0 ? "↳ " : "");
    const subHint = f.depth > 0 ? ` [Subfolder of ${f.path.split("/").slice(0, -1).join("/")}]` : "";
    options.push({
      value: f.path,
      label: `${indent}${f.name}${subHint}`
    });
  });

  const targetFolder = await showSelectModal({
    title: "Move Video",
    message: `Select destination folder for "${video.name}":`,
    options: options,
    defaultValue: video.folder || "",
    confirmText: "Move Video"
  });

  if (targetFolder === null) return;

  try {
    const res = await apiFetch("/api/move-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoPath: video.path,
        targetFolder: targetFolder
      })
    });
    const data = await res.json();
    if (data.success) {
      loadLibrary();
      showToast(`Moved to ${targetFolder ? targetFolder.split("/").filter(Boolean).pop() : "Root"}`);
    } else {
      alert(data.error || "Failed to move video");
    }
  } catch (err) {
    alert("Error moving video: " + err.message);
  }
}

// Search Bar Input Listener
const searchInput = document.getElementById("library-search");
const searchClearBtn = document.getElementById("search-clear-btn");

if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    if (searchClearBtn) searchClearBtn.style.display = searchQuery ? "block" : "none";
    renderCatalogue();
  });
}

if (searchClearBtn) {
  searchClearBtn.addEventListener("click", () => {
    searchQuery = "";
    if (searchInput) searchInput.value = "";
    searchClearBtn.style.display = "none";
    renderCatalogue();
  });
}

// ==========================================================================
// Quick Episodes Drawer (Browse inside Cinema mode)
const cinemaEpisodesDrawer = document.getElementById("cinema-episodes-drawer");
const btnCinemaEpisodesToggle = document.getElementById("btn-cinema-episodes-toggle");
const btnCloseEpisodesDrawer = document.getElementById("btn-close-episodes-drawer");

if (btnCinemaEpisodesToggle) {
  btnCinemaEpisodesToggle.addEventListener("click", () => {
    if (cinemaEpisodesDrawer) {
      cinemaEpisodesDrawer.classList.toggle("open");
      renderEpisodesDrawer();
    }
  });
}

if (btnCloseEpisodesDrawer) {
  btnCloseEpisodesDrawer.addEventListener("click", () => {
    if (cinemaEpisodesDrawer) cinemaEpisodesDrawer.classList.remove("open");
  });
}

function renderEpisodesDrawer() {
  const listEl = document.getElementById("drawer-episodes-list");
  const titleEl = document.getElementById("drawer-folder-title");
  if (!listEl) return;

  const targetFolderPath = currentPlayingFolder || currentFolderView;
  const folder = findFolderByPath(currentLibraryData.folders || [], targetFolderPath);

  if (!folder || !folder.videos || folder.videos.length === 0) {
    if (titleEl) titleEl.textContent = "Episodes";
    listEl.innerHTML = `<span style="color:var(--text-muted);font-size:0.8rem;padding:8px;">No episodes in this playlist.</span>`;
    return;
  }

  if (titleEl) titleEl.textContent = folder.name;
  listEl.innerHTML = "";

  folder.videos.forEach((v, index) => {
    const isPlayingThis = customVideo.src && (
      customVideo.src.includes(encodeURIComponent(v.name)) ||
      decodeURIComponent(customVideo.src).includes(v.name)
    );

    const item = document.createElement("div");
    item.className = "drawer-ep-item" + (isPlayingThis ? " active" : "");
    item.innerHTML = `
      <span class="drawer-ep-num">E${index + 1}</span>
      <span class="drawer-ep-title">${escapeHtml(formatMediaTitle(v.name))}</span>
      ${isPlayingThis ? `
        <span class="equalizer-wave">
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
        </span>
      ` : ""}
    `;

    item.addEventListener("click", () => {
      playVideo(v.url, folder.path);
      if (cinemaEpisodesDrawer) cinemaEpisodesDrawer.classList.remove("open");
    });

    listEl.appendChild(item);
  });
}

// Auto Next: automatically advance to the next video in folder
function playNextInFolder(folderPath, forceNext = false) {
  if (isTransitioningNext && !forceNext) return;
  const folder = findFolderByPath(currentLibraryData.folders || [], folderPath);
  if (!folder || !folder.videos || folder.videos.length === 0) return;

  const currentPlayingFile = pathBasename(customVideo.src);
  let currentIndex = folder.videos.findIndex(v => {
    return (
      decodeURIComponent(currentPlayingFile) === v.name ||
      encodeURIComponent(v.name) === currentPlayingFile ||
      currentPlayingFile.includes(v.name)
    );
  });

  const nextIndex = currentIndex + 1;
  if (nextIndex < folder.videos.length) {
    const nextVideo = folder.videos[nextIndex];
    isTransitioningNext = true;
    updateStatus(`Next episode: ${formatMediaTitle(nextVideo.name)}...`);

    setTimeout(() => {
      playVideo(nextVideo.url, folderPath);
      isTransitioningNext = false;
    }, forceNext ? 200 : 1200);
  } else {
    updateStatus(`Playlist completed for "${folder.name}"`);
  }
}

// ==========================================================================
// Library Data Fetching & Helpers
async function loadLibrary() {
  try {
    const res = await apiFetch("/api/library");
    const data = await res.json();
    currentLibraryData = data || { folders: [], rootVideos: [], allFoldersList: [] };
    updateFolderSelectDropdown();
    renderCatalogue();
    updateHeroBillboard();
    renderEpisodesDrawer();
  } catch (e) {
    console.error("Failed to load library:", e);
  }
}

function findFolderByPath(folders, targetPath) {
  if (!folders || !targetPath) return null;
  for (const f of folders) {
    if (f.path === targetPath) return f;
    if (f.subfolders && f.subfolders.length > 0) {
      const found = findFolderByPath(f.subfolders, targetPath);
      if (found) return found;
    }
  }
  return null;
}

// ==========================================================================
// Treeselectjs Hierarchical Folder & Subfolder Select Integration
let folderTreeselectInstance = null;
let currentSelectedUploadFolder = ""; // Dedicated state for selected upload folder
let isQuickNewFolderInitialized = false;

function buildTreeselectFolderOptions(folders) {
  function mapFolderNode(f) {
    const hasChildren = Boolean(f.subfolders && f.subfolders.length > 0);
    return {
      name: `${f.name}` + (typeof f.totalVideos === "number" ? ` (${f.totalVideos} vids)` : ""),
      value: f.path,
      children: hasChildren ? f.subfolders.map(mapFolderNode) : undefined
    };
  }

  const rootOption = {
    name: "Root (No Folder / Standalone Movie)",
    value: "__root__"
  };

  const folderNodes = (folders || []).map(mapFolderNode);
  return [rootOption, ...folderNodes];
}

function updateFolderSelectDropdown() {
  const select = document.getElementById("upload-folder-select");
  if (select) {
    select.innerHTML = `<option value="">Root (No Folder / Standalone Movie)</option>`;
    if (currentLibraryData && currentLibraryData.allFoldersList) {
      currentLibraryData.allFoldersList.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.path;
        const indent = "  ".repeat(f.depth) + (f.depth > 0 ? "↳ " : "");
        opt.textContent = `${indent}${f.name}`;
        if (f.path === currentSelectedUploadFolder) opt.selected = true;
        select.appendChild(opt);
      });
    }

    if (currentSelectedUploadFolder) {
      let opt = Array.from(select.options).find(o => o.value === currentSelectedUploadFolder);
      if (!opt) {
        opt = document.createElement("option");
        opt.value = currentSelectedUploadFolder;
        opt.textContent = currentSelectedUploadFolder;
        opt.selected = true;
        select.appendChild(opt);
      } else {
        opt.selected = true;
      }
    }
  }

  // Initialize or re-mount Treeselectjs
  const container = document.getElementById("treeselect-folder-container");
  if (!container || typeof Treeselect === "undefined") return;

  const folders = (currentLibraryData && currentLibraryData.folders) ? currentLibraryData.folders : [];
  const options = buildTreeselectFolderOptions(folders);

  if (folderTreeselectInstance) {
    try {
      folderTreeselectInstance.destroy();
    } catch (e) {
      console.warn("Treeselect cleanup:", e);
    }
    folderTreeselectInstance = null;
  }

  container.innerHTML = "";

  const initialTreeselectVal = currentSelectedUploadFolder || "__root__";

  folderTreeselectInstance = new Treeselect({
    parentHtmlContainer: container,
    value: initialTreeselectVal,
    options: options,
    isSingleSelect: true,
    showTags: false,
    clearable: false,
    searchable: true,
    placeholder: "Search or select folder / subfolder...",
    openLevel: 1,
    expandSelected: true,
    disabledBranchNode: false,
    isIndependentNodes: true,
    direction: "auto",
    appendToBody: true,
    listClassName: "upload-folder-list",
    ariaLabel: "Target Series / Folder"
  });

  folderTreeselectInstance.srcElement.addEventListener("input", (e) => {
    const rawVal = e.detail;
    let selectedVal = Array.isArray(rawVal) ? (rawVal[0] || "") : (rawVal || "");
    if (selectedVal === "__root__") selectedVal = "";
    currentSelectedUploadFolder = selectedVal;

    const selectEl = document.getElementById("upload-folder-select");
    if (selectEl) {
      let opt = Array.from(selectEl.options).find(o => o.value === selectedVal);
      if (!opt && selectedVal) {
        opt = document.createElement("option");
        opt.value = selectedVal;
        opt.textContent = selectedVal;
        selectEl.appendChild(opt);
      }
      selectEl.value = selectedVal;
      selectEl.dispatchEvent(new Event("change"));
    }
  });

  initQuickNewFolderButton();
}

function initQuickNewFolderButton() {
  if (isQuickNewFolderInitialized) return;
  const quickNewFolderBtn = document.getElementById("btn-upload-quick-folder");
  if (!quickNewFolderBtn) return;
  isQuickNewFolderInitialized = true;

  quickNewFolderBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const currentSelected = currentSelectedUploadFolder || "";
    let message = "Enter name for new top-level folder:";
    if (currentSelected) {
      message = `Enter folder name (will be created inside "${currentSelected}" as a subfolder):`;
    }

    const name = await showPromptModal({
      title: currentSelected ? "New Subfolder" : "New Folder",
      message: message,
      placeholder: "e.g. Season 1, Extra, Special Episodes",
      confirmText: "Create Folder"
    });

    if (!name || !name.trim()) return;

    try {
      const payload = {
        name: name.trim(),
        parent: currentSelected || ""
      };

      const res = await apiFetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success && data.folder) {
        showToast(`Created folder: ${data.folder}`);
        await loadLibrary();
        currentSelectedUploadFolder = data.folder;
        updateFolderSelectDropdown();
      } else {
        showAlertModal({
          title: "Folder Error",
          message: data.error || "Failed to create folder"
        });
      }
    } catch (err) {
      showToast("Error creating folder: " + err.message);
    }
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Format Media Title nicely
function formatMediaTitle(filename) {
  if (!filename) return "Untitled Video";
  // Remove file extension
  let clean = filename.replace(/\.(mp4|webm|mkv|mov|ogg|ogv|avi|flv|wmv|m4v)$/i, "");
  // Remove generated random hash suffix (e.g. _dn6zd, _wukpb, _8o1ut)
  clean = clean.replace(/_(?:[a-z0-9]{5}|[a-f0-9]{16})$/i, "");
  // Replace underscores with spaces
  clean = clean.replace(/_/g, " ").trim();
  return clean || filename;
}

// Dynamic gradient generator for aesthetic Apple TV poster cards
function getDynamicFolderGradient(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const palettes = [
    "linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)",
    "linear-gradient(135deg, #833ab4 0%, #fd1d1d 50%, #fcb045 100%)",
    "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)",
    "linear-gradient(135deg, #4b1248 0%, #f0c27b 100%)",
    "linear-gradient(135deg, #11998e 0%, #38ef7d 100%)",
    "linear-gradient(135deg, #e52d27 0%, #b31217 100%)",
    "linear-gradient(135deg, #654ea3 0%, #eaafc8 100%)"
  ];
  const index = Math.abs(hash) % palettes.length;
  return palettes[index];
}

function pathBasename(urlOrPath) {
  if (!urlOrPath) return "";
  try {
    const parsed = new URL(urlOrPath, "http://localhost");
    return parsed.pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return urlOrPath.split("/").filter(Boolean).pop() || "";
  }
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ==========================================================================
// Chunked Upload System
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB per chunk
const uploadBtn = document.getElementById("upload-btn");
const fileInput = document.getElementById("file-input");
const uploadDropzone = document.getElementById("upload-dropzone");
const progressContainer = document.getElementById("progress-container");
const progressBarFill = document.getElementById("progress-bar-fill");
const uploadStatus = document.getElementById("upload-status");
const uploadPercent = document.getElementById("upload-percent");
const uploadChunks = document.getElementById("upload-chunks");
const uploadSize = document.getElementById("upload-size");
const uploadSpeed = document.getElementById("upload-speed");

// Video / Movie file formats allowed for streaming
// Note: .ts is intentionally excluded to distinguish between TypeScript source code and MPEG-TS (which HTML5 browsers cannot play natively).
const ALLOWED_VIDEO_EXTENSIONS = [
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".wmv", ".m4v", ".ogv"
];

async function checkSingleFile(file) {
  if (!file || !file.name) return { valid: false, message: "Invalid file" };
  const ext = "." + file.name.split(".").pop().toLowerCase();

  // Distinguish .ts (TypeScript vs MPEG-TS Movie)
  if (ext === ".ts") {
    try {
      const slice = await file.slice(0, 512).arrayBuffer();
      const bytes = new Uint8Array(slice);
      const isMpegTs = bytes.length > 0 && bytes[0] === 0x47 && (bytes.length < 188 || bytes[188] === 0x47);
      if (isMpegTs) {
        return {
          valid: false,
          title: "MPEG-TS Video (.ts) Rejected",
          message: `"${file.name}" is an MPEG Transport Stream video (.ts).\n\nHTML5 web browsers cannot play raw .ts files directly without an HLS transcoder. Please convert your video to MP4, MKV, or WebM.`
        };
      }
    } catch (_) {}

    return {
      valid: false,
      title: "TypeScript File (.ts) Rejected",
      message: `"${file.name}" is recognized as a TypeScript source code file (.ts).\n\nTachyonStream only accepts movie/video files. Source code cannot be uploaded.`
    };
  }

  const isVideoExt = ALLOWED_VIDEO_EXTENSIONS.includes(ext);
  const isVideoMime = file.type && file.type.startsWith("video/");
  if (!isVideoExt && !isVideoMime) {
    return {
      valid: false,
      title: "Invalid File Format",
      message: `"${file.name}" is NOT a recognized movie/video file.\n\nOnly movie formats (MP4, MKV, WebM, MOV, AVI) are supported.`
    };
  }

  // Quick check for disguised text file (e.g. script.ts renamed to movie.mp4)
  try {
    const slice = await file.slice(0, 256).arrayBuffer();
    const bytes = new Uint8Array(slice);
    if (bytes.length >= 16) {
      let asciiCount = 0;
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) asciiCount++;
      }
      if (asciiCount / bytes.length > 0.90) {
        return {
          valid: false,
          title: "Text/Code File Rejected",
          message: `"${file.name}" appears to be plain text or source code disguised as a movie file.`
        };
      }
    }
  } catch (_) {}

  return { valid: true };
}

async function processFilesForUpload(fileList) {
  if (!fileList || fileList.length === 0) return false;
  const files = Array.from(fileList);

  for (const f of files) {
    const check = await checkSingleFile(f);
    if (!check.valid) {
      fileInput.value = "";
      showAlertModal({
        title: check.title || "Upload Rejected",
        message: check.message
      });
      showToast("Rejected: Not a valid movie file!");
      const mainText = uploadDropzone.querySelector(".dropzone-main-text");
      if (mainText) mainText.textContent = "Drag & drop movie files here, or browse";
      return false;
    }
  }

  const file = files[0];
  const mainText = uploadDropzone.querySelector(".dropzone-main-text");
  if (mainText) mainText.textContent = `Selected Movie: ${file.name}`;
  return true;
}

if (uploadDropzone) {
  uploadDropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadDropzone.classList.add("dragover");
  });

  uploadDropzone.addEventListener("dragleave", () => {
    uploadDropzone.classList.remove("dragover");
  });

  uploadDropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const ok = await processFilesForUpload(e.dataTransfer.files);
      if (!ok) return;
      fileInput.files = e.dataTransfer.files;
    }
  });

  fileInput.addEventListener("change", async () => {
    if (fileInput.files && fileInput.files.length > 0) {
      const ok = await processFilesForUpload(fileInput.files);
      if (!ok) return;
    }
  });
}

if (uploadBtn) {
  uploadBtn.addEventListener("click", async () => {
    const file = fileInput.files ? fileInput.files[0] : null;
    if (!file) {
      showAlertModal({
        title: "No Movie Selected",
        message: "Please choose or drop a movie file first!"
      });
      return;
    }

    const check = await checkSingleFile(file);
    if (!check.valid) {
      fileInput.value = "";
      const mainText = uploadDropzone.querySelector(".dropzone-main-text");
      if (mainText) mainText.textContent = "Drag & drop movie files here, or browse";
      showAlertModal({
        title: check.title || "Upload Rejected",
        message: check.message
      });
      showToast("Rejected: Not a valid movie file!");
      return;
    }

    const uploadId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const targetFolder = currentSelectedUploadFolder || "";

    progressContainer.style.display = "flex";
    uploadBtn.disabled = true;
    uploadStatus.textContent = "Starting chunked upload...";
    uploadPercent.textContent = "0%";
    progressBarFill.style.width = "0%";

    const startTime = Date.now();
    let uploadedBytes = 0;

    try {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const chunkBlob = file.slice(start, end);

        let success = false;
        let retries = 3;

        while (!success && retries > 0) {
          try {
            const chunkRes = await apiFetch(`/api/upload-chunk?uploadId=${uploadId}&chunkIndex=${i}&fileName=${encodeURIComponent(file.name)}`, {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: chunkBlob
            });
            if (chunkRes.ok) {
              success = true;
            } else {
              let errMessage = "Chunk failed with status " + chunkRes.status;
              try {
                const errJson = await chunkRes.json();
                if (errJson && errJson.error) errMessage = errJson.error;
              } catch (_) {}
              throw new Error(errMessage);
            }
          } catch (e) {
            retries--;
            if (retries === 0) throw e;
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        uploadedBytes += (end - start);
        const pct = Math.round((uploadedBytes / file.size) * 100);
        progressBarFill.style.width = pct + "%";
        uploadPercent.textContent = pct + "%";
        uploadChunks.textContent = `Chunk: ${i + 1}/${totalChunks}`;
        uploadSize.textContent = `${(uploadedBytes / 1024 / 1024).toFixed(1)} MB / ${(file.size / 1024 / 1024).toFixed(1)} MB`;

        const elapsedSec = (Date.now() - startTime) / 1000;
        if (elapsedSec > 0) {
          const speedMBs = (uploadedBytes / 1024 / 1024 / elapsedSec).toFixed(1);
          uploadSpeed.textContent = `${speedMBs} MB/s`;
        }
      }

      uploadStatus.textContent = "Assembling video chunks on server...";
      const completeRes = await apiFetch("/api/complete-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId,
          fileName: file.name,
          totalChunks,
          folder: targetFolder
        })
      });

      const result = await completeRes.json();
      if (result.url) {
        uploadStatus.textContent = "Upload complete! Streaming now...";
        uploadPercent.textContent = "100%";
        playVideo(result.url, result.folder || null);
        loadLibrary();
        switchView("cinema");

        setTimeout(() => {
          progressContainer.style.display = "none";
          progressBarFill.style.width = "0%";
          fileInput.value = "";
          const mainText = uploadDropzone.querySelector(".dropzone-main-text");
          if (mainText) mainText.textContent = "Drag & drop video files here, or browse";
        }, 3000);
      } else {
        throw new Error(result.error || "Assembly failed");
      }
    } catch (err) {
      uploadStatus.textContent = "Upload failed!";
      uploadSpeed.textContent = err.message;
      showAlertModal({
        title: "Upload Rejected",
        message: err.message || "Upload failed. TachyonStream only accepts valid movie files."
      });
      showToast("Upload Rejected");
      setTimeout(() => {
        progressContainer.style.display = "none";
      }, 5000);
    } finally {
      uploadBtn.disabled = false;
    }
  });
}

// ==========================================================================
// In-App Modal Dialog Helpers
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const modalMessage = document.getElementById("modal-message");
const modalInputContainer = document.getElementById("modal-input-container");
const modalBtnConfirm = document.getElementById("modal-btn-confirm");
const modalBtnCancel = document.getElementById("modal-btn-cancel");
const modalCloseBtn = document.getElementById("modal-close-btn");

let activeModalResolve = null;

function closeModal(result = null) {
  if (modalBackdrop) modalBackdrop.style.display = "none";
  if (modalBtnCancel) modalBtnCancel.style.display = "inline-flex";
  if (activeModalResolve) {
    const resolve = activeModalResolve;
    activeModalResolve = null;
    resolve(result);
  }
}

function showAlertModal({ title = "Notice", message, confirmText = "OK" }) {
  return new Promise((resolve) => {
    activeModalResolve = resolve;
    if (modalTitle) modalTitle.textContent = title;
    if (modalMessage) modalMessage.textContent = message;
    if (modalBtnConfirm) {
      modalBtnConfirm.textContent = confirmText;
      modalBtnConfirm.className = "modal-btn modal-btn-primary";
    }
    if (modalBtnCancel) modalBtnCancel.style.display = "none";
    if (modalInputContainer) modalInputContainer.innerHTML = "";

    if (modalBtnConfirm) {
      modalBtnConfirm.onclick = () => {
        closeModal(true);
      };
    }

    if (modalBackdrop) modalBackdrop.style.display = "flex";
    setTimeout(() => { if (modalBtnConfirm) modalBtnConfirm.focus(); }, 50);
  });
}

if (modalCloseBtn) modalCloseBtn.onclick = () => closeModal(null);
if (modalBtnCancel) modalBtnCancel.onclick = () => closeModal(null);
if (modalBackdrop) {
  modalBackdrop.onclick = (e) => {
    if (e.target === modalBackdrop) closeModal(null);
  };
}

function showPromptModal({ title, message, defaultValue = "", placeholder = "", confirmText = "Confirm" }) {
  return new Promise((resolve) => {
    activeModalResolve = resolve;
    if (modalTitle) modalTitle.textContent = title || "Prompt";
    if (modalMessage) modalMessage.textContent = message || "";
    if (modalBtnConfirm) {
      modalBtnConfirm.textContent = confirmText;
      modalBtnConfirm.className = "modal-btn modal-btn-primary";
    }

    if (modalInputContainer) {
      modalInputContainer.innerHTML = `
        <input type="text" id="modal-text-input" class="modal-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}" />
      `;
    }
    const input = document.getElementById("modal-text-input");

    if (modalBtnConfirm) {
      modalBtnConfirm.onclick = () => {
        const val = input ? input.value.trim() : "";
        closeModal(val);
      };
    }

    if (input) {
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (modalBtnConfirm) modalBtnConfirm.click();
        } else if (e.key === "Escape") {
          closeModal(null);
        }
      };
    }

    if (modalBackdrop) modalBackdrop.style.display = "flex";
    setTimeout(() => { if (input) { input.focus(); input.select(); } }, 50);
  });
}

function showSelectModal({ title, message, options = [], defaultValue = "", confirmText = "Confirm" }) {
  return new Promise((resolve) => {
    activeModalResolve = resolve;
    if (modalTitle) modalTitle.textContent = title || "Select";
    if (modalMessage) modalMessage.textContent = message || "";
    if (modalBtnConfirm) {
      modalBtnConfirm.textContent = confirmText;
      modalBtnConfirm.className = "modal-btn modal-btn-primary";
    }

    let selectHtml = `<select id="modal-select-input" class="modal-select">`;
    options.forEach(opt => {
      const selected = opt.value === defaultValue ? " selected" : "";
      selectHtml += `<option value="${escapeHtml(opt.value)}"${selected}>${escapeHtml(opt.label)}</option>`;
    });
    selectHtml += `</select>`;
    if (modalInputContainer) modalInputContainer.innerHTML = selectHtml;

    const select = document.getElementById("modal-select-input");

    if (modalBtnConfirm) {
      modalBtnConfirm.onclick = () => {
        const val = select ? select.value : "";
        closeModal(val);
      };
    }

    if (modalBackdrop) modalBackdrop.style.display = "flex";
    setTimeout(() => { if (select) select.focus(); }, 50);
  });
}

function showConfirmModal({ title, message, confirmText = "Delete", isDanger = true }) {
  return new Promise((resolve) => {
    activeModalResolve = resolve;
    if (modalTitle) modalTitle.textContent = title || "Confirm";
    if (modalMessage) modalMessage.textContent = message || "Are you sure?";
    if (modalBtnConfirm) {
      modalBtnConfirm.textContent = confirmText;
      modalBtnConfirm.className = `modal-btn ${isDanger ? "modal-btn-danger" : "modal-btn-primary"}`;
    }
    if (modalInputContainer) modalInputContainer.innerHTML = "";

    if (modalBtnConfirm) {
      modalBtnConfirm.onclick = () => {
        closeModal(true);
      };
    }

    if (modalBackdrop) modalBackdrop.style.display = "flex";
    setTimeout(() => { if (modalBtnConfirm) modalBtnConfirm.focus(); }, 50);
  });
}

// Initial initialization
switchView("browse");
loadLibrary();
updateSoundUI();
