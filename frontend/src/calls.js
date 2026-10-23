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
    if (ringCtx) return true;
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
    return true;
  } catch (e) {
    console.warn('ringtone:', e);
    return false;
  }
}

function stopRingLoop() {
  if (!ringNodes) return;
  clearInterval(ringNodes.timer);
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
        }
      : null;
  }

  // --- Исходящий звонок: getUserMedia + offer сразу (Discord-семантика быстрая) ---
  async start(peer) {
    if (!peer || this.pc) {
      this.emit(this.currentState(), this.pc ? 'Уже в звонке' : '');
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
        if (this.pc) {
          // Занято — автоответ.
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
          } else if (this.pc) {
            this.queueIce.push(cand);
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
