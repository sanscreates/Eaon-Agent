'use strict';

/**
 * Eaon Agent — Electron main process.
 *
 * Job:
 *  - Create the BrowserWindow and load the renderer (xterm.js UI, built by the
 *    renderer engineer against the preload contract exposed in preload.js).
 *  - Own the engine lifecycle. The agent (`dist/index.js`) refuses to run
 *    without a real TTY, so it is spawned inside a PTY that lives in a tiny
 *    sidecar, `bridge.mjs`, which runs under the SAME bundled Node ABI as the
 *    engine (see scripts/package-engine.mjs). Electron never touches node-pty,
 *    so there are no ABI rebuilds.
 *
 *     main.js <--(newline-delimited JSON over stdio)--> bridge.mjs --PTY--> agent dist/index.js
 *
 * Bridge messages (main -> bridge):
 *   spawn  {node, script, cwd, env, rows, cols}
 *   input  {data}
 *   resize {cols, rows}
 *   kill
 * Bridge messages (bridge -> main):
 *   ready            (PTY spawned)
 *   output {data}    (base64 of utf8 bytes)
 *   exit   {code}
 *   notice {message} (diagnostics, e.g. spawn failure)
 *
 * RPC to renderer (all routed through the contextBridge in preload.js):
 *   handles: engine-info, new-session, open-folder, sessions-list,
 *            sessions-save, sessions-delete, get-settings
 *   events:  term-input, term-resize, settings-save, set-zoom, quit-app
 *   push:    engine-output, engine-ready, engine-exit, engine-notice, menu-action
 *
 * Plain CommonJS; only Electron + Node builtins. No native modules.
 */

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_VERSION = '1.5.0';
const BUNDLED_NODE_VERSION = '22.17.0'; // must match scripts/package-engine.mjs
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;
const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const MAX_SESSIONS = 100;

// ---------------------------------------------------------------------------
// Engine resolution
// ---------------------------------------------------------------------------

/** Root of the engine: packaged apps read resourcesPath, dev runs read macapp/resources. */
function engineRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'engine');
  return path.join(__dirname, 'resources', 'engine');
}

/** Absolute path of the bundled `node` binary shipped with the engine. */
function bundledNodeBin(root) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return path.join(root, 'runtime', `darwin-${arch}`, 'bin', 'node');
}

/**
 * Validate the packaged engine end to end. Powers `engine-info` and gates
 * session starts. Returns a plain object, never throws.
 */
function getEngine() {
  const result = {
    ready: false,
    path: engineRoot(),
    bin: null,
    manifest: null,
    version: null,
    engineVersion: null,
    node: BUNDLED_NODE_VERSION,
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    reason: null,
  };
  try {
    const root = result.path;
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      result.reason = `Engine not found at ${root}. Run \`npm run package-engine\`.`;
      return result;
    }
    const manifestPath = path.join(root, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      result.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      result.version = result.manifest.version ?? null;
      result.engineVersion = result.manifest.engineVersion ?? null;
      result.node = result.manifest.node ?? result.node;
      result.arch = result.manifest.arch ?? result.arch;
    }
    const bin = bundledNodeBin(root);
    if (!fs.existsSync(bin)) {
      result.reason = `Bundled node missing at ${bin}`;
      return result;
    }
    result.bin = bin;
    if (!fs.existsSync(path.join(root, 'bridge.mjs'))) {
      result.reason = `bridge.mjs missing in engine at ${root}`;
      return result;
    }
    if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
      result.reason = `Agent build missing: ${path.join(root, 'dist', 'index.js')}`;
      return result;
    }
    result.ready = true;
  } catch (err) {
    result.reason = err.message;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Settings persistence (cwd + zoom; fonts live in the renderer)
// ---------------------------------------------------------------------------

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function clampZoom(f) {
  if (typeof f !== 'number' || !Number.isFinite(f)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, f));
}

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return {
      cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : os.homedir(),
      zoom: clampZoom(raw.zoom),
    };
  } catch {
    return { cwd: os.homedir(), zoom: DEFAULT_ZOOM };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch ?? {}) };
  next.zoom = clampZoom(next.zoom);
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('failed to persist settings:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Session journal (userData/sessions.json)
// ---------------------------------------------------------------------------

function sessionsFile() {
  return path.join(app.getPath('userData'), 'sessions.json');
}

function readSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeSessions(list) {
  try {
    fs.mkdirSync(path.dirname(sessionsFile()), { recursive: true });
    fs.writeFileSync(sessionsFile(), JSON.stringify(list.slice(0, MAX_SESSIONS), null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('failed to persist sessions:', err.message);
  }
}

/** Upsert a session record by id; returns the whole (truncated) list. */
function upsertSession(meta) {
  const list = readSessions();
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : os.homedir();
  const label =
    typeof meta?.label === 'string' && meta.label.trim()
      ? meta.label.trim()
      : path.basename(cwd) || 'Home';
  const id =
    typeof meta?.id === 'string' && meta.id
      ? meta.id
      : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const idx = list.findIndex((s) => s && s.id === id);
  if (idx >= 0) list[idx] = { id, cwd, label, updatedAt: now };
  else list.unshift({ id, cwd, label, updatedAt: now });
  writeSessions(list);
  return readSessions();
}

// ---------------------------------------------------------------------------
// Bridge / PTY session control
// ---------------------------------------------------------------------------

let win = null;
let session = null; // { child, cwd, stopped, ptyExited, buf }
let appQuitting = false;

/** Forward a push event to the renderer (safe no-op when no window). */
function forward(channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

/**
 * Host env vars that must never reach the bundled Node or the agent.
 * The Electron main process inherits whatever launchd/terminal set — e.g.
 * NODE_OPTIONS pointed at the host Node's modules (or `--inspect`), or
 * ELECTRON_* switches that misbehave when the bundled Node starts. The bridge
 * and the agent run a DIFFERENT Node than the host shell, so inheriting those
 * raw is at best useless and at worst breaks spawn entirely.
 */
const HOST_ENV_DENYLIST = new Set([
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_REPL_HISTORY',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_OVERRIDE_DIST_PATH',
  'ELECTRON_LOG_FILE',
  'ELECTRON_DEBUG',
]);

/** Full host env minus the denylisted keys. */
function sanitizeEnv(base = process.env) {
  const env = { ...base };
  for (const key of HOST_ENV_DENYLIST) delete env[key];
  return env;
}

/** Environment given to the agent inside the PTY. */
function agentEnv(cwd) {
  return {
    ...sanitizeEnv(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Eaon Agent',
    PWD: cwd,
  };
}

/** Write one newline-delimited JSON message to a session's bridge. */
function sendToSession(s, msg) {
  if (!s || !s.child || s.stopped) return false;
  try {
    const { stdin } = s.child;
    if (!stdin || stdin.destroyed) return false;
    stdin.write(JSON.stringify(msg) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** Write to the currently active bridge (used by renderer IPC). */
function sendToBridge(msg) {
  return sendToSession(session, msg);
}

/**
 * Tear down the current bridge. Sends `kill`, closes stdin, then SIGKILLs the
 * sidecar after 1s if it did not exit on its own. Marks the session `stopped`
 * so the child 'exit' handler does not emit a spurious engine-exit.
 */
function killBridge() {
  const s = session;
  session = null;
  if (!s || !s.child) return;
  // Send `kill` BEFORE marking the session stopped — sendToSession() bails
  // on stopped sessions, so ordering matters. This lets the bridge tear down
  // its PTY (and the agent inside it) cleanly instead of orphaning it.
  try {
    const { stdin } = s.child;
    if (stdin && !stdin.destroyed) {
      stdin.write(JSON.stringify({ type: 'kill' }) + '\n');
      stdin.end();
    }
  } catch { /* noop */ }
  s.stopped = true;
  setTimeout(() => {
    try {
      if (s.child.exitCode === null && s.child.signalCode === null && !s.child.killed) {
        s.child.kill('SIGKILL');
      }
    } catch { /* noop */ }
  }, 1000);
}

/**
 * Spawn the bridge sidecar and immediately ask it to open a PTY running the
 * agent at `cwd`. Returns true on success, false otherwise.
 */
function spawnBridge(cwd) {
  const eng = getEngine();
  if (!eng.ready) {
    forward('engine-notice', { message: eng.reason ?? 'Engine unavailable.' });
    return false;
  }
  let child;
  try {
    child = spawn(eng.bin, [path.join(eng.path, 'bridge.mjs')], {
      cwd: eng.path,
      env: sanitizeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    forward('engine-notice', { message: `bridge spawn failed: ${err.message}` });
    return false;
  }

  const s = { child, cwd, stopped: false, ptyExited: false, buf: '' };
  session = s;

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => onBridgeData(s, chunk));
  child.stderr?.on('data', (chunk) => {
    console.error('[bridge]', String(chunk).replace(/\s+$/, ''));
  });
  child.on('error', (err) => {
    console.error('[bridge] error', err);
    s.stopped = true;
    if (!appQuitting) forward('engine-notice', { message: `bridge error: ${err.message}` });
  });
  child.on('exit', (code, signal) => {
    // Only surface an engine-exit here if the bridge died without the PTY
    // having announced its own exit first (i.e. an unexpected sidecar crash).
    // Controlled restarts set `stopped`; normal PTY exits set `ptyExited`.
    if (!appQuitting && !s.stopped && !s.ptyExited) {
      forward('engine-exit', { code: typeof code === 'number' ? code : null, signal });
    }
  });

  sendToSession(s, {
    type: 'spawn',
    node: eng.bin,
    script: path.join(eng.path, 'dist', 'index.js'),
    cwd,
    env: agentEnv(cwd),
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
  });
  return true;
}

/** Parse the newline-delimited JSON stream coming from the bridge. */
function onBridgeData(s, chunk) {
  s.buf += chunk;
  let nl;
  while ((nl = s.buf.indexOf('\n')) !== -1) {
    const raw = s.buf.slice(0, nl).trim();
    s.buf = s.buf.slice(nl + 1);
    if (!raw) continue;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue; // ignore non-JSON noise on the stdout channel
    }
    if (!msg || typeof msg !== 'object') continue;
    switch (msg.type) {
      case 'ready':
        forward('engine-ready');
        break;
      case 'output':
        if (typeof msg.data === 'string') forward('engine-output', { data: msg.data });
        break;
      case 'exit':
        s.ptyExited = true;
        forward('engine-exit', { code: typeof msg.code === 'number' ? msg.code : null });
        break;
      case 'notice':
        forward('engine-notice', { message: msg.message ?? 'unknown' });
        break;
      default:
        break;
    }
  }
}

/**
 * Kill any current session and start a fresh bridge+PTY at `cwd`.
 * Persists `cwd` so the session can be restored on next launch.
 */
function restartBridge(cwd) {
  if (typeof cwd !== 'string' || !cwd) cwd = os.homedir();
  cwd = path.resolve(cwd);
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      forward('engine-notice', { message: `Not a directory: ${cwd}` });
      return false;
    }
  } catch (err) {
    forward('engine-notice', { message: `Bad cwd ${cwd}: ${err.message}` });
    return false;
  }
  killBridge();
  writeSettings({ cwd });
  return spawnBridge(cwd);
}

// ---------------------------------------------------------------------------
// IPC: requests handled here, exposed to the renderer via preload.js
// ---------------------------------------------------------------------------

function registerIpc() {
  const configPath = path.join(os.homedir(), '.eaon', 'config.json');

  ipcMain.handle('engine-info', () => {
    const eng = getEngine();
    return {
      ready: eng.ready,
      path: eng.path,
      version: eng.version,
      engineVersion: eng.engineVersion,
      node: eng.node,
      arch: eng.arch,
      configured: fs.existsSync(configPath),
    };
  });

  ipcMain.on('term-input', (event, data) => {
    if (typeof data === 'string' && data) sendToBridge({ type: 'input', data });
  });

  ipcMain.on('term-resize', (event, size) => {
    const cols = typeof size?.cols === 'number' ? size.cols : DEFAULT_COLS;
    const rows = typeof size?.rows === 'number' ? size.rows : DEFAULT_ROWS;
    sendToBridge({ type: 'resize', cols, rows });
  });

  ipcMain.handle('new-session', (event, cwd) => {
    const ok = restartBridge(typeof cwd === 'string' ? cwd : os.homedir());
    return { ok };
  });

  ipcMain.handle('open-folder', async () => {
    if (!win || win.isDestroyed()) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Open workspace folder',
    });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  ipcMain.handle('sessions-list', () => readSessions());
  ipcMain.handle('sessions-save', (event, meta) => upsertSession(meta));
  ipcMain.handle('sessions-delete', (event, id) => {
    if (typeof id !== 'string') return readSessions();
    writeSessions(readSessions().filter((s) => s && s.id !== id));
    return readSessions();
  });

  ipcMain.handle('get-settings', () => readSettings());
  ipcMain.on('settings-save', (event, data) => {
    writeSettings(typeof data === 'object' && data ? data : {});
  });

  ipcMain.on('set-zoom', (event, factor) => {
    const zoom = clampZoom(typeof factor === 'number' ? factor : DEFAULT_ZOOM);
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoom);
    writeSettings({ zoom });
  });

  ipcMain.on('quit-app', () => app.quit());
}

// ---------------------------------------------------------------------------
// Application menu (slim; pushes `menu-action` messages the renderer can use)
// ---------------------------------------------------------------------------

function buildMenu() {
  // Returns a full MenuItem spec — Electron rejects items that have neither a
  // label, a role, nor a type (click-only templates are invalid).
  const dispatch = (action, label, accelerator) => ({
    label,
    accelerator,
    click: (menuItem, focusedWin) => {
      if (focusedWin && !focusedWin.isDestroyed()) {
        focusedWin.webContents.send('menu-action', { action });
      }
    },
  });
  const applyZoom = (delta) => {
    if (!win || win.isDestroyed()) return;
    const current = win.webContents.getZoomFactor() ?? DEFAULT_ZOOM;
    const zoom = clampZoom(Math.round((current + delta) * 100) / 100);
    win.webContents.setZoomFactor(zoom);
    writeSettings({ zoom });
    // Menu accelerators (CmdOrCtrl+/-/0) are swallowed by the app menu, so the
    // renderer never sees the keydown and its zoom % readout would go stale.
    // Push the authoritative value down so the UI stays in sync.
    win.webContents.send('menu-action', { action: 'zoom-sync', zoom });
  };

  const template = [
    ...(process.platform === 'darwin'
      ? [
          {
            role: 'appMenu',
            label: 'Eaon Agent',
            submenu: [{ role: 'quit', label: 'Quit Eaon Agent' }],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        dispatch('new-session', 'New Session', 'CmdOrCtrl+N'),
        dispatch('open-folder', 'Open Folder…', 'CmdOrCtrl+O'),
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => applyZoom(0.1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => applyZoom(-0.1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => applyZoom(1) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'editMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Window & app lifecycle
// ---------------------------------------------------------------------------

function createWindow() {
  const settings = readSettings();
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: 'Eaon Agent',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 17 }, // keep traffic lights clear of the terminal chrome
    backgroundColor: '#0b0e14',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Preload only uses `contextBridge` + `ipcRenderer` — both available in a
      // sandboxed renderer — so there is no reason to grant the renderer the
      // full Node runtime.
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (settings.zoom !== DEFAULT_ZOOM) {
      win.webContents.setZoomFactor(clampZoom(settings.zoom));
    }
    // Dev/CI helper: EAON_SHOT=/abs/path.png captures the window after a
    // delay (default 5s) and quits — powers the README screenshot + CI proof.
    if (process.env.EAON_SHOT) {
      const delay = Number(process.env.EAON_SHOT_DELAY || 5000);
      setTimeout(() => {
        win.webContents
          .capturePage()
          .then((img) => {
            fs.writeFileSync(process.env.EAON_SHOT, img.toPNG());
            console.log(`[eaon] screenshot written to ${process.env.EAON_SHOT}`);
            app.quit();
          })
          .catch((err) => {
            console.error('[eaon] screenshot failed:', err.message);
            app.exit(1);
          });
      }, delay);
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function reportMissingEngine() {
  const eng = getEngine();
  dialog
    .showMessageBox({
      type: 'error',
      buttons: ['Quit'],
      title: 'Engine missing',
      message: 'The Eaon Agent engine is not installed.',
      detail: eng.reason ?? `Expected engine at ${eng.path}. Run \`npm run package-engine\` first.`,
    })
    .then(() => app.quit())
    .catch(() => app.quit());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('before-quit', () => {
    appQuitting = true;
    killBridge();
  });

  // Quit on darwin too — keeps the PTY session lifecycle simple.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.whenReady().then(() => {
    if (!getEngine().ready) {
      reportMissingEngine();
      return;
    }
    registerIpc();
    buildMenu();
    createWindow();
    // Restore the last session (cwd) once the renderer has had a beat to load.
    const { cwd } = readSettings();
    setTimeout(() => {
      if (!session && win) spawnBridge(cwd || os.homedir());
    }, 400);
  });
}
