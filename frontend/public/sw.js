/* VAKSA service worker: кэш оболочки приложения, API и WS всегда из сети. */
const CACHE = 'vaksa-pwa-v1';
const CORE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  // Не кэшируем живые данные
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) return;
  if (url.pathname.startsWith('/ws')) return;

  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            const cacheable =
              response.ok &&
              response.type === 'basic' &&
              (url.pathname.startsWith('/static/') ||
                url.pathname.startsWith('/stickers/') ||
                url.pathname.startsWith('/icons/') ||
                url.pathname === '/' ||
                url.pathname === '/index.html' ||
                url.pathname === '/manifest.json');
            if (cacheable) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
