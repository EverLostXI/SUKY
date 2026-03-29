const SERVICE_WORKER_URL = '/sw.js';
const CONTROLLER_WAIT_MS = 10000;

let registrationPromise = null;
let listenersBound = false;
let latestPayload = null;

export async function ensureVirtualDataServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('当前浏览器不支持 Service Worker。');
  }

  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: '/',
      type: 'module'
    });
  }

  const registration = await registrationPromise;
  bindBridgeListeners();
  await navigator.serviceWorker.ready;
  await waitForController(registration);
  return registration;
}

export async function syncVirtualLibrary(handle, metadata) {
  latestPayload = {
    type: 'root-handle',
    handle,
    metadata
  };

  const registration = await ensureVirtualDataServiceWorker();
  await postPayload(registration, latestPayload);
}

export async function clearVirtualLibrarySync() {
  latestPayload = null;

  if (!('serviceWorker' in navigator)) return;

  const registration = registrationPromise
    ? await registrationPromise.catch(() => null)
    : await navigator.serviceWorker.ready.catch(() => null);

  const target = navigator.serviceWorker.controller || registration?.active;
  target?.postMessage({ type: 'clear-root-handle' });
}

function bindBridgeListeners() {
  if (listenersBound) return;
  listenersBound = true;

  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'need-root-handle' && latestPayload) {
      void syncVirtualLibrary(latestPayload.handle, latestPayload.metadata);
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!latestPayload) return;
    void navigator.serviceWorker.ready
      .then(registration => postPayload(registration, latestPayload))
      .catch(error => {
        console.warn('Service Worker controller 更新后重新同步失败。', error);
      });
  });
}

async function postPayload(registration, payload) {
  const controller = await waitForController(registration);
  controller.postMessage(payload);

  if (registration.active && registration.active !== controller) {
    registration.active.postMessage(payload);
  }
}

async function waitForController(registration) {
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.controller;
  }

  if (registration.active) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('等待 Service Worker 控制页面超时。'));
      }, CONTROLLER_WAIT_MS);

      const onControllerChange = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      };

      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    }).catch(error => {
      if (!navigator.serviceWorker.controller) throw error;
    });
  }

  if (!navigator.serviceWorker.controller) {
    throw new Error('Service Worker 尚未接管页面，无法提供虚拟数据路径。');
  }

  return navigator.serviceWorker.controller;
}
