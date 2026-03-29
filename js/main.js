/**
 * main.js — 初始化入口
 */
import state from './core/state.js';
import { loadAlbumsList } from './core/dataLoader.js';
import {
  assertLocalLibrarySupport,
  chooseMusicRoot,
  forgetMusicRoot,
  initVirtualDataWorker,
  loadStoredMusicRoot,
  queryMusicRootPermission,
  requestMusicRootPermission,
  scanMusicRoot
} from './core/localLibrary.js';
import { audioEngine } from './core/audioEngine.js';
import {
  renderCoverFlow,
  initCoverFlowControls,
  initProgressBar,
  initCdDrag,
  initPlaybackControls,
  initHoverZones,
  initSettings,
  initSearch,
  updateProgressBar,
  updatePlayPauseBtn,
  isCdDragging
} from './ui/components.js';
import { createStartupOverlay } from './ui/startupOverlay.js';

const startupOverlay = createStartupOverlay();
let currentRootHandle = null;
let rebuildInFlight = false;
const TITLEBAR_BUTTON_SIZE = 50;
const TITLEBAR_EDGE_PADDING = 12;
const TITLEBAR_TOP_PADDING = 8;
const TITLEBAR_DRAG_REGION_ID = 'window-drag-region';

async function init() {
  initWindowControlsOverlay();
  bindLibrarySettingsActions();

  await prepareLocalLibrary();

  const albums = await loadAlbumsList();
  state.set('albums', albums);

  startupOverlay.hide();

  renderCoverFlow();

  const startupInfo = document.querySelector('.is-startup-info');
  let startupCleanupDone = false;
  const finishStartup = () => {
    if (startupCleanupDone) return;
    startupCleanupDone = true;
    document.body.classList.remove('is-startup');
    startupInfo?.classList.remove('is-startup-info');
  };

  if (startupInfo) {
    startupInfo.addEventListener('animationend', e => {
      if (e.animationName === 'infoEmergence') {
        finishStartup();
      }
    }, { once: true });

    setTimeout(finishStartup, 2400);
  } else {
    setTimeout(finishStartup, 1600);
  }

  initCoverFlowControls();
  initProgressBar();
  initCdDrag();
  initPlaybackControls();
  initHoverZones();
  initSettings();
  initSearch();

  audioEngine.onPlaybackStateChange = isPlaying => {
    state.set('isPlaying', isPlaying);
    updatePlayPauseBtn();
  };

  let lastSaveTime = 0;
  audioEngine.onTimeUpdate = (albumTime, trackIndex) => {
    state.set('currentAlbumTime', albumTime);
    state.set('currentTrackIndex', trackIndex);
    if (!isCdDragging()) {
      updateProgressBar(albumTime);
    }

    const now = Date.now();
    if (now - lastSaveTime > 3000) {
      lastSaveTime = now;
      const albumId = state.currentAlbum?.id;
      if (albumId) {
        localStorage.setItem(`playersky_progress_${albumId}`, albumTime);
      }
    }
  };

  let trackInfoTimeout;
  audioEngine.onTrackChange = trackIndex => {
    state.set('currentTrackIndex', trackIndex);

    const currentTime = audioEngine.currentAlbumTime || state.currentAlbumTime || 0;
    updateProgressBar(currentTime);

    const trackInfo = document.querySelector('.track-info');
    if (trackInfo) {
      trackInfo.classList.add('force-show');
      clearTimeout(trackInfoTimeout);
      trackInfoTimeout = setTimeout(() => {
        trackInfo.classList.remove('force-show');
      }, 3000);
    }
  };

  audioEngine.onEnded = () => {
    state.set('isPlaying', false);
    updatePlayPauseBtn();
  };

  audioEngine.setVolume(state.volume);

  console.log('Suky initialized.');
}

function initWindowControlsOverlay() {
  const topBar = document.getElementById('global-top-bar');
  if (!topBar || typeof window === 'undefined') {
    return;
  }

  const overlay = navigator.windowControlsOverlay;
  const overlayDisplayMode = typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: window-controls-overlay)')
    : null;
  const dragRegion = ensureWindowDragRegion();

  const syncWindowControlsOverlay = event => {
    const overlayVisible = Boolean(
      event?.visible ??
      overlay?.visible ??
      overlayDisplayMode?.matches
    );

    document.body.classList.toggle('window-controls-overlay-visible', overlayVisible);

    if (!overlayVisible || typeof overlay?.getTitlebarAreaRect !== 'function') {
      resetWindowControlsOverlayLayout(topBar, dragRegion);
      return;
    }

    const titlebarAreaRect = normalizeTitlebarAreaRect(
      event?.titlebarAreaRect ?? overlay.getTitlebarAreaRect()
    );

    applyWindowControlsOverlayLayout(topBar, dragRegion, titlebarAreaRect);
  };

  overlay?.addEventListener?.('geometrychange', syncWindowControlsOverlay);
  overlayDisplayMode?.addEventListener?.('change', syncWindowControlsOverlay);
  window.addEventListener('resize', syncWindowControlsOverlay);

  syncWindowControlsOverlay();
}

function applyWindowControlsOverlayLayout(topBar, dragRegion, titlebarAreaRect) {
  const left = Math.max(TITLEBAR_EDGE_PADDING, titlebarAreaRect.x + TITLEBAR_EDGE_PADDING);
  const top = Math.max(TITLEBAR_TOP_PADDING, titlebarAreaRect.y + TITLEBAR_TOP_PADDING);
  const dragHeight = Math.max(
    titlebarAreaRect.height,
    TITLEBAR_BUTTON_SIZE + TITLEBAR_TOP_PADDING
  );

  topBar.style.top = `${Math.round(top)}px`;
  topBar.style.left = `${Math.round(left)}px`;
  topBar.style.setProperty('-webkit-app-region', 'drag');
  topBar.style.setProperty('app-region', 'drag');

  for (const button of topBar.querySelectorAll('button')) {
    button.style.setProperty('-webkit-app-region', 'no-drag');
    button.style.setProperty('app-region', 'no-drag');
  }

  dragRegion.hidden = false;
  dragRegion.style.top = `${Math.round(Math.max(0, titlebarAreaRect.y))}px`;
  dragRegion.style.left = `${Math.round(Math.max(0, titlebarAreaRect.x))}px`;
  dragRegion.style.width = `${Math.round(Math.max(0, titlebarAreaRect.width))}px`;
  dragRegion.style.height = `${Math.round(dragHeight)}px`;
}

function resetWindowControlsOverlayLayout(topBar, dragRegion) {
  topBar.style.removeProperty('top');
  topBar.style.removeProperty('left');
  topBar.style.removeProperty('-webkit-app-region');
  topBar.style.removeProperty('app-region');

  for (const button of topBar.querySelectorAll('button')) {
    button.style.removeProperty('-webkit-app-region');
    button.style.removeProperty('app-region');
  }

  dragRegion.hidden = true;
  dragRegion.style.removeProperty('top');
  dragRegion.style.removeProperty('left');
  dragRegion.style.removeProperty('width');
  dragRegion.style.removeProperty('height');
}

function ensureWindowDragRegion() {
  let dragRegion = document.getElementById(TITLEBAR_DRAG_REGION_ID);
  if (dragRegion) {
    return dragRegion;
  }

  dragRegion = document.createElement('div');
  dragRegion.id = TITLEBAR_DRAG_REGION_ID;
  dragRegion.hidden = true;
  dragRegion.setAttribute('aria-hidden', 'true');
  dragRegion.style.position = 'fixed';
  dragRegion.style.zIndex = '59';
  dragRegion.style.background = 'transparent';
  dragRegion.style.setProperty('-webkit-app-region', 'drag');
  dragRegion.style.setProperty('app-region', 'drag');

  document.body.appendChild(dragRegion);
  return dragRegion;
}

function normalizeTitlebarAreaRect(rect = {}) {
  const x = Number.isFinite(rect.x) ? rect.x : 0;
  const y = Number.isFinite(rect.y) ? rect.y : 0;
  const width = Number.isFinite(rect.width) ? rect.width : window.innerWidth;
  const height = Number.isFinite(rect.height) ? rect.height : 0;

  return { x, y, width, height };
}

async function prepareLocalLibrary() {
  assertLocalLibrarySupport();

  startupOverlay.showScanning(0, 0, '正在注册虚拟数据 Service Worker。');
  await initVirtualDataWorker();

  currentRootHandle = await resolveMusicRootHandle();

  startupOverlay.showScanning(0, 0, '正在扫描音乐目录并写入 .suky 元数据。');
  await scanMusicRoot(currentRootHandle, {
    onProgress(done, total) {
      startupOverlay.showScanning(done, total, '正在扫描音乐目录并写入 .suky 元数据。');
    }
  });
}

async function resolveMusicRootHandle() {
  const storedHandle = await loadStoredMusicRoot();
  if (!storedHandle) {
    return promptForNewMusicRoot();
  }

  const permission = await queryMusicRootPermission(storedHandle);
  if (permission === 'granted') {
    return storedHandle;
  }

  if (permission === 'prompt') {
    return promptForStoredHandlePermission(storedHandle);
  }

  return promptForNewMusicRoot();
}

async function promptForNewMusicRoot() {
  return new Promise((resolve, reject) => {
    let busy = false;

    const pickDirectory = async () => {
      if (busy) return;
      busy = true;

      try {
        const handle = await chooseMusicRoot();
        resolve(handle);
      } catch (error) {
        if (error?.name === 'AbortError') {
          busy = false;
          startupOverlay.showWelcome(pickDirectory);
          return;
        }
        reject(error);
      }
    };

    startupOverlay.showWelcome(pickDirectory);
  });
}

async function promptForStoredHandlePermission(handle) {
  return new Promise((resolve, reject) => {
    let busy = false;

    const chooseAnother = async () => {
      if (busy) return;
      busy = true;

      try {
        const newHandle = await chooseMusicRoot();
        resolve(newHandle);
      } catch (error) {
        if (error?.name === 'AbortError') {
          busy = false;
          startupOverlay.showPermissionRequest(continueAccess, chooseAnother);
          return;
        }
        reject(error);
      }
    };

    const continueAccess = async () => {
      if (busy) return;
      busy = true;

      try {
        const permission = await requestMusicRootPermission(handle);
        if (permission === 'granted') {
          resolve(handle);
          return;
        }

        busy = false;
        startupOverlay.showPermissionRequest(continueAccess, chooseAnother);
      } catch (error) {
        reject(error);
      }
    };

    startupOverlay.showPermissionRequest(continueAccess, chooseAnother);
  });
}

function bindLibrarySettingsActions() {
  const rebuildBtn = document.getElementById('rebuild-library-btn');
  const changeRootBtn = document.getElementById('change-root-btn');

  rebuildBtn?.addEventListener('click', async () => {
    if (!currentRootHandle || rebuildInFlight) return;

    rebuildInFlight = true;
    startupOverlay.showScanning(0, 0, '正在整库重建媒体库并刷新封面缓存。');

    try {
      await scanMusicRoot(currentRootHandle, {
        rebuild: true,
        onProgress(done, total) {
          startupOverlay.showScanning(done, total, '正在整库重建媒体库并刷新封面缓存。');
        }
      });
      window.location.reload();
    } catch (error) {
      rebuildInFlight = false;
      startupOverlay.showError(error, {
        onRetry: () => window.location.reload(),
        onChooseDirectory: handleChangeRoot
      });
    }
  });

  changeRootBtn?.addEventListener('click', handleChangeRoot);
}

async function handleChangeRoot() {
  await forgetMusicRoot();
  window.location.reload();
}

init().catch(error => {
  console.error(error);
  startupOverlay.showError(error, {
    onRetry: () => window.location.reload(),
    onChooseDirectory: async () => {
      try {
        await forgetMusicRoot();
      } catch (_) {
        // Ignore cleanup failures while recovering from init errors.
      }
      window.location.reload();
    }
  });
});
