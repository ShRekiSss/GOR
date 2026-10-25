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

// ---------- Web Push (Milestone 2) ----------
self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (e) {
    data = null;
  }
  const title = (data && data.title) || 'VAKSA';
  const body = (data && data.body) || 'Новое событие в чате';
  const chatId = (data && data.chatId) || 0;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data && data.type === 'call' ? 'vaksa-call' : `vaksa-msg-${chatId}`,
      renotify: data && data.type === 'call',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { chatId, url: chatId ? `/?chat=${chatId}` : '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          try { client.postMessage({ type: 'open-chat', url: target }); } catch (e) { /* нет канала */ }
          return;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
