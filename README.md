# RemoteDesk

A TeamViewer-style remote desktop app for **Windows, macOS and Linux**, built on Electron + WebRTC.

| Feature | Details |
|---|---|
| ID + password | Permanent 9-digit ID per computer, fresh random password each launch (↻ to rotate) |
| Unattended access | Optional fixed password (only a derived key is stored, never the password) |
| Consent prompt | "Allow / Decline" with 30-second auto-decline; host can disconnect any time |
| Screen streaming | WebRTC video, 30 fps, sharp text mode, quality presets (Best / Balanced / Fast) |
| Remote control | Mouse (move, 3 buttons, scroll) and keyboard, Ctrl⇄Cmd auto-swap between Mac and PC |
| Multi-monitor | Viewer switches between the host's monitors |
| Extras | Chat, text clipboard sync, file transfer (drag & drop), special keys menu, fullscreen, live stats |
| View-only | Host can switch off control mid-session |

## Quick start (local test)

```bash
# 1. Signaling server
cd server && npm install && npm start          # listens on ws://localhost:8080

# 2. App (on each computer)
cd app && npm install && npm start
```

Open Settings (⚙) and set the server URL on both computers. Then read the ID and password off the computer you want to control, and type them into the other one.

To run two copies on one machine for testing:
`REMOTEDESK_PROFILE=/tmp/profile2 npm start`

## Going online (across the internet)

1. Rent a small VPS with a domain name pointed at it.
2. `cd deploy`, put your domain in `Caddyfile`, set a TURN password in `docker-compose.yml`, then run `docker compose up -d`.
3. In the app settings:
   - Server URL: `wss://remote.example.com`
   - ICE servers:
     ```json
     [
       { "urls": "stun:remote.example.com:3478" },
       { "urls": "turn:remote.example.com:3478", "username": "remotedesk", "credential": "YOUR_TURN_PASSWORD" }
     ]
     ```
   TURN relays the stream when the two networks can't connect directly (strict office or mobile networks). The session toolbar shows **Direct** or **Relayed**.

## Building installers

Set `defaultServerUrl` in `app/package.json` to your server first, e.g. `ws://10.100.80.238:8080` or `wss://remote.example.com`. Installed copies then connect without any setup; it can still be changed in Settings.

```bash
cd app
npm run dist:win     # .exe installer  (run on Windows)
npm run dist:mac     # .dmg            (run on macOS; sign + notarize for distribution)
npm run dist:linux   # AppImage + .deb
```

## Platform notes

- **macOS:** grant RemoteDesk **Screen Recording** and **Accessibility** permission (System Settings → Privacy & Security). The app shows a button that opens the right page.
- **Linux:** viewing works everywhere. Remote control needs an **X11/Xorg** session; Wayland blocks synthetic input. Debian/Ubuntu also need `sudo apt install libxtst6`.
- **Windows:** you can't control UAC prompts or the Ctrl+Alt+Del screen unless the app runs as a service. That needs a signed system service, which is a later step.

## Security model

- The server only relays messages. It never sees the password: the viewer proves it knows it with HMAC-SHA256 over a random challenge, using a key derived with PBKDF2 (150k iterations, salted with the host ID).
- The host proves it knows the password too (mutual authentication).
- The WebRTC DTLS fingerprints in the offer and answer are signed with the same key. A malicious server therefore can't man-in-the-middle the encrypted stream.
- 5 wrong passwords within 5 minutes lock the host out of new connections, with exponential backoff.
- Each ID is bound to a secret token, so nobody else can register your ID.
- The Electron renderer is sandboxed with context isolation, a strict CSP and no Node access.

## Project layout

```
server/index.js          signaling server (ws) + server/test.js
app/main.js              Electron main: capture source, input injection (nut-js), files, clipboard, settings
app/preload.js           minimal bridge API
app/renderer/            UI + WebRTC logic (host.js, viewer.js, crypto.js, signaling.js, app.js)
app/src/keymap.js        KeyboardEvent.code → native key mapping
deploy/                  Dockerfile, docker-compose (Caddy HTTPS + coturn), Caddyfile
```

## Tests

`cd server && npm test` (server protocol) · `cd app && npm test` (key map + crypto).
An end-to-end run was also done: two real app instances under Xvfb, covering wrong-password rejection, consent, video, mouse injection, chat, view-only, file transfer and disconnect.
