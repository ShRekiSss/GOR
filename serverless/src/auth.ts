// Авторизация: PBKDF2 (Web Crypto — обходится нам едва CPU), сессии в D1,
// лимитер попыток входа в Durable Object.

import type { Env, UserRow } from './types';

export interface User {
  id: number;
  username: string;
  avatar?: string;
  displayName?: string;
  bio?: string;
  statusText?: string;
  statusEmoji?: string;
  isAdmin?: number;
  banned?: number;
}

// PBKDF2-SHA256, 25 000 итераций — бесплатно по CPU и достаточно против оффлайн-брута.
const PBKDF2_ITER = 25_000;
const PBKDF2_LEN = 32;

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITER },
    key,
    PBKDF2_LEN * 8,
  );
  return new Uint8Array(bits);
}

function b64url(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return `pbkdf2$sha256$i=${PBKDF2_ITER}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  // Некорректный/чужой формат хэша — это просто «пароль не подошёл», а не 500.
  try {
    const parts = encoded.split('$');
    if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
    if (parts[1] !== 'sha256') return false;
    const iter = parseInt((parts[2].match(/i=(\d+)/) || [])[1] || '0', 10);
    if (!iter || iter < 1000 || iter > 5_000_000) return false;
    const salt = b64urlDecode(parts[3]);
    const expected = b64urlDecode(parts[4]);
    const actual = await pbkdf2(password, salt);
    if (actual.length !== expected.length) return false;
    // constant-time сравнение
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const raw = atob(pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const SESSION_TTL_SEC = 30 * 24 * 3600;

export async function createSession(env: Env, userID: number): Promise<string> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = b64url(raw);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userID, now + SESSION_TTL_SEC)
    .run();
  // Заодно чистим просроченные сессии (дешёвый оппортьюн principal — 1 раз на чанк вероятности).
  if (crypto.getRandomValues(new Uint32Array(1))[0] % 50 === 0) {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  }
  return token;
}

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// Token: прежде всего Bearer, далее cookie gor_session, затем ?t для медиа-тегов.
export function tokenFromRequest(req: Request): string {
  const auth = req.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)gor_session=([^;]+)/);
  if (m) return m[1];
  return '';
}

export async function userByToken(env: Env, token: string): Promise<User | null> {
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.avatar, u.is_admin, u.banned FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? LIMIT 1`,
  ).bind(token, now).first<UserRow & { avatar?: string; is_admin?: number; banned?: number }>();
  if (!row) return null;
  return {
    id: row.id, username: row.username, avatar: row.avatar || '',
    isAdmin: row.is_admin || 0, banned: row.banned || 0,
  };
}

// Полный профиль из users (для /api/me/profile и публичных страниц).
export async function profileOf(env: Env, id: number): Promise<User | null> {
  const row = await env.DB.prepare(
    'SELECT id, username, avatar, is_admin, banned, display_name, bio, status_text, status_emoji FROM users WHERE id = ? LIMIT 1',
  ).bind(id).first<any>();
  if (!row) return null;
  return {
    id: row.id, username: row.username, avatar: row.avatar || '',
    isAdmin: row.is_admin || 0, banned: row.banned || 0,
    displayName: row.display_name || '', bio: row.bio || '',
    statusText: row.status_text || '', statusEmoji: row.status_emoji || '',
  };
}

// ---------- Лимитер (/api/auth/*): 20 попыток / 5 минут на IP ----------

// Лимитер НЕ имеет права вешать вход навсегда: если DO завис/отвечает медленно —
// пропускаем (fail-open). Лучше короткая окно без лимита, чем вечная «крутилка».
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

export async function rateLimitAuth(env: Env, ip: string): Promise<boolean> {
  const id = env.LIMIT.idFromName(ip);
  const stub = env.LIMIT.get(id);
  const resp = await withTimeout(
    stub.fetch('https://limit/allow', {
      method: 'POST',
      body: JSON.stringify({ limit: 20, window: 300 }),
    }),
    5000,
  );
  // null = DO завис/упал → пропускаем, вход не блокируем.
  if (!resp) {
    console.warn('rate limiter недоступен — fail-open для', ip);
    return true;
  }
  return resp.status === 200;
}
