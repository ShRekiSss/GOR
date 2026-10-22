/* VAKSA service worker: кэш оболочки приложения, API и WS всегда из сети. */
const CACHE = 'vaksa-pwa-v2';
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

  // Shell (index.html) — network-first: после пересборки сервера клиент
  // получает новый бандл и хэши, без чистки «Данных сайта» на Android.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => {
            cache.put('/index.html', copy);
            cache.put('/', copy);
          });
          return response;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || caches.match('/'))
        )
    );
    return;
  }

  // Хэшированные ресурсы /static/, стикеры, иконки — cache-first (офлайн-оболочка),
  // с фоновым обновлением кэша свежим ответом.
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
                url.pathname.startsWith('/fonts/') ||
                url.pathname.startsWith('/icons/') ||
                url.pathname === '/manifest.json');
            if (cacheable) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);
        // Отдаём кэш мгновенно, сеть обновляет кэш в фоне.
        return cached || network;
      })
    )
  );
});
