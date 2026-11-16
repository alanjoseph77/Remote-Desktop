'use strict';
/**
 * RemoteDesk signaling server
 *
 * - Hosts register and get a permanent 9-digit ID (bound to a secret token so
 *   nobody else can take over the ID later).
 * - Viewers ask to connect to an ID; the server opens a session and relays
 *   messages between the two sides. Authentication (password challenge) and
 *   WebRTC offer/answer happen end-to-end THROUGH this relay: the server never
 *   sees the password, and the SDP fingerprints are signed with a key derived
 *   from it, so the server can't man-in-the-middle the media stream.
 *
 * Run behind TLS (wss://) in production, e.g. with Caddy or nginx.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'ids.json');
const MAX_PAYLOAD = 256 * 1024;
const CONNECT_LIMIT_PER_MIN = 20;

// ---------- ID registry (id -> sha256(token)) ----------
let registry = {};
try { registry = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { registry = {}; }
let saveTimer = null;
function saveRegistry() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(registry), () => {});
  }, 200);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function newId() {
  let id;
  do { id = String(crypto.randomInt(100000000, 1000000000)); } while (registry[id]);
  return id;
}

// ---------- live state ----------
const hosts = new Map();    // id -> ws
const sessions = new Map(); // sid -> { host: ws, viewer: ws, hostId }
const connectHits = new Map(); // ip -> [timestamps]

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function rateLimited(ip) {
  const now = Date.now();
  const hits = (connectHits.get(ip) || []).filter((t) => now - t < 60000);
  hits.push(now);
  connectHits.set(ip, hits);
  return hits.length > CONNECT_LIMIT_PER_MIN;
}

function endSession(sid, reason, from) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  for (const side of [s.host, s.viewer]) {
    if (side !== from) send(side, { type: 'ended', sid, reason });
    side.sessions && side.sessions.delete(sid);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, hosts: hosts.size, sessions: sessions.size }));
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('RemoteDesk signaling server is running.\n');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  ws.ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.sessions = new Set();
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'register': {
        if (ws.hostId) return;
        let id = typeof msg.id === 'string' && /^\d{9}$/.test(msg.id) ? msg.id : null;
        let token = typeof msg.token === 'string' ? msg.token : null;
        // Re-use the stored ID only if the token proves ownership.
        if (!(id && token && registry[id] === sha256(token))) {
          id = newId();
          token = crypto.randomBytes(32).toString('hex');
          registry[id] = sha256(token);
          saveRegistry();
        }
        const existing = hosts.get(id);
        if (existing && existing !== ws) {
          send(existing, { type: 'error', code: 'replaced', message: 'This ID was opened on another instance.' });
          existing.close();
        }
        ws.hostId = id;
        hosts.set(id, ws);
        send(ws, { type: 'registered', id, token });
        break;
      }

      case 'connect': {
        const target = String(msg.target || '').replace(/\D/g, '');
        if (rateLimited(ws.ip)) return send(ws, { type: 'error', code: 'rate', message: 'Too many attempts. Wait a minute.' });
        const host = hosts.get(target);
        if (!host) return send(ws, { type: 'error', code: 'offline', message: 'Partner is not online.' });
        if (host === ws) return send(ws, { type: 'error', code: 'self', message: "You can't connect to yourself." });
        const sid = crypto.randomUUID();
        sessions.set(sid, { host, viewer: ws, hostId: target });
        host.sessions.add(sid);
        ws.sessions.add(sid);
        send(ws, { type: 'pending', sid });
        send(host, { type: 'incoming', sid, ip: ws.ip });
        break;
      }

      case 'relay': {
        const s = sessions.get(msg.sid);
        if (!s) return;
        const other = ws === s.host ? s.viewer : ws === s.viewer ? s.host : null;
        if (!other) return;
        send(other, { type: 'relay', sid: msg.sid, payload: msg.payload });
        break;
      }

      case 'end': {
        const s = sessions.get(msg.sid);
        if (s && (s.host === ws || s.viewer === ws)) endSession(msg.sid, msg.reason || 'Partner disconnected.', ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.hostId && hosts.get(ws.hostId) === ws) hosts.delete(ws.hostId);
    for (const sid of [...ws.sessions]) endSession(sid, 'Partner went offline.', ws);
  });
});

// Heartbeat: drop dead sockets so IDs don't stay "online" forever.
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(hb));

if (require.main === module) {
  server.listen(PORT, () => console.log(`RemoteDesk signaling server on :${PORT}`));
}
module.exports = { server, wss };
