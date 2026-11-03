// Настройки подключения к серверу VAKSA (GOR).
// В браузере по умолчанию используется тот же origin (пустая строка).
// В desktop-приложении (Tauri) адрес сервера задаётся пользователем и
// сохраняется в localStorage.
import { getToken } from './auth';

const STORAGE_KEY = 'gor_server_url';

// Запасные входы: тот же Worker на нескольких хостах. Если основной домен
// не открывается у провайдера — пользователь открывает зеркало, данные те же.
export const MIRRORS = [
  'https://vaksa.space',
  'https://m.vaksa.space',
  'https://app.vaksa.space',
  'https://chat.vaksa.space',
  'https://www.vaksa.space',
];

// Короткая подпись зеркала для кнопок: vaksa.space / m.vaksa.space …
export function mirrorLabel(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return String(url || '');
  }
}

// Текущий origin страницы (в Tauri его нет — там адрес задаётся вручную).
export function currentOrigin() {
  if (typeof window === 'undefined') return '';
  const { protocol, origin } = window.location;
  return protocol === 'http:' || protocol === 'https:' ? origin : '';
}

// Список зеркал с текущим origin первым (если он http/https).
export function mirrorList() {
  const origin = currentOrigin();
  const out = origin ? [origin] : [];
  for (const m of MIRRORS) {
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

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
// Для приватных /uploads/* добавляем одноразовый по времени токен в query:
// теги <img>/<video>/<audio> не умеют слать Authorization.
export function resolveUrl(url) {
  if (!url) return url;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  const server = getServer();
  const full = server
    ? server + (url.startsWith('/') ? url : '/' + url)
    : url;
  if (full.includes('/uploads/')) {
    const token = getToken();
    if (token) {
      return `${full}${full.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
    }
  }
  return full;
}

// Токен к WS больше не идёт в URL (чтоб не попадал в логи прокси):
// клиент отправляет его первым кадром после открытия соединения.
export function serverWsUrl() {
  const server = getServer();
  if (server) {
    try {
      const parsed = new URL(server);
      const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${parsed.host}/ws`;
    } catch (e) {
      // некорректный адрес — падаем обратно на текущий origin
    }
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
