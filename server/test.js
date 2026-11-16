// Integration test for the signaling server.
const assert = require('assert');
const os = require('os');
const path = require('path');
process.env.DATA_FILE = path.join(os.tmpdir(), `rd-ids-${Date.now()}.json`);
const WebSocket = require('ws');
const { server, wss } = require('./index');

function client(port) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      const i = ws.waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) ws.waiters.splice(i, 1)[0].res(m); else ws.inbox.push(m);
    });
    ws.next = (type) => new Promise((r, rej) => {
      const i = ws.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return r(ws.inbox.splice(i, 1)[0]);
      const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), 2000);
      ws.waiters.push({ type, res: (m) => { clearTimeout(t); r(m); } });
    });
    ws.json = (m) => ws.send(JSON.stringify(m));
    ws.on('open', () => res(ws));
  });
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // Host registers -> gets 9-digit ID + token
  const host = await client(port);
  host.json({ type: 'register' });
  const reg = await host.next('registered');
  assert.match(reg.id, /^\d{9}$/);
  assert.match(reg.token, /^[0-9a-f]{64}$/);

  // Viewer: offline target
  const viewer = await client(port);
  viewer.json({ type: 'connect', target: '000000001' });
  assert.strictEqual((await viewer.next('error')).code, 'offline');

  // Viewer connects; relay works both ways
  viewer.json({ type: 'connect', target: reg.id.replace(/(\d{3})/g, '$1 ') });
  const { sid } = await viewer.next('pending');
  const inc = await host.next('incoming');
  assert.strictEqual(inc.sid, sid);
  host.json({ type: 'relay', sid, payload: { kind: 'hello', nonce: 'abc' } });
  assert.deepStrictEqual((await viewer.next('relay')).payload, { kind: 'hello', nonce: 'abc' });
  viewer.json({ type: 'relay', sid, payload: { kind: 'auth', mac: 'x' } });
  assert.strictEqual((await host.next('relay')).payload.kind, 'auth');

  // A third party can't inject into the session
  const intruder = await client(port);
  intruder.json({ type: 'relay', sid, payload: { kind: 'evil' } });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!host.inbox.some((m) => m.type === 'relay'));

  // End propagates
  viewer.json({ type: 'end', sid, reason: 'bye' });
  assert.strictEqual((await host.next('ended')).reason, 'bye');

  // Hijack: registering the same ID without the token gives a NEW id
  const thief = await client(port);
  thief.json({ type: 'register', id: reg.id, token: 'f'.repeat(64) });
  const treg = await thief.next('registered');
  assert.notStrictEqual(treg.id, reg.id);

  // Reconnect with the token keeps the same ID and kicks the old socket
  const host2 = await client(port);
  host2.json({ type: 'register', id: reg.id, token: reg.token });
  assert.strictEqual((await host2.next('registered')).id, reg.id);
  assert.strictEqual((await host.next('error')).code, 'replaced');

  // Host going offline ends viewer session
  viewer.json({ type: 'connect', target: reg.id });
  const p2 = await viewer.next('pending');
  await host2.next('incoming');
  host2.close();
  const ended = await viewer.next('ended');
  assert.strictEqual(ended.sid, p2.sid);

  console.log('server ok');
  for (const c of [viewer, intruder, thief]) c.close();
  wss.close();
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
