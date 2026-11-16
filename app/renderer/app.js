// UI wiring: home screen (host + connect), session view, chat, settings.
import { Signaling } from './signaling.js';
import { HostController } from './host.js';
import { ViewerSession } from './viewer.js';
import { deriveKey, makePassword, toB64, fromB64 } from './crypto.js';

const $ = (id) => document.getElementById(id);
const rd = window.rd;

let settings = await rd.getSettings();
const info = await rd.info();
let sig = null;
let hostId = null;
let tempPassword = makePassword();
let tempKey = null;
let viewer = null;
let chatTarget = null; // HostSession or ViewerSession

// ---------- helpers ----------
const fmtId = (id) => (id ? String(id).replace(/(\d{3})(?=\d)/g, '$1 ') : '— — —');

function toast(text, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  if (action) {
    const a = document.createElement('a');
    a.textContent = ' ' + action.label;
    a.onclick = action.run;
    el.append(a);
  }
  $('toasts').append(el);
  setTimeout(() => el.remove(), action ? 9000 : 5000);
}

function permKey() {
  if (!settings.permanentKey || settings.permanentKeyId !== hostId) return null;
  try { return fromB64(settings.permanentKey); } catch { return null; }
}

function updateUnattendedNote() {
  const has = !!settings.permanentKey;
  const valid = has && settings.permanentKeyId === hostId;
  $('unattended-note').textContent = !has ? 'Unattended access is off. Set a password in Settings to enable it.'
    : valid ? 'Unattended access is on (no prompt with the unattended password).'
    : 'Your ID changed — set the unattended password again in Settings.';
}

async function refreshTempKey() {
  $('my-password').textContent = tempPassword;
  tempKey = hostId ? await deriveKey(tempPassword, hostId) : null;
}

// ---------- warnings (permissions / platform) ----------
async function renderWarnings() {
  const box = $('warnings');
  box.replaceChildren();
  const add = (text, btnLabel, fn) => {
    const d = document.createElement('div');
    d.className = 'warn-box';
    d.textContent = '⚠ ' + text;
    if (btnLabel) { const b = document.createElement('button'); b.className = 'btn ghost small'; b.textContent = btnLabel; b.onclick = fn; d.append(b); }
    box.append(d);
  };
  if (!info.inputAvailable) add('Remote control is unavailable on this computer (input library failed to load). Viewing still works.');
  if (info.wayland) add('Wayland session detected: remote mouse/keyboard needs an X11 (Xorg) session on Linux.');
  if (info.platform === 'darwin') {
    const p = await rd.permsStatus();
    if (p.screen !== 'granted' || !p.accessibility) {
      add('macOS needs Screen Recording and Accessibility permission so others can see and control this Mac.', 'Open settings', async () => { await rd.permsRequest(); });
    }
  }
}

// ---------- signaling ----------
const host = new HostController({
  sig: null,
  state: () => ({ hostId, temp: tempKey, perm: permKey(), settings, info }),
  ui: {
    askConsent,
    hostSessionStarted(s) {
      $('host-banner-name').textContent = s.peerName;
      $('host-allow-control').checked = true;
      $('host-banner').classList.remove('hidden');
      chatTarget = s;
      rd.notify('RemoteDesk', `${s.peerName} is connected to this computer.`);
    },
    hostSessionEnded(s, reason) {
      $('host-banner').classList.add('hidden');
      if (chatTarget === s) { chatTarget = null; closeChat(); }
      toast(`Session with ${s.peerName} ended. ${reason || ''}`);
    },
    chat: (from, text) => addChat(from, text, false),
    toast,
    fileReceived: (name, p) => toast(`Received “${name}”.`, { label: 'Show in folder', run: () => rd.fileShow(p) }),
  },
});

function startSignaling() {
  if (sig) sig.close();
  sig = new Signaling(settings.serverUrl, { diagnose: (url) => rd.probeServer(url) });
  host.sig = sig;
  sig.addEventListener('status', (e) => {
    const on = e.detail.online;
    $('server-status').className = 'pill ' + (on ? 'online' : 'offline');
    $('server-status').querySelector('span').textContent = on ? 'Ready' : (e.detail.error || 'Offline — reconnecting');
    $('server-status').title = on ? settings.serverUrl : (e.detail.reason || '');
    $('server-error').textContent = on ? '' : (e.detail.reason ? `${e.detail.reason} Server address is set in Settings (⚙).` : '');
  });
  sig.addEventListener('open', () => sig.send({ type: 'register', id: settings.hostId, token: settings.hostToken }));
  sig.addEventListener('close', () => {
    host.disconnectAll('Lost connection to the server.');
    if (viewer && !viewer.connected) viewer.close('Lost connection to the server.', false);
  });
  sig.addEventListener('message', async (e) => {
    const m = e.detail;
    switch (m.type) {
      case 'registered':
        if (m.id !== settings.hostId || m.token !== settings.hostToken) {
          settings = await rd.setSettings({ hostId: m.id, hostToken: m.token });
        }
        hostId = m.id;
        $('my-id').textContent = fmtId(hostId);
        updateUnattendedNote();
        await refreshTempKey();
        break;
      case 'incoming': host.onIncoming(m.sid); break;
      case 'relay':
        if (host.sessions.has(m.sid)) host.onRelay(m.sid, m.payload);
        else if (viewer && viewer.sid === m.sid) viewer.onServer(m);
        break;
      case 'ended':
        if (host.sessions.has(m.sid)) host.onEnded(m.sid, m.reason);
        else if (viewer) viewer.onServer(m);
        break;
      case 'pending': if (viewer && !viewer.sid) viewer.onServer(m); break;
      case 'error':
        if (m.code === 'replaced') toast(m.message);
        else if (viewer) viewer.onServer(m);
        else toast(m.message || 'Server error');
        break;
    }
  });
}

// ---------- consent prompt ----------
let consentQueue = Promise.resolve();
function askConsent(name) {
  // One prompt at a time.
  consentQueue = consentQueue.then(() => new Promise((resolve) => {
    rd.attention();
    $('consent-name').textContent = name;
    $('consent').classList.remove('hidden');
    let left = 30;
    $('consent-count').textContent = left;
    const done = (ok) => {
      clearInterval(t);
      $('consent').classList.add('hidden');
      $('consent-allow').onclick = $('consent-deny').onclick = null;
      resolve(ok);
    };
    const t = setInterval(() => { left--; $('consent-count').textContent = left; if (left <= 0) done(false); }, 1000);
    $('consent-allow').onclick = () => done(true);
    $('consent-deny').onclick = () => done(false);
  }));
  return consentQueue;
}

// ---------- host banner ----------
$('host-allow-control').onchange = (e) => host.active && host.active.setAllowControl(e.target.checked);
$('host-disconnect').onclick = () => host.disconnectAll('The partner ended the session.');
$('host-chat-btn').onclick = () => openChat(host.active);

$('new-password').onclick = async () => { tempPassword = makePassword(); await refreshTempKey(); toast('New password created.'); };
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.onclick = () => { navigator.clipboard.writeText($(b.dataset.copy).textContent.replace(/\s/g, '')); toast('Copied.'); };
});

// ---------- connect (viewer) ----------
$('partner-id').addEventListener('input', (e) => {
  const digits = e.target.value.replace(/\D/g, '').slice(0, 9);
  e.target.value = fmtId(digits).replace('— — —', '');
});

$('connect-form').onsubmit = (e) => {
  e.preventDefault();
  if (viewer) return;
  const id = $('partner-id').value.replace(/\D/g, '');
  const pw = $('partner-password').value;
  if (id.length !== 9) return ($('connect-status').textContent = 'The ID has 9 digits.');
  if (!sig || !sig.online) return ($('connect-status').textContent = 'Not connected to the server. Check Settings.');
  $('connect-btn').disabled = true;
  viewer = new ViewerSession({ sig, settings, info, targetId: id, password: pw, ui: viewerUi });
  viewer.start();
};

const video = $('remote-video');
const viewerUi = {
  viewerStatus: (t) => { $('connect-status').textContent = t; },
  viewerTrack: (stream) => { video.srcObject = stream; },
  viewerStarted(v) {
    $('partner-password').value = '';
    $('connect-status').textContent = '';
    $('session-name').textContent = v.hostName;
    $('home').classList.add('hidden');
    $('session').classList.remove('hidden');
    $('view-only').classList.add('hidden');
    $('quality-select').value = 'balanced';
    v.attachInput(video);
    chatTarget = v;
    video.focus();
  },
  viewerEnded(v, reason) {
    if (viewer !== v) return;
    viewer = null;
    video.srcObject = null;
    rd.fullscreen(false);
    $('session').classList.add('hidden');
    $('home').classList.remove('hidden');
    $('connect-btn').disabled = false;
    $('connect-status').textContent = reason || '';
    if (chatTarget === v) { chatTarget = null; closeChat(); }
    if (v.connected) toast(reason || 'Session ended.');
  },
  displays(list, current) {
    const sel = $('display-select');
    sel.replaceChildren(...list.map((d, i) => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `${i + 1}: ${d.label}${d.primary ? ' (main)' : ''}`;
      return o;
    }));
    sel.value = current;
    sel.classList.toggle('hidden', list.length < 2);
  },
  controlAllowed: (on) => $('view-only').classList.toggle('hidden', on),
  chat: (from, text) => addChat(from, text, false),
  stats: (s) => {
    $('session-stats').textContent = [s.res, s.fps ? `${s.fps} fps` : '', s.kbps ? `${(s.kbps / 1000).toFixed(1)} Mbps` : '', s.rtt != null ? `${s.rtt} ms` : '', s.route].filter(Boolean).join(' · ');
  },
  toast,
  fileProgress: (name, f) => {
    if (f < 0) toast(`Sending “${name}” failed.`);
    else $('session-stats').dataset.file = f < 1 ? `Sending ${name}: ${Math.round(f * 100)}%` : '';
    if (f >= 0 && f < 1) $('session-stats').textContent = $('session-stats').dataset.file;
  },
};

$('end-btn').onclick = () => viewer && viewer.close('You ended the session.', true);
$('fullscreen-btn').onclick = () => rd.fullscreen();
$('quality-select').onchange = (e) => viewer && viewer.setQuality(e.target.value);
$('display-select').onchange = (e) => viewer && viewer.setDisplay(e.target.value);
$('keys-btn').onclick = (e) => { e.stopPropagation(); $('keys-menu').classList.toggle('hidden'); };
document.addEventListener('click', () => $('keys-menu').classList.add('hidden'));
$('keys-menu').querySelectorAll('[data-combo]').forEach((b) => {
  b.onclick = () => { viewer && viewer.sendCombo(b.dataset.combo.split(',')); video.focus(); };
});
$('file-btn').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => { const f = e.target.files[0]; if (f && viewer) viewer.sendFile(f); e.target.value = ''; };

const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); $('drop-hint').classList.remove('hidden'); });
stage.addEventListener('dragleave', () => $('drop-hint').classList.add('hidden'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop-hint').classList.add('hidden');
  const f = e.dataTransfer.files[0];
  if (f && viewer) viewer.sendFile(f);
});
// Block accidental navigation when files are dropped elsewhere.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- chat ----------
function openChat(target) {
  if (!target) return;
  chatTarget = target;
  $('chat').classList.remove('hidden');
  $('chat-input').focus();
}
function closeChat() { $('chat').classList.add('hidden'); }
function addChat(from, text, me) {
  const d = document.createElement('div');
  d.className = 'msg' + (me ? ' me' : '');
  const s = document.createElement('small');
  s.textContent = me ? 'You' : from;
  d.append(s, document.createTextNode(text));
  $('chat-log').append(d);
  $('chat-log').scrollTop = 1e9;
  if (!me && $('chat').classList.contains('hidden')) { openChat(chatTarget); rd.attention(); }
}
$('chat-btn').onclick = () => ($('chat').classList.contains('hidden') ? openChat(viewer) : closeChat());
$('chat-close').onclick = closeChat;
$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text || !chatTarget) return;
  chatTarget.sendChat(text);
  addChat('You', text, true);
  $('chat-input').value = '';
};

// ---------- settings ----------
function openSettings() {
  $('s-server').value = settings.serverUrl;
  $('s-name').value = settings.deviceName;
  $('s-perm').value = '';
  $('s-perm-clear').checked = false;
  $('s-consent').checked = !!settings.askConsent;
  $('s-clip').checked = !!settings.clipboardSync;
  $('s-ice').value = JSON.stringify(settings.iceServers, null, 2);
  $('s-error').textContent = '';
  $('settings').classList.remove('hidden');
}
$('open-settings').onclick = openSettings;
$('settings-cancel').onclick = () => $('settings').classList.add('hidden');
$('settings-form').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('s-server').value.trim();
  if (!/^wss?:\/\/.+/.test(url)) return ($('s-error').textContent = 'Server URL must start with ws:// or wss://');
  let ice;
  try {
    ice = JSON.parse($('s-ice').value || '[]');
    if (!Array.isArray(ice) || !ice.every((s) => s && s.urls)) throw new Error();
  } catch { return ($('s-error').textContent = 'ICE servers must be a JSON array like [{"urls":"stun:..."}]'); }
  const patch = {
    serverUrl: url,
    deviceName: $('s-name').value.trim() || info.hostname,
    askConsent: $('s-consent').checked,
    clipboardSync: $('s-clip').checked,
    iceServers: ice,
  };
  const pw = $('s-perm').value;
  if ($('s-perm-clear').checked) { patch.permanentKey = null; patch.permanentKeyId = null; }
  else if (pw) {
    if (pw.length < 8) return ($('s-error').textContent = 'Use at least 8 characters for the unattended password.');
    if (!hostId) return ($('s-error').textContent = 'Connect to the server first so your ID is known.');
    patch.permanentKey = toB64(await deriveKey(pw, hostId));
    patch.permanentKeyId = hostId;
  }
  const serverChanged = url !== settings.serverUrl;
  settings = await rd.setSettings(patch);
  $('settings').classList.add('hidden');
  updateUnattendedNote();
  toast('Settings saved.');
  if (serverChanged) { host.disconnectAll('Server changed.'); hostId = null; $('my-id').textContent = fmtId(null); startSignaling(); }
};

// ---------- boot ----------
$('my-password').textContent = tempPassword;
updateUnattendedNote();
renderWarnings();
startSignaling();
