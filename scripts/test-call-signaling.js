// Тест сигналинга звонков: ПК + «телефон» (второй сокет того же пользователя).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18101;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gor-calls-'));
const BIN = process.platform === 'win32' ? './build/gor.exe' : './build/gor';
const server = spawn(BIN, [], {
  env: { ...process.env, GOR_PORT: String(PORT), GOR_DB: `${dir}/chat.db`,
    GOR_UPLOADS: `${dir}/uploads`, GOR_STATIC: `${dir}/no-static` },
  cwd: process.cwd(),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}, token) {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS', name);
  else { fails++; console.log('FAIL', name, extra ?? ''); }
}

function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events = [];
  ws.addEventListener('message', (d) => { try { events.push(JSON.parse(d.data)); } catch { /* ignore */ } });
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  return { ws, events };
}
const waitAuth = async (c) => {
  for (let i = 0; i < 40; i++) {
    if (c.events.some((e) => e.type === 'auth_ok')) return;
    await sleep(50);
  }
  throw new Error('auth_ok не пришёл');
};

(async () => {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(300); }
  }

  const a = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'caller', password: 'longpassword1' }) });
  const b = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'callee', password: 'longpassword2' }) });
  check('register 201', a.status === 201 && b.status === 201);

  const pc = connect(a.body.token);      // ПК звонящего
  const phone = connect(b.body.token);   // телефон принимающего
  const pc2 = connect(b.body.token);     // second device (мульти-логин)
  await Promise.all([waitAuth(pc), waitAuth(phone), waitAuth(pc2)]);
  check('три WS авторизованы', true);

  pc.ws.send(JSON.stringify({ type: 'call_offer', to: 'callee', sdp: { type: 'offer', sdp: 'FAKE-SDP' } }));
  await sleep(300);
  check('offer дошёл на телефон', phone.events.some((e) => e.type === 'call_offer' && e.fromName === 'caller' && e.sdp?.sdp === 'FAKE-SDP'));
  check('offer дошёл на второе устройство', pc2.events.some((e) => e.type === 'call_offer'));
  check('звонящий не получил свой offer', !pc.events.some((e) => e.type === 'call_offer'));

  phone.ws.send(JSON.stringify({ type: 'call_answer', to: 'caller', sdp: { type: 'answer', sdp: 'ANSWER' } }));
  await sleep(250);
  check('answer вернулся звонящему', pc.events.some((e) => e.type === 'call_answer' && e.fromName === 'callee'));

  pc.ws.send(JSON.stringify({ type: 'call_ice', to: 'callee', candidate: { candidate: 'candidate:1' } }));
  await sleep(200);
  check('ICE-кандидат доставлен', phone.events.some((e) => e.type === 'call_ice' && e.candidate?.candidate === 'candidate:1'));

  phone.ws.send(JSON.stringify({ type: 'call_busy', to: 'caller' }));
  await sleep(200);
  check('busy доставлен', pc.events.some((e) => e.type === 'call_busy'));

  pc.ws.send(JSON.stringify({ type: 'call_hangup', to: 'nobody' }));
  await sleep(200);
  check('несуществующий адресат → call_offline', pc.events.some((e) => e.type === 'call_offline' && e.fromName === 'nobody'));

  console.log(fails ? `ИТОГ: ${fails} ПРОВАЛОВ` : 'ИТОГ: ВСЁ ОК');
  server.kill('SIGTERM');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); server.kill('SIGTERM'); process.exit(1); });
