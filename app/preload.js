'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The renderer only gets this small, explicit API — no Node access.
contextBridge.exposeInMainWorld('rd', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  info: () => ipcRenderer.invoke('app:info'),
  probeServer: (url) => ipcRenderer.invoke('server:probe', url),
  displays: () => ipcRenderer.invoke('displays:list'),
  selectCapture: (id) => ipcRenderer.invoke('capture:select', id),
  permsStatus: () => ipcRenderer.invoke('perms:status'),
  permsRequest: () => ipcRenderer.invoke('perms:request'),
  fullscreen: (on) => ipcRenderer.invoke('window:fullscreen', on),
  attention: () => ipcRenderer.invoke('window:attention'),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  input: (ev) => ipcRenderer.send('input:event', ev),
  setInputEnabled: (on, displayId) => ipcRenderer.invoke('input:setEnabled', on, displayId),
  setInputDisplay: (id) => ipcRenderer.invoke('input:display', id),
  fileBegin: (name, size) => ipcRenderer.invoke('file:begin', name, size),
  fileChunk: (token, data) => ipcRenderer.invoke('file:chunk', token, data),
  fileEnd: (token, ok) => ipcRenderer.invoke('file:end', token, ok),
  fileShow: (p) => ipcRenderer.invoke('file:show', p),
});
