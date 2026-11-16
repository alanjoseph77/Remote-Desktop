// Host side: the computer being controlled.
import { hmac, randomHex, safeEqual, fingerprints } from './crypto.js';

export const QUALITY = {
  best: { maxBitrate: 8_000_000, maxFramerate: 30, scaleResolutionDownBy: 1, pref: 'maintain-resolution' },
  balanced: { maxBitrate: 3_000_000, maxFramerate: 30, scaleResolutionDownBy: 1, pref: 'maintain-resolution' },
  fast: { maxBitrate: 1_200_000, maxFramerate: 20, scaleResolutionDownBy: 1.5, pref: 'balanced' },
};

export class HostController {
  /**
   * @param {object} o
   * @param {import('./signaling.js').Signaling} o.sig
   * @param {() => {hostId:string, temp:Uint8Array|null, perm:Uint8Array|null, settings:object, info:object}} o.state
   * @param {object} o.ui callbacks
   */
  constructor({ sig, state, ui }) {
    this.sig = sig;
    this.state = state;
    this.ui = ui;
    this.sessions = new Map(); // sid -> HostSession (pending or active)
    this.active = null;
    this.fails = [];
    this.lockedUntil = 0;
  }

  onIncoming(sid) {
    const now = Date.now();
    if (this.active) return this.reject(sid, 'Partner is already in another session.');
    if (now < this.lockedUntil) return this.reject(sid, 'Too many wrong passwords. Try again later.');
    if (this.sessions.size >= 3) return this.reject(sid, 'Partner is busy.');
    const s = new HostSession(this, sid);
    this.sessions.set(sid, s);
    s.start();
  }

  onRelay(sid, payload) { const s = this.sessions.get(sid); if (s) s.onPayload(payload); }
  onEnded(sid, reason) { const s = this.sessions.get(sid); if (s) s.close(reason, false); }

  reject(sid, reason) {
    this.sig.relay(sid, { kind: 'reject', reason });
    this.sig.end(sid, reason);
  }

  recordFailure() {
    const now = Date.now();
    this.fails = this.fails.filter((t) => now - t < 5 * 60_000);
    this.fails.push(now);
    if (this.fails.length >= 5) {
      // Exponential lockout: 1 min, 2 min, 4 min, ...
      this.lockedUntil = now + 60_000 * 2 ** (this.fails.length - 5);
    }
  }

  disconnectAll(reason = 'Host ended the session.') {
    for (const s of [...this.sessions.values()]) s.close(reason, true);
  }
}

class HostSession {
  constructor(ctl, sid) {
    this.ctl = ctl;
    this.sid = sid;
    this.nonce = randomHex(32);
    this.key = null;
    this.peerName = 'Partner';
    this.pc = null;
    this.ctlCh = null;
    this.fileCh = null;
    this.stream = null;
    this.sender = null;
    this.displayId = null;
    this.allowControl = true;
    this.quality = 'balanced';
    this.closed = false;
    this.lastClip = null;
    this.clipTimer = null;
    this.fileQueue = Promise.resolve();
    this.incomingFile = null;
    // Unauthenticated sessions expire quickly.
    this.authTimer = setTimeout(() => this.close('Authentication timed out.', true), 60_000);
  }

  get sig() { return this.ctl.sig; }
  get ui() { return this.ctl.ui; }
  relay(payload) { this.sig.relay(this.sid, payload); }

  start() {
    const { settings, info } = this.ctl.state();
    this.relay({ kind: 'hello', nonce: this.nonce, name: settings.deviceName, platform: info.platform });
  }

  async onPayload(p) {
    if (!p || this.closed) return;
    try {
      switch (p.kind) {
        case 'auth': return await this.onAuth(p);
        case 'answer': return await this.onAnswer(p);
        case 'ice': if (this.pc && p.c) await this.pc.addIceCandidate(p.c).catch(() => {}); return;
      }
    } catch (e) {
      this.close('Connection error: ' + (e.message || e), true);
    }
  }

  async onAuth(p) {
    if (this.key) return; // already authenticated
    const { hostId, temp, perm, settings } = this.ctl.state();
    const msg = `auth|${this.nonce}|${hostId}`;
    let matched = null;
    if (temp && safeEqual(await hmac(temp, msg), p.mac)) matched = 'temp';
    else if (perm && safeEqual(await hmac(perm, msg), p.mac)) matched = 'perm';

    if (!matched) {
      this.ctl.recordFailure();
      this.relay({ kind: 'reject', reason: 'Wrong password.' });
      return this.close('Wrong password.', true, true);
    }
    this.key = matched === 'temp' ? temp : perm;
    this.peerName = String(p.name || 'Partner').slice(0, 64);
    clearTimeout(this.authTimer);

    // Unattended (permanent) password skips the prompt; the temporary one asks if enabled.
    if (settings.askConsent && matched === 'temp') {
      this.relay({ kind: 'waiting' });
      const ok = await this.ui.askConsent(this.peerName);
      if (this.closed) return;
      if (!ok) {
        this.relay({ kind: 'reject', reason: 'Partner declined the connection.' });
        return this.close('Declined.', true, true);
      }
    }
    if (this.ctl.active) {
      this.relay({ kind: 'reject', reason: 'Partner is already in another session.' });
      return this.close('Busy.', true, true);
    }
    this.ctl.active = this;
    await this.startMedia();
  }

  async startMedia() {
    const { settings, info } = this.ctl.state();
    const displays = await window.rd.displays();
    const primary = displays.find((d) => d.primary) || displays[0];
    this.displayId = primary ? primary.id : null;
    this.stream = await this.capture(this.displayId);

    this.pc = new RTCPeerConnection({ iceServers: settings.iceServers || [] });
    this.pc.onicecandidate = (e) => { if (e.candidate) this.relay({ kind: 'ice', c: e.candidate.toJSON() }); };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc && this.pc.connectionState;
      if (st === 'failed') this.close('Connection lost.', true);
      if (st === 'connected') this.ui.hostConnected && this.ui.hostConnected(this);
    };

    const track = this.stream.getVideoTracks()[0];
    const tx = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [this.stream] });
    this.sender = tx.sender;

    this.ctlCh = this.pc.createDataChannel('ctl', { ordered: true });
    this.ctlCh.onopen = () => this.onCtlOpen();
    this.ctlCh.onmessage = (e) => this.onCtlMessage(e.data);
    this.fileCh = this.pc.createDataChannel('file', { ordered: true });
    this.fileCh.binaryType = 'arraybuffer';
    this.fileCh.onmessage = (e) => this.onFileMessage(e.data);

    await window.rd.setInputEnabled(true, this.displayId);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const mac = await hmac(this.key, `offer|${this.nonce}|${fingerprints(offer.sdp)}`);
    const acceptMac = await hmac(this.key, `accepted|${this.nonce}`);
    this.relay({ kind: 'accepted', mac: acceptMac, platform: info.platform, name: settings.deviceName });
    this.relay({ kind: 'offer', sdp: offer.sdp, mac });
    this.ui.hostSessionStarted(this);
  }

  async capture(displayId) {
    await window.rd.selectCapture(displayId);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, cursor: 'always' },
      audio: false,
    });
    const t = stream.getVideoTracks()[0];
    if (t) t.contentHint = 'detail'; // keep text sharp
    return stream;
  }

  async onAnswer(p) {
    if (!this.pc || this.pc.remoteDescription) return;
    const expect = await hmac(this.key, `answer|${this.nonce}|${fingerprints(p.sdp)}`);
    if (!safeEqual(expect, p.mac)) return this.close('Security check failed (answer signature).', true);
    await this.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
    await this.applyQuality(this.quality);
  }

  async applyQuality(level) {
    const q = QUALITY[level];
    if (!q || !this.sender) return;
    this.quality = level;
    const params = this.sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = q.maxBitrate;
    params.encodings[0].maxFramerate = q.maxFramerate;
    params.encodings[0].scaleResolutionDownBy = q.scaleResolutionDownBy;
    params.degradationPreference = q.pref;
    try { await this.sender.setParameters(params); } catch { /* not all browsers allow every field */ }
  }

  async onCtlOpen() {
    const displays = await window.rd.displays();
    this.send({ t: 'displays', list: displays, current: this.displayId });
    this.send({ t: 'control', allowed: this.allowControl });
    const { settings } = this.ctl.state();
    if (settings.clipboardSync) {
      this.lastClip = await window.rd.clipboardRead();
      this.clipTimer = setInterval(async () => {
        const text = await window.rd.clipboardRead();
        if (text && text !== this.lastClip) { this.lastClip = text; this.send({ t: 'clip', text }); }
      }, 1000);
    }
  }

  send(obj) { if (this.ctlCh && this.ctlCh.readyState === 'open') this.ctlCh.send(JSON.stringify(obj)); }

  async onCtlMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'mm': case 'md': case 'mu': case 'wh': case 'kd': case 'ku': case 'combo':
        if (this.allowControl) window.rd.input(m);
        break;
      case 'clip':
        if (typeof m.text === 'string' && this.ctl.state().settings.clipboardSync) {
          this.lastClip = m.text;
          window.rd.clipboardWrite(m.text);
        }
        break;
      case 'chat':
        if (typeof m.text === 'string') this.ui.chat(this.peerName, m.text.slice(0, 4000));
        break;
      case 'quality':
        await this.applyQuality(m.level);
        break;
      case 'display':
        await this.switchDisplay(String(m.id));
        break;
    }
  }

  async switchDisplay(id) {
    const displays = await window.rd.displays();
    if (!displays.some((d) => d.id === id) || id === this.displayId) return;
    const next = await this.capture(id);
    await this.sender.replaceTrack(next.getVideoTracks()[0]);
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = next;
    this.displayId = id;
    await window.rd.setInputDisplay(id);
    await this.applyQuality(this.quality);
    this.send({ t: 'displays', list: displays, current: id });
  }

  setAllowControl(on) {
    this.allowControl = !!on;
    window.rd.setInputEnabled(this.allowControl, this.displayId);
    this.send({ t: 'control', allowed: this.allowControl });
  }

  sendChat(text) { this.send({ t: 'chat', text }); }

  // File transfer: JSON header, binary chunks, JSON footer. Writes are serialized.
  onFileMessage(data) {
    this.fileQueue = this.fileQueue.then(async () => {
      if (typeof data === 'string') {
        let m;
        try { m = JSON.parse(data); } catch { return; }
        if (m.t === 'begin') {
          const token = await window.rd.fileBegin(m.name, m.size);
          this.incomingFile = { token, name: m.name, ok: true };
        } else if (m.t === 'end' && this.incomingFile) {
          const f = this.incomingFile;
          this.incomingFile = null;
          const saved = await window.rd.fileEnd(f.token, f.ok && !m.cancelled);
          this.send({ t: 'file-done', name: f.name, ok: !!saved });
          if (saved) this.ui.fileReceived(f.name, saved);
        }
      } else if (this.incomingFile && this.incomingFile.ok) {
        const ok = await window.rd.fileChunk(this.incomingFile.token, data);
        if (!ok) this.incomingFile.ok = false;
      }
    }).catch(() => {});
  }

  close(reason, notifyServer, silent = false) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    clearInterval(this.clipTimer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.pc) { try { this.pc.close(); } catch {} }
    this.ctl.sessions.delete(this.sid);
    if (notifyServer) this.sig.end(this.sid, reason);
    if (this.ctl.active === this) {
      this.ctl.active = null;
      window.rd.setInputEnabled(false);
      this.ui.hostSessionEnded(this, reason);
    } else if (!silent && this.key) {
      this.ui.toast(reason);
    }
  }
}
