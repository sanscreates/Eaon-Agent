'use strict';

/**
 * Eaon Desktop — preload script (contextBridge).
 *
 * Exposes a frozen, minimal `window.eaon` API to the sandboxed renderer.
 * Every call maps 1:1 onto an IPC channel handled in main.js. The renderer
 * (xterm.js UI, written by the renderer engineer) never sees Node or Electron
 * internals — only this object.
 *
 * Push events arrive via ipcRenderer.on callbacks; the renderer supplies a
 * cb per event. Event payload shapes:
 *   onOutput(d) -> d.data  (base64 of utf8 bytes)
 *   onExit(d)   -> d.code
 *   onNotice(d) -> d.message
 *   onMenu(d)   -> d.action
 */

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  version: '1.5.0',
  platform: process.platform,

  getEngineInfo: () => ipcRenderer.invoke('engine-info'),

  onOutput: (cb) => ipcRenderer.on('engine-output', (_e, d) => cb(d)),
  onReady: (cb) => ipcRenderer.on('engine-ready', () => cb()),
  onExit: (cb) => ipcRenderer.on('engine-exit', (_e, d) => cb(d)),
  onNotice: (cb) => ipcRenderer.on('engine-notice', (_e, d) => cb(d)),
  onMenu: (cb) => ipcRenderer.on('menu-action', (_e, d) => cb(d)),

  input: (data) => ipcRenderer.send('term-input', data),
  resize: (cols, rows) => ipcRenderer.send('term-resize', { cols, rows }),

  newSession: (cwd) => ipcRenderer.invoke('new-session', cwd),
  openFolder: () => ipcRenderer.invoke('open-folder'),

  listSessions: () => ipcRenderer.invoke('sessions-list'),
  saveSession: (meta) => ipcRenderer.invoke('sessions-save', meta),
  deleteSession: (id) => ipcRenderer.invoke('sessions-delete', id),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.send('settings-save', s),
  setZoom: (f) => ipcRenderer.send('set-zoom', f),

  quit: () => ipcRenderer.send('quit-app'),
};

contextBridge.exposeInMainWorld('eaon', Object.freeze(api));