// Web Push (VAPID + RFC 8291 aes128gcm) для Cloudflare Workers.
// VAPID-ключи генерируются один раз и лежат в D1 (push_state), подписки —
// push_subscriptions. Без внешних пакетов: весь crypto через crypto.subtle.

import type { Env } from './types';

const RUNTIME = crypto.subtle;
const PROFILE_MAIL = 'mailto:poverenokgovnenok94@gmail.com';
const REC = 4096; // размер рекорда aes128gcm (пейлод ужмём в один)
const NUL = new Uint8Array(1); // 0x00

const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unB64u = (s: string): Uint8Array => {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- VAPID-ключи: сгенерировать один раз, дальше из D1 ----------

interface VapidJwk { crv: string; kty: string; x: string; y: string; d: string }
interface VapidKeys { jwk: VapidJwk; publicKey: string }

let vapidMemo: VapidKeys | null = null;

async function loadVapid(env: Env): Promise<VapidKeys> {
  if (vapidMemo) return vapidMemo;
  const row = await env.DB.prepare(
    `SELECT value FROM push_state WHERE k = 'vapid' LIMIT 1`,
  ).first<{ value: string }>().catch(() => null);
  let jwk: VapidJwk;
  if (row?.value) {
    jwk = JSON.parse(row.value) as VapidJwk;
  } else {
    const pair = (await RUNTIME.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const priv = await RUNTIME.exportKey('jwk', pair.privateKey) as VapidJwk;
    jwk = { crv: 'P-256', kty: 'EC', x: priv.x, y: priv.y, d: priv.d };
    await env.DB.prepare(`INSERT INTO push_state (k, value) VALUES ('vapid', ?)`)
      .bind(JSON.stringify(jwk)).run().catch(() => null);
  }
  // Публичный raw 0x04||x||y — applicationServerKey для браузера.
  const pub = await RUNTIME.importKey(
    'jwk',
    { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const raw = b64u(new Uint8Array(await RUNTIME.exportKey('raw', pub) as ArrayBuffer));
  vapidMemo = { jwk, publicKey: raw };
  return vapidMemo;
}

export async function pushPublicKey(env: Env): Promise<string> {
  return (await loadVapid(env)).publicKey;
}

async function vapidJwt(env: Env, audience: string): Promise<string> {
  const k = await loadVapid(env);
  const priv = await RUNTIME.importKey(
    'jwk',
    { crv: 'P-256', kty: 'EC', x: k.jwk.x, y: k.jwk.y, d: k.jwk.d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const enc = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const header = enc({ typ: 'JWT', alg: 'ES256' });
  const claims = enc({
    aud: audience,
    sub: PROFILE_MAIL,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
  });
  const sig = new Uint8Array(
    await RUNTIME.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, new TextEncoder().encode(`${header}.${claims}`)),
  );
  return `${header}.${claims}.${b64u(sig)}`;
}

// ---------- HKDF-помощники ----------

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const base = await RUNTIME.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await RUNTIME.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    base,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

// ---------- RFC 8291: шифрование payload (aes128gcm, один рекорд) ----------

async function encryptPayload(p256dhB64u: string, authB64u: string, plaintext: Uint8Array): Promise<Uint8Array | null> {
  const userPub: Uint8Array = (() => {
    try { return unB64u(p256dhB64u); } catch { return new Uint8Array(0); }
  })();
  if (userPub.length !== 65) return null;
  let auth: Uint8Array;
  try { auth = unB64u(authB64u); } catch { return null; }

  // Эфемерный серверный ECDH-ключ.
  const eph = (await RUNTIME.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asEphPub = new Uint8Array(await RUNTIME.exportKey('raw', eph.publicKey) as ArrayBuffer);

  // ECDH(ephPriv, userPub).
  const userPubKey = await RUNTIME.importKey(
    'raw', userPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await RUNTIME.deriveBits({ name: 'ECDH', public: userPubKey }, eph.privateKey, 256));

  // IKM = HKDF(salt=auth, ikm=shared, info="WebPush: info"+NUL+userPub+asEphPub)  [RFC 8291 §3.3]
  const infoIkm = concat(new TextEncoder().encode('WebPush: info'), NUL, userPub, asEphPub);
  const ikm = await hkdf(shared, auth, infoIkm, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, concat(new TextEncoder().encode('Content-Encoding: aes128gcm'), NUL), 16);
  const nonce = await hkdf(ikm, salt, concat(new TextEncoder().encode('Content-Encoding: nonce'), NUL), 12);

  // Один рекорд: data + 0x02-разделитель + паддинг до (REC-16) байт открытого текста.
  const openMax = REC - 16;
  if (plaintext.length > openMax - 1) return null;
  const plain = new Uint8Array(openMax);
  plain.set(plaintext, 0);
  plain[plaintext.length] = 0x02;

  const aesKey = await RUNTIME.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // seq = 0 → iv = nonce (XOR 0).
  const ct = new Uint8Array(await RUNTIME.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));

  // Заголовок: salt(16) | rs(4 BE) | idlen(1) | keyid=asEphPub(65).
  const header = new Uint8Array(16 + 4 + 1 + asEphPub.length);
  header.set(salt, 0);
  header[16] = (REC >> 24) & 0xff;
  header[17] = (REC >> 16) & 0xff;
  header[18] = (REC >> 8) & 0xff;
  header[19] = REC & 0xff;
  header[20] = asEphPub.length;
  header.set(asEphPub, 21);

  return concat(header, ct);
}

// ---------- Отправка ----------

const siteOf = (url: string): string => {
  try { return new URL(url).origin; } catch { return ''; }
};

export async function sendPush(
  env: Env,
  userId: number,
  payload: Record<string, unknown> | null,
): Promise<void> {
  const subs = await env.DB.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
  ).bind(userId).all<{ endpoint: string; p256dh: string; auth: string }>().catch(() => null);
  if (!subs?.results?.length) return;

  const data = payload ? new TextEncoder().encode(JSON.stringify(payload)) : null;
  const isCall = payload?.type === 'call';

  for (const s of subs.results.slice(0, 30)) {
    const audience = siteOf(s.endpoint);
    if (!audience) continue;
    const headers: Record<string, string> = {
      TTL: isCall ? '60' : '3600',
      Urgency: isCall ? 'high' : 'normal',
      Authorization: `vapid t=${await vapidJwt(env, audience)}, k=${(await loadVapid(env)).publicKey}`,
    };
    let body: BufferSource | null = null;
    if (data) {
      const enc = await encryptPayload(s.p256dh, s.auth, data).catch(() => null);
      if (enc) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Content-Encoding'] = 'aes128gcm';
        body = enc;
      } // не смогли зашифровать — шлём без payload (generic notif), подпись не теряем
    }
    let res: Response | null = null;
    for (const attempt of [0, 1]) {
      if (attempt) await wait(2000);
      try { res = await fetch(s.endpoint, { method: 'POST', headers, body }); break; } catch { res = null; }
    }
    if (!res) continue;
    if (res.status === 201) continue;
    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(s.endpoint).run().catch(() => null);
      continue;
    }
    // Прочие коды (400/426/429/5xx) — молча: не роняем основной поток.
  }
}
