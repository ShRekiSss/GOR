// Настройки подключения к серверу GOR.
// В браузере по умолчанию используется тот же origin (пустая строка).
// В desktop-приложении (Tauri) адрес сервера задаётся пользователем и
// сохраняется в localStorage.

const STORAGE_KEY = 'gor_server_url';

export function normalizeServer(raw) {
  let value = (raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) {
    value = 'http://' + value;
  }
  return value.replace(/\/+$/, '');
}

export function getServer() {
  try {
    return normalizeServer(localStorage.getItem(STORAGE_KEY) || '');
  } catch (e) {
    return '';
  }
}

export function setServer(url) {
  const value = normalizeServer(url);
  try {
    if (value) {
      localStorage.setItem(STORAGE_KEY, value);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch (e) {
    // localStorage может быть недоступен — тогда работаем как в браузере
  }
  return value;
}

// true, если страница открыта внутри Tauri (а не в обычном браузере)
export function isDesktop() {
  if (typeof window === 'undefined') return false;
  return (
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost' ||
    Boolean(window.__TAURI_INTERNALS__)
  );
}

// Абсолютный адрес API: в браузере — относительный, в desktop — с сервером.
export function apiUrl(path) {
  const server = getServer();
  return server ? server + path : path;
}

// Приводит ссылку из сообщения (/uploads/..., /stickers/...) к серверу.
export function resolveUrl(url) {
  if (!url) return url;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  const server = getServer();
  return server ? server + (url.startsWith('/') ? url : '/' + url) : url;
}

export function serverWsUrl(token) {
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const server = getServer();
  if (server) {
    try {
      const parsed = new URL(server);
      const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${parsed.host}/ws${query}`;
    } catch (e) {
      // некорректный адрес — падаем обратно на текущий origin
    }
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws${query}`;
}
