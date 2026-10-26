// Звонки 1:1 (Discord-style) поверх сигналинга VAKSA через обычный WebSocket.
// Сервер — тупой релей call_* пользователю по username, вся логика здесь:
// getUserMedia → RTCPeerConnection → call_offer/answer/ice/hangup.
// ICE: публичные STUN; TURN добавим позже (coturn на VPS) для тяжёлых NAT.
const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

const MEDIA_OK = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

const RING_TIMEOUT = 45000; // кто-то не берёт трубку — сброс

// Паракдадный рингтон через Web Audio: без внешних ассетов, работает и в Tauri.
let ringCtx = null;
let ringNodes = null;

function startRingLoop() {
  try {
    if (!ringCtx) {
      ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ringCtx.createGain();
      gain.gain.value = 0.0;
      gain.connect(ringCtx.destination);
      // Мигание: два коротких писка каждые 2 секунды.
      const osc = ringCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 440;
      osc.connect(gain);
      osc.start();
      const on = () => {
        const t = ringCtx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0.0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.03);
        gain.gain.setValueAtTime(0.18, t + 0.35);
        gain.gain.linearRampToValueAtTime(0.0, t + 0.4);
        gain.gain.setValueAtTime(0.0, t + 0.45);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.5);
        gain.gain.setValueAtTime(0.18, t + 0.85);
        gain.gain.linearRampToValueAtTime(0.0, t + 0.9);
      };
      on();
      ringNodes = { osc, gain, timer: setInterval(on, 2000) };
    }
  } catch (e) {
    console.warn('ringtone:', e);
    ringCtx = null;
    ringNodes = null;
    return false;
  }
  // Android (WebView/PWA): без пользовательского жеста контекст приходит
  // suspended — надо resume(), иначе узлы «играют» в пустоту.
  if (ringCtx.state === 'suspended') {
    ringCtx.resume().catch(() => { /* жест ещё не был — ждём */ });
  }
  // Пока звук реально не идёт (контекст suspended) — дублируем вибро тактом,
  // чтобы входящий всё-таки ощущается без апгрейда жеста.
  const audible = ringCtx.state === 'running';
  if (ringNodes && !audible) {
    try {
      ringNodes.vibrateTimer = setInterval(() => {
        if (ringCtx && ringCtx.state === 'running') return; // звук заработал
        navigator.vibrate?.([300, 150, 300, 150, 300, 500, 300]);
      }, 2000);
    } catch { /* нет вибрации */ }
  }
  // Первый такт — сразу, пока звук ещё suspended.
  if (!audible) {
    try { navigator.vibrate?.([300, 150, 300, 150, 300, 500, 300]); } catch { /* нет vibrate */ }
  }
  return audible;
}

function stopRingLoop() {
  if (!ringNodes) return;
  clearInterval(ringNodes.timer);
  if (ringNodes.vibrateTimer) clearInterval(ringNodes.vibrateTimer);
  try {
    ringNodes.osc.stop();
    ringNodes.gain.disconnect();
  } catch { /* уже снят */ }
  ringNodes = null;
}

export class CallEngine {
  // deps: { send: (frame: string) => void, onEvent: (state|null, toast?) => void }
  constructor(deps) {
    this.deps = deps;
    this.pc = null;
    this.local = null;      // MediaStream своего микрофона
    this.remote = null;     // MediaStream собеседника
    this.peer = null;       // username собеседника
    this.direction = null;  // 'out' | 'in'
    this.status = null;     // 'ringing' | 'outgoing' | 'connecting' | 'active'
    this.pendingOffer = null; // SDP входящего вызова
    this.ringTimer = null;
    this.muted = false;
    this.iceOpen = false;   // зовём addIceCandidate только после setRemote
    this.queueIce = [];
    // «На динамик»: WebAudio-усиление удалённого потока (громкость ~2×).
    this.boost = false;
    this._boostOn = false;
    this.audioGraph = null; // { ctx, src, gain } — создаётся при первом потоке
  }

  emit(state, toast) {
    this.deps.onEvent(state, toast);
  }

  currentState() {
    return this.peer
      ? {
          peer: this.peer,
          direction: this.direction,
          status: this.status,
          stream: this.remote,
          muted: this.muted,
          boost: this.boost,
          audioRouted: !!this.audioGraph,
        }
      : null;
  }

  // --- Аудиомаршрут: до 1× играет сам <audio>-элемент; при бусте включаем
  // WebAudio (src → gain → destination) и глушим элемент, иначе двойной звук.
  _ensureGraph() {
    if (this.audioGraph || !this.remote || !MEDIA_OK) return !!this.audioGraph;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(this.remote);
      const gain = ctx.createGain();
      src.connect(gain);
      gain.connect(ctx.destination);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      this.audioGraph = { ctx, src, gain };
    } catch (e) {
      console.warn('boost ctx:', e);
      this.audioGraph = null;
    }
    return !!this.audioGraph;
  }

  _applyBoost() {
    if (this._boostOn) {
      if (this._ensureGraph()) {
        // Резкий подъём на «динамик»: ~2× поверх штатной громкости.
        this.audioGraph.gain.gain.value = 2.0;
        if (this.audioGraph.ctx.state === 'suspended') {
          this.audioGraph.ctx.resume().catch(() => {});
        }
      }
    } else if (this.audioGraph) {
      // 1× — через graph всё ещё играем (элемент заглушён в буст-режиме? нет:
      // muted управляется снаружи по call.boost) — просто тихо.
      this.audioGraph.gain.gain.value = 1.0;
    }
  }

  // Переключатель «громкость на динамик»: 1× → ×2.
  toggleBoost() {
    this._boostOn = !this._boostOn;
    this.boost = this._boostOn;
    this._applyBoost();
    this.emit(this.currentState());
    return this._boostOn;
  }

  // --- Исходящий звонок: getUserMedia + offer сразу (Discord-семантика быстрая) ---
  async start(peer) {
    if (!peer) return;
    // Входящий в ringing не создаёт pc — поэтому одного this.pc мало:
    // иначе исходящий вызов молча затирает входящий.
    if (this.pc || this.pendingOffer || this.status === 'ringing') {
      this.emit(this.currentState(), 'Сначала завершите текущий звонок');
      return;
    }
    this.peer = peer;
    this.direction = 'out';
    this.status = 'outgoing';
    this.emit(this.currentState());
    if (!MEDIA_OK) {
      this.emit(null, 'Микрофон доступен только по HTTPS (или в приложении)');
      this.peer = null;
      return;
    }
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      console.warn('mic:', e);
      this.emit(null, 'Нет доступа к микрофону');
      this.peer = null;
      return;
    }

    try {
      this.pc = new RTCPeerConnection(RTC_CONFIG);
      this.local.getTracks().forEach((t) => this.pc.addTrack(t, this.local));
      this.wirePC();
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ type: 'call_offer', to: peer, sdp: offer });
      // Собеседник завис в оффлайне?
      this.ringTimer = setTimeout(async () => {
        if (this.status !== 'active' && this.pc) {
          this.sendSignal({ type: 'call_hangup', to: this.peer });
          this.emit(null, 'Не отвечает');
          this.endLocal(true);
        }
      }, RING_TIMEOUT);
    } catch (e) {
      console.warn('offer:', e);
      this.emit(null, 'Не удалось начать звонок');
      this.endLocal(true);
    }
    // call_offline от сервера уже пришёл раньше answer? — обрабатывается в handleSignal.
  }

  // --- Согласиться на входящий ---
  async accept() {
    if (this.status !== 'ringing' || !this.pendingOffer) return;
    if (!MEDIA_OK) {
      this.emit(null, 'Микрофон доступен только по HTTPS (или в приложении)');
      this.decline();
      return;
    }
    stopRingLoop();
    clearTimeout(this.ringTimer);
    const offer = this.pendingOffer;
    this.status = 'connecting';
    this.emit(this.currentState());
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.pc = new RTCPeerConnection(RTC_CONFIG);
      this.local.getTracks().forEach((t) => this.pc.addTrack(t, this.local));
      this.wirePC();
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      this.iceOpen = true;
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendSignal({ type: 'call_answer', to: this.peer, sdp: answer });
      // Кандидаты, пришедшие до setRemote, откладывались:
      const queued = this.queueIce;
      this.queueIce = [];
      queued.forEach((c) => {
        try { this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('ice:', e); }
      });
    } catch (e) {
      console.warn('accept:', e);
      this.sendSignal({ type: 'call_hangup', to: this.peer });
      this.emit(null, 'Не удалось подключиться');
      this.endLocal(true);
    }
  }

  decline() {
    if (this.status === 'ringing') {
      this.sendSignal({ type: 'call_decline', to: this.peer });
    }
    stopRingLoop();
    clearTimeout(this.ringTimer);
    this.endLocal(true);
  }

  hangup() {
    if (this.peer) {
      this.sendSignal({ type: 'call_hangup', to: this.peer });
    }
    stopRingLoop();
    clearTimeout(this.ringTimer);
    this.endLocal(true);
  }

  toggleMute() {
    if (!this.local) return !this.muted;
    this.muted = !this.muted;
    this.local.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    this.emit(this.currentState());
    return this.muted;
  }

  // --- Входящие кадры call_* из WS ---
  handleSignal(ev) {
    switch (ev.type) {
      case 'call_offer': {
        if (this.pc || this.status === 'outgoing') {
          // Занято (звонок активен или исходящий уже в работе) — автоответ.
          this.sendSignal({ type: 'call_busy', to: ev.fromName });
          return;
        }
        this.peer = ev.fromName;
        this.direction = 'in';
        this.status = 'ringing';
        // SDP приходит как обычный объект {type, sdp} после JSON-распаковки — ок.
        this.pendingOffer = ev.sdp || null;
        this.emit(this.currentState());
        clearTimeout(this.ringTimer);
        this.ringTimer = setTimeout(() => {
          if (this.status === 'ringing') {
            this.sendSignal({ type: 'call_decline', to: this.peer });
            this.emit(null, 'Пропущенный звонок');
            this.endLocal(true);
          }
        }, RING_TIMEOUT);
        if (!startRingLoop()) {
          // Звук не завёлся (нет жеста пользователя) — звоним вибро/визуально.
          try { navigator.vibrate?.([300, 150, 300, 150, 300, 500, 300]); } catch { /* нет vibrate */ }
        }
        return;
      }
      case 'call_answer':
        if (this.pc && ev.sdp) {
          this.status = 'connecting';
          this.pc.setRemoteDescription(new RTCSessionDescription(ev.sdp))
            .then(() => {
              this.iceOpen = true;
              const queued = this.queueIce;
              this.queueIce = [];
              queued.forEach((c) => {
                try { this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('ice:', e); }
              });
            })
            .catch((e) => console.warn('answer sdp:', e));
        }
        return;
      case 'call_ice':
        try {
          const cand = ev.candidate || ev.ice;
          if (!cand) return;
          if (this.pc && this.iceOpen) {
            this.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
          } else {
            // pc ещё нет (входящий в ringing: pc создаётся в accept()) или
            // setRemoteDescription не готов — буферизуем ВСЕГДА, очередь
            // сливается сразу после setRemote в accept()/call_answer.
            if (this.queueIce.length < 64) this.queueIce.push(cand);
          }
        } catch (e) { console.warn('ice:', e); }
        return;
      case 'call_decline':
        if (this.peer === ev.fromName && this.status !== 'active') {
          this.emit(null, 'Звонок отклонён');
          this.hangup();
        }
        return;
      case 'call_busy':
        if (this.peer === ev.fromName && this.status !== 'active') {
          this.emit(null, 'Собеседник занят');
          this.hangup();
        }
        return;
      case 'call_offline':
        if (this.pc && this.status !== 'active') {
          this.emit(null, 'Собеседник не в сети');
          this.hangup();
        }
        return;
      case 'call_hangup':
        if (this.peer === ev.fromName) {
          this.emit(null, this.status === 'active' ? 'Звонок завершён' : '');
          stopRingLoop();
          clearTimeout(this.ringTimer);
          this.endLocal(true);
        }
        return;
      default:
        return;
    }
  }

  wirePC() {
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal({ type: 'call_ice', to: this.peer, candidate: e.candidate });
      }
    };
    this.pc.ontrack = (e) => {
      this.remote = e.streams[0];
      // Поток появился — перенастраиваем громкость (граф создаётся лениво).
      this._applyBoost();
      this.emit(this.currentState());
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'connected') {
        stopRingLoop();
        this.status = 'active';
        this.emit(this.currentState());
      } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        if (st === 'disconnected') {
          // Может быть потеря и восстановление: даём ICE 5 секунд.
          setTimeout(() => {
            if (this.pc && this.pc.connectionState !== 'connected') {
              this.emit(null, 'Связь потеряна');
              this.hangup();
            }
          }, 5000);
        } else {
          this.emit(null, 'Связь потеряна');
          this.hangup();
        }
      }
    };
  }

  sendSignal(frame) {
    if (!this.deps.send(frame)) {
      // Сокет умер в момент звонка — честно рвём.
      this.emit(null, 'Нет связи с сервером');
      stopRingLoop();
      clearTimeout(this.ringTimer);
      this.endLocal(true);
    }
  }

  endLocal(silent) {
    try { this.pc && this.pc.close(); } catch { /* уже */ }
    this.pc = null;
    try {
      this.local && this.local.getTracks().forEach((t) => t.stop());
    } catch { /* уже */ }
    this.local = null;
    this.remote = null;
    // Аудиограф буста — останавливаем, иначе ctx живёт и жрёт батарею.
    if (this.audioGraph) {
      try { this.audioGraph.src.disconnect(); this.audioGraph.gain.disconnect(); } catch { /* уже */ }
      try { this.audioGraph.ctx.close(); } catch { /* уже */ }
      this.audioGraph = null;
    }
    this.boost = false;
    this._boostOn = false;
    this.peer = null;
    this.direction = null;
    this.status = null;
    this.pendingOffer = null;
    this.muted = false;
    this.iceOpen = false;
    this.queueIce = [];
    if (!silent) this.emit(this.currentState());
    else this.emit(null);
  }
}
