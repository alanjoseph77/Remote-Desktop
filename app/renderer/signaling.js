// WebSocket connection to the signaling server, with automatic reconnect.
const CONNECT_TIMEOUT_MS = 8000;

export class Signaling extends EventTarget {
  // diagnose(url) -> Promise<{ short, reason }>: explains why a connection failed
  // (the browser WebSocket API itself never says).
  constructor(url, { diagnose } = {}) {
    super();
    this.url = url;
    this.diagnose = diagnose;
    this.ws = null;
    this.retry = 0;
    this.closedByUser = false;
    this.connect();
  }

  get online() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) {
      this.emit('status', { online: false, error: 'Invalid server URL', reason: `"${this.url}" is not a valid ws:// or wss:// URL. Fix it in Settings.` });
      return this.scheduleReconnect();
    }
    this.ws = ws;
    let opened = false;
    // Without this, a firewall that silently drops packets leaves us "connecting" for ~20 s+.
    const timer = setTimeout(() => { if (!opened) ws.close(); }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => { opened = true; clearTimeout(timer); this.retry = 0; this.emit('status', { online: true }); this.emit('open'); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.emit('message', msg);
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      if (this.closedByUser) { this.emit('close'); return; }
      const delay = this.scheduleReconnect();
      const retryIn = `Retrying in ${Math.round(delay / 1000)} s.`;
      if (opened) {
        this.emit('status', { online: false, error: 'Offline — reconnecting', reason: `Lost connection to ${this.url} (code ${e.code}). ${retryIn}` });
      } else {
        this.emit('status', { online: false, error: 'Offline — connecting…', reason: `Cannot connect to ${this.url}. ${retryIn}` });
        if (this.diagnose) {
          this.diagnose(this.url).then((d) => {
            // Ignore the result if we reconnected or were closed meanwhile.
            if (!d || this.closedByUser || this.online) return;
            this.emit('status', { online: false, error: `Offline — ${d.short || 'cannot connect'}`, reason: `${d.reason} ${retryIn}` });
          }).catch(() => {});
        }
      }
      this.emit('close');
    };
    ws.onerror = () => {};
  }

  scheduleReconnect() {
    const delay = Math.min(15000, 500 * 2 ** this.retry++);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
    return delay;
  }

  send(msg) { if (this.online) this.ws.send(JSON.stringify(msg)); }
  relay(sid, payload) { this.send({ type: 'relay', sid, payload }); }
  end(sid, reason) { this.send({ type: 'end', sid, reason }); }

  close() {
    this.closedByUser = true;
    clearTimeout(this.timer);
    if (this.ws) this.ws.close();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
