// WebSocket connection to the signaling server, with automatic reconnect.
export class Signaling extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.retry = 0;
    this.closedByUser = false;
    this.connect();
  }

  get online() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) {
      this.emit('status', { online: false, error: 'Invalid server URL' });
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.emit('status', { online: true }); this.emit('open'); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.emit('message', msg);
    };
    ws.onclose = () => {
      this.emit('status', { online: false });
      this.emit('close');
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  scheduleReconnect() {
    const delay = Math.min(15000, 500 * 2 ** this.retry++);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
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
