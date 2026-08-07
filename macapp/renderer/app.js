// Eaon Agent — renderer.
//
// Everything the TUI does, with a real interface: streaming answers, tool
// calls you can open, permission prompts, slash commands, model and theme
// switching, onboarding, session stats. The agent itself is untouched — this
// only speaks to the engine.

import { renderMarkdown, escapeHtml, renderDiff } from './markdown.mjs';

const api = window.eaon;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const app = {
  version: '1.5.0',
  snap: null, // engine snapshot: config, models, themes, stats…
  presets: [],
  commands: [],
  help: '',
  git: { repo: false, branch: '', files: [] },
  busy: false,
  history: [],
  historyIdx: -1,
  draft: '',
  stick: true,
  live: null, // { el, body, raw } — the assistant message being streamed
  tools: new Map(), // tool call id -> card element
  overlay: null, // { close() }
  askId: null,
};

// ---------------------------------------------------------------------------
// color helpers (same contrast rules the TUI uses, in CSS terms)
// ---------------------------------------------------------------------------

function rgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return [20, 17, 11];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a, b, t) {
  const ca = rgb(a);
  const cb = rgb(b);
  return `#${ca.map((c, i) => Math.round(c + (cb[i] - c) * t).toString(16).padStart(2, '0')).join('')}`;
}

const alpha = (hex, a) => `rgba(${rgb(hex).join(', ')}, ${a})`;

/** Paint the whole app from one of the agent's themes. */
function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  const dark = luminance(theme.bg) < 0.5;
  const fg = dark ? '#efece4' : '#191714';
  const muted = contrast(theme.muted, theme.bg) >= 3.6 ? theme.muted : mix(fg, theme.bg, 0.42);
  const accent = contrast(theme.accent, theme.bg) >= 3.2 ? theme.accent : mix(theme.accent, fg, 0.45);

  root.setProperty('--bg', theme.bg);
  root.setProperty('--fg', fg);
  root.setProperty('--muted', muted);
  root.setProperty('--accent', accent);
  root.setProperty('--accent-fg', luminance(accent) > 0.5 ? '#141109' : '#ffffff');
  root.setProperty('--accent-soft', alpha(accent, dark ? 0.14 : 0.13));
  root.setProperty('--surface', alpha(fg, dark ? 0.04 : 0.035));
  root.setProperty('--surface-2', alpha(fg, dark ? 0.07 : 0.06));
  root.setProperty('--border', alpha(fg, dark ? 0.1 : 0.12));
  root.setProperty('--border-strong', alpha(fg, dark ? 0.18 : 0.22));
  root.setProperty('--success', contrast(theme.success, theme.bg) >= 3.2 ? theme.success : mix(theme.success, fg, 0.4));
  root.setProperty('--error', contrast(theme.error, theme.bg) >= 3.2 ? theme.error : mix(theme.error, fg, 0.4));
  root.setProperty('--code', contrast(theme.code, theme.bg) >= 3.2 ? theme.code : mix(theme.code, fg, 0.4));
  api.setBackground(theme.bg);
}

// ---------------------------------------------------------------------------
// small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

let toastTimer = null;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const node = el('div', 'toast', escapeHtml(text));
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2400);
}

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------

const transcript = $('transcript');

function atBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
}

function scrollDown(force) {
  if (!force && !app.stick) return;
  transcript.scrollTop = transcript.scrollHeight;
}

transcript.addEventListener('scroll', () => {
  app.stick = atBottom();
  $('jump').classList.toggle('hidden', app.stick);
});

$('jump').onclick = () => {
  app.stick = true;
  scrollDown(true);
  $('jump').classList.add('hidden');
};

function push(node) {
  const empty = transcript.querySelector('.empty');
  if (empty) empty.remove();
  transcript.appendChild(node);
  scrollDown();
  return node;
}

function addUser(text) {
  const node = el('div', 'msg user');
  node.appendChild(el('div', 'bubble', escapeHtml(text)));
  return push(node);
}

function addProse(text) {
  const node = el('div', 'msg prose', renderMarkdown(text));
  wireCode(node);
  return push(node);
}

function addNote(text, variant = '') {
  return push(el('div', `note ${variant}`, escapeHtml(text)));
}

/** The agent's slash-command output is plain text — keep it monospaced. */
function addOutput(text) {
  const node = el('div', 'note mono');
  node.textContent = text;
  return push(node);
}

let thinkingNode = null;
function showThinking(on) {
  if (on) {
    if (thinkingNode || app.live) return;
    const label = app.snap?.main ? `${app.snap.main.provider}/${app.snap.main.model}` : 'model';
    thinkingNode = push(el('div', 'thinking', `<span class="orb"></span><span>${escapeHtml(label)} is thinking…</span>`));
  } else {
    thinkingNode?.remove();
    thinkingNode = null;
  }
}

// --- streaming assistant text ---

let renderQueued = false;

function liveNode() {
  if (app.live) return app.live;
  showThinking(false);
  const node = el('div', 'msg prose');
  push(node);
  app.live = { el: node, raw: '' };
  return app.live;
}

function appendText(chunk) {
  const live = liveNode();
  live.raw += chunk;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!app.live) return;
    app.live.el.innerHTML = renderMarkdown(app.live.raw) + '<span class="caret"></span>';
    wireCode(app.live.el);
    scrollDown();
  });
}

function endLive() {
  if (!app.live) return;
  const { el: node, raw } = app.live;
  app.live = null;
  if (!raw.trim()) {
    node.remove();
    return;
  }
  node.innerHTML = renderMarkdown(raw);
  wireCode(node);
}

/** Copy buttons inside rendered code blocks. */
function wireCode(scope) {
  scope.querySelectorAll('[data-copy]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.onclick = () => {
      const code = btn.closest('.code-block')?.dataset.code ?? '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      });
    };
  });
}

// --- tool calls ---

const TOOL_ARG_KEYS = ['command', 'path', 'pattern', 'query', 'url', 'task', 'file_path', 'name', 'content'];

function argPreview(args) {
  for (const key of TOOL_ARG_KEYS) {
    const v = args?.[key];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').slice(0, 140);
  }
  const json = JSON.stringify(args ?? {});
  return json === '{}' ? '' : json.slice(0, 140);
}

function addToolCard(call) {
  endLive();
  showThinking(false);
  const card = el('div', 'card');
  card.innerHTML =
    `<button class="card-head" type="button">` +
    `<span class="status-dot running"></span>` +
    `<span class="name">${escapeHtml(call.name)}</span>` +
    `<span class="arg">${escapeHtml(argPreview(call.args))}</span>` +
    `<span class="meta"></span><span class="chev">▶</span></button>` +
    `<div class="card-body"><pre>running…</pre></div>`;
  card.querySelector('.card-head').onclick = () => card.classList.toggle('open');
  app.tools.set(call.id, card);
  return push(card);
}

function finishToolCard(id, name, result, ms) {
  const card = app.tools.get(id);
  if (!card) return;
  app.tools.delete(id);
  const failed = /^(Error:|Denied by user\.)/.test(result ?? '');
  card.querySelector('.status-dot').className = `status-dot${failed ? ' failed' : ''}`;
  card.querySelector('.meta').textContent = ms ? fmtMs(ms) : '';
  const body = card.querySelector('.card-body');
  const text = result ?? '';
  const isDiff = /^(diff --git|@@ |\+\+\+ |--- )/m.test(text);
  body.innerHTML = `<pre${isDiff ? ' class="diff"' : ''}>${isDiff ? renderDiff(text) : escapeHtml(text) || '<span class="dim">(no output)</span>'}</pre>`;
  if (failed) card.classList.add('open');
}

function addSubagentCard(task, model) {
  endLive();
  showThinking(false);
  const card = el('div', 'card subagent');
  card.innerHTML =
    `<button class="card-head" type="button">` +
    `<span class="status-dot running"></span>` +
    `<span class="name">sub-agent</span>` +
    `<span class="arg">${escapeHtml(model)} · ${escapeHtml(task.slice(0, 120))}</span>` +
    `<span class="meta">working…</span><span class="chev">▶</span></button>` +
    `<div class="card-body"><pre>${escapeHtml(task)}</pre></div>`;
  card.querySelector('.card-head').onclick = () => card.classList.toggle('open');
  app.subagent = card;
  return push(card);
}

function endSubagentCard(ok) {
  const card = app.subagent;
  if (!card) return;
  app.subagent = null;
  card.querySelector('.status-dot').className = `status-dot${ok ? '' : ' failed'}`;
  card.querySelector('.meta').textContent = ok ? 'done' : 'failed';
}

function emptyState() {
  const model = app.snap?.main ? `${app.snap.main.provider}/${app.snap.main.model}` : 'no model configured';
  const node = el('div', 'empty');
  node.innerHTML =
    `<div class="mark"><svg viewBox="0 0 24 24" fill="none"><path d="M4 6.5 10 12l-6 5.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 18h7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></div>` +
    `<h1>Eaon Agent</h1>` +
    `<p>Working in <strong>${escapeHtml(app.snap?.workspace ?? '~')}</strong> with ${escapeHtml(model)}. Sub-agents, parallel tools and context compression run on their own.</p>` +
    `<div class="suggestions">` +
    [
      ['Explain this codebase', 'Map the structure, stack and entry points', 'Explore this project and explain how it fits together: structure, stack, entry points, and how to run it.'],
      ['Review my changes', 'Diff review with a sub-agent', '/caveman-review'],
      ['Write project memory', 'Generate EAON.md for future sessions', '/init'],
    ]
      .map(
        ([title, sub, prompt]) =>
          `<button class="suggestion" data-prompt="${escapeHtml(prompt)}">${escapeHtml(title)}<small>${escapeHtml(sub)}</small></button>`,
      )
      .join('') +
    `</div>`;
  node.querySelectorAll('.suggestion').forEach((btn) => {
    btn.onclick = () => submit(btn.dataset.prompt);
  });
  transcript.appendChild(node);
}

function clearTranscript() {
  transcript.innerHTML = '';
  app.live = null;
  app.tools.clear();
  thinkingNode = null;
  emptyState();
}

// ---------------------------------------------------------------------------
// chrome (titlebar + sidebar)
// ---------------------------------------------------------------------------

function applySnapshot(snap) {
  if (!snap) return;
  app.snap = snap;

  $('ws-name').textContent = snap.workspace;
  $('ws-chip').title = snap.cwd;
  $('model-label').textContent = snap.main ? `${snap.main.provider}/${snap.main.model}` : 'no model';

  $('sel-permissions').value = snap.permissionMode;

  const caveman = $('sel-caveman');
  if (caveman.options.length !== snap.cavemanLevels.length) {
    caveman.innerHTML = snap.cavemanLevels.map((l) => `<option value="${l}">${l}</option>`).join('');
  }
  caveman.value = snap.caveman;

  const themeSel = $('sel-theme');
  if (themeSel.options.length !== snap.themes.length) {
    themeSel.innerHTML = snap.themes.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
  }
  themeSel.value = snap.theme;
  applyTheme(snap.themes.find((t) => t.id === snap.theme) ?? snap.themes[0]);

  const s = snap.stats;
  document.querySelector('.stat-grid').classList.toggle('hidden', !snap.showTokens);
  $('st-in').textContent = fmtTokens(s.inputTokens);
  $('st-out').textContent = fmtTokens(s.outputTokens);
  $('st-saved').textContent = `⛏ ${fmtTokens(s.saved)}`;
  $('st-tools').textContent = String(s.toolCalls);

  // How full the context is relative to the compression threshold.
  const threshold = Math.max(1, snap.compression?.thresholdTokens ?? 20000);
  const used = Math.min(1, s.inputTokens / threshold);
  $('ctx-fill').style.width = `${Math.round(used * 100)}%`;
  $('ctx-note').textContent = s.compressionEvents
    ? `${s.compressionEvents} compression${s.compressionEvents === 1 ? '' : 's'} · ${fmtTokens(s.compressedTokens)} tokens dropped`
    : snap.compression?.enabled
      ? `auto-compresses past ~${fmtTokens(threshold)} tokens`
      : 'compression off';

  const caps = [];
  if (snap.skills.length) caps.push(`${snap.skills.length} skill${snap.skills.length === 1 ? '' : 's'}`);
  if (snap.mcp.length) caps.push(`${snap.mcp.length} MCP`);
  if (snap.plugins.length) caps.push(`${snap.plugins.length} plugin${snap.plugins.length === 1 ? '' : 's'}`);
  $('foot-caps').textContent = caps.join(' · ') || 'no skills yet';
  $('foot-version').textContent = `v${app.version}`;
}

function applyGit(git) {
  app.git = git ?? { repo: false, branch: '', files: [] };
  $('ws-branch').textContent = app.git.branch || '';
  const list = $('changes');
  const files = app.git.files ?? [];
  $('changes-count').textContent = files.length ? String(files.length) : '';
  if (!app.git.repo) {
    list.innerHTML = '<div class="side-empty">Not a git repository.</div>';
    return;
  }
  if (!files.length) {
    list.innerHTML = '<div class="side-empty">Working tree clean.</div>';
    return;
  }
  const statusClass = (st) =>
    st.includes('?') ? 'untracked' : st.includes('D') ? 'deleted' : st.includes('A') ? 'added' : 'modified';
  list.innerHTML = files
    .map(
      (f) =>
        `<button class="change" data-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">` +
        `<span class="st ${statusClass(f.status)}">${escapeHtml(f.status)}</span>` +
        `<span class="nm">${escapeHtml(f.path)}</span></button>`,
    )
    .join('');
  list.querySelectorAll('.change').forEach((btn) => {
    btn.onclick = () => showDiff(btn.dataset.file);
  });
}

async function refreshGit() {
  try {
    applyGit(await api.call('git'));
  } catch {
    /* the folder may have gone away */
  }
}

function setBusy(busy) {
  app.busy = busy;
  const send = $('send');
  send.classList.toggle('stop', busy);
  send.title = busy ? 'Stop (⌘.)' : 'Send (⏎)';
  send.innerHTML = busy
    ? '<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 16 16" class="ico" aria-hidden="true"><path d="M2.5 8h9M8 4.5 11.5 8 8 11.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const status = $('status');
  status.textContent = busy ? 'Working…' : 'Ready';
  status.classList.toggle('busy', busy);
  if (!busy) showThinking(false);
}

// ---------------------------------------------------------------------------
// engine events
// ---------------------------------------------------------------------------

api.onEvent((msg) => {
  switch (msg.ev) {
    case 'thinking':
      showThinking(true);
      break;
    case 'text':
      appendText(msg.text);
      break;
    case 'tool_start':
      addToolCard(msg.call);
      break;
    case 'tool_end':
      finishToolCard(msg.id, msg.name, msg.result, msg.ms);
      break;
    case 'notice':
      endLive();
      showThinking(false);
      addOutput(msg.text);
      break;
    case 'error':
      endLive();
      showThinking(false);
      addNote(msg.text, 'error');
      break;
    case 'compression':
      addNote(`⚡ ${msg.label}`, 'accent');
      break;
    case 'subagent_start':
      addSubagentCard(msg.task, msg.model);
      break;
    case 'subagent_end':
      endSubagentCard(msg.ok);
      break;
    case 'permission':
      askPermission(msg.askId, msg.request);
      break;
    case 'pick_model':
      openModelPicker(msg.askId);
      break;
    case 'open_setup':
      openSetup();
      break;
    case 'config':
      applySnapshot(msg.state);
      break;
    case 'busy':
      setBusy(msg.busy);
      break;
    case 'exit_requested':
      window.close();
      break;
    case 'engine_down':
      addNote('The agent engine stopped unexpectedly. Reopen the app to continue.', 'error');
      setBusy(false);
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// permission prompt
// ---------------------------------------------------------------------------

const KIND_LABEL = {
  shell: 'Run a shell command',
  write: 'Write a file',
  edit: 'Edit a file',
  fetch: 'Fetch a URL',
  mcp: 'Call an MCP tool',
};

function askPermission(askId, req) {
  const slot = $('perm-slot');
  slot.innerHTML = '';
  const detail = req.detail ?? '';
  const isDiff = /^[-+]/m.test(detail) && /\n/.test(detail);
  const wrap = el('div', 'perm');
  wrap.innerHTML =
    `<div class="perm-card">` +
    `<div class="perm-head"><span class="kind">${escapeHtml(req.kind)}</span>${escapeHtml(req.label || KIND_LABEL[req.kind] || 'Permission needed')}</div>` +
    (detail ? `<pre class="perm-detail">${isDiff ? renderDiff(detail) : escapeHtml(detail)}</pre>` : '') +
    `<div class="perm-actions">` +
    `<button class="btn solid" data-d="once">Allow once<span class="key">⏎</span></button>` +
    (req.kind === 'shell' ? `<button class="btn" data-d="always">Always allow<span class="key">A</span></button>` : '') +
    `<span class="grow"></span>` +
    `<button class="btn danger" data-d="deny">Deny<span class="key">esc</span></button>` +
    `</div></div>`;
  slot.appendChild(wrap);
  scrollDown(true);

  const answer = (decision) => {
    if (app.askId !== askId) return;
    app.askId = null;
    slot.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    api.call('answer', { askId, value: decision }).catch(() => {});
  };
  const onKey = (e) => {
    if (app.overlay) return;
    if (e.key === 'Enter') { e.preventDefault(); answer('once'); }
    else if (e.key === 'Escape') { e.preventDefault(); answer('deny'); }
    else if ((e.key === 'a' || e.key === 'A') && req.kind === 'shell' && document.activeElement !== $('input')) {
      e.preventDefault();
      answer('always');
    }
  };
  app.askId = askId;
  wrap.querySelectorAll('[data-d]').forEach((btn) => {
    btn.onclick = () => answer(btn.dataset.d);
  });
  document.addEventListener('keydown', onKey, true);
}

// ---------------------------------------------------------------------------
// composer
// ---------------------------------------------------------------------------

const input = $('input');
const suggest = $('suggest');
let suggestItems = [];
let suggestIdx = 0;

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

input.addEventListener('focus', () => $('composer-box').classList.add('focus'));
input.addEventListener('blur', () => $('composer-box').classList.remove('focus'));
input.addEventListener('input', () => {
  autoGrow();
  updateSuggest();
});

function updateSuggest() {
  const value = input.value;
  const single = !value.includes('\n');
  const match = single && value.startsWith('/') ? value.slice(1).split(/\s/)[0].toLowerCase() : null;
  if (match === null || value.slice(1).includes(' ')) return hideSuggest();
  suggestItems = app.commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(match));
  if (!suggestItems.length) return hideSuggest();
  suggestIdx = 0;
  renderSuggest();
}

function renderSuggest() {
  suggest.innerHTML = suggestItems
    .map(
      (c, i) =>
        `<button class="suggest-item${i === suggestIdx ? ' active' : ''}" data-i="${i}">` +
        `<span class="cmd">${escapeHtml(c.name)}</span>` +
        `<span class="args">${escapeHtml(c.args || '')}</span>` +
        `<span class="desc">${escapeHtml(c.description)}</span></button>`,
    )
    .join('');
  suggest.classList.remove('hidden');
  suggest.querySelectorAll('.suggest-item').forEach((btn) => {
    btn.onmousedown = (e) => {
      e.preventDefault();
      applySuggest(Number(btn.dataset.i));
    };
  });
}

function hideSuggest() {
  suggest.classList.add('hidden');
  suggestItems = [];
}

function applySuggest(i) {
  const cmd = suggestItems[i];
  if (!cmd) return;
  input.value = `${cmd.name}${cmd.args ? ' ' : ''}`;
  hideSuggest();
  input.focus();
  autoGrow();
}

input.addEventListener('keydown', (e) => {
  if (suggestItems.length && !suggest.classList.contains('hidden')) {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      suggestIdx = (suggestIdx + 1) % suggestItems.length;
      renderSuggest();
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      suggestIdx = (suggestIdx - 1 + suggestItems.length) % suggestItems.length;
      renderSuggest();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      applySuggest(suggestIdx);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideSuggest();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit(input.value);
    return;
  }
  // Shell-style history when the caret is on an untouched first line.
  if (e.key === 'ArrowUp' && input.selectionStart === 0 && app.history.length) {
    e.preventDefault();
    if (app.historyIdx === -1) app.draft = input.value;
    app.historyIdx = app.historyIdx === -1 ? app.history.length - 1 : Math.max(0, app.historyIdx - 1);
    input.value = app.history[app.historyIdx];
    autoGrow();
    return;
  }
  if (e.key === 'ArrowDown' && app.historyIdx !== -1 && input.selectionStart === input.value.length) {
    e.preventDefault();
    app.historyIdx += 1;
    if (app.historyIdx >= app.history.length) {
      app.historyIdx = -1;
      input.value = app.draft;
    } else {
      input.value = app.history[app.historyIdx];
    }
    autoGrow();
  }
});

$('btn-slash').onclick = () => {
  input.focus();
  if (!input.value.startsWith('/')) input.value = `/${input.value}`;
  updateSuggest();
  autoGrow();
};

$('send').onclick = () => {
  if (app.busy) cancel();
  else submit(input.value);
};

async function submit(raw) {
  const text = String(raw ?? '').trim();
  if (!text || app.busy) return;
  if (!app.snap?.configured) {
    openSetup();
    return;
  }
  input.value = '';
  hideSuggest();
  autoGrow();
  app.history.push(text);
  app.historyIdx = -1;
  app.draft = '';
  app.stick = true;

  // /clear is instant and local; everything else goes to the engine.
  addUser(text);
  setBusy(true);
  try {
    const res = await api.call('send', { text });
    if (res?.kind === 'unknown') addNote(`Unknown command: ${text.split(/\s/)[0]} — press ⌘K to see what exists.`, 'error');
    if (res?.state) applySnapshot(res.state);
    if (text.trim() === '/clear') clearTranscript();
  } catch (err) {
    addNote(err.message ?? String(err), 'error');
  } finally {
    endLive();
    setBusy(false);
    refreshGit();
  }
}

async function cancel() {
  try {
    const res = await api.call('cancel');
    if (res?.cancelled) addNote('Task cancelled.', '');
  } catch {
    /* nothing running */
  }
}

// ---------------------------------------------------------------------------
// overlays
// ---------------------------------------------------------------------------

function closeOverlay() {
  app.overlay?.close();
}

function overlay(node, opts = {}) {
  closeOverlay();
  const scrim = el('div', `scrim${opts.center ? ' center' : ''}`);
  scrim.appendChild(node);
  scrim.onmousedown = (e) => {
    if (e.target === scrim && !opts.sticky) close();
  };
  $('overlays').appendChild(scrim);

  function close() {
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    if (app.overlay?.node === scrim) app.overlay = null;
    opts.onClose?.();
    input.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape' && !opts.sticky) {
      e.preventDefault();
      close();
    }
    opts.onKey?.(e, close);
  }
  document.addEventListener('keydown', onKey, true);
  app.overlay = { node: scrim, close };
  return close;
}

function modal(title, bodyHtml, opts = {}) {
  const node = el('div', `modal${opts.wide ? ' wide' : ''}`);
  node.innerHTML =
    `<div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="close" type="button">✕</button></div>` +
    `<div class="modal-body">${bodyHtml}</div>` +
    (opts.foot ? `<div class="modal-foot">${opts.foot}</div>` : '');
  const close = overlay(node, opts);
  node.querySelector('.close').onclick = close;
  return { node, close };
}

/** Searchable list overlay — the shape used by ⌘K and the model picker. */
function picker(placeholder, items, onPick, opts = {}) {
  const node = el('div', 'modal');
  node.innerHTML =
    `<input class="palette-input" type="text" placeholder="${escapeHtml(placeholder)}" spellcheck="false">` +
    `<div class="palette-list"></div>`;
  const field = node.querySelector('.palette-input');
  const list = node.querySelector('.palette-list');
  let filtered = items;
  let index = 0;

  function draw() {
    if (!filtered.length) {
      list.innerHTML = '<div class="palette-empty">Nothing matches.</div>';
      return;
    }
    list.innerHTML = filtered
      .map(
        (it, i) =>
          `<button class="palette-item${i === index ? ' active' : ''}" data-i="${i}">` +
          `<span class="lead">${escapeHtml(it.lead)}</span>` +
          `<span>${escapeHtml(it.label ?? '')}</span>` +
          (it.sub ? `<span class="sub">${escapeHtml(it.sub)}</span>` : '') +
          `</button>`,
      )
      .join('');
    list.querySelectorAll('.palette-item').forEach((btn) => {
      btn.onclick = () => choose(filtered[Number(btn.dataset.i)]);
    });
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(item) {
    if (!item) return;
    close();
    onPick(item);
  }

  const close = overlay(node, {
    ...opts,
    onKey: (e, doClose) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        index = Math.min(filtered.length - 1, index + 1);
        draw();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        index = Math.max(0, index - 1);
        draw();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(filtered[index]);
      } else if (e.key === 'Escape' && opts.sticky) {
        e.preventDefault();
        doClose();
        opts.onCancel?.();
      }
    },
  });

  field.addEventListener('input', () => {
    const q = field.value.trim().toLowerCase();
    filtered = !q
      ? items
      : items.filter((it) => `${it.lead} ${it.label ?? ''} ${it.sub ?? ''}`.toLowerCase().includes(q));
    index = 0;
    draw();
  });
  draw();
  setTimeout(() => field.focus(), 0);
  return close;
}

// --- command palette ---

function openPalette() {
  const actions = [
    { lead: 'New chat', label: '', sub: '⌘N', run: newChat },
    { lead: 'Open folder…', label: '', sub: '⌘O', run: openFolder },
    { lead: 'Switch model…', label: '', sub: '⌘P', run: () => openModelPicker(null) },
    { lead: 'Change theme…', label: '', sub: '', run: openThemePicker },
    { lead: 'Settings…', label: '', sub: '⌘,', run: openSettings },
    { lead: 'Session stats', label: '', sub: '⌘I', run: openStats },
    { lead: 'Compress context', label: '', sub: '⌘⇧K', run: compressNow },
    { lead: 'Re-run setup…', label: '', sub: '', run: openSetup },
  ];
  const commands = app.commands.map((c) => ({
    lead: c.name,
    label: c.args || '',
    sub: c.description,
    run: () => {
      input.value = `${c.name}${c.args ? ' ' : ''}`;
      input.focus();
      autoGrow();
      if (!c.args) submit(c.name);
    },
  }));
  picker('Search commands…', [...actions, ...commands], (item) => item.run());
}

// --- model picker (also answers the engine's /model request) ---

function openModelPicker(askId) {
  const models = app.snap?.models ?? [];
  if (!models.length) {
    if (askId) api.call('answer', { askId, value: null }).catch(() => {});
    toast('No models configured yet — run setup first.');
    return;
  }
  const items = models.map((m) => ({
    lead: `${m.provider}/${m.model}`,
    label: '',
    sub: m.role ? m.role : '',
    value: `${m.provider}/${m.model}`,
  }));
  let picked = false;
  picker(
    'Pick the main model…',
    items,
    async (item) => {
      picked = true;
      if (askId) {
        await api.call('answer', { askId, value: item.value }).catch(() => {});
      } else {
        const res = await api.call('configure', { model: item.value }).catch((e) => {
          toast(e.message);
          return null;
        });
        if (res?.state) applySnapshot(res.state);
        toast(`Main model → ${item.value}`);
      }
    },
    {
      sticky: !!askId,
      onCancel: () => {
        if (askId && !picked) api.call('answer', { askId, value: null }).catch(() => {});
      },
      onClose: () => {
        if (askId && !picked) api.call('answer', { askId, value: null }).catch(() => {});
      },
    },
  );
}

function openThemePicker() {
  const themes = app.snap?.themes ?? [];
  picker(
    'Search themes…',
    themes.map((t) => ({ lead: t.name, label: t.description, sub: t.source ? `plugin: ${t.source}` : '', id: t.id })),
    (item) => setTheme(item.id),
  );
}

async function setTheme(id) {
  const theme = app.snap.themes.find((t) => t.id === id);
  if (theme) applyTheme(theme); // instant, then persist
  const res = await api.call('configure', { theme: id }).catch(() => null);
  if (res?.state) applySnapshot(res.state);
}

// --- settings ---

function openSettings(tab = 'general') {
  const snap = app.snap;
  if (!snap) return;

  const general = () => `
    <div class="row">
      <div><span class="label">Permission mode</span><span class="sub">How Eaon asks before shell commands, writes and edits.</span></div>
      <select data-set="permissionMode">
        ${['confirm', 'auto', 'readonly']
          .map((m) => `<option value="${m}"${snap.permissionMode === m ? ' selected' : ''}>${m === 'confirm' ? 'Ask every time' : m === 'auto' ? 'Auto-approve' : 'Read only'}</option>`)
          .join('')}
      </select>
    </div>
    <div class="row">
      <div><span class="label">Caveman ⛏</span><span class="sub">Output compression. Same substance, fewer output tokens.</span></div>
      <select data-set="caveman">
        ${snap.cavemanLevels.map((l) => `<option value="${l}"${snap.caveman === l ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="row">
      <div><span class="label">Token counters</span><span class="sub">Show usage in the sidebar.</span></div>
      <select data-set="showTokens">
        <option value="1"${snap.showTokens ? ' selected' : ''}>Shown</option>
        <option value="0"${!snap.showTokens ? ' selected' : ''}>Hidden</option>
      </select>
    </div>
    <div class="row" style="display:block">
      <span class="label">Theme</span>
      <span class="sub" style="margin-bottom:10px">Shared with the terminal agent — this is the same list /theme uses.</span>
      <div class="theme-grid">
        ${snap.themes
          .map(
            (t) =>
              `<button class="theme-swatch${t.id === snap.theme ? ' active' : ''}" data-theme="${escapeHtml(t.id)}">` +
              `<span class="dots"><i style="background:${escapeHtml(t.bg)}"></i><i style="background:${escapeHtml(t.accent)}"></i><i style="background:${escapeHtml(t.code)}"></i></span>` +
              `<span class="nm">${escapeHtml(t.name)}</span><span class="ds">${escapeHtml(t.description)}</span></button>`,
          )
          .join('')}
      </div>
    </div>`;

  const models = () => `
    <div class="row">
      <div><span class="label">Main model</span><span class="sub">Does the work.</span></div>
      <select data-set="model">
        ${(snap.models ?? [])
          .map((m) => {
            const v = `${m.provider}/${m.model}`;
            const cur = snap.main && `${snap.main.provider}/${snap.main.model}` === v;
            return `<option value="${escapeHtml(v)}"${cur ? ' selected' : ''}>${escapeHtml(v)}</option>`;
          })
          .join('') || '<option>no models configured</option>'}
      </select>
    </div>
    <div class="row">
      <div><span class="label">Compressor model</span><span class="sub">Summarizes old context. Cheapest model wins.</span></div>
      <select data-set="compressor">
        <option value="">same as main (single-model)</option>
        ${(snap.models ?? [])
          .map((m) => {
            const v = `${m.provider}/${m.model}`;
            const cur = snap.compressor && `${snap.compressor.provider}/${snap.compressor.model}` === v;
            return `<option value="${escapeHtml(v)}"${cur ? ' selected' : ''}>${escapeHtml(v)}</option>`;
          })
          .join('')}
      </select>
    </div>
    <div class="row" style="display:block">
      <span class="label">Providers</span>
      <span class="sub" style="margin-bottom:8px">Configured in ${escapeHtml(snap.configPath)}</span>
      <div class="list">
        ${snap.providers.length
          ? snap.providers.map((p) => `<div class="list-item"><span class="k">${escapeHtml(p.id)}</span><span>${escapeHtml(p.name)}</span><span class="v">${p.models} models</span></div>`).join('')
          : '<div class="list-item">No providers yet.</div>'}
      </div>
    </div>
    <div class="row">
      <div><span class="label">Connect another provider</span><span class="sub">Runs the same onboarding the TUI uses.</span></div>
      <button class="btn" data-act="setup">Open setup</button>
    </div>`;

  const context = () => `
    <div class="row">
      <div><span class="label">Auto-compression</span><span class="sub">A cheap model summarizes old turns so long sessions stay affordable.</span></div>
      <select data-set="compressionEnabled">
        <option value="1"${snap.compression?.enabled ? ' selected' : ''}>On</option>
        <option value="0"${!snap.compression?.enabled ? ' selected' : ''}>Off</option>
      </select>
    </div>
    <div class="row">
      <div><span class="label">Compress past</span><span class="sub">Estimated history size that triggers a compression.</span></div>
      <input type="number" min="2000" step="1000" value="${Number(snap.compression?.thresholdTokens ?? 20000)}" data-set="thresholdTokens">
    </div>
    <div class="row">
      <div><span class="label">Compress now</span><span class="sub">Summarize the current conversation immediately.</span></div>
      <button class="btn" data-act="compress">Compress</button>
    </div>`;

  const about = () => `
    <dl class="kv">
      <dt>App</dt><dd>Eaon Agent ${escapeHtml(app.version)}</dd>
      <dt>Workspace</dt><dd>${escapeHtml(snap.cwd)}</dd>
      <dt>Config</dt><dd>${escapeHtml(snap.configPath)}</dd>
    </dl>
    <div class="row" style="display:block;margin-top:12px">
      <span class="label">Skills</span>
      <span class="sub" style="margin-bottom:8px">Loaded on demand by the model, never all at once.</span>
      <div class="list">
        ${snap.skills.length
          ? snap.skills.map((s) => `<div class="list-item"><span class="k">${escapeHtml(s.name)}</span><span>${escapeHtml(s.description)}</span><span class="v">${escapeHtml(s.source)}</span></div>`).join('')
          : '<div class="list-item">No skills found.</div>'}
      </div>
    </div>
    <div class="row" style="display:block">
      <span class="label">MCP servers</span>
      <div class="list">
        ${snap.mcp.length ? snap.mcp.map((n) => `<div class="list-item"><span class="k">${escapeHtml(n)}</span></div>`).join('') : '<div class="list-item">None configured.</div>'}
      </div>
    </div>
    <div class="row" style="display:block">
      <span class="label">Plugins</span>
      <div class="list">
        ${snap.plugins.length
          ? snap.plugins.map((p) => `<div class="list-item"><span class="k">${escapeHtml(p.name)}</span><span class="v">${escapeHtml(p.version)}</span></div>`).join('')
          : '<div class="list-item">Drop a folder with plugin.json into ~/.eaon/plugins/.</div>'}
      </div>
    </div>
    <div class="row">
      <div><span class="label">Open config folder</span><span class="sub">${escapeHtml(snap.home)}</span></div>
      <button class="btn" data-act="open-home">Reveal</button>
    </div>`;

  const tabs = { general, models, context, about };
  const node = el('div', 'modal wide');
  node.innerHTML =
    `<div class="modal-head"><h2>Settings</h2><button class="close" type="button">✕</button></div>` +
    `<div class="tabs">${Object.keys(tabs).map((k) => `<button class="tab${k === tab ? ' active' : ''}" data-tab="${k}">${k[0].toUpperCase()}${k.slice(1)}</button>`).join('')}</div>` +
    `<div class="modal-body">${tabs[tab]()}</div>`;
  const close = overlay(node);
  node.querySelector('.close').onclick = close;
  node.querySelectorAll('.tab').forEach((btn) => {
    btn.onclick = () => {
      close();
      openSettings(btn.dataset.tab);
    };
  });
  wireSettings(node, close);
}

function wireSettings(node, close) {
  node.querySelectorAll('[data-set]').forEach((field) => {
    field.onchange = async () => {
      const key = field.dataset.set;
      let value = field.value;
      if (key === 'showTokens' || key === 'compressionEnabled') value = field.value === '1';
      if (key === 'thresholdTokens') value = Number(field.value);
      const res = await api.call('configure', { [key]: value }).catch((e) => {
        toast(e.message);
        return null;
      });
      if (res?.state) applySnapshot(res.state);
    };
  });
  node.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.onclick = async () => {
      await setTheme(btn.dataset.theme);
      node.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('active', b === btn));
    };
  });
  node.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === 'setup') { close(); openSetup(); }
      if (act === 'compress') { close(); compressNow(); }
      if (act === 'open-home') api.openPath(app.snap.home);
    };
  });
}

function openStats() {
  const s = app.snap?.stats;
  if (!s) return;
  const life = app.snap.lifetime;
  const mins = (s.elapsedMs / 60000).toFixed(1);
  modal(
    'Session',
    `<dl class="kv">
      <dt>Elapsed</dt><dd>${mins} min</dd>
      <dt>Main model</dt><dd>in ${fmtTokens(s.inputTokens)} · out ${fmtTokens(s.outputTokens)}</dd>
      <dt>Compressor</dt><dd>in ${fmtTokens(s.compressorInput)} · out ${fmtTokens(s.compressorOutput)} (${s.compressionEvents} runs)</dd>
      <dt>Tools</dt><dd>${s.toolCalls} calls · ${s.subagentCalls} sub-agents</dd>
      <dt>Saved</dt><dd>⛏ ${fmtTokens(s.saved)} (${fmtTokens(s.compressedTokens)} compression + ${fmtTokens(s.cavemanSavedEst)} caveman)</dd>
    </dl>` +
      (life
        ? `<div class="row" style="display:block;margin-top:14px"><span class="label">Lifetime</span>
             <dl class="kv" style="margin-top:8px">
               <dt>Sessions</dt><dd>${life.sessions}</dd>
               <dt>Tokens</dt><dd>in ${fmtTokens(life.inputTokens)} · out ${fmtTokens(life.outputTokens)}</dd>
               <dt>Saved</dt><dd>⛏ ${fmtTokens((life.compressedTokens ?? 0) + (life.cavemanSavedEst ?? 0))}</dd>
             </dl></div>`
        : ''),
  );
}

async function showDiff(file) {
  const { node } = modal(file, '<div class="spinner-row"><span class="spinner"></span> Loading diff…</div>', { wide: true });
  const res = await api.call('diff', { file }).catch((e) => ({ diff: '', error: e.message }));
  const body = node.querySelector('.modal-body');
  if (!res.diff) {
    body.innerHTML = `<div class="palette-empty">${escapeHtml(res.error || 'No changes in this file.')}</div>`;
    return;
  }
  body.innerHTML = `<figure class="code-block"><figcaption><span class="code-lang">diff</span></figcaption><pre><code>${renderDiff(res.diff)}</code></pre></figure>`;
}

// ---------------------------------------------------------------------------
// setup wizard
// ---------------------------------------------------------------------------

function openSetup() {
  closeOverlay();
  const host = el('div', 'setup');
  document.body.appendChild(host);

  const wizard = {
    step: 'connect',
    preset: null,
    apiKey: '',
    baseUrl: '',
    models: [],
    main: '',
    compressor: '',
    caveman: app.snap?.caveman ?? 'full',
    error: '',
  };
  const ORDER = ['connect', 'provider', 'key', 'models', 'compressor', 'caveman'];

  const done = () => {
    host.remove();
    document.removeEventListener('keydown', onKey, true);
    input.focus();
  };

  function onKey(e) {
    if (e.key === 'Escape' && app.snap?.configured) done();
  }
  document.addEventListener('keydown', onKey, true);

  function go(step) {
    wizard.step = step;
    draw();
  }

  function steps() {
    const i = ORDER.indexOf(wizard.step);
    return `<div class="steps">${ORDER.map((_, n) => `<i class="${n <= i ? 'on' : ''}"></i>`).join('')}</div>`;
  }

  function draw() {
    const s = wizard.step;
    let body = '';

    if (s === 'connect') {
      body =
        `<h1>Set up Eaon</h1>` +
        `<p class="lede">One model does the work. An optional second, cheaper model compresses old context so long sessions stay affordable.</p>` +
        `<button class="choice" data-go="free"><span class="tag">free</span><strong>Use the built-in free tier</strong><small>OSAII poolside models. No API key, nothing to configure.</small></button>` +
        `<button class="choice" data-go="own"><strong>Connect my own provider</strong><small>Anthropic, OpenAI, OpenRouter, DeepSeek, Groq, Ollama and more.</small></button>`;
    } else if (s === 'provider') {
      body =
        `<h1>Pick a provider</h1><p class="lede">Eaon talks to anything with an OpenAI-compatible or Anthropic API.</p>` +
        `<div class="setup-list">` +
        app.presets
          .filter((p) => !p.free)
          .map(
            (p) =>
              `<button class="choice" data-preset="${escapeHtml(p.id)}"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.hint)}${p.hasKeyInEnv ? ` · ${escapeHtml(p.keyEnv)} found in your environment` : ''}</small></button>`,
          )
          .join('') +
        `</div>`;
    } else if (s === 'key') {
      const p = wizard.preset;
      body =
        `<h1>${escapeHtml(p.name)}</h1>` +
        `<p class="lede">${p.keyEnv ? `Paste an API key, or leave it blank to read <code>${escapeHtml(p.keyEnv)}</code> from your environment.` : 'This provider needs no API key.'}</p>` +
        (p.keyEnv ? `<input class="setup-input" type="password" id="setup-key" placeholder="sk-…" value="${escapeHtml(wizard.apiKey)}">` : '') +
        `<input class="setup-input" type="text" id="setup-url" placeholder="Base URL" value="${escapeHtml(wizard.baseUrl || p.baseUrl)}">`;
    } else if (s === 'fetching') {
      body = `<h1>Finding models</h1><div class="spinner-row"><span class="spinner"></span> asking ${escapeHtml(wizard.preset.name)}…</div>`;
    } else if (s === 'models') {
      body =
        `<h1>Main model</h1><p class="lede">The model that reasons, writes code and calls tools.</p>` +
        `<div class="setup-list">${wizard.models.map((m) => `<button class="choice" data-model="${escapeHtml(m)}"><strong>${escapeHtml(m)}</strong></button>`).join('')}</div>`;
    } else if (s === 'compressor') {
      body =
        `<h1>Compressor model</h1><p class="lede">Only summarizes old turns. Pick the cheapest one, or reuse the main model.</p>` +
        `<div class="setup-list">` +
        `<button class="choice" data-comp=""><strong>Same as main</strong><small>Single-model mode — nothing else to configure.</small></button>` +
        wizard.models.map((m) => `<button class="choice" data-comp="${escapeHtml(m)}"><strong>${escapeHtml(m)}</strong></button>`).join('') +
        `</div>`;
    } else if (s === 'caveman') {
      const levels = [
        ['full', 'Short fragments. The default.'],
        ['lite', 'Normal sentences, no filler.'],
        ['ultra', 'Maximum compression.'],
        ['wenyan', 'Classical Chinese — densest of all.'],
        ['off', 'Ordinary, verbose replies.'],
      ];
      body =
        `<h1>Caveman mode ⛏</h1><p class="lede">Style compression on the model's output. Code, paths and commands are never touched — only the prose around them.</p>` +
        levels.map(([id, note]) => `<button class="choice" data-cave="${id}"><strong>${id}</strong><small>${escapeHtml(note)}</small></button>`).join('');
    } else if (s === 'saving') {
      body = `<h1>Saving</h1><div class="spinner-row"><span class="spinner"></span> writing ~/.eaon/config.json…</div>`;
    }

    host.innerHTML =
      `<div class="setup-card">` +
      `<div class="setup-mark"><svg viewBox="0 0 24 24" fill="none"><path d="M4 6.5 10 12l-6 5.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 18h7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></div>` +
      (ORDER.includes(s) ? steps() : '') +
      body +
      (wizard.error ? `<p class="setup-error">${escapeHtml(wizard.error)}</p>` : '') +
      `<div class="setup-actions">` +
      (s !== 'connect' && ORDER.includes(s) ? `<button class="btn" data-back>Back</button>` : '') +
      (s === 'key' ? `<button class="btn solid" data-next>Continue</button>` : '') +
      `<span class="grow"></span>` +
      (app.snap?.configured ? `<button class="link" data-cancel>Cancel</button>` : '') +
      `</div></div>`;

    host.querySelectorAll('[data-go]').forEach((btn) => {
      btn.onclick = () => (btn.dataset.go === 'free' ? useFreeTier() : go('provider'));
    });
    host.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.onclick = () => {
        wizard.preset = app.presets.find((p) => p.id === btn.dataset.preset);
        wizard.baseUrl = wizard.preset.baseUrl;
        wizard.apiKey = wizard.preset.hasKeyInEnv ? `\${${wizard.preset.keyEnv}}` : '';
        go('key');
      };
    });
    host.querySelector('[data-next]')?.addEventListener('click', fetchModels);
    host.querySelector('#setup-key')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fetchModels();
    });
    host.querySelector('#setup-url')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fetchModels();
    });
    host.querySelectorAll('[data-model]').forEach((btn) => {
      btn.onclick = () => {
        wizard.main = btn.dataset.model;
        go('compressor');
      };
    });
    host.querySelectorAll('[data-comp]').forEach((btn) => {
      btn.onclick = () => {
        wizard.compressor = btn.dataset.comp;
        go('caveman');
      };
    });
    host.querySelectorAll('[data-cave]').forEach((btn) => {
      btn.onclick = () => {
        wizard.caveman = btn.dataset.cave;
        save();
      };
    });
    host.querySelector('[data-back]')?.addEventListener('click', () => {
      const i = ORDER.indexOf(wizard.step);
      wizard.error = '';
      go(ORDER[Math.max(0, i - 1)]);
    });
    host.querySelector('[data-cancel]')?.addEventListener('click', done);
    host.querySelector('.setup-input')?.focus();
  }

  async function useFreeTier() {
    go('saving');
    try {
      const res = await api.call('free_tier');
      applySnapshot(res.state);
      done();
      clearTranscript();
      toast('Free tier ready — poolside models, no key.');
    } catch (e) {
      wizard.error = e.message;
      go('connect');
    }
  }

  async function fetchModels() {
    wizard.apiKey = host.querySelector('#setup-key')?.value ?? '';
    wizard.baseUrl = host.querySelector('#setup-url')?.value ?? wizard.preset.baseUrl;
    wizard.error = '';
    go('fetching');
    const res = await api
      .call('fetch_models', { presetId: wizard.preset.id, apiKey: wizard.apiKey, baseUrl: wizard.baseUrl })
      .catch((e) => ({ models: [], error: e.message }));
    if (!res.models?.length) {
      wizard.error = `Could not reach ${wizard.preset.name}: ${res.error ?? 'no models returned'}. Check the key and base URL.`;
      go('key');
      return;
    }
    wizard.models = res.models;
    go('models');
  }

  async function save() {
    go('saving');
    try {
      const res = await api.call('save_setup', {
        presetId: wizard.preset.id,
        apiKey: wizard.apiKey,
        baseUrl: wizard.baseUrl,
        models: wizard.models,
        mainModel: wizard.main,
        compressorModel: wizard.compressor,
        caveman: wizard.caveman,
      });
      applySnapshot(res.state);
      done();
      clearTranscript();
      toast(`Ready — ${res.state.main.provider}/${res.state.main.model}`);
    } catch (e) {
      wizard.error = e.message;
      go('caveman');
    }
  }

  draw();
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function newChat() {
  if (app.busy) await cancel();
  const res = await api.call('clear').catch(() => null);
  if (res?.state) applySnapshot(res.state);
  clearTranscript();
  input.focus();
}

async function openFolder() {
  const dir = await api.pickFolder();
  if (!dir) return;
  try {
    const res = await api.call('open_workspace', { cwd: dir });
    applySnapshot(res.state);
    applyGit(res.git);
    clearTranscript();
    toast(`Workspace → ${res.state.workspace}`);
  } catch (e) {
    toast(e.message);
  }
}

async function compressNow() {
  if (!app.snap?.configured) return;
  const res = await api.call('compress').catch((e) => ({ text: e.message }));
  if (res.state) applySnapshot(res.state);
  addNote(res.text ?? '', 'accent');
}

$('btn-new').onclick = newChat;
$('ws-chip').onclick = openFolder;
$('btn-compress').onclick = compressNow;
$('btn-model').onclick = () => openModelPicker(null);
$('btn-palette').onclick = openPalette;
$('btn-settings').onclick = () => openSettings();
$('btn-stats').onclick = openStats;
$('btn-about').onclick = () => openSettings('about');
$('btn-refresh-git').onclick = (e) => {
  e.stopPropagation();
  refreshGit();
};

$('sel-permissions').onchange = async (e) => {
  const res = await api.call('configure', { permissionMode: e.target.value }).catch(() => null);
  if (res?.state) applySnapshot(res.state);
};
$('sel-caveman').onchange = async (e) => {
  const res = await api.call('configure', { caveman: e.target.value }).catch(() => null);
  if (res?.state) applySnapshot(res.state);
};
$('sel-theme').onchange = (e) => setTheme(e.target.value);

api.onAction(({ action }) => {
  switch (action) {
    case 'new-chat': newChat(); break;
    case 'open-folder': openFolder(); break;
    case 'settings': openSettings(); break;
    case 'setup': openSetup(); break;
    case 'palette': openPalette(); break;
    case 'models': openModelPicker(null); break;
    case 'stats': openStats(); break;
    case 'compress': compressNow(); break;
    case 'cancel': cancel(); break;
    case 'sidebar': $('sidebar').classList.toggle('collapsed'); break;
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  // Typing anywhere goes to the composer, the way a chat app should behave.
  if (app.overlay || app.askId) return;
  const target = e.target;
  const typing = target === input || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1 || e.key === 'Backspace') input.focus();
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  const info = await api.info();
  app.version = info.version;

  // The engine forks in parallel with the window; retry briefly on a cold start.
  let hello = null;
  for (let attempt = 0; attempt < 40 && !hello; attempt++) {
    hello = await api.call('hello', { cwd: null }).catch(() => null);
    if (!hello) await new Promise((r) => setTimeout(r, 100));
  }
  if (!hello) {
    transcript.innerHTML = '';
    addNote('The agent engine did not start. Reinstall the app, or run "npm run build" in the repo if you are running from source.', 'error');
    return;
  }

  app.presets = hello.presets ?? [];
  app.commands = hello.commands ?? [];
  app.help = hello.help ?? '';
  applySnapshot(hello.state);
  applyGit(hello.git);
  clearTranscript();
  setBusy(false);
  input.focus();

  if (!hello.state.configured) openSetup();
  setInterval(refreshGit, 15000);
}

boot();
