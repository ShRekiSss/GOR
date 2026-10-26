// REST API VAKSA — семантика 1:1 с main.go (коды, тексты ошибок, JSON-формы).

import { Env, Frame } from './types';
import {
  User, USERNAME_RE, createSession, hashPassword, profileOf, rateLimitAuth, tokenFromRequest, userByToken, verifyPassword,
} from './auth';
import { text } from './index';
import { sendPush, pushPublicKey } from './push';

// In-memory: кэш GIPHY-поиска на изолят + лимит на (юзер × kind × минуту).
const giphyCache = new Map<string, { items: { id: string; url: string; title: string }[]; t: number }>();
const kindHits = new Map<string, { n: number; t: number }>();
const KIND_LIMIT: Record<string, number> = { giphy: 30, ai: 20 };
async function limitOk(_env: Env, userID: number, kind: string): Promise<boolean> {
  const kkey = `${kind}:${userID}`;
  const rec = kindHits.get(kkey);
  if (!rec || Date.now() - rec.t > 60_000) {
    kindHits.set(kkey, { n: 1, t: Date.now() });
    return true;
  }
  rec.n += 1;
  return rec.n <= (KIND_LIMIT[kind] || 30);
}
import { hhmmss, saveAndBroadcast, broadcastOnly } from './hub';

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function hhmmss(): string {
  // Как в GOR: серверное локальное времяdart, у нас UTC+7.
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export async function api(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean); // ['api', ...]

  // ---------- health / stats ----------
  if (path === '/api/health') {
    return json({ status: 'ok', uptime: 'cloud', version: env.VERSION });
  }
  if (path === '/api/stats') {
    const stub = env.HUB.get(env.HUB.idFromName('hub'));
    const resp = await stub.fetch('https://hub/stats');
    const online = (await resp.json()) as { online: number };
    return json({ online: online.online ?? 0 });
  }

  // ---------- auth ----------
  if (path === '/api/auth/register' || path === '/api/auth/login') {
    const isRegister = path.endsWith('/register');
    if (req.method !== 'POST') return text('Method not allowed', 405);

    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await rateLimitAuth(env, ip))) {
      return text('Слишком много попыток, попробуйте позже', 429);
    }

    let creds: { username?: string; password?: string };
    try {
      creds = await req.json();
    } catch {
      return text('Некорректный запрос', 400);
    }
    const username = (creds.username || '').trim();
    const password = creds.password || '';

    if (isRegister) {
      if (!USERNAME_RE.test(username)) return text('Имя: 3-32 символа, латиница, цифры, _ . -', 400);
      if (password.length < 8) return text('Пароль должен быть не короче 8 символов', 400);
      if (password.length > 256) return text('Пароль слишком длинный', 400);

      const exists = await env.DB.prepare(
        'SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1',
      ).bind(username).first();
      if (exists) return text('Это имя уже занято', 409);

      const hash = await hashPassword(password);
      const ins = await env.DB.prepare(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      ).bind(username, hash).run();
      const userID = ins.meta.last_row_id as number;

      const token = await createSession(env, userID);
      await ensureGeneralChat(env, userID);
      return json({ token, user: await profileOf(env, userID) }, 201);
    }

    // login: время выравнивается тем, что в обоих случаях гоняем hash-проверку
    const row = await env.DB.prepare(
      'SELECT id, username, password_hash, banned FROM users WHERE username = ? COLLATE NOCASE LIMIT 1',
    ).bind(username).first<{ id: number; username: string; password_hash: string; banned?: number }>();

    let user: User | null = null;
    if (row) {
      if (await verifyPassword(row.password_hash, password)) {
        user = { id: row.id, username: row.username };
      }
    } else {
      await verifyPassword('pbkdf2$sha256$i=25000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', password);
    }
    if (!user) return text('Неверное имя или пароль', 401);
    if (row.banned) return text('Аккаунт заблокирован', 403);

    await ensureGeneralChat(env, user.id);
    const token = await createSession(env, user.id);
    return json({ token, user: await profileOf(env, user.id) }, 200);
  }

  if (path === '/api/auth/logout') {
    if (req.method !== 'POST') return text('Method not allowed', 405);
    const token = tokenFromRequest(req);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return new Response(null, { status: 204 });
  }

  // /uploads/* сам разбирает авторизацию (Bearer / cookie / ?t= для <img> и <video>),
  // остальное требует заголовок/cookie.
  const isUploads = path.startsWith('/uploads/');
  if (!isUploads && path !== '/api/download') {
    const authUser = await userByToken(env, tokenFromRequest(req));
    if (!authUser) return text('Не авторизован', 401);
    if (authUser.banned) return text('Аккаунт заблокирован', 403);
    return apiRest(req, env, authUser);
  }
  // Для /uploads/* и /api/download токен вычисляем здесь: Bearer/cookie либо ?t=.
  const maybeToken =
    tokenFromRequest(req) || new URL(req.url).searchParams.get('t') || '';
  const mediaUser = maybeToken ? await userByToken(env, maybeToken) : null;
  if (!mediaUser) return text('Не авторизован', 401);
  if (mediaUser.banned) return text('Аккаунт заблокирован', 403);
  return apiMedia(req, env, mediaUser);
}

// REST: всё, кроме выдачи файлов (тут user гарантированно есть).
async function apiRest(req: Request, env: Env, user: User): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean);

  // ---------- me / users ----------
  if (path === '/api/auth/me' && req.method === 'GET') {
    return json({ user });
  }

  // ---------- Админка (права разраба; фича пока только в облаке) ----------
  if (path.startsWith('/api/admin')) {
    if (!user.isAdmin) return text('Нет прав', 403);
    return adminApi(req, env, user);
  }

  // ---------- Профиль (MVP по WeChat-спеке) ----------
  // Свой профиль: полный, со счётчиками разделов.
  if (path === '/api/me/profile' && req.method === 'GET') {
    const me = await profileOf(env, user.id);
    if (!me) return text('Не найдено', 404);
    // Друзья — люди, с которыми есть личный чат (пока без отдельной соцсети).
    const fr = await env.DB.prepare(
      `SELECT COUNT(DISTINCT m.user_id) AS n FROM chat_members a
       JOIN chats c ON c.id = a.chat_id AND c.type = 'direct'
       JOIN chat_members m ON m.chat_id = c.id AND m.user_id != a.user_id
       WHERE a.user_id = ?`,
    ).bind(user.id).first<{ n: number }>();
    return json({
      user: me,
      counts: { photos: 0, notes: 0, links: 0, friends: fr?.n || 0 },
      permissions: { canEdit: true },
    });
  }

  // Правка своего профиля: displayName / bio / statusText / statusEmoji / searchable.
  if (path === '/api/me/profile' && req.method === 'PATCH') {
    let body: { displayName?: string; bio?: string; statusText?: string; statusEmoji?: string; searchable?: number | boolean };
    try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }
    const dn = String(body.displayName ?? '').trim();
    const bio = String(body.bio ?? '').trim();
    const st = String(body.statusText ?? '').trim();
    const se = String(body.statusEmoji ?? '').trim();
    if (dn.length > 48 || bio.length > 280 || st.length > 64 || [...se].length > 4) {
      return text('Слишком длинные данные профиля', 400);
    }
    await env.DB.prepare(
      'UPDATE users SET display_name = ?, bio = ?, status_text = ?, status_emoji = ? WHERE id = ?',
    ).bind(dn, bio, st, se, user.id).run();
    // Приватность: скрыть/показать себя в поиске людей. Если миграция D1 ещё
    // не применена — честно говорим «прими миграции» вместо немого провала.
    if (body.searchable !== undefined) {
      const sv = Number(body.searchable) ? 1 : 0;
      try {
        await env.DB.prepare('UPDATE users SET searchable = ? WHERE id = ?').bind(sv, user.id).run();
      } catch (e: any) {
        if (String(e?.message || e).includes('no such column')) {
          return text('Миграция D1 не применена: ALTER TABLE users ADD COLUMN searchable (см. migrations/)', 400);
        }
        throw e;
      }
    }
    return json({ user: await profileOf(env, user.id) });
  }

  // Друзья первого этапа: все, с кем есть личный чат.
  if (path === '/api/me/friends' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT u.id, u.username, u.avatar, u.status_text, u.status_emoji
       FROM chat_members a
       JOIN chats c ON c.id = a.chat_id AND c.type = 'direct'
       JOIN chat_members m ON m.chat_id = c.id AND m.user_id != a.user_id
       JOIN users u ON u.id = m.user_id
       WHERE a.user_id = ? ORDER BY u.username LIMIT 100`,
    ).bind(user.id).all<any>();
    return json({ friends: (rows.results || []).map((f) => ({
      id: f.id, username: f.username, avatar: f.avatar || '',
      statusText: f.status_text || '', statusEmoji: f.status_emoji || '',
    })) });
  }

  // Публичный профиль по @username: только безопасная часть.
  const pubUser = (seg[0] === 'api' && seg[1] === 'users' && seg[3] === 'profile' && seg[2]) ? seg[2] : null;
  if (pubUser && req.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT id, username, avatar, is_admin, display_name, bio, status_text, status_emoji FROM users WHERE username = ? COLLATE NOCASE LIMIT 1',
    ).bind(pubUser).first<any>();
    if (!row) return text('Не найдено', 404);
    return json({ user: {
      id: row.id, username: row.username, avatar: row.avatar || '',
      isAdmin: row.is_admin || 0,
      displayName: row.display_name || '', bio: row.bio || '',
      statusText: row.status_text || '', statusEmoji: row.status_emoji || '',
      presence: 'offline',
    } });
  }

  // Смена аватара профиля: { dataUrl: 'data:image/png;base64,...' } (можно и через
  // multipart file — клиент шлёт dataUrl с canvas 128px).
  if (path === '/api/me/avatar' && req.method === 'POST') {
    let body: { dataUrl?: string };
    try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }
    const du = String(body.dataUrl || '');
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(du)) {
      return text('Формат изображения не поддержан', 400);
    }
    const b64 = du.slice(du.indexOf(',') + 1);
    if (b64.length < 24 || b64.length % 4 !== 0) {
      return text('Повреждённая картинка', 400);
    }
    // Магические байты: JPEG (FF D8 FF) или PNG (89 50 4E 47) — иначе «Картинка
    // повреждена»: старые обрезанные/битые data-URL больше не дойдут до D1.
    try {
      const head = atob(b64.slice(0, 8));
      const b = [head.charCodeAt(0), head.charCodeAt(1), head.charCodeAt(2), head.charCodeAt(3)];
      const isJpeg = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
      const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
      if (!isJpeg && !isPng) return text('Повреждённая картинка', 400);
    } catch {
      return text('Повреждённая картинка', 400);
    }
    if (du.length > 400_000) {
      return text('Слишком большая картинка (лимит ~300 КиБ)', 400);
    }
    await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(du, user.id).run();
    return json({ user: { ...user, avatar: du } });
  }

  // ---------- GIPHY-прокси (паритет с main.go): ключ живёт на сервере ----------
  // Кэш на изолят 10 минут, чтобы не сжигать квоту GIPHY при спаме поиска.
  if (path === '/api/giphy' && req.method === 'GET') {
    if (!env.GOR_GIPHY_KEY) {
      return json({ error: 'GIPHY отключён: задайте GOR_GIPHY_KEY на сервере' }, 503);
    }
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return text('Укажите поисковый запрос ?q=', 400);
    if (!(await limitOk(env, user.id, 'giphy'))) return text('Слишком много запросов, попробуйте позже', 429);
    const gkey = `giphy:${q.toLowerCase().slice(0, 64)}`;
    const cached = giphyCache.get(gkey);
    if (cached && Date.now() - cached.t < 600_000) return json({ data: cached.items, cached: true });
    const api = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(env.GOR_GIPHY_KEY)}&q=${encodeURIComponent(q)}&limit=12&rating=pg-13`;
    const gr = await fetch(api, { cf: { cacheTtl: 300 } }).catch(() => null);
    if (!gr || !gr.ok) return text('Не удалось выполнить поиск GIF', 502);
    const gd = await gr.json().catch(() => null);
    if (!gd?.data) return text('Не удалось выполнить поиск GIF', 502);
    const items = (gd.data as any[]).slice(0, 12).map((g) => ({
      id: g.id,
      url: g.images?.original?.url || g.images?.downsized?.url || '',
      title: g.title || '',
    })).filter((g) => g.url);
    giphyCache.set(gkey, { items, t: Date.now() });
    return json({ data: items });
  }

  // ---------- Web Push (Milestone 2) ----------
  // Публичный VAPID-ключ (applicationServerKey) для подписки браузера.
  if (path === '/api/push/pubkey' && req.method === 'GET') {
    return json({ publicKey: await pushPublicKey(env) });
  }

  // Подписка устройства: { endpoint, keys: { p256dh, auth } }.
  if (path === '/api/push/subscribe' && req.method === 'POST') {
    let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }
    const endpoint = String(body.endpoint || '');
    const p256dh = String(body.keys?.p256dh || '');
    const auth = String(body.keys?.auth || '');
    if (!endpoint.startsWith('https://') || !p256dh || !auth) {
      return text('Некорректная подписка', 400);
    }
    if (endpoint.length > 1024 || p256dh.length > 200 || auth.length > 40) {
      return text('Слишком длинные данные подписки', 400);
    }
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).bind(endpoint, user.id, p256dh, auth).run();
    return new Response(null, { status: 201 });
  }

  // Отписка устройства (SW делает её сам по pushsubscriptionchange тоже).
  if (path === '/api/push/unsubscribe' && req.method === 'POST') {
    let body: { endpoint?: string };
    try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }
    const endpoint = String(body.endpoint || '');
    if (!endpoint) return text('Некорректный запрос', 400);
    await env.DB.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
    ).bind(endpoint, user.id).run();
    return new Response(null, { status: 204 });
  }

  if (path === '/api/users' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const pattern = `%${q}%`;
    // Приватность: скрытые из поиска (searchable=0) не попадают в выдачу,
    // НО остаются видимыми тем, у кого с ними уже есть личный чат.
    const PRIV = `AND (u.searchable = 1 OR u.id IN (
        SELECT other.user_id FROM chat_members me
        JOIN chats c ON c.id = me.chat_id AND c.type = 'direct'
        JOIN chat_members other ON other.chat_id = me.chat_id
        WHERE me.user_id = ? AND other.user_id != me.user_id
      ))`;
    const base = (withPriv: string) => (
      `SELECT u.id, u.username, u.avatar FROM users u
       WHERE u.id != ? AND u.username LIKE ? ${withPriv}
       ORDER BY u.username LIMIT 20`
    );
    try {
      const rows = await env.DB.prepare(base(PRIV))
        .bind(user.id, pattern, user.id).all<any>();
      return json({ users: (rows.results || []).map((u) => ({ ...u, avatar: u.avatar || '' })) });
    } catch (e: any) {
      if (String(e?.message || e).includes('no such column')) {
        // Миграция не применена — старое поведение (всех видно).
        const rows = await env.DB.prepare(
          'SELECT id, username, avatar FROM users WHERE id != ? AND username LIKE ? ORDER BY username LIMIT 20',
        ).bind(user.id, pattern).all<User & { avatar?: string }>();
        return json({ users: (rows.results || []).map((u) => ({ ...u, avatar: u.avatar || '' })) });
      }
      throw e;
    }
  }

  // ---------- chats ----------
  if (path === '/api/chats') {
    if (req.method === 'GET') return json({ chats: await listChats(env, user.id) });
    if (req.method === 'POST') return createChat(req, env, user);
    return text('Method not allowed', 405);
  }

  if (seg[0] === 'api' && seg[1] === 'chats' && seg.length === 4) {
    const chatID = Number(seg[2]);
    const sub = seg[3];
    if (!Number.isInteger(chatID) || chatID <= 0) return text('Не найдено', 404);
    if (!(await isMember(env, chatID, user.id))) return text('Нет доступа к чату', 403);

    if (sub === 'messages' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after')) || 0;
      const before = Number(url.searchParams.get('before')) || 0;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 200);
      return json(await getMessages(env, chatID, limit, after, before, user.id));
    }
    if (sub === 'read' && req.method === 'POST') {
      let body: { messageId?: number };
      try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }
      await env.DB.prepare(
        'UPDATE chat_members SET last_read_message_id = MAX(last_read_message_id, ?) WHERE chat_id = ? AND user_id = ?',
      ).bind(body.messageId || 0, chatID, user.id).run();
      // ✓✓ вживую: авторы сообщений чата узнают, что их прочитали до этого id.
      await broadcastOnly(env, {
        type: 'read', chatId: chatID, userId: user.id, username: user.username,
        messageId: Number(body.messageId) || 0,
      } as any);
      return new Response(null, { status: 204 });
    }
    return text('Не найдено', 404);
  }

  // ---------- messages (старый путь, массивом) ----------
  if (path === '/api/messages' && req.method === 'GET') {
    const chatID = Number(url.searchParams.get('chatId')) || 1;
    if (!(await isMember(env, chatID, user.id))) return text('Нет доступа к чату', 403);
    return json(await getMessages(env, chatID, 100, 0, 0, user.id));
  }

  // ---------- Нейро-бот (OpenAI-совместимый; без ключа — честная ошибка) ----------
  if (path === '/api/ai' && req.method === 'POST') {
    if (!env.GOR_AI_KEY) {
      return json({ error: 'AI отключён: задайте секрет GOR_AI_KEY (wrangler secret put GOR_AI_KEY)' }, 503);
    }
    let body: { chatId?: number; text?: string };
    try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }
    const chatID = Number(body.chatId) || 0;
    const prompt = String(body.text ?? '').trim();
    if (!prompt) return text('Пустой вопрос', 400);
    if (prompt.length > 2000) return text('Вопрос слишком длинный (до 2000 символов)', 400);
    if (!(await isMember(env, chatID, user.id))) return text('Нет доступа к чату', 403);
    if (!(await limitOk(env, user.id, 'ai'))) return text('Слишком много запросов к боту, попробуйте позже', 429);

    // Бот — обычный юзер в users, создаётся при первом обращении.
    const botRow = await env.DB.prepare(
      `INSERT INTO users (username, password_hash) VALUES ('VAKSA-бот', ?)
       ON CONFLICT(username) DO NOTHING`,
    ).bind(await hashPassword(`bot-${Date.now()}`)).run();
    const bot = await env.DB.prepare(
      "SELECT id, username, avatar FROM users WHERE username = 'VAKSA-бот' LIMIT 1",
    ).first<{ id: number; username: string; avatar: string }>();
    if (!bot) return text('Не удалось создать бота', 500);

    // Вопрос юзера — как обычное сообщение (видно в истории чата).
    const asked = await saveAndBroadcast(env, {
      chatId: chatID, userId: user.id, username: user.username,
      text: prompt, type: 'text', timestamp: hhmmss(),
    } as Frame);
    await broadcastOnly(env, asked);

    const base = (env.GOR_AI_BASEURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = env.GOR_AI_MODEL || 'gpt-4o-mini';
    const ar = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.GOR_AI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        messages: [
          { role: 'system', content: 'Ты VAKSA-бот в мессенджере VAKSA. Отвечай по-русски, кратко и по делу, дружелюбно. Markdown-таблицы и ссылки на файлы не используй — только обычный текст.' },
          { role: 'user', content: prompt },
        ],
      }),
    }).catch(() => null);
    if (!ar || !ar.ok) {
      return text(ar ? `AI-провайдер ответил ${ar.status}` : 'AI-провайдер недоступен', 502);
    }
    const ad = await ar.json().catch(() => null);
    const reply = String(ad?.choices?.[0]?.message?.content || '').trim();
    if (!reply) return text('AI вернул пустой ответ', 502);

    const answer = await saveAndBroadcast(env, {
      chatId: chatID, userId: bot.id, username: bot.username,
      text: reply.slice(0, 4000), type: 'text', timestamp: hhmmss(),
    } as Frame);
    await broadcastOnly(env, answer);
    return json({ message: answer });
  }

  // ---------- Истории (24 ч, ТГ/ТТ-стиль) ----------
  if (path === '/api/stories' && req.method === 'GET') {
    await cleanupStories(env);
    const rows = await env.DB.prepare(
      `SELECT s.id, s.user_id AS userId, s.kind, s.caption, s.file_key AS fileKey,
              s.duration_ms AS durationMs, s.gradient, s.created_at AS createdAt,
              s.expires_at AS expiresAt, u.username, u.avatar,
              (SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id) AS views,
              EXISTS(SELECT 1 FROM story_views v2 WHERE v2.story_id = s.id AND v2.user_id = ?) AS seen
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ?
       ORDER BY s.created_at ASC`,
    ).bind(user.id, new Date().toISOString()).all<any>();
    // Группируем по автору: свои сверху, затем по свежести последней истории.
    const byUser = new Map<number, any>();
    for (const r of rows.results || []) {
      r.seen = !!Number(r.seen); r.views = Number(r.views) || 0;
      let g = byUser.get(r.userId);
      if (!g) {
        g = { userId: r.userId, username: r.username, avatar: r.avatar || '', allSeen: true, stories: [] };
        byUser.set(r.userId, g);
      }
      if (!r.seen) g.allSeen = false;
      delete r.userId; delete r.username; delete r.avatar;
      g.stories.push(r);
    }
    const groups = [...byUser.values()].sort((a, b) => {
      if (a.userId === user.id) return -1;
      if (b.userId === user.id) return 1;
      if (a.allSeen !== b.allSeen) return a.allSeen ? 1 : -1;
      return 0;
    });
    return json({ groups, total: (rows.results || []).length });
  }

  if (path === '/api/stories' && req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    if (!form) return text('Некорректный запрос', 400);
    const caption = String(form.get('caption') || '').trim().slice(0, 500);
    const gradient = Math.max(0, Math.min(7, Number(form.get('gradient')) || 0));
    const file = form.get('file');
    let kind = 'text', key = '', durMs = 0;
    if (file instanceof File && file.size > 0) {
      if (file.size > 50 * 1024 * 1024) return text('File too large (max 50MB)', 400);
      const isImg = /^image\/(jpe?g|png|webp)(;|$)/.test(file.type || '');
      const isVid = /^video\/(mp4|webm)(;|$)/.test(file.type || '');
      if (!isImg && !isVid) return text('Только image/photo или видео mp4/webm', 400);
      kind = isImg ? 'image' : 'video';
      durMs = Math.max(0, Math.min(60_000, Number(form.get('durationMs')) || 0));
      const originalName = safeUploadName(file.name || (isImg ? 'story.jpg' : 'story.mp4'));
      key = `story_${Date.now()}${Math.floor(Math.random() * 1000)}_${originalName}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await putFileChunks(env, key, bytes, file.type || 'application/octet-stream');
    } else if (!caption) {
      return text('Пустая история: нужен файл или текст', 400);
    }
    const now = new Date();
    const res = await env.DB.prepare(
      `INSERT INTO stories (user_id, kind, caption, file_key, duration_ms, gradient, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(user.id, kind, caption, key, durMs, gradient, now.toISOString(),
      new Date(now.getTime() + 24 * 3600 * 1000).toISOString()).run();
    return json({ ok: true, id: res.meta.last_row_id }, 201);
  }

  if (seg[0] === 'api' && seg[1] === 'stories' && seg.length === 3) {
    const sid = Number(seg[2]);
    if (!Number.isInteger(sid) || sid <= 0) return text('Не найдено', 404);
    if (req.method === 'POST') {
      // Отметка просмотра: кто бы ни был — инкремент один раз.
      await env.DB.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES (?, ?)')
        .bind(sid, user.id).run();
      return new Response(null, { status: 204 });
    }
    if (req.method === 'DELETE') {
      const own = await env.DB.prepare(
        'SELECT id, file_key AS fileKey FROM stories WHERE id = ? AND user_id = ?',
      ).bind(sid, user.id).first<any>();
      if (!own) return text('История не найдена', 404);
      await env.DB.prepare('DELETE FROM stories WHERE id = ?').bind(sid).run();
      await env.DB.prepare('DELETE FROM story_views WHERE story_id = ?').bind(sid).run();
      if (own.fileKey) await deleteFileChunks(env, own.fileKey);
      return new Response(null, { status: 204 });
    }
    return text('Method not allowed', 405);
  }

  // ---------- upload ----------
  if (path === '/api/upload' && req.method === 'POST') {
    return handleUpload(req, env, user);
  }

  return text('Не найдено', 404);
}

// Медиа: /uploads/<name> и /api/download — авторизация Bearer/cookie либо ?t=.
async function apiMedia(req: Request, env: Env, user: User): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // ---------- download ----------
  if (path === '/api/download') {
    return uploadsRead(req, env, user, (url.searchParams.get('file') || '').split('/').pop() || '');
  }

  // ---------- раздача файлов /uploads/<name> ----------
  if (path.startsWith('/uploads/')) {
    const name = decodeURIComponent(path.slice('/uploads/'.length)).split('/').pop() || '';
    return uploadsRead(req, env, user, name);
  }

  return text('Не найдено', 404);
}

// ---------- Хелперы чатов/сообщений ----------

export async function ensureGeneralChat(env: Env, userID: number) {
  await env.DB.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (1, ?)')
    .bind(userID).run();
}

export async function isMember(env: Env, chatID: number, userID: number): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?',
  ).bind(chatID, userID).first();
  return !!row;
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

export async function getMessages(
  env: Env,
  chatID: number,
  limit: number,
  after = 0,
  before = 0,
  viewer = 0,
): Promise<{ messages: Frame[]; reactions: Record<string, { emoji: string; count: number; usernames: string[] }[]>; hasMore: boolean; foreignRead: number }> {

  let out: Frame[];
  if (after > 0) {
    // Догон: всё, что новее after, старые сначала.
    const rows = await env.DB.prepare(
      'SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
    ).bind(chatID, after, limit).all();
    out = (rows.results || []).map(frameFromRow);
  } else if (before > 0) {
    // Пагинация назад: страница перед самым старым загруженным.
    const rows = await env.DB.prepare(
      'SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
    ).bind(chatID, before, limit).all();
    out = (rows.results || []).map(frameFromRow);
    out.reverse();
  } else {
    const rows = await env.DB.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?',
    ).bind(chatID, limit).all();
    out = (rows.results || []).map(frameFromRow);
    out.reverse(); // старые сначала
  }
  const hasMore = out.length >= limit;

  // До какого id прочли чат другие участники (для ✓✓ на своих сообщениях).
  const fr = await env.DB.prepare(
    `SELECT COALESCE(MAX(last_read_message_id), 0) AS n FROM chat_members
     WHERE chat_id = ? AND user_id != ?`,
  ).bind(chatID, viewer).first<{ n: number }>().catch(() => null);
  const foreignReadId = fr?.n || 0;

  // Реакции по этим сообщениям — одним запросом.
  const ids = out.map((m) => m.id).filter(Boolean);
  const reactions: Record<string, { emoji: string; count: number; usernames: string[] }[]> = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const rrows = await env.DB.prepare(
      `SELECT message_id, emoji, username FROM reactions WHERE message_id IN (${ph})`,
    ).bind(...ids).all<{ message_id: number; emoji: string; username: string }>();
    for (const r of rrows.results || []) {
      const key = String(r.message_id);
      reactions[key] = reactions[key] || [];
      let agg = reactions[key].find((x) => x.emoji === r.emoji);
      if (!agg) {
        agg = { emoji: r.emoji, count: 0, usernames: [] };
        reactions[key].push(agg);
      }
      agg.count += 1;
      agg.usernames.push(r.username);
    }
  }
  return { messages: out, reactions, hasMore, foreignRead: foreignReadId };
}

export async function listChats(env: Env, userID: number) {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.type, c.title, cm.last_read_message_id AS last_read
     FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
     WHERE cm.user_id = ?`,
  ).bind(userID).all<{ id: number; type: string; title: string; last_read: number }>();

  const items: { chat: any; lastID: number }[] = [];
  for (const r of rows.results || []) {
    const chat: any = { id: r.id, type: r.type, title: r.title, unread: 0 };
    let lastID = 0;
    const last = await env.DB.prepare(
      'SELECT id, text, username, timestamp FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1',
    ).bind(r.id).first<any>();
    if (last) {
      lastID = last.id;
      chat.lastText = last.text ?? '';
      chat.lastSender = last.username ?? '';
      chat.lastTime = last.timestamp ?? '';
    }
    const unreadRow = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND id > ? AND COALESCE(user_id, 0) != ?',
    ).bind(r.id, r.last_read, userID).first<{ n: number }>();
    chat.unread = unreadRow?.n || 0;

    if (r.type === 'direct') {
      const peer = await env.DB.prepare(
        `SELECT u.id, u.username, u.avatar FROM chat_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.chat_id = ? AND cm.user_id != ? LIMIT 1`,
      ).bind(r.id, userID).first<any>();
      if (peer) {
        chat.peerId = peer.id;
        chat.peer = peer.username;
        chat.title = peer.username;
        chat.avatar = peer.avatar || '';
      }
    }
    items.push({ chat, lastID });
  }
  // новые сверху (по последнему сообщению, как в GOR)
  items.sort((a, b) => b.lastID - a.lastID);
  return items.map((i) => i.chat);
}

async function createChat(req: Request, env: Env, user: User): Promise<Response> {
  let body: { type?: string; username?: string; title?: string; usernames?: string[] };
  try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }

  const findUser = async (name: string) => {
    return env.DB.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE LIMIT 1')
      .bind(name.trim()).first<User>();
  };

  if (body.type === 'direct') {
    const peer = await findUser(body.username || '');
    if (!peer) return text('Пользователь не найден', 404);
    if (peer.id === user.id) return text('Нельзя начать чат с самим собой', 400);

    const dupe = await env.DB.prepare(
      `SELECT cm1.chat_id AS id FROM chat_members cm1
       JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id
       JOIN chats c ON c.id = cm1.chat_id
       WHERE c.type = 'direct' AND cm1.user_id = ? AND cm2.user_id = ? LIMIT 1`,
    ).bind(user.id, peer.id).first<{ id: number }>();

    let chatID: number;
    if (dupe) {
      chatID = dupe.id;
    } else {
      const ins = await env.DB.prepare(
        "INSERT INTO chats (type, title, created_by) VALUES ('direct', '', ?)",
      ).bind(user.id).run();
      chatID = ins.meta.last_row_id as number;
      await env.DB.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?), (?, ?)')
        .bind(chatID, user.id, chatID, peer.id).run();
    }
    const chats = await listChats(env, user.id);
    const chat = chats.find((c) => c.id === chatID);
    if (!chat) return text('Чат создан, но не найден', 500);
    return json({ chat }, 201);
  }

  if (body.type === 'group') {
    const title = (body.title || '').trim();
    if (title.length < 1 || title.length > 64) return text('Название группы: от 1 до 64 символов', 400);
    const names = body.usernames || [];
    if (names.length === 0) return text('Добавьте хотя бы одного участника', 400);
    if (names.length > 50) return text('Слишком много участников (максимум 50)', 400);

    const ids: number[] = [];
    for (const name of names) {
      const member = await findUser(name);
      if (!member) return text(`Пользователь "${name}" не найден`, 404);
      ids.push(member.id);
    }

    const ins = await env.DB.prepare(
      "INSERT INTO chats (type, title, created_by) VALUES ('group', ?, ?)",
    ).bind(title, user.id).run();
    const chatID = ins.meta.last_row_id as number;

    const seen = new Set<number>([user.id]);
    let q = 'INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)';
    const binds: any[] = [chatID, user.id];
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      q += ', (?, ?)';
      binds.push(chatID, id);
    }
    await env.DB.prepare(q).bind(...binds).run();

    const chats = await listChats(env, user.id);
    const chat = chats.find((c) => c.id === chatID);
    if (!chat) return text('Группа создана, но не найдена', 500);
    return json({ chat }, 201);
  }

  return text('Тип чата: direct или group', 400);
}

// ---------- Файлы ----------

function fileTypeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(ext)) return 'video';
  return 'document';
}

function safeUploadName(name: string): string {
  name = (name || 'file').replace(/\\/g, '/').split('/').pop() || 'file';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f]/g, '');
  if (!name || name === '.' || name === '..') name = 'file';
  if (name.length > 128) {
    const dot = name.lastIndexOf('.');
    name = name.slice(0, 120) + (dot > 0 ? name.slice(dot) : '');
  }
  return name;
}

async function handleUpload(req: Request, env: Env, user: User): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return text('Некорректный запрос', 400);
  const file = form.get('file');
  if (!(file instanceof File)) return text('Failed to get file', 400);
  if (file.size > 50 * 1024 * 1024) return text('File too large (max 50MB)', 400);

  const chatID = Number(form.get('chatId')) || 1;
  if (!(await isMember(env, chatID, user.id))) return text('Нет доступа к чату', 403);
  // silent=1: только загрузка, без авто-«📎 отправил файл» — клиент сам решает,
  // каким сообщением файл поедет (голосовое ТГ-кружочком, например).
  const silent = String(form.get('silent') || '') === '1';

  const originalName = safeUploadName(file.name);
  const key = `${Date.now()}${Math.floor(Math.random() * 1000)}_${originalName}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  await putFileChunks(env, key, bytes, file.type || 'application/octet-stream');

  if (silent) {
    return json({
      success: true,
      fileUrl: `/uploads/${key}`,
      fileName: originalName,
      fileSize: file.size,
      fileType: fileTypeOf(originalName),
    });
  }

  const msg: any = {
    chatId: chatID,
    userId: user.id,
    username: user.username,
    text: '📎 Отправил файл',
    type: 'file',
    timestamp: hhmmss(),
    fileUrl: `/uploads/${key}`,
    fileName: originalName,
    fileSize: file.size,
    fileType: fileTypeOf(originalName),
  };
  const savedMsg = await saveAndBroadcast(env, msg);
  await broadcastOnly(env, savedMsg);

  return json({
    success: true,
    fileUrl: msg.fileUrl,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    fileType: msg.fileType,
  });
}

// ---------- Хранение файлов в D1 чанками (замена R2) ----------

const CHUNK_SIZE = 900 * 1024;

export async function putFileChunks(env: Env, key: string, bytes: Uint8Array, contentType: string) {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0, seq = 0; i < bytes.length; i += CHUNK_SIZE, seq++) {
    stmts.push(env.DB.prepare('INSERT INTO file_chunks (name, seq, data) VALUES (?, ?, ?)')
      .bind(key, seq, bytes.subarray(i, i + CHUNK_SIZE)));
  }
  stmts.push(env.DB.prepare('INSERT INTO files (name, size, content_type) VALUES (?, ?, ?)')
    .bind(key, bytes.length, contentType));
  if (stmts.length > 1) {
    await env.DB.batch(stmts);
  } else {
    for (const s of stmts) await s.run();
  }
}

export async function deleteFileChunks(env: Env, key: string) {
  if (!key) return;
  const dels: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM files WHERE name = ?').bind(key),
    env.DB.prepare('DELETE FROM file_chunks WHERE name = ?').bind(key),
  ];
  await env.DB.batch(dels).catch(() => { /* уже нет — не беда */ });
}

// Ленивая чистка историй: всё, что старше 24 ч, вместе с чанками (файлы
// историй живут с префиксом story_ — файлы чатов не трогаем).
export async function cleanupStories(env: Env) {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(
    "SELECT id, file_key AS fileKey FROM stories WHERE expires_at <= ? AND (file_key LIKE 'story_%' OR file_key = '')",
  ).bind(now).all<any>();
  for (const s of expired.results || []) {
    if (s.fileKey) await deleteFileChunks(env, s.fileKey);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM stories WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM story_views WHERE story_id NOT IN (SELECT id FROM stories)'),
  ]).catch(() => { /* гонка чисток — не беда */ });
}

export async function getFileChunks(env: Env, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const meta = await env.DB.prepare('SELECT size, content_type FROM files WHERE name = ?')
    .bind(key).first<{ size: number; content_type: string }>();
  if (!meta) return null;
  const rows = await env.DB.prepare('SELECT data FROM file_chunks WHERE name = ? ORDER BY seq')
    .bind(key).all<{ data: ArrayBuffer }>();
  const chunks = (rows.results || []).map((r) => new Uint8Array(r.data));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return { bytes: out, contentType: meta.content_type };
}

async function uploadsRead(req: Request, env: Env, user: User, rawName: string): Promise<Response> {
  // Медиа-теги не шлют заголовки: разрешаем ?t=<token> только здесь.
  let token = tokenFromRequest(req);
  if (!token) token = new URL(req.url).searchParams.get('t') || '';
  const viewer = token ? await userByToken(env, token) : user;
  if (!viewer) return text('Не авторизован', 401);

  const name = rawName.replace(/\\/g, '/').split('/').pop() || '';
  if (!name || name.includes('..')) return text('Не найдено', 404);

  // Привязка к чату по сообщению с этим file_url.
  const linked = await env.DB.prepare(
    'SELECT COALESCE(chat_id, 1) AS chat_id FROM messages WHERE file_url = ? ORDER BY id LIMIT 1',
  ).bind(`/uploads/${name}`).first<{ chat_id: number }>();

  // Файл без привязки к сообщению — только участникам общего чата (как в GOR).
  const chatID = linked ? Number(linked.chat_id) || 1 : 1;
  if (!(await isMember(env, chatID, viewer.id))) return text('Нет доступа к файлу', 403);

  const file = await getFileChunks(env, name);
  if (!file) return text('Не найдено', 404);

  const headers = new Headers();
  headers.set('content-type', file.contentType || 'application/octet-stream');
  headers.set('cache-control', 'private, max-age=3600');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(file.bytes, { headers });
}

// ---------- Админка: права разраба (бан, переминовка, лист входов) ----------
// Фича пока только в облаке (в main.go соответствия нет — см. дорожную карту).
async function adminApi(req: Request, env: Env, me: User): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean);
  // seg: ['api','admin','users'] | ['api','admin','users',':id','ban'|'rename']

  if (path === '/api/admin/users' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT u.id, u.username, u.avatar, u.is_admin, u.banned,
              u.created_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > (SELECT strftime('%s','now'))) AS sessions_alive,
              (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login,
              (SELECT MAX(m.timestamp) FROM messages m WHERE m.user_id = u.id) AS last_message
       FROM users u ORDER BY u.id`,
    ).all<any>();
    return json({ users: rows.results || [] });
  }

  if (seg[1] === 'admin' && seg[2] === 'users' && Number.isInteger(Number(seg[3])) && Number(seg[3]) > 0) {
    const target = Number(seg[3]);
    if (req.method === 'POST' && seg[4] === 'ban') {
      if (target === me.id) return text('Нельзя забанить самого себя', 400);
      let body: { on?: boolean };
      try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }
      const on = body.on !== false;
      await env.DB.prepare(
        `UPDATE users SET banned = ? WHERE id = ?`,
      ).bind(on ? 1 : 0, target).run();
      if (on) {
        // Бан убивает входы: живые сессии и пуш-подписки зануляем.
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target).run();
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(target).run();
      }
      return json({ ok: true, banned: on });
    }
    if (req.method === 'POST' && seg[4] === 'rename') {
      let body: { username?: string };
      try { body = await req.json(); } catch { return text('Некорректный запрос', 400); }
      const name = String(body.username || '').trim();
      if (!USERNAME_RE.test(name)) return text('Имя: 3-32 символа, латиница, цифры, _ . -', 400);
      const exists = await env.DB.prepare(
        'SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1',
      ).bind(name).first<{ id: number }>();
      if (exists && exists.id !== target) return text('Это имя уже занято', 409);
      await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(name, target).run();
      return json({ ok: true, user: await profileOf(env, target) });
    }
    return text('Method not allowed', 405);
  }

  return text('Не найдено', 404);
}
