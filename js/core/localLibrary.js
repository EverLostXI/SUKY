import { loadRootHandle, saveRootHandle, clearRootHandle } from './libraryStore.js';
import { quickScanLibrary, rebuildLibrary } from './libraryScanner.js';
import {
  clearVirtualLibrarySync,
  ensureVirtualDataServiceWorker,
  syncVirtualLibrary
} from './serviceWorkerBridge.js';

const READWRITE_MODE = { mode: 'readwrite' };

export function assertLocalLibrarySupport() {
  if (!window.isSecureContext) {
    throw new Error('当前页面不是安全上下文，Service Worker 和文件系统访问不可用。请通过 localhost 或 HTTPS 打开。');
  }

  if (!('showDirectoryPicker' in window)) {
    throw new Error('当前浏览器不支持 File System Access API。请使用较新的 Chromium 浏览器。');
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error('当前浏览器不支持 Service Worker。');
  }

  if (!('indexedDB' in window)) {
    throw new Error('当前浏览器不支持 IndexedDB。');
  }
}

export async function initVirtualDataWorker() {
  return ensureVirtualDataServiceWorker();
}

export async function loadStoredMusicRoot() {
  return loadRootHandle();
}

export async function chooseMusicRoot() {
  const handle = await window.showDirectoryPicker(READWRITE_MODE);
  await saveRootHandle(handle);
  return handle;
}

export async function queryMusicRootPermission(handle) {
  return handle.queryPermission(READWRITE_MODE);
}

export async function requestMusicRootPermission(handle) {
  return handle.requestPermission(READWRITE_MODE);
}

export async function scanMusicRoot(handle, { rebuild = false, onProgress } = {}) {
  const metadata = rebuild
    ? await rebuildLibrary(handle, { onProgress })
    : await quickScanLibrary(handle, { onProgress });

  await syncVirtualLibrary(handle, metadata);
  return metadata;
}

export async function forgetMusicRoot() {
  await clearRootHandle();
  await clearVirtualLibrarySync();
}
