// Тест звонков: «connecting» не должен висить вечно (aiti CONNECT_TIMEOUT).
const fs = require('fs');
const path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'calls.js'), 'utf8');
src = src.replace('export class CallEngine', 'class CallEngine') + '\nreturn CallEngine;';

const timers = [];
let nextId = 1;
const fakeSetTimeout = (fn, ms) => { timers.push({ id: nextId, fn, ms }); return nextId++; };
const fakeClearTimeout = (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
function fire(ms) {
  const due = timers.filter(t => t.ms === ms);
  due.forEach(t => { fakeClearTimeout(t.id); t.fn(); });
  return due.length;
}

const fakePc = () => ({
  connectionState: 'new', iceConnectionState: 'new',
  addTrack() {}, setRemoteDescription: async () => {}, setLocalDescription: async () => {},
  createAnswer: async () => ({ type: 'answer', sdp: 'a' }),
  createOffer: async () => ({ type: 'offer', sdp: 'o' }),
  addIceCandidate: async () => {}, close() {},
});

const track = { enabled: true, kind: 'audio', stop() {} };
const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
const globals = {
  RTCPeerConnection: function () { return fakePc(); },
  RTCSessionDescription: function (x) { return x; },
  RTCIceCandidate: function (x) { return x; },
  navigator: { mediaDevices: { getUserMedia: async () => stream } },
  window: { AudioContext: function () { throw new Error('no audio'); } },
  console: { warn() {}, log() {} },
};

const CallEngine = new Function('setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'navigator', 'window', 'console', src)(
  fakeSetTimeout, fakeClearTimeout, () => 1, () => {},
  globals.RTCPeerConnection, globals.RTCSessionDescription, globals.RTCIceCandidate,
  globals.navigator, globals.window, globals.console);

const events = [];
const engine = new CallEngine({
  send: () => true,
  onEvent: (state, toast) => events.push({ state, toast }),
});

function ring(engine) {
  engine.peer = 'alice';
  engine.direction = 'in';
  engine.status = 'ringing';
  engine.pendingOffer = { type: 'offer', sdp: 'x' };
}

(async () => {
  ring(engine);
  await engine.accept();
  if (engine.status !== 'connecting') throw new Error('accept не перевёл в connecting');
  if (!engine.connectTimer) throw new Error('не заведён connectTimer');

  const fired = fire(20000);
  if (fired !== 1) throw new Error('таймер 20s не сработал');
  if (engine.status !== null || engine.pc !== null) throw new Error('звонок не сброшен по таймауту');
  const failure = events.find(e => e.toast && e.toast.includes('Не удалось соединиться'));
  if (!failure) throw new Error('нет сообщения об ошибке соединения');
  console.log('PASS call connecting timeout -> hangup');

  // Успешное соединение снимает таймер.
  const ok = new CallEngine({ send: () => true, onEvent: () => {} });
  ring(ok);
  await ok.accept();
  ok.pc.connectionState = 'connected';
  ok.pc.onconnectionstatechange();
  if (ok.status !== 'active' || ok.connectTimer) throw new Error('connected не снял connectTimer');
  if (fire(20000) !== 0) throw new Error('таймер остался после connected');
  console.log('PASS call connected clears timeout');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
