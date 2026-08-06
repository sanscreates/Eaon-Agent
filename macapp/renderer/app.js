/* ==========================================================================
 * Eaon Agent 1.5 — renderer app chrome + xterm wiring
 *
 * Runs with nodeIntegration OFF. The ONLY bridge to the main process is the
 * contextBridge-exposed `window.eaon` surface (see PRELOAD_API below).
 * No modules, no bundler — plain script; xterm UMD globals only.
 * ========================================================================== */
(function () {
  'use strict';

  /* ----------------------------------------------------------------------
   * Preload contract — main-process engineer double-check this list:
   *
   *   eaon.version              string  '1.5.0'
   *   eaon.platform             string  'darwin'
   *   eaon.getEngineInfo()      Promise<{ready,path,version,configured,node,arch}>
   *   eaon.onOutput(cb)         cb({ data: string })  // data is base64
   *   eaon.onExit(cb)           cb({ code: number })
   *   eaon.onReady(cb)          cb()
   *   eaon.onNotice(cb)         cb({ message: string })
   *   eaon.input(data)          raw terminal bytes
   *   eaon.resize(cols, rows)
   *   eaon.newSession(cwd)      Promise
   *   eaon.openFolder()         Promise<string|null>
   *   eaon.listSessions()       Promise<Array<{id,cwd,label,updatedAt}>>
   *   eaon.saveSession(meta)    Promise<void>
   *   eaon.deleteSession(id)    Promise<void>
   *   eaon.getSettings()        Promise<{cwd?, zoom?}>
   *   eaon.saveSettings(s)      void
   *   eaon.setZoom(factor)      void
   *   eaon.quit()               void
   * ---------------------------------------------------------------------- */

  /* ============================== dom refs ============================== */

  const $ = (sel) => document.querySelector(sel);

  const bootEl        = $('#bootOverlay');
  const bootMsg       = $('#bootMsg');
  const bootStartBtn  = $('#bootStart');
  const bootError     = $('#bootError');
  const statusText    = $('#statusText');
  const liveDotEl     = $('#liveDot');
  const liveTextEl    = $('#liveText');
  const chipEl        = $('#workspaceChip');
  const chipNameEl    = $('#workspaceName');
  const sessionListEl = $('#sessionList');
  const paletteEl     = $('#palette');
  const paletteInput  = $('#paletteInput');
  const paletteList   = $('#paletteList');
  const paletteEmpty  = $('#paletteEmpty');
  const zoomPctEl     = $('#zoomPct');
  const zoomInBtn     = $('#zoomIn');
  const zoomOutBtn    = $('#zoomOut');
  const hintBtn       = $('#paletteHint');
  const engineBadge   = $('#engineBadge');
  const archBadge     = $('#archBadge');
  const termEl        = $('#term');
  const termWrapEl    = $('#termWrap');
  const sessCountEl   = $('#sessCount');

  /* ============================== state ============================== */

  let term = null;
  let fitAddon = null;
  let pendingOutput = [];        // engine bytes that arrive before the terminal
  let bootDismissed = false;
  let bootSeen = false;          // sessionStorage flag — hero once per run
  let busyTimer = null;
  let busyInFlight = false;
  let starting = false;          // guards double "new session"
  let sessions = [];
  let currentSessionId = null;
  let settingsCwd = null;
  let zoom = 1;

  const engine = {
    ready: false,
    exitCode: null,
    info: null,
  };

  try {
    bootSeen = sessionStorage.getItem('eaon.boot.skipped') === '1';
  } catch (e) {
    bootSeen = false;
  }

  /* ============================== utils ============================== */

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function log(...args) { console.log('[eaon]', ...args); }

  function decodeBase64(b64) {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function basenameOf(p) {
    if (!p) return null;
    const parts = String(p).replace(/\/+$/, '').split(/[/\\]/);
    const last = parts[parts.length - 1];
    if (!last) return parts[parts.length - 2] || null;
    return last;
  }

  function shortenPath(p) {
    if (!p) return '~';
    return p.length > 30 ? '…' + p.slice(-28) : p;
  }

  function relTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h';
    return Math.round(h / 24) + 'd';
  }

  /* ===================== status / busy heuristic ===================== */

  function setStatus(msg, mode, dotClass) {
    if (!statusText) return;
    statusText.textContent = msg;
    statusText.className = '';
    if (mode) statusText.classList.add(mode);
    // Live dot follows the explicit dotClass when given; otherwise derive it
    // from the mode so the dot never stalls on a previous state.
    let cls = dotClass || (mode === 'busy' ? 'busy' : mode === 'error' ? 'error' : '');
    if (liveDotEl) liveDotEl.className = 'live-dot' + (cls ? ' ' + cls : '');
  }

  function setLiveText(t) {
    if (liveTextEl) liveTextEl.textContent = t;
  }

  function clearBusy() {
    busyInFlight = false;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  }

  /** Mark the agent working; settle back to Ready after 2 s of quiet. */
  function pokeBusy() {
    clearBusy();
    busyInFlight = true;
    setStatus('Working… tap Esc to cancel', 'busy', 'busy');
    setLiveText('agent: working');
    busyTimer = setTimeout(() => {
      busyInFlight = false;
      if (engine.ready && engine.exitCode === null) {
        setStatus('Ready', null, 'ready');
        setLiveText('agent: ready');
      }
    }, 2000);
  }

  /* ========================== boot overlay ========================== */

  function bootMessage(text) {
    bootMsg.innerHTML = '';
    const span = document.createElement('span');
    span.className = 't';
    span.textContent = text;
    bootMsg.appendChild(span);
  }

  function showBoot(kind) {
    bootEl.classList.remove('hidden-now');
    bootError.classList.add('hidden');
    bootStartBtn.classList.remove('hidden');
    bootStartBtn.disabled = false;
    if (kind === 'exit') {
      bootMessage('Session closed — start a new session');
      bootStartBtn.textContent = 'New session';
      setStatus('exited', 'error', 'error');
      setLiveText('agent: exited');
    } else {
      bootMessage('Press Enter to start');
      bootStartBtn.textContent = 'Start';
      setLiveText('agent: starting');
    }
  }

  function hideBoot() {
    if (bootDismissed) return;
    bootDismissed = true;
    try { sessionStorage.setItem('eaon.boot.skipped', '1'); } catch (e) {}
    bootEl.classList.add('hidden-now');
  }

  /** Hero fades when the engine comes up or emits its first output. */
  function dismissBoot() {
    if (!bootDismissed) hideBoot();
  }

  /* ========================= engine wire-up ========================= */

  function wireEngine() {
    window.eaon.onOutput((d) => {
      const data = d && d.data ? d.data : '';
      if (!data) return;
      if (term) {
        pokeBusy();
        try { term.write(decodeBase64(data)); } catch (e) {}
      } else {
        pendingOutput.push(data);
      }
      dismissBoot();
    });

    window.eaon.onReady(() => {
      engine.ready = true;
      engine.exitCode = null;
      bootError.classList.add('hidden');
      bootStartBtn.disabled = false;
      setStatus('Ready', null, 'ready');
      setLiveText('agent: ready');
      dismissBoot();
    });

    window.eaon.onExit((d) => {
      engine.ready = false;
      engine.exitCode = d ? d.code : null;
      clearBusy();
      showBoot('exit');
    });

    window.eaon.onNotice((d) => {
      if (d && d.message) setStatus(d.message, 'notice');
    });

    // App-menu (File) actions are pushed down by the main process — mirror them.
    if (typeof window.eaon.onMenu === 'function') {
      window.eaon.onMenu((d) => {
        if (!d || !d.action) return;
        if (d.action === 'new-session') newSessionNow();
        else if (d.action === 'open-folder') openFolderFlow();
        // The View menu's zoom accelerators are swallowed by the app menu, so the
        // renderer never sees those keydowns — main pushes the new factor here so
        // the % readout in the status bar stays truthful.
        else if (d.action === 'zoom-sync' && typeof d.zoom === 'number') {
          zoom = clamp(d.zoom, 0.5, 2);
          renderZoom();
        }
      });
    }
  }

  /* ============================ terminal ============================ */

  function initTerminal() {
    if (typeof Terminal === 'undefined') {
      showBoot();
      bootError.textContent = 'xterm failed to load — check ../node_modules';
      bootError.classList.remove('hidden');
      return;
    }

    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      lineHeight: 1.3,
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      theme: {
        background: '#161208',
        foreground: '#e9e4d6',
        cursor: '#f4a942',
        cursorAccent: '#161208',
        selectionBackground: 'rgba(244, 169, 66, 0.3)',
        selectionForeground: '#e9e4d6',
      },
      scrollback: 20000,
      allowProposedApi: true,
    });

    if (typeof FitAddon !== 'undefined') {
      // UMD export shapes differ across @xterm/addon-fit versions: 0.11+
      // exposes the class as `FitAddon.FitAddon` (older builds used `.Fit`).
      const FitCls = (typeof FitAddon.FitAddon === 'function')
        ? FitAddon.FitAddon
        : (typeof FitAddon.Fit === 'function' ? FitAddon.Fit : null);
      if (FitCls) {
        fitAddon = new FitCls();
        term.loadAddon(fitAddon);
      }
    }

    // attach to DOM first, then fit, then wire sizes
    term.open(termEl);
    requestAnimationFrame(resizeNow);

    term.onData((data) => {
      pokeBusy();
      if (typeof window.eaon.input === 'function') window.eaon.input(data);
    });

    term.onResize(() => {
      if (typeof window.eaon.resize === 'function') {
        window.eaon.resize(term.cols, term.rows);
      }
    });

    // keep rows/cols in sync with the layout (debounced 60 ms)
    let roTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(roTimer);
      roTimer = setTimeout(resizeNow, 60);
    });
    if (termWrapEl) ro.observe(termWrapEl);

    // flush output that arrived before the terminal existed
    if (pendingOutput.length) {
      pendingOutput.forEach((b64) => {
        try { term.write(decodeBase64(b64)); } catch (e) {}
      });
      pendingOutput.length = 0;
    }
  }

  function resizeNow() {
    if (!term || !fitAddon) return;
    try {
      fitAddon.fit();
      if (typeof window.eaon.resize === 'function') {
        window.eaon.resize(term.cols, term.rows);
      }
    } catch (e) { /* container not measurable yet */ }
  }

  /* ===================== workspace chip + settings ===================== */

  function loadSettings() {
    if (!window.eaon.getSettings) return;
    window.eaon.getSettings().then((s) => {
      if (!s) return;
      if (typeof s.zoom === 'number') zoom = clamp(s.zoom, 0.5, 2);
      if (typeof s.cwd === 'string') settingsCwd = s.cwd;
      renderZoom();
      updateChip();
    }).catch(() => {});
  }

  function updateChip() {
    const cwd = settingsCwd || (sessions.length && sessions[0] ? sessions[0].cwd : null) || null;
    const name = cwd ? basenameOf(cwd) || cwd : '~';
    if (chipNameEl.textContent !== name) {
      chipNameEl.textContent = name;
      chipEl.title = cwd || 'Home (~)';
      flashChip();
    }
  }

  let chipFlashTimer = null;
  function flashChip() {
    chipEl.classList.remove('flash');
    void chipEl.offsetWidth; // restart the animation
    chipEl.classList.add('flash');
    clearTimeout(chipFlashTimer);
    chipFlashTimer = setTimeout(() => chipEl.classList.remove('flash'), 1100);
  }

  function saveSettingsNow() {
    if (window.eaon.saveSettings) {
      // Zoom is persisted by the main process on set-zoom; only cwd is ours.
      window.eaon.saveSettings({ cwd: settingsCwd });
    }
  }

  /* ============================ sessions ============================ */

  function renderSessions() {
    sessionListEl.innerHTML = '';
    if (sessCountEl) {
      sessCountEl.textContent = sessions.length ? String(sessions.length) : '';
    }
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = 'No sessions yet — start one and it shows up here.';
      sessionListEl.appendChild(empty);
      return;
    }
    for (const s of sessions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
      item.setAttribute('role', 'listitem');
      item.title = s.cwd || 'Home';

      const head = document.createElement('span');
      head.className = 'session-head';
      const label = document.createElement('span');
      label.className = 'session-label';
      label.textContent = s.label || basenameOf(s.cwd) || 'Home';
      head.appendChild(label);
      const when = document.createElement('span');
      when.className = 'session-when';
      when.textContent = relTime(s.updatedAt);
      head.appendChild(when);
      item.appendChild(head);

      const cwd = document.createElement('span');
      cwd.className = 'session-cwd';
      cwd.textContent = shortenPath(s.cwd || '~');
      item.appendChild(cwd);

      const del = document.createElement('span');
      del.className = 'session-del';
      del.textContent = '✕';
      del.setAttribute('role', 'button');
      del.setAttribute('tabindex', '0');
      del.setAttribute('aria-label', 'Delete session ' + (s.label || ''));
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteSession(s);
      });
      del.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          ev.stopPropagation();
          deleteSession(s);
        }
      });
      item.appendChild(del);

      item.addEventListener('click', () => restoreSession(s));
      sessionListEl.appendChild(item);
    }
  }

  function refreshSessions(list) {
    if (Array.isArray(list)) sessions = list;
    renderSessions();
    updateChip();
  }

  function deleteSession(s) {
    window.eaon.deleteSession(s.id).then(() => {
      sessions = sessions.filter((x) => x.id !== s.id);
      renderSessions();
    }).catch(() => {});
  }

  function restoreSession(s) {
    currentSessionId = s.id;
    startSession(s.cwd);
    flashChip();
  }

  /* ========================= session lifecycle ========================= */

  function startSession(cwd, opts) {
    opts = opts || {};
    if (starting) return;
    starting = true;
    bootStartBtn.disabled = true;
    setLiveText('agent: starting');

    const p = window.eaon.newSession(cwd || null);

    if (opts.updatedCwd && cwd) {
      settingsCwd = cwd;
      saveSettingsNow();
      updateChip();
    }

    p.then((res) => {
      // new-session resolves with { ok } — surface a clean failure.
      if (res && res.ok === false) {
        bootError.textContent = 'Engine could not start in that folder.';
        bootError.classList.remove('hidden');
        showBoot();
        engine.exitCode = null;
        return;
      }
      engine.exitCode = null;
      engine.ready = true;

      // journal meta (id generated renderer-side; main keeps the authoritative list)
      if (window.eaon.saveSession) {
        const id = Date.now().toString(36);
        currentSessionId = id;
        window.eaon.saveSession({
          id,
          label: cwd ? basenameOf(cwd) || 'Home' : 'Home',
          cwd: cwd || '',
        }).then(
          () => window.eaon.listSessions && window.eaon.listSessions().then(refreshSessions, () => {}),
          () => {}
        );
      }

      if (term) term.focus();
      dismissBoot();
    },
    (err) => {
      const msg = (err && (err.message || err)) || 'Engine failed to start';
      bootError.textContent = 'Could not start: ' + msg;
      bootError.classList.remove('hidden');
      showBoot();
    }).then(() => {
      starting = false;
      bootStartBtn.disabled = false;
    });
  }

  function newSessionNow() {
    startSession(settingsCwd);
  }

  function openFolderFlow() {
    window.eaon.openFolder().then((picked) => {
      if (!picked) return; // cancelled — keep current
      startSession(picked, { updatedCwd: true });
    }).catch(() => {
      setStatus('Could not open folder', 'error');
    });
  }

  /* ========================= engine info badge ========================= */

  function initEngineBadge() {
    if (!window.eaon.getEngineInfo) return;
    window.eaon.getEngineInfo().then((ei) => {
      engine.info = ei;
      if (engineBadge) engineBadge.textContent = ei && (ei.engineVersion || ei.version)
        ? 'eng v' + (ei.engineVersion || ei.version)
        : 'eng ?';
      if (archBadge) archBadge.textContent = (ei && ei.node ? ei.node : '') + (ei && ei.arch ? ' · ' + ei.arch : '');
      if (!ei || !ei.ready) {
        bootError.textContent = 'Engine not found — run `npm run package-engine`' +
          (ei && ei.path ? '\n(' + ei.path + ')' : '');
        bootError.classList.remove('hidden');
        showBoot();
      }
    }).catch(() => {
      bootError.textContent = 'Engine not found — run npm run package-engine';
      bootError.classList.remove('hidden');
    });
  }

  /* ============================ command palette ============================ */

  const PALETTE_CMDS = [
    ['/help', 'List every available command'],
    ['/clear', 'Clear the conversation'],
    ['/stats', 'Token usage and cost this session'],
    ['/model', 'Pick the active model'],
    ['/models', 'List available models'],
    ['/theme', 'List or switch terminal themes'],
    ['/caveman', 'Cycle caveman mode (off | lite | full | ultra | wenyan)'],
    ['/caveman lite', 'Caveman: minimal prose'],
    ['/caveman full', 'Caveman: brute-force brevity'],
    ['/caveman ultra', 'Caveman: maximum primitive'],
    ['/caveman wenyan', 'Caveman: classical wenyan'],
    ['/caveman off', 'Caveman: back to normal'],
    ['/init', 'Analyze the project and write EAON.md'],
    ['/setup', 'Re-run onboarding / provider setup'],
    ['/permissions', 'Tool-permission mode: confirm | auto | readonly'],
    ['/macro list', 'List your macros'],
    ['/macro set', 'Save a macro'],
    ['/macro rm', 'Delete a macro'],
    ['/skills', 'List available skills'],
    ['/mcp', 'Inspect MCP connections'],
    ['/plugins', 'List plugins and their commands'],
    ['/compress', 'Compress older context to save tokens'],
    ['/caveman-stats', 'Caveman message statistics'],
    ['/caveman-commit', 'Caveman-styled git commit message'],
    ['/caveman-review', 'Caveman-flavored git diff review'],
    ['/caveman-compress', 'Caveman conversation compression'],
    ['/github', 'GitHub CLI (no MCP needed)'],
    ['/git', 'Bundled git wrapper'],
    ['/docker', 'Docker CLI commands'],
    ['/npm', 'Node package manager'],
    ['/node', 'Run Node.js one-liners'],
    ['/python', 'Run Python 3 one-liners'],
    ['/make', 'Run Makefile targets'],
    ['/cargo', 'Rust toolchain'],
    ['/kubectl', 'Kubernetes cluster'],
    ['/terraform', 'Terraform / IaC'],
    ['/exit', 'Quit the agent session'],
  ];

  const PALETTE_ACTIONS = [
    { label: 'New session', action: 'new-session', desc: 'Fresh agent in the current folder', hint: '⌘N', glyph: '✦' },
    { label: 'Open folder…', action: 'open-folder', desc: 'Pick a workspace folder', hint: '⌘O', glyph: '⌗' },
    { label: 'Reset zoom',   action: 'reset-zoom',  desc: 'Back to 100%', hint: '⌘0', glyph: '↺' },
  ];

  function allEntries() {
    const cmds = PALETTE_CMDS.map((c) => ({
      kind: 'cmd', cmd: c[0], desc: c[1], hint: null, glyph: '/',
    }));
    const acts = PALETTE_ACTIONS.map((a) => ({
      kind: 'action', cmd: a.label, desc: a.desc, hint: a.hint, action: a.action, glyph: a.glyph,
    }));
    return cmds.concat(acts);
  }

  const entries = allEntries();
  let filtered = entries;
  let paletteOpen = false;
  let selIndex = 0;

  /** Fuzzy-ish: case-insensitive substring; prefix of the command wins. */
  function filterPalette(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return entries;
    return entries
      .map((e) => {
        const cmdHay = (e.cmd || '').toLowerCase();
        const allHay = (cmdHay + ' ' + (e.desc || '')).toLowerCase();
        const at = allHay.indexOf(q);
        if (at === -1) return { e, s: null };
        let s;
        if (cmdHay.indexOf(q) === 0) s = 0;          // prefix of command
        else if (cmdHay.indexOf(q) > -1) s = 10;     // inside command
        else s = 30 + at;                            // matched description
        return { e, s };
      })
      .filter((x) => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.e);
  }

  function drawPalette() {
    paletteList.innerHTML = '';
    if (!filtered.length) {
      paletteEmpty.classList.remove('hidden');
      return;
    }
    paletteEmpty.classList.add('hidden');
    filtered.forEach((e, i) => {
      const li = document.createElement('li');
      li.className = 'palette-item' + (i === selIndex ? ' sel' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === selIndex ? 'true' : 'false');
      li.dataset.index = String(i);

      const kind = document.createElement('span');
      kind.className = 'p-kind';
      kind.textContent = e.glyph || (e.kind === 'action' ? '↵' : '/');
      li.appendChild(kind);

      const cmd = document.createElement('span');
      cmd.className = 'p-cmd';
      cmd.textContent = e.cmd;
      li.appendChild(cmd);

      const desc = document.createElement('span');
      desc.className = 'p-desc';
      desc.textContent = e.desc || '';
      li.appendChild(desc);

      if (e.hint) {
        const hint = document.createElement('span');
        hint.className = 'p-hint';
        hint.textContent = e.hint;
        li.appendChild(hint);
      }

      li.addEventListener('mousemove', () => {
        if (selIndex !== i) { selIndex = i; drawPalette(); }
      });
      li.addEventListener('click', () => runPaletteItem(e));
      paletteList.appendChild(li);
    });
    const sel = paletteList.querySelector('.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  function openPalette() {
    paletteEl.classList.remove('hidden');
    paletteInput.value = '';
    filtered = entries;
    selIndex = 0;
    drawPalette();
    paletteInput.focus();
    paletteOpen = true;
  }

  function closePalette() {
    paletteEl.classList.add('hidden');
    paletteOpen = false;
    if (term) term.focus();
  }

  function runPaletteItem(e) {
    closePalette();
    if (e.kind === 'action') {
      if (e.action === 'new-session') newSessionNow();
      else if (e.action === 'open-folder') openFolderFlow();
      else if (e.action === 'reset-zoom') setZoom(1);
      return;
    }
    // terminal command — inject into the agent TUI
    const line = e.cmd + '\r';
    if (window.eaon.input) {
      window.eaon.input(line);
      pokeBusy();
    }
    if (term) term.focus();
  }

  /* ============================ zoom ============================ */

  function setZoom(next) {
    zoom = clamp(Math.round(next * 10) / 10, 0.5, 2);
    // NOTE: zoom is owned by the main process (win.webContents.setZoomFactor),
    // which also persists it. We do NOT scale xterm fonts here to avoid
    // double-zooming.
    renderZoom();
    if (typeof window.eaon.setZoom === 'function') window.eaon.setZoom(zoom);
    saveSettingsNow();
  }

  function renderZoom() {
    zoomPctEl.textContent = Math.round(zoom * 100) + '%';
  }

  /* ============================ keyboard ============================ */

  const META = (e) => e.metaKey || e.ctrlKey; // ⌘ on darwin, Ctrl fallback

  window.addEventListener('keydown', (e) => {
    // A menu accelerator that matched (e.g. ⌘N/⌘O/⌘+ from the app menu) has
    // already been handled by the main process and is marked defaultPrevented —
    // never run our handler on top of it, or actions would fire twice.
    if (e.defaultPrevented || e.isComposing) return;
    const mod = META(e);
    const t = e.target;
    const key = e.key.toLowerCase();
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

    // ⌘K / Ctrl+K — toggle palette
    if (mod && key === 'k') {
      e.preventDefault();
      if (paletteOpen) closePalette(); else openPalette();
      return;
    }

    // ⌘O — open folder
    if (mod && key === 'o' && !inField) {
      e.preventDefault();
      openFolderFlow();
      return;
    }

    // ⌘N — new session
    if (mod && key === 'n' && !inField) {
      e.preventDefault();
      newSessionNow();
      return;
    }

    // ⌘+ / ⌘- / ⌘0 — zoom (clamped 0.5..2, step 0.1)
    if (mod && !inField) {
      if (key === '=' || key === '+') {
        e.preventDefault();
        setZoom(zoom + 0.1);
        return;
      }
      if (key === '-' || key === '−') {
        e.preventDefault();
        setZoom(zoom - 0.1);
        return;
      }
      if (key === '0') {
        e.preventDefault();
        setZoom(1);
        return;
      }
    }

    // ⌘V — paste clipboard straight into the agent (xterm can't see ⌘V)
    if (mod && key === 'v' && !inField) {
      e.preventDefault();
      navigator.clipboard.readText().then((txt) => {
        if (txt && window.eaon.input) window.eaon.input(txt);
      }).catch(() => {});
      return;
    }

    // Esc closes the palette (terminal receives Esc when palette is closed)
    if (paletteOpen && e.key === 'Escape') {
      e.preventDefault();
      closePalette();
      return;
    }
  });

  // Enter on the boot hero starts the session
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !bootEl.classList.contains('hidden-now')) {
      e.preventDefault();
      bootStartBtn.click();
    }
  });

  // Palette-exclusive navigation while the input has focus
  paletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selIndex = Math.min(selIndex + 1, Math.max(filtered.length - 1, 0));
      drawPalette();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selIndex = Math.max(selIndex - 1, 0);
      drawPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[selIndex];
      if (item) runPaletteItem(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });

  paletteInput.addEventListener('input', () => {
    filtered = filterPalette(paletteInput.value);
    selIndex = 0;
    drawPalette();
  });

  // click on the backdrop closes the palette
  paletteEl.addEventListener('click', (e) => {
    if (e.target === paletteEl) closePalette();
  });

  /* ========================= pointer shortcuts ========================= */

  // When the native menu handles the zoom accelerators, the main process
  // changes the factor without telling us — re-sync the % readout on focus.
  window.addEventListener('focus', () => {
    if (window.eaon.getSettings) {
      window.eaon.getSettings().then((s) => {
        if (s && typeof s.zoom === 'number') {
          zoom = clamp(s.zoom, 0.5, 2);
          renderZoom();
        }
      }).catch(() => {});
    }
  });

  zoomInBtn.addEventListener('click', () => setZoom(zoom + 0.1));
  zoomOutBtn.addEventListener('click', () => setZoom(zoom - 0.1));
  zoomPctEl.addEventListener('click', () => setZoom(1));
  hintBtn.addEventListener('click', () => openPalette());

  bootStartBtn.addEventListener('click', () => {
    if (engine.ready) startSession(settingsCwd);
    else newSessionNow();
  });

  $('#newChat').addEventListener('click', () => newSessionNow());
  $('#openFolder').addEventListener('click', () => openFolderFlow());

  /* ============================ self-test log ============================ */

  function selfTest() {
    if (!window.eaon) {
      bootError.textContent = 'Preload bridge unavailable (window.eaon missing)';
      bootError.classList.remove('hidden');
      console.error('[eaon] window.eaon is missing — preload not injected');
      return;
    }
    const surface = Object.keys(window.eaon).filter((k) => typeof window.eaon[k] !== 'undefined');
    log('Eaon Agent renderer ready', { version: window.eaon.version, platform: window.eaon.platform });
    log('preload API surface (' + surface.length + '):', surface.join(', '));
  }

  /* ============================ boot sequence ============================ */

  function init() {
    // 1. engine events first — they can fire before the terminal exists
    if (window.eaon) wireEngine();
    else setLiveText('agent: bridge missing');

    // 2. terminal mounts (drains any pending output after first fit)
    initTerminal();

    // 3. restore settings + journal
    loadSettings();
    if (window.eaon.listSessions) {
      window.eaon.listSessions().then(refreshSessions, () => {});
    }

    // 4. engine info badge + readiness error handling
    initEngineBadge();

    // 5. hero overlay: first run per window lifetime; later runs go straight in
    if (!bootSeen) showBoot();

    selfTest();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();