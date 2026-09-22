// Guarda a chave de dados (CryptoKey não exportável) no IndexedDB do aparelho,
// para o app abrir sem pedir a senha toda vez. Nem o próprio app consegue extrair os bytes dela.

const DB = 'pf-keys';
const STORE = 'keys';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const keystore = {
  get: (uid) => tx('readonly', (s) => s.get(uid)).catch(() => null),
  set: (uid, key) => tx('readwrite', (s) => s.put(key, uid)),
  remove: (uid) => tx('readwrite', (s) => s.delete(uid)).catch(() => {}),
  clear: () => tx('readwrite', (s) => s.clear()).catch(() => {}),
};
