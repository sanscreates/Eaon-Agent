// Eaon Agent — macOS app shell.
//
// Owns the window and the engine process. The engine (engine/server.mjs) runs
// the real agent from dist/ and talks to this process over Node IPC; the
// renderer never touches the agent directly and there is no terminal anywhere
// in the stack.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isDev = !app.isPackaged;

// Electron's app.getPath('home'/'userData') read the real OS user record and
// ignore $HOME, so an e2e run needs an explicit override for a clean sandbox
// (see macapp/e2e). Never set outside of that harness.
const TEST_HOME = process.env.EAON_TEST_HOME;
function appHome() {
  return TEST_HOME || app.getPath('home');
}
function appUserData() {
  return TEST_HOME ? path.join(TEST_HOME, 'app-data') : app.getPath('userData');
}

/** Where the compiled agent lives: bundled under Resources, or the repo in dev. */
function distPath() {
  const packaged = path.join(process.resourcesPath ?? '', 'engine', 'dist');
  if (fs.existsSync(path.join(packaged, 'core', 'runtime.js'))) return packaged;
  return path.resolve(__dirname, '..', 'dist');
}

/** The engine script: bundled next to dist, or in this folder in dev. */
function enginePath() {
  const packaged = path.join(process.resourcesPath ?? '', 'engine', 'server.mjs');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, 'engine', 'server.mjs');
}

let win = null;
let engine = null;
let engineReady = false;
let reqSeq = 1;
const inflight = new Map();

// ---------------------------------------------------------------------------
// remembered state
// ---------------------------------------------------------------------------

/** The folder the app opened last — reopening in ~ every time is useless. */
function statePath() {
  return path.join(appUserData(), 'state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function rememberCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return;
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), cwd }, null, 2));
  } catch {
    /* not worth bothering the user about */
  }
}

function startCwd() {
  const saved = readState().cwd;
  if (saved && fs.existsSync(saved)) return saved;
  return appHome();
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

function startEngine() {
  const dist = distPath();
  if (!fs.existsSync(path.join(dist, 'core', 'runtime.js'))) {
    dialog.showErrorBox(
      'Eaon Agent is incomplete',
      `The agent build is missing at:\n${dist}\n\nIn development run "npm run build" in the repo root first.`,
    );
    app.quit();
    return;
  }

  engine = fork(enginePath(), [dist], {
    // ELECTRON_RUN_AS_NODE turns the bundled Electron binary into plain Node,
    // so the app ships one runtime instead of two.
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', EAON_APP_VERSION: app.getVersion(), ...(TEST_HOME ? { HOME: TEST_HOME } : {}) },
    cwd: startCwd(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  });

  engine.stdout?.on('data', (b) => process.stdout.write(`[engine] ${b}`));
  engine.stderr?.on('data', (b) => process.stderr.write(`[engine] ${b}`));

  engine.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.ev) {
      if (msg.ev === 'ready') engineReady = true;
      win?.webContents.send('engine:event', msg);
      return;
    }
    const pending = inflight.get(msg.id);
    if (!pending) return;
    inflight.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || 'engine error'));
  });

  engine.on('exit', (code) => {
    engineReady = false;
    for (const { reject } of inflight.values()) reject(new Error('The agent engine stopped.'));
    inflight.clear();
    if (!app.isQuitting) {
      win?.webContents.send('engine:event', { ev: 'engine_down', code });
    }
  });
}

function call(type, payload = {}) {
  if (!engine || !engine.connected) return Promise.reject(new Error('The agent engine is not running.'));
  const id = reqSeq++;
  return new Promise((resolve, reject) => {
    inflight.set(id, { resolve, reject });
    engine.send({ id, type, ...payload });
  });
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#14110b',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links open in the user's browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

/** Ask the renderer to run a UI action (menu items and shortcuts). */
function ui(action, payload) {
  win?.webContents.send('ui:action', { action, payload });
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => ui('settings') },
        { label: 'Re-run Setup…', accelerator: 'Cmd+Shift+,', click: () => ui('setup') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'Cmd+N', click: () => ui('new-chat') },
        { label: 'Open Folder…', accelerator: 'Cmd+O', click: () => ui('open-folder') },
        { type: 'separator' },
        { label: 'Compress Context', accelerator: 'Cmd+Shift+K', click: () => ui('compress') },
        { label: 'Stop Task', accelerator: 'Cmd+.', click: () => ui('cancel') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette', accelerator: 'Cmd+K', click: () => ui('palette') },
        { label: 'Model Picker', accelerator: 'Cmd+P', click: () => ui('models') },
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => ui('sidebar') },
        { label: 'Session Stats', accelerator: 'Cmd+I', click: () => ui('stats') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Eaon on GitHub', click: () => shell.openExternal('https://github.com/sanscreates/Eaon-Agent') },
        { label: 'Report an Issue', click: () => shell.openExternal('https://github.com/sanscreates/Eaon-Agent/issues') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// renderer bridge
// ---------------------------------------------------------------------------

ipcMain.handle('engine:call', async (_e, type, payload) => {
  try {
    const result = await call(type, payload ?? {});
    if (type === 'open_workspace' || type === 'hello') rememberCwd(result?.state?.cwd);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
});

ipcMain.handle('app:pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    message: 'Choose the project Eaon should work in',
    buttonLabel: 'Use Folder',
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  home: appHome(),
  ready: engineReady,
  dark: nativeTheme.shouldUseDarkColors,
}));

ipcMain.handle('app:open-external', (_e, url) => {
  if (/^https?:/.test(url)) shell.openExternal(url);
});

ipcMain.handle('app:open-path', (_e, target) => {
  if (typeof target === 'string' && target) shell.openPath(target);
});

ipcMain.handle('app:background', (_e, color) => {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) win?.setBackgroundColor(color);
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    startEngine();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  try {
    if (engine?.connected) {
      // Give the engine a moment to record lifetime stats and stop MCP servers.
      engine.send({ id: reqSeq++, type: 'shutdown' });
      await new Promise((r) => setTimeout(r, 120));
      engine.kill();
    }
  } catch {
    /* shutting down anyway */
  }
});
