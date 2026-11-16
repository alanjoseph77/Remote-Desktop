'use strict';
const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, screen, clipboard,
  systemPreferences, Notification, shell, powerSaveBlocker,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const keymap = require('./src/keymap');

// ---------- input injection (nut-js) ----------
let nut = null;
let nutError = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.mouse.config.mouseSpeed = 100000;
  nut.keyboard.config.autoDelayMs = 0;
} catch (e) {
  nutError = String(e && e.message || e);
}

// Optional separate profile, e.g. to run two instances on one machine for testing.
if (process.env.REMOTEDESK_PROFILE) app.setPath('userData', path.resolve(process.env.REMOTEDESK_PROFILE));

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = {
  serverUrl: 'ws://localhost:8080',
  hostId: null,
  hostToken: null,
  permanentKey: null, // base64 PBKDF2-derived key (the password itself is never stored)
  permanentKeyId: null, // host ID the key was derived for
  askConsent: true,
  clipboardSync: true,
  deviceName: os.hostname(),
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
let settings = { ...defaults };
function loadSettings() {
  try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...defaults }; }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

let win = null;
let captureDisplayId = null;
let inputEnabled = false;
let inputDisplayId = null;
let psbId = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'RemoteDesk',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Never let the app navigate away or open arbitrary windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  loadSettings();

  // getDisplayMedia() in the renderer is answered with the display chosen via IPC,
  // so the host never sees a picker and the viewer can switch monitors remotely.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const pick = sources.find((s) => String(s.display_id) === String(captureDisplayId)) || sources[0];
      callback(pick ? { video: pick } : {});
    } catch {
      callback({});
    }
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { releaseAll(); if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC: settings / info ----------
ipcMain.handle('settings:get', () => ({ ...settings }));
ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = ['serverUrl', 'hostId', 'hostToken', 'permanentKey', 'permanentKeyId', 'askConsent', 'clipboardSync', 'deviceName', 'iceServers'];
  for (const k of Object.keys(patch || {})) if (allowed.includes(k)) settings[k] = patch[k];
  saveSettings();
  return { ...settings };
});
// The renderer's WebSocket API hides why a connection failed (it only fires a
// bare "error" + close code 1006). Probe the same host:port from Node to get
// the real reason: refused, timeout, DNS, TLS, ...
ipcMain.handle('server:probe', (_e, wsUrl) => new Promise((resolve) => {
  let u;
  try { u = new URL(String(wsUrl)); } catch { return resolve({ ok: false, short: 'invalid URL', reason: 'Invalid server URL.' }); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return resolve({ ok: false, short: 'invalid URL', reason: 'Server URL must start with ws:// or wss://' });
  const secure = u.protocol === 'wss:';
  const port = u.port || (secure ? 443 : 80);
  const where = `${u.hostname}:${port}`;
  const mod = require(secure ? 'https' : 'http');
  let done = false;
  const finish = (r) => { if (!done) { done = true; resolve(r); } };
  const req = mod.get({ hostname: u.hostname, port, path: '/health', timeout: 5000 }, (res) => {
    res.resume();
    finish({ ok: true, short: 'WebSocket rejected', reason: `Server at ${where} is reachable (HTTP ${res.statusCode}) but the WebSocket was rejected — is it a RemoteDesk server?` });
  });
  req.on('timeout', () => {
    req.destroy();
    finish({ ok: false, code: 'ETIMEDOUT', short: 'timeout', reason: `Timed out reaching ${where} — firewall on the server PC is blocking port ${port}, wrong IP, or a different network.` });
  });
  req.on('error', (err) => {
    const c = err.code || '';
    let reason, short = 'cannot connect';
    if (c === 'ECONNREFUSED') short = 'connection refused', reason = `Connection refused by ${where} — the signaling server is not running there (or not on port ${port}).`;
    else if (c === 'ETIMEDOUT') short = 'timeout', reason = `Timed out reaching ${where} — firewall blocking port ${port}, or wrong IP.`;
    else if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') short = 'DNS error', reason = `DNS: cannot resolve "${u.hostname}". Check the server address.`;
    else if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') short = 'host unreachable', reason = `Host ${where} is unreachable — not on the same network?`;
    else if (c === 'ECONNRESET') short = 'connection reset', reason = `Connection to ${where} was reset${secure ? ' — the server may not support TLS (try ws://)' : ''}.`;
    else if (/CERT|SSL|TLS|SELF_SIGNED|EPROTO/i.test(c + ' ' + err.message)) short = 'TLS error', reason = `TLS error with ${where}: ${String(err.message).split(':error:')[0]}${secure ? ' (for a plain LAN server use ws:// not wss://)' : ''}`;
    else reason = `Cannot reach ${where}: ${c || err.message}`;
    finish({ ok: false, code: c, short, reason });
  });
}));

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  hostname: os.hostname(),
  version: app.getVersion(),
  inputAvailable: !!nut,
  inputError: nutError,
  wayland: process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY),
}));

ipcMain.handle('displays:list', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: d.label || `Display ${i + 1}`,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.id === primary,
  }));
});
ipcMain.handle('capture:select', (_e, displayId) => { captureDisplayId = displayId; return true; });

// ---------- IPC: permissions (macOS) ----------
ipcMain.handle('perms:status', () => {
  if (process.platform !== 'darwin') return { screen: 'granted', accessibility: true };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
});
ipcMain.handle('perms:request', () => {
  if (process.platform === 'darwin') {
    systemPreferences.isTrustedAccessibilityClient(true);
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
  return true;
});

// ---------- IPC: window ----------
ipcMain.handle('window:fullscreen', (_e, on) => { if (win) win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on); return win && win.isFullScreen(); });
ipcMain.handle('window:attention', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.flashFrame(true);
});
ipcMain.handle('notify', (_e, title, body) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
});

// ---------- IPC: clipboard ----------
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', (_e, text) => { if (typeof text === 'string' && text.length < 1_000_000) clipboard.writeText(text); });

// ---------- IPC: input injection (host side) ----------
const queue = [];
let busy = false;
const held = { keys: new Set(), buttons: new Set() };

function toScreenPoint(nx, ny) {
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => String(x.id) === String(inputDisplayId)) || screen.getPrimaryDisplay();
  const cx = Math.min(Math.max(nx, 0), 0.9999);
  const cy = Math.min(Math.max(ny, 0), 0.9999);
  let p = { x: Math.round(d.bounds.x + cx * d.bounds.width), y: Math.round(d.bounds.y + cy * d.bounds.height) };
  // Windows/Linux injection works in physical pixels; macOS works in points (= DIP).
  if (process.platform !== 'darwin' && typeof screen.dipToScreenPoint === 'function') p = screen.dipToScreenPoint(p);
  return new nut.Point(p.x, p.y);
}

const BUTTONS = () => [nut.Button.LEFT, nut.Button.MIDDLE, nut.Button.RIGHT];

async function apply(ev) {
  const { mouse, keyboard, Key } = nut;
  switch (ev.t) {
    case 'mm': await mouse.setPosition(toScreenPoint(ev.x, ev.y)); break;
    case 'md': { const b = BUTTONS()[ev.b]; if (b === undefined) break; if (ev.x !== undefined) await mouse.setPosition(toScreenPoint(ev.x, ev.y)); await mouse.pressButton(b); held.buttons.add(ev.b); break; }
    case 'mu': { const b = BUTTONS()[ev.b]; if (b === undefined) break; if (ev.x !== undefined) await mouse.setPosition(toScreenPoint(ev.x, ev.y)); await mouse.releaseButton(b); held.buttons.delete(ev.b); break; }
    case 'wh': {
      const dy = Math.max(-20, Math.min(20, ev.dy | 0));
      const dx = Math.max(-20, Math.min(20, ev.dx | 0));
      if (dy > 0) await mouse.scrollDown(dy); else if (dy < 0) await mouse.scrollUp(-dy);
      if (dx > 0) await mouse.scrollRight(dx); else if (dx < 0) await mouse.scrollLeft(-dx);
      break;
    }
    case 'kd': case 'ku': {
      const name = keymap[ev.code];
      if (!name || Key[name] === undefined) break;
      if (ev.t === 'kd') { await keyboard.pressKey(Key[name]); held.keys.add(name); }
      else { await keyboard.releaseKey(Key[name]); held.keys.delete(name); }
      break;
    }
    case 'combo': {
      const names = (ev.codes || []).map((c) => keymap[c]).filter((n) => n && Key[n] !== undefined);
      if (!names.length) break;
      await keyboard.pressKey(...names.map((n) => Key[n]));
      await keyboard.releaseKey(...names.reverse().map((n) => Key[n]));
      break;
    }
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const ev = queue.shift();
      try { await apply(ev); } catch { /* ignore single failed event */ }
    }
  } finally { busy = false; }
}

ipcMain.on('input:event', (_e, ev) => {
  if (!nut || !inputEnabled || !ev || typeof ev.t !== 'string') return;
  // Coalesce mouse moves so a slow injector never lags behind the viewer.
  if (ev.t === 'mm' && queue.length && queue[queue.length - 1].t === 'mm') queue[queue.length - 1] = ev;
  else if (queue.length < 500) queue.push(ev);
  pump();
});

async function releaseAll() {
  queue.length = 0;
  if (!nut) return;
  const { keyboard, mouse, Key } = nut;
  for (const name of held.keys) { try { await keyboard.releaseKey(Key[name]); } catch {} }
  for (const b of held.buttons) { try { await mouse.releaseButton(BUTTONS()[b]); } catch {} }
  held.keys.clear();
  held.buttons.clear();
}

ipcMain.handle('input:setEnabled', async (_e, on, displayId) => {
  inputEnabled = !!on;
  if (displayId !== undefined) inputDisplayId = displayId;
  if (!inputEnabled) await releaseAll();
  // Keep the host awake while someone is connected.
  if (inputEnabled && psbId === null) psbId = powerSaveBlocker.start('prevent-display-sleep');
  if (!inputEnabled && psbId !== null) { powerSaveBlocker.stop(psbId); psbId = null; }
  return inputEnabled;
});
ipcMain.handle('input:display', (_e, displayId) => { inputDisplayId = displayId; return true; });

// ---------- IPC: incoming file transfer (host side) ----------
const transfers = new Map();
function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 200);
  return base && base !== '.' && base !== '..' ? base : 'file';
}
ipcMain.handle('file:begin', (_e, name, size) => {
  const dir = path.join(app.getPath('downloads'), 'RemoteDesk');
  fs.mkdirSync(dir, { recursive: true });
  const n = safeName(name);
  const ext = path.extname(n);
  const stem = n.slice(0, n.length - ext.length);
  let target = path.join(dir, n);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
  const token = crypto.randomUUID();
  transfers.set(token, { fd: fs.openSync(target, 'wx'), target, size: Number(size) || 0, written: 0 });
  return token;
});
ipcMain.handle('file:chunk', (_e, token, data) => {
  const t = transfers.get(token);
  if (!t) return false;
  const buf = Buffer.from(data);
  if (t.size && t.written + buf.length > t.size) return false;
  fs.writeSync(t.fd, buf);
  t.written += buf.length;
  return true;
});
ipcMain.handle('file:end', (_e, token, ok) => {
  const t = transfers.get(token);
  if (!t) return null;
  transfers.delete(token);
  fs.closeSync(t.fd);
  if (!ok) { try { fs.unlinkSync(t.target); } catch {} return null; }
  return t.target;
});
ipcMain.handle('file:show', (_e, p) => { if (p) shell.showItemInFolder(p); });
