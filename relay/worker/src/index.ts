// Релей VAKSA: публичный вход https://vaksa.space -> Cloudflare Worker,
// который держит исходящее WSS-соединение с домашней машиной (gor-relay)
// и проксирует запросы через него. Компенсирует блокировку cloudflared
// провайдером: трафик выглядит как обычный HTTPS/WebSocket на :443.

export interface Env {
  RELAY: DurableObjectNamespace;
  RELAY_KEY: string;
}

// ---------- Вспомогательное ----------

type Frame = {
  c: number; // канал
  req?: { method: string; path: string; headers: Record<string, string>; ws?: boolean };
  resp?: { status: number; headers: Record<string, string> };
  d?: string; // base64-чанк тела
  t?: string; // текстовое сообщение WS-канала
  fin?: boolean;
  close?: boolean;
  err?: string;
  ping?: boolean;
};

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "host",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop",
  "cf-warp-tag-id", "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
  "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "sec-fetch-user",
  "accept-language", "accept-encoding", "upgrade-insecure-requests", "cookie",
]);

function hopHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (!HOP_HEADERS.has(k.toLowerCase())) out[k] = v;
  });
  return out;
}

// ---------- Durable Object ----------

// Собирает данные канала и резолвит промис, когда пришёл fin.
class PendingChannel {
  mode: "http" | "ws";
  ws!: WebSocket; // для ws-режима — серверный конец браузерного WS
  buf = new Array<Uint8Array>();
  text: string[] = [];
  status = 0;
  headers: Record<string, string> = {};
  private resolve: (v: void) => void = () => {};
  promise: Promise<void>;

  constructor(mode: "http" | "ws", ws?: WebSocket) {
    this.mode = mode;
    if (ws) this.ws = ws;
    this.promise = new Promise((r) => (this.resolve = r));
  }

  finish() {
    this.resolve();
  }
}

export class Relay {
  state: DurableObjectState;
  env: Env;
  homes = new Map<number, WebSocket>();
  homeSeq = 1;
  nextHome = 1;
  channels = new Map<number, PendingChannel>();
  nextChannel = 1;
  rr = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__relay/home") return this.handleHome(req);
    return this.proxyToHome(req);
  }

  // ---------- домашняя машина подключается ----------

  private handleHome(req: Request): Response {
    if (req.headers.get("X-Relay-Key") !== this.env.RELAY_KEY) {
      return new Response("forbidden\n", { status: 403 });
    }
    const pair = new WebSocketPair();
    (pair[1] as any).accept();
    const id = this.homeSeq++;
    this.homes.set(id, pair[1]);
    // Здоровый ping, чтобы край и ТСПУ не рвали соединение.
    setInterval(() => {
      try { pair[1].send(JSON.stringify({ ping: true, c: 0 })); } catch { /* закрыт */ }
    }, 20000);
    pair[1].addEventListener("close", () => {
      this.homes.delete(id);
      // Все каналы этой коннекции — закрываем браузерные концы.
      for (const [chId, ch] of this.channels) {
        if ((ch as any).homeId === id) {
          if (ch.mode === "ws") { try { ch.ws.close(1011, "home lost"); } catch { /* уже */ } }
          try { ch.finish(); } catch { /* уже */ }
          this.channels.delete(chId);
        }
      }
    });
    pair[1].addEventListener("message", (ev) => this.handleHomeMessage(id, ev.data as string));
    pair[1].send(JSON.stringify({ ok: true }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private handleHomeMessage(homeId: number, raw: string) {
    let f: Frame;
    try { f = JSON.parse(raw) as Frame; } catch { return; }
    if (f.ping) return;

    const ch = this.channels.get(f.c);
    if (!ch) return;

    if (f.resp) {
      ch.status = f.resp.status;
      ch.headers = f.resp.headers || {};
    }
    if (typeof f.t === "string") {
      try { ch.ws.send(f.t); } catch { /* браузер ушёл */ }
    }
    if (typeof f.d === "string") {
      const bin = base64ToBytes(f.d);
      ch.buf.push(bin);
    }
    if (f.ping) {
      try { ch.ws.send("ping"); } catch { /* пф */ }
    }
    if (f.err) {
      if (ch.mode === "ws") { try { ch.ws.close(1011, f.err); } catch { /* уже */ } }
      try { (ch as any).homeId = homeId; ch.finish(); } catch { /* уже */ }
      this.channels.delete(f.c);
      return;
    }
    if (f.close && ch.mode === "ws") {
      try { ch.ws.close(1000, "eof"); } catch { /* уже */ }
      this.channels.delete(f.c);
      return;
    }
    // fin помечает конец потока ответа (http) — резолвим.
    if (f.fin && ch.mode === "http") {
      try { (ch as any).homeId = homeId; ch.finish(); } catch { /* уже */ }
    }
  }

  // ---------- публичный трафик браузера ----------

  private async proxyToHome(req: Request): Promise<Response> {
    const home = this.pickHome();
    if (!home) return new Response("Задний релей офлайн. Попробуй позже.\n", {
      status: 502,
      headers: { "retry-after": "15" },
    });
    const url = new URL(req.url);

    // WebSocket-апгрейд (клиентский /ws) — мост со структурой канала.
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.proxyWebSocket(home, req);
    }

    const chId = this.nextChannel++;
    const ch = new PendingChannel("http");
    this.channels.set(chId, ch);

    // 1) открываем канал
    const open: Frame = {
      c: chId,
      req: {
        method: req.method,
        path: url.pathname + url.search,
        headers: hopHeaders(req.headers),
      },
    };
    home.send(JSON.stringify(open));

    // 2) тело запроса (чеканки по 512 КиБ)
    const body = await req.arrayBuffer();
    const CHUNK = 512 * 1024;
    for (let off = 0; off < body.byteLength; off += CHUNK) {
      const slice = new Uint8Array(body, off, Math.min(CHUNK, body.byteLength - off));
      home.send(JSON.stringify({ c: chId, d: bytesToBase64(slice), fin: false } as Frame));
    }
    // даже для пустого тела шлём fin, чтобы home начал исполнение
    home.send(JSON.stringify({ c: chId, fin: true } as Frame));

    await ch.promise;
    this.channels.delete(chId);

    const headers = new Headers(ch.headers);
    const total = ch.buf.reduce((n, b) => n + b.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const b of ch.buf) { merged.set(b, off); off += b.byteLength; }

    return new Response(merged.length ? merged.buffer : null, {
      status: ch.status || 502,
      headers,
    });
  }

  private proxyWebSocket(home: WebSocket, req: Request): Response {
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    (pair[1] as any).accept();

    const chId = this.nextChannel++;
    const ch = new PendingChannel("ws", pair[1]);
    this.channels.set(chId, ch);

    home.send(JSON.stringify({
      c: chId,
      req: {
        method: "GET",
        path: url.pathname + url.search,
        headers: hopHeaders(req.headers),
        ws: true,
      },
    } as Frame));

    pair[1].addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : null;
      if (data === null) return; // бинарные WS-кадры нам не нужны
      try { home.send(JSON.stringify({ c: chId, t: data } as Frame)); } catch { /* рвём */ }
    });
    pair[1].addEventListener("close", () => {
      try { home.send(JSON.stringify({ c: chId, close: true } as Frame)); } catch { /* уже */ }
      this.channels.delete(chId);
    });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private pickHome(): WebSocket | undefined {
    const list = [...this.homes.values()];
    if (list.length === 0) return undefined;
    const ws = list[this.rr % list.length];
    this.rr++;
    return ws;
  }
}

// ---------- base64 для чанков ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  const len = s.length - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
  const out = new Uint8Array((len / 4) * 3);
  let p = 0, bits = 0, accum = 0;
  for (const chr of s) {
    const v = B64.indexOf(chr);
    if (v < 0) continue;
    accum = (accum << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (accum >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

// ---------- входная точка Worker'а ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if ((url.hostname === "vaksa.space" || url.hostname.endsWith(".workers.dev")) &&
        url.pathname === "/__relay/home") {
      const id = env.RELAY.idFromName("relay");
      const stub = env.RELAY.get(id);
      return stub.fetch(req);
    }
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    return stub.fetch(req);
  },
};
