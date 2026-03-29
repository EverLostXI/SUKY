const DB_NAME = 'suky-local-library';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const ROOT_HANDLE_KEY = 'musicRoot';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败'));
  });
}

function runStore(mode, executor) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);

    let settled = false;
    const finishResolve = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    tx.oncomplete = () => {
      db.close();
      if (!settled) finishResolve(undefined);
    };
    tx.onerror = () => {
      db.close();
      finishReject(tx.error || new Error('IndexedDB 事务失败'));
    };
    tx.onabort = () => {
      db.close();
      finishReject(tx.error || new Error('IndexedDB 事务已中止'));
    };

    Promise.resolve()
      .then(() => executor(store, finishResolve, finishReject))
      .catch(error => {
        try {
          tx.abort();
        } catch (_) {
          // Ignore secondary abort failures.
        }
        finishReject(error);
      });
  }));
}

export function saveRootHandle(handle) {
  return runStore('readwrite', store => {
    store.put(handle, ROOT_HANDLE_KEY);
  });
}

export function loadRootHandle() {
  return runStore('readonly', (store, finishResolve, finishReject) => {
    const request = store.get(ROOT_HANDLE_KEY);
    request.onsuccess = () => finishResolve(request.result || null);
    request.onerror = () => finishReject(request.error || new Error('读取目录句柄失败'));
  });
}

export function clearRootHandle() {
  return runStore('readwrite', store => {
    store.delete(ROOT_HANDLE_KEY);
  });
}
