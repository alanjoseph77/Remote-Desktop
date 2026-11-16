// Viewer side: the computer doing the controlling.
import { deriveKey, hmac, safeEqual, fingerprints } from './crypto.js';

const FILE_CHUNK = 16 * 1024;
const FILE_HIGH_WATER = 1024 * 1024;

export class ViewerSession {
  constructor({ sig, settings, info, ui, targetId, password }) {
    this.sig = sig;
    this.settings = settings;
    this.info = info;
    this.ui = ui;
    this.targetId = targetId;
    this.password = password;
    this.sid = null;
    this.key = null;
    this.nonce = null;
    this.hostVerified = false;
    this.hostPlatform = null;
    this.hostName = 'Partner';
    this.pc = null;
    this.ctlCh = null;
    this.fileCh = null;
    this.closed = false;
    this.controlAllowed = true;
    this.swapCmdCtrl = false;
    this.pressed = new Set();
    this.lastClip = null;
    this.timers = [];
    this.pendingIce = [];
    this.connected = false;
    this.cleanupInput = null;
    this.giveUp = setTimeout(() => this.close('Partner did not respond.', true), 90_000);
  }

  start() {
    this.ui.viewerStatus('Connecting…');
    this.sig.send({ type: 'connect', target: this.targetId });
  }

  // ---------- signaling ----------
  onServer(msg) {
    if (msg.type === 'pending') { this.sid = msg.sid; this.ui.viewerStatus('Checking password…'); }
    else if (msg.type === 'error') this.close(msg.message || 'Could not connect.', false);
    else if (msg.type === 'ended' && msg.sid === this.sid) this.close(msg.reason || 'Session ended.', false);
    else if (msg.type === 'relay' && msg.sid === this.sid) this.onPayload(msg.payload).catch((e) => this.close('Connection error: ' + (e.message || e), true));
  }

  relay(payload) { this.sig.relay(this.sid, payload); }

  async onPayload(p) {
    if (!p || this.closed) return;
    switch (p.kind) {
      case 'hello': {
        if (this.nonce) return;
        this.nonce = String(p.nonce);
        this.hostName = String(p.name || 'Partner').slice(0, 64);
        this.key = await deriveKey(this.password, this.targetId);
        this.password = null; // don't keep it around
        const mac = await hmac(this.key, `auth|${this.nonce}|${this.targetId}`);
        this.relay({ kind: 'auth', mac, name: this.settings.deviceName });
        break;
      }
      case 'waiting':
        this.ui.viewerStatus(`Waiting for ${this.hostName} to accept…`);
        break;
      case 'reject':
        this.close(String(p.reason || 'Connection refused.'), false);
        break;
      case 'accepted': {
        // Mutual authentication: the host proves it also knows the password.
        const expect = await hmac(this.key, `accepted|${this.nonce}`);
        if (!safeEqual(expect, p.mac)) return this.close('Security check failed (host could not prove the password).', true);
        this.hostVerified = true;
        this.hostPlatform = p.platform;
        this.hostName = String(p.name || this.hostName).slice(0, 64);
        // A Mac controlling Windows/Linux (or vice versa) wants Cmd and Ctrl swapped.
        this.swapCmdCtrl = (this.info.platform === 'darwin') !== (p.platform === 'darwin');
        this.ui.viewerStatus('Starting screen…');
        break;
      }
      case 'offer': await this.onOffer(p); break;
      case 'ice':
        if (!p.c) return;
        if (this.pc && this.pc.remoteDescription) await this.pc.addIceCandidate(p.c).catch(() => {});
        else this.pendingIce.push(p.c);
        break;
    }
  }

  async onOffer(p) {
    if (!this.hostVerified || this.pc) return;
    const expect = await hmac(this.key, `offer|${this.nonce}|${fingerprints(p.sdp)}`);
    if (!safeEqual(expect, p.mac)) return this.close('Security check failed (offer signature).', true);

    this.pc = new RTCPeerConnection({ iceServers: this.settings.iceServers || [] });
    this.pc.onicecandidate = (e) => { if (e.candidate) this.relay({ kind: 'ice', c: e.candidate.toJSON() }); };
    this.pc.ontrack = (e) => this.ui.viewerTrack(e.streams[0] || new MediaStream([e.track]));
    this.pc.ondatachannel = (e) => {
      if (e.channel.label === 'ctl') {
        this.ctlCh = e.channel;
        this.ctlCh.onmessage = (ev) => this.onCtlMessage(ev.data);
        this.ctlCh.onopen = () => this.onCtlOpen();
      } else if (e.channel.label === 'file') {
        this.fileCh = e.channel;
        this.fileCh.binaryType = 'arraybuffer';
        this.fileCh.bufferedAmountLowThreshold = FILE_HIGH_WATER / 2;
      }
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc && this.pc.connectionState;
      if (st === 'connected' && !this.connected) {
        this.connected = true;
        clearTimeout(this.giveUp);
        this.ui.viewerStarted(this);
        this.timers.push(setInterval(() => this.collectStats(), 1000));
      }
      if (st === 'disconnected') this.ui.viewerStatus('Reconnecting…');
      if (st === 'failed') this.close('Connection lost. If this keeps happening, configure a TURN server in Settings.', true);
    };

    await this.pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
    for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    const mac = await hmac(this.key, `answer|${this.nonce}|${fingerprints(answer.sdp)}`);
    this.relay({ kind: 'answer', sdp: answer.sdp, mac });
  }

  // ---------- control channel ----------
  send(obj) { if (this.ctlCh && this.ctlCh.readyState === 'open') this.ctlCh.send(JSON.stringify(obj)); }

  async onCtlOpen() {
    if (this.settings.clipboardSync) {
      this.lastClip = await window.rd.clipboardRead();
      this.timers.push(setInterval(async () => {
        const text = await window.rd.clipboardRead();
        if (text && text !== this.lastClip) { this.lastClip = text; this.send({ t: 'clip', text }); }
      }, 1000));
    }
  }

  onCtlMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'displays': this.ui.displays(m.list || [], m.current); break;
      case 'control': this.controlAllowed = !!m.allowed; this.ui.controlAllowed(this.controlAllowed); if (!this.controlAllowed) this.releaseKeys(); break;
      case 'clip':
        if (typeof m.text === 'string' && this.settings.clipboardSync) { this.lastClip = m.text; window.rd.clipboardWrite(m.text); }
        break;
      case 'chat': if (typeof m.text === 'string') this.ui.chat(this.hostName, m.text.slice(0, 4000)); break;
      case 'file-done': this.ui.toast(m.ok ? `Sent “${m.name}”. Saved in the partner's Downloads/RemoteDesk.` : `Sending “${m.name}” failed.`); break;
    }
  }

  setQuality(level) { this.send({ t: 'quality', level }); }
  setDisplay(id) { this.send({ t: 'display', id }); }
  sendChat(text) { this.send({ t: 'chat', text }); }
  sendCombo(codes) { if (this.controlAllowed) this.send({ t: 'combo', codes: codes.map((c) => this.mapCode(c)) }); }

  mapCode(code) {
    if (!this.swapCmdCtrl) return code;
    const swap = { ControlLeft: 'MetaLeft', ControlRight: 'MetaRight', MetaLeft: 'ControlLeft', MetaRight: 'ControlRight' };
    return swap[code] || code;
  }

  // ---------- input capture ----------
  attachInput(video) {
    const pos = (e) => {
      // Account for letterboxing (object-fit: contain).
      const r = video.getBoundingClientRect();
      const vw = video.videoWidth || r.width;
      const vh = video.videoHeight || r.height;
      const scale = Math.min(r.width / vw, r.height / vh);
      const w = vw * scale, h = vh * scale;
      const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
      const x = (e.clientX - ox) / w, y = (e.clientY - oy) / h;
      return { x, y, inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
    };
    const can = () => this.controlAllowed && this.ctlCh && this.ctlCh.readyState === 'open';
    const btn = (b) => (b === 0 ? 0 : b === 1 ? 1 : b === 2 ? 2 : -1);

    // Throttle mouse moves to ~120/s; always deliver the latest position.
    let pendingMove = null;
    let moveTimer = 0;
    let lastMoveAt = 0;
    const flushMove = () => {
      clearTimeout(moveTimer); moveTimer = 0;
      if (pendingMove) { this.send(pendingMove); pendingMove = null; lastMoveAt = performance.now(); }
    };

    const onMove = (e) => {
      if (!can()) return;
      const p = pos(e);
      if (!p.inside) return;
      pendingMove = { t: 'mm', x: p.x, y: p.y };
      const wait = 8 - (performance.now() - lastMoveAt);
      if (wait <= 0) flushMove();
      else if (!moveTimer) moveTimer = setTimeout(flushMove, wait);
    };
    const onDown = (e) => {
      if (!can()) return;
      const b = btn(e.button); const p = pos(e);
      if (b < 0 || !p.inside) return;
      e.preventDefault();
      video.focus();
      flushMove();
      this.send({ t: 'md', b, x: p.x, y: p.y });
    };
    const onUp = (e) => {
      if (!can()) return;
      const b = btn(e.button); if (b < 0) return;
      const p = pos(e);
      this.send({ t: 'mu', b, x: Math.min(Math.max(p.x, 0), 1), y: Math.min(Math.max(p.y, 0), 1) });
    };
    let accX = 0, accY = 0;
    const onWheel = (e) => {
      if (!can()) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      accX += e.deltaX * unit; accY += e.deltaY * unit;
      const ty = Math.trunc(accY / 100), tx = Math.trunc(accX / 100);
      if (ty || tx) { accY -= ty * 100; accX -= tx * 100; this.send({ t: 'wh', dx: tx, dy: ty }); }
    };
    const isTyping = (e) => {
      const el = e.target;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const onKeyDown = (e) => {
      if (!can() || isTyping(e)) return;
      // Ctrl+Alt+Shift+F = leave fullscreen locally instead of forwarding.
      if (e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyF') { window.rd.fullscreen(false); return; }
      e.preventDefault();
      const code = this.mapCode(e.code);
      this.pressed.add(code);
      this.send({ t: 'kd', code });
    };
    const onKeyUp = (e) => {
      if (!can() || isTyping(e)) return;
      e.preventDefault();
      const code = this.mapCode(e.code);
      this.pressed.delete(code);
      this.send({ t: 'ku', code });
    };
    const onBlur = () => this.releaseKeys();
    const noMenu = (e) => e.preventDefault();

    video.addEventListener('pointermove', onMove);
    video.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    video.addEventListener('wheel', onWheel, { passive: false });
    video.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);

    this.cleanupInput = () => {
      video.removeEventListener('pointermove', onMove);
      video.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      video.removeEventListener('wheel', onWheel);
      video.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      clearTimeout(moveTimer);
    };
  }

  releaseKeys() {
    for (const code of this.pressed) this.send({ t: 'ku', code });
    this.pressed.clear();
  }

  // ---------- file transfer ----------
  async sendFile(file) {
    if (!this.fileCh || this.fileCh.readyState !== 'open') return this.ui.toast('File channel is not ready yet.');
    if (this.sendingFile) return this.ui.toast('Please wait for the current file to finish.');
    this.sendingFile = true;
    const ch = this.fileCh;
    try {
      ch.send(JSON.stringify({ t: 'begin', name: file.name, size: file.size }));
      let offset = 0;
      while (offset < file.size) {
        if (this.closed || ch.readyState !== 'open') throw new Error('closed');
        if (ch.bufferedAmount > FILE_HIGH_WATER) {
          await new Promise((res) => { ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; res(); }; });
        }
        const buf = await file.slice(offset, offset + FILE_CHUNK).arrayBuffer();
        ch.send(buf);
        offset += buf.byteLength;
        this.ui.fileProgress(file.name, offset / file.size);
      }
      ch.send(JSON.stringify({ t: 'end' }));
      this.ui.fileProgress(file.name, 1);
    } catch {
      try { ch.send(JSON.stringify({ t: 'end', cancelled: true })); } catch {}
      this.ui.fileProgress(file.name, -1);
    } finally {
      this.sendingFile = false;
    }
  }

  // ---------- stats ----------
  async collectStats() {
    if (!this.pc) return;
    const stats = await this.pc.getStats();
    let fps = 0, bytes = 0, w = 0, h = 0, rtt = null, route = '';
    let pairId = null;
    const byId = new Map();
    stats.forEach((s) => {
      byId.set(s.id, s);
      if (s.type === 'inbound-rtp' && s.kind === 'video') { fps = s.framesPerSecond || 0; bytes = s.bytesReceived || 0; w = s.frameWidth || 0; h = s.frameHeight || 0; }
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    if (!pairId) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id; });
    const pair = pairId && byId.get(pairId);
    if (pair) {
      rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
      const local = byId.get(pair.localCandidateId);
      const remote = byId.get(pair.remoteCandidateId);
      route = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay') ? 'Relayed' : 'Direct';
    }
    const now = performance.now();
    const kbps = this.lastBytes != null ? Math.round(((bytes - this.lastBytes) * 8) / (now - this.lastT)) : 0;
    this.lastBytes = bytes; this.lastT = now;
    this.ui.stats({ fps: Math.round(fps), kbps, rtt, route, res: w && h ? `${w}×${h}` : '' });
  }

  close(reason, notifyServer) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.giveUp);
    this.timers.forEach(clearInterval);
    this.releaseKeys();
    if (this.cleanupInput) this.cleanupInput();
    if (this.pc) { try { this.pc.close(); } catch {} }
    if (notifyServer && this.sid) this.sig.end(this.sid, reason);
    this.key = null;
    this.ui.viewerEnded(this, reason);
  }
}
