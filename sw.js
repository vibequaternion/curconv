// Service worker: приложение открывается и без интернета.
// Курсы сюда не попадают — их кэширует само приложение в localStorage.

const CACHE = 'valuty-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/core.js',
  './js/flags.js',
  './js/sources.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './fonts/golos-text-latin-400-normal.woff2',
  './fonts/golos-text-cyrillic-400-normal.woff2',
  './fonts/golos-text-latin-500-normal.woff2',
  './fonts/golos-text-cyrillic-500-normal.woff2',
  './fonts/golos-text-latin-600-normal.woff2',
  './fonts/golos-text-cyrillic-600-normal.woff2',
  './fonts/source-serif-4-latin-opsz-normal.woff2',
  './fonts/source-serif-4-cyrillic-opsz-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Запросы к API курсов идут напрямую в сеть; свои файлы (включая флаги) —
  // сразу из кэша, а кэш параллельно обновляется из сети.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached ?? Response.error());
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return network;
    })());
  }
});
