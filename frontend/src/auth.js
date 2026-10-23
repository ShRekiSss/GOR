// Токен сессии хранится отдельно для каждого сервера.
import { apiUrl, getServer } from './server';

const PREFIX = 'gor_token';

function storageKey() {
  const server = getServer();
  return server ? `${PREFIX}:${server}` : PREFIX;
}

export function getToken() {
  try {
    return localStorage.getItem(storageKey()) || '';
  } catch (e) {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(storageKey(), token);
    } else {
      localStorage.removeItem(storageKey());
    }
  } catch (e) {
    // localStorage недоступен — сессия проживёт только до перезагрузки
  }
}

export function clearToken() {
  setToken('');
}

export function authHeaders(extra) {
  const token = getToken();
  const headers = { ...(extra || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function authFetch(path, options) {
  const opts = { ...(options || {}) };
  opts.headers = authHeaders(opts.headers);
  // Никогда не крутим «вечно»: 20 секунд — и честная ошибка на экране.
  try {
    opts.signal = AbortSignal.timeout(20000);
  } catch (e) {
    // старый WebView без AbortSignal.timeout — живём по-старому, без таймаута
  }
  return fetch(apiUrl(path), opts);
}
