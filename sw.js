// Service worker: deixa o app abrir sem internet. Estratégia "rede primeiro":
// online sempre pega a versão mais nova; offline usa a cópia em cache.
// Chamadas ao Supabase (outra origem) não passam por aqui.

const CACHE = 'pf-v5';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/recurrence.js',
  './js/format.js',
  './js/store.js',
  './js/series.js',
  './js/supa.js',
  './js/cloud.js',
  './js/crypto.js',
  './js/keystore.js',
  './js/emoji.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
