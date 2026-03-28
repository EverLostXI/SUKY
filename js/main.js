/**
 * main.js — 初始化入口
 */
import state from './core/state.js';
import { loadAlbumsList } from './core/dataLoader.js';
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

async function init() {
  // 1. 加载专辑列表
  try {
    const albums = await loadAlbumsList();
    state.set('albums', albums);
  } catch (e) {
    console.warn('albums.json 加载失败，显示空状态。', e);
    state.set('albums', []);
  }

  // 2. 渲染 Cover Flow
  renderCoverFlow();

  // 等启动文字动画自己结束后再清理类名，避免在动画尾帧中途被强行打断。
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

    // Fallback for cases where the animation event does not fire.
    setTimeout(finishStartup, 2400);
  } else {
    setTimeout(finishStartup, 1600);
  }

  // 3. 初始化所有交互
  initCoverFlowControls();
  initProgressBar();
  initCdDrag();
  initPlaybackControls();
  initHoverZones();
  initSettings();
  initSearch();

  // 4. 音频引擎时间更新 → 进度条
  audioEngine.onPlaybackStateChange = (isPlaying) => {
    state.set('isPlaying', isPlaying);
    updatePlayPauseBtn();
  };

  let _lastSaveTime = 0;
  audioEngine.onTimeUpdate = (albumTime, trackIndex) => {
    state.set('currentAlbumTime', albumTime);
    state.set('currentTrackIndex', trackIndex);
    if (!isCdDragging()) {
      updateProgressBar(albumTime);
    }
    // 每 3 秒存一次进度
    const now = Date.now();
    if (now - _lastSaveTime > 3000) {
      _lastSaveTime = now;
      const albumId = state.currentAlbum?.id;
      if (albumId) {
        localStorage.setItem(`playersky_progress_${albumId}`, albumTime);
      }
    }
  };

  let trackInfoTimeout;
  audioEngine.onTrackChange = (trackIndex) => {
    state.set('currentTrackIndex', trackIndex);
    
    // 立即刷新进度条文字（防止第一帧闪烁旧名字）
    // 使用 audioEngine 的实时时间而非 state 缓存，避免 seek 后进度条跳回旧位置
    const currentTime = audioEngine.currentAlbumTime || state.currentAlbumTime || 0;
    updateProgressBar(currentTime);
    
    // 强制显示3秒歌曲信息
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

  // 5. 音量初始化
  audioEngine.setVolume(state.volume);

  console.log('PlayerForSky initialized.');
}

init().catch(console.error);
