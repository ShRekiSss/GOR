// Точка входа Worker'а VAKSA: API на /api/* и /uploads/*, WS на /ws,
// всё остальное — статика PWA с CDN. Семантика 1:1 с main.go.

import type { Env } from './types';
import { api } from './api';
import { Hub } from './hub';
import { Limiter } from './limiter';

export { Hub, Limiter };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};

const VERSION_DEFAULT = '1.0.0-beta';

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const originHeader = req.headers.get('Origin');
  if (!originHeader) return {};
  let u: URL;
  try { u = new URL(originHeader); } catch { return {}; }
  const sameHost = u.host === new URL(req.url).host;
  const isTauri =
    (u.protocol === 'tauri:' && u.host === 'localhost') ||
    ((u.protocol === 'http:' || u.protocol === 'https:') && u.host === 'tauri.localhost');
  const extra = (env.ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!sameHost && !isTauri && !extra.includes(originHeader)) return {};
  return {
    'access-control-allow-origin': originHeader,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-max-age': '600',
  };
}

async function handle(req: Request, envRaw: Env): Promise<Response> {
  const env: Env = envRaw.VERSION ? envRaw : { ...envRaw, VERSION: VERSION_DEFAULT };

  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const path = url.pathname;

  // WS-хаб: прямая передача апгрейда в DO.
  if (path === '/ws') {
    const stub = env.HUB.get(env.HUB.idFromName('hub'));
    return stub.fetch(req);
  }

  // API и файлы (единая логика в api.ts)
  if (path.startsWith('/api/') || path.startsWith('/uploads/')) {
    let resp: Response;
    try {
      resp = await api(req, env);
    } catch (e: any) {
      resp = text(`Внутренняя ошибка: ${e?.message || e}`, 500);
    }
    return withCors(resp, cors);
  }

  // Всё остальное — статика PWA (SPA-фолбэк в [assets]).
  const assetsResp = await env.ASSETS.fetch(req);
  return withCors(assetsResp, cors);
}

// Записать CORS-заголовки как можно мягче. Ответы от сабреквестов (DO, ASSETS,
// внешние fetch) приходят с иммутабельными заголовками — до тихого set() падает
// TypeError и роняет весь запрос (в т.ч. WS-апгрейд и auth). Падение — чиним
// пересборкой Response с копией заголовков, они уже доступны в мутабельном виде.
function withCors(resp: Response, cors: Record<string, string>): Response {
  try {
    for (const [k, v] of Object.entries(cors)) if (!resp.headers.has(k)) resp.headers.set(k, v);
    return resp;
  } catch {
    const out = new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: new Headers(resp.headers),
    });
    for (const [k, v] of Object.entries(cors)) if (!out.headers.has(k)) out.headers.set(k, v);
    return out;
  }
}

export function text(message: string, status: number): Response {
  return new Response(message + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
