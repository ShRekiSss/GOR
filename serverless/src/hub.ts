// Hub — Durable Object: держит все WebSocket-соединения браузеров,
// рассылает сообщения (клиент фильтрует по chatId — семантика GOR)
// и сохраняет сообщения в D1 (как защищённый SaveMessage из main.go).

import type { Env, Frame } from './types';
import { userByToken } from './auth';

export class Hub {
  state: DurableObjectState;
  env: Env;
  sockets = new Map<number, { ws: WebSocket; userID: number; username: string }>();
  seq = 1;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/stats') {
      return new Response(JSON.stringify({ online: this.sockets.size }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/broadcast' && req.method === 'POST') {
      const frame = await req.json() as Frame;
      this.broadcast(frame);
      return new Response('ok');
    }

    // WebSocket-апгрейд от клиента /ws
    if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      (pair[1] as any).accept();
      const id = this.seq++;
      const s = { ws: pair[1] as WebSocket, userID: 0, username: '' };
      this.sockets.set(id, s);

      pair[1].addEventListener('message', (ev) => {
        this.onClientFrame(id, ev.data as string).catch(() => this.sockets.delete(id));
      });
      pair[1].addEventListener('close', () => this.sockets.delete(id));
      pair[1].addEventListener('error', () => this.sockets.delete(id));

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  private sendTo(id: number, s: { ws: WebSocket }, frame: object) {
    try {
      s.ws.send(JSON.stringify(frame));
    } catch {
      this.sockets.delete(id);
    }
  }

  private async onClientFrame(conID: number, raw: string) {
    const s = this.sockets.get(conID);
    if (!s) return;

    let data: any;
    try { data = JSON.parse(raw); } catch { return; }
    if (data?.type === 'ping' || data?.ping) return; // чистый keepalive

    // Первый кадр — авторизация (протокол 0.9.x: auth первым кадром).
    if (s.userID === 0) {
      if (data?.type === 'auth' && data?.token) {
        const user = await userByToken(this.env, data.token);
        if (!user) {
          this.sendTo(conID, s, { type: 'auth_error' });
          try { s.ws.close(1008, 'auth_error'); } catch { /* уже */ }
          this.sockets.delete(conID);
          return;
        }
        s.userID = user.id;
        s.username = user.username;
        this.sendTo(conID, s, { type: 'auth_ok' });
        return;
      }
      this.sendTo(conID, s, { type: 'auth_error' });
      try { s.ws.close(1008, 'auth required'); } catch { /* уже */ }
      this.sockets.delete(conID);
      return;
    }

    // Обычное сообщение из чата: сохранить + разослать всем.
    if (data?.chatId) {
      const f = {
        chatId: Number(data.chatId) || 1,
        userId: s.userID,
        username: s.username,
        text: String(data.text ?? ''),
        type: data.type ?? 'text',
        stickerId: data.stickerId ?? '',
        stickerUrl: data.stickerUrl ?? '',
        stickerPack: data.stickerPack ?? '',
        fileUrl: data.fileUrl ?? '',
        fileName: data.fileName ?? '',
        fileSize: data.fileSize ?? 0,
        fileType: data.fileType ?? '',
      } as Frame;
      const saved = await saveAndBroadcast(this.env, f);
      this.broadcast(saved);
    }
  }

  private broadcast(f: Frame) {
    const raw = JSON.stringify(f);
    for (const [id, s] of this.sockets) {
      try { s.ws.send(raw); } catch { this.sockets.delete(id); }
    }
  }
}

// Сохранить сообщение в D1 и разослать всем WS-клиентам (для upload и хаба).
export async function saveAndBroadcast(env: Env, f: Frame): Promise<Frame> {
  const chatID = f.chatId && f.chatId > 0 ? f.chatId : 1;
  const ts = f.timestamp || hhmmss();
  const ins = await env.DB.prepare(
    `INSERT INTO messages (chat_id, user_id, username, text, timestamp, message_type,
      sticker_id, sticker_url, sticker_pack, file_url, file_name, file_size, file_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    chatID, f.userId ?? 0, f.username ?? '', f.text ?? '', ts,
    f.type ?? '', f.stickerId ?? '', f.stickerUrl ?? '', f.stickerPack ?? '',
    f.fileUrl ?? '', f.fileName ?? '', f.fileSize ?? 0, f.fileType ?? '',
  ).run();

  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?')
    .bind(ins.meta.last_row_id as number).first<any>();
  const saved = row ? frameFromRow(row) : { ...f, chatId: chatID, timestamp: ts } as Frame;

  broadcastOnly(env, saved);
  return saved;
}

// Разослать (без записи) — вызывается из api.ts после upload.
export function broadcastOnly(env: Env, f: Frame) {
  const stub = env.HUB.get(env.HUB.idFromName('hub'));
  stub.fetch('https://hub/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(f),
  }).catch(() => { /* WS-рассылка лучше усилий */ });
}

export function hhmmss(): string {
  // У нашего сервера всегда было локальное время UTC+7 (SERV).
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function frameFromRow(r: any): Frame {
  return {
    id: r.id,
    chatId: Number(r.chat_id ?? 1),
    userId: r.user_id ?? 0,
    username: r.username ?? '',
    text: r.text ?? '',
    timestamp: r.timestamp ?? '',
    type: r.message_type ?? '',
    stickerId: r.sticker_id ?? '',
    stickerUrl: r.sticker_url ?? '',
    stickerPack: r.sticker_pack ?? '',
    fileUrl: r.file_url ?? '',
    fileName: r.file_name ?? '',
    fileSize: r.file_size ?? 0,
    fileType: r.file_type ?? '',
  };
}
