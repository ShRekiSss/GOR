// Дым-тест VAKSA-сервера после 0.9.1 правок.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gor-test-'));

const server = spawn('./build/gor', [],
  { env: { ...process.env, GOR_PORT: String(PORT), GOR_DB: `${dir}/chat.db`, GOR_UPLOADS: `${dir}/uploads`, GOR_STATIC: `${dir}/no-static` }, cwd: process.cwd() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opts = {}, token) => {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* текстовая ошибка (429/400) */ }
  return { status: res.status, body: json, text: body };
};

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS', name);
  else { failures++; console.log('FAIL', name, extra ?? ''); }
}

async function main() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/health`); break; } catch (e) { await sleep(300); }
  }

  // Регистрация двоих
  const u1 = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'shrek', password: 'longpassword1' }) });
  const u2 = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'toad', password: 'longpassword2' }) });
  check('register 201', u1.status === 201 && u2.status === 201);
  const t1 = u1.body.token, t2 = u2.body.token;

  // WS: авторизация первым кадром + presence-события
  const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
  // Глобальный WebSocket в node 26 есть; fallback не нужен.
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events1 = [];
  ws1.addEventListener('message', (d) => events1.push(JSON.parse(d.data)));
  const events2 = [];
  ws2.addEventListener('message', (d) => events2.push(JSON.parse(d.data)));

  ws1.addEventListener('open', () => ws1.send(JSON.stringify({ type: 'auth', token: t1 })));
  ws2.addEventListener('open', () => ws2.send(JSON.stringify({ type: 'auth', token: t2 })));
  await sleep(700);
  check('ws1 auth_ok', events1.some((m) => m.type === 'auth_ok'));
  check('ws2 auth_ok', events2.some((m) => m.type === 'auth_ok'));
  check('presence join к обоим', events1.some((m) => m.type === 'presence' && m.event === 'join') &&
    events2.some((m) => m.type === 'presence' && m.event === 'join'));
  check('нет System-сообщения о входе', !events1.some((m) => m.username === 'System'));

  // Личный чат user1 ↔ user2
  const chat = await api('/api/chats', { method: 'POST', body: JSON.stringify({ type: 'direct', username: 'toad' }) }, t1);
  check('direct chat created', chat.status === 201 && chat.body.chat.id > 1);
  const chatId = chat.body.chat.id;

  const sendMessage = (ws, text) => ws.send(JSON.stringify({ chatId, text, type: 'text' }));
  const sent = [];
  for (let i = 1; i <= 3; i++) { sendMessage(ws1, 'msg ' + i); sent.push('msg ' + i); }
  await sleep(700);

  // user2 получил все 3 с ISO-таймстемпом
  const recvd = events2.filter((m) => m.text && m.text.startsWith('msg'));
  check('user2 получил 3 сообщения', recvd.length === 3, String(recvd.length));
  check('таймстемп ISO UTC', recvd.every((m) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.timestamp)), recvd[0]?.timestamp);

  // История: базовый GET + пагинация
  let hist = await api(`/api/chats/${chatId}/messages`, {}, t2);
  check('история 3 сообщений', hist.body.messages.length === 3);
  const mid = hist.body.messages[1].id;

  const after = await api(`/api/chats/${chatId}/messages?after=${mid}`, {}, t2);
  check('after=возвращает только старшие', after.body.messages.length === 1 && after.body.messages[0].text === 'msg 3', JSON.stringify(after.body));

  const before = await api(`/api/chats/${chatId}/messages?before=${mid}&limit=3`, {}, t2);
  check('before=возвращает 1 младшее с hasMore=false', before.body.messages.length === 1 && before.body.messages[0].text === 'msg 1' && before.body.hasMore === false, JSON.stringify(before.body));

  const limitPage = await api(`/api/chats/${chatId}/messages?limit=2`, {}, t2);
  check('limit=2 → hasMore=true', limitPage.body.messages.length === 2 && limitPage.body.hasMore === true);

  // GIPHY без ключа — мягкое 503
  const giphy = await api('/api/giphy?q=cats', {}, t2);
  check('giphy без ключа → 503 JSON', giphy.status === 503 && /GOR_GIPHY_KEY/.test(String(giphy.text)));

  // Разлогинимся ws2 → presence leave у ws1
  ws2.close();
  await sleep(500);
  check('presence leave у ws1', events1.some((m) => m.type === 'presence' && m.event === 'leave'));

  // Rate limit на авторизации остался ( Guthrie те же 20 попыток)
  let last = null;
  for (let i = 0; i < 21; i++) { last = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'x', password: 'y' }) }); }
  check('rate-limit 5-й блок: 429', last.status === 429);

  console.log(failures ? ` ИТОГ: ${failures} ПРОВАЛОВ` : ' ИТОГ: ВСЁ ОК');
  server.kill('SIGTERM');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
