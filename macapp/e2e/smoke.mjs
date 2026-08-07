#!/usr/bin/env node
// End-to-end check of the desktop app's two halves that can run without a
// window: the engine protocol (against the offline echo provider) and the
// renderer's markdown pipeline.
//
//   node e2e/smoke.mjs
//
// Runs against a throwaway HOME, so it never touches ~/.eaon.

import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdown, renderDiff, highlight } from '../renderer/markdown.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const macapp = path.resolve(here, '..');
const repo = path.resolve(macapp, '..');
const dist = path.join(repo, 'dist');

if (!fs.existsSync(path.join(dist, 'core', 'runtime.js'))) {
  console.error('No agent build found. Run "npm run build" in the repo root first.');
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-smoke-'));
const work = path.join(home, 'project');
fs.mkdirSync(path.join(home, '.eaon'), { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, 'README.md'), '# smoke\n');
fs.writeFileSync(
  path.join(home, '.eaon', 'config.json'),
  JSON.stringify(
    {
      version: 1,
      providers: [{ id: 'echo', name: 'Echo', type: 'echo', models: ['echo-1'] }],
      main: { provider: 'echo', model: 'echo-1' },
      permissions: { mode: 'confirm', allow: [] },
      ui: { showTokens: true, maxToolResultChars: 12000, theme: 'eaon' },
    },
    null,
    2,
  ),
);

const engine = fork(path.join(macapp, 'engine', 'server.mjs'), [dist], {
  env: { ...process.env, HOME: home, EAON_APP_VERSION: '1.5.0-test' },
  cwd: work,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  serialization: 'json',
});

let seq = 1;
const waiting = new Map();
const events = [];
const listeners = new Set();

engine.on('message', (msg) => {
  if (msg.ev) {
    events.push(msg);
    for (const fn of [...listeners]) fn(msg);
    return;
  }
  const p = waiting.get(msg.id);
  if (!p) return;
  waiting.delete(msg.id);
  msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
});

function call(type, payload = {}) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    engine.send({ id, type, ...payload });
  });
}

function onEvent(predicate, timeout = 15000) {
  const hit = events.find(predicate);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(fn);
      reject(new Error('timed out waiting for an engine event'));
    }, timeout);
    const fn = (msg) => {
      if (!predicate(msg)) return;
      clearTimeout(timer);
      listeners.delete(fn);
      resolve(msg);
    };
    listeners.add(fn);
  });
}

const textSince = (from) =>
  events
    .slice(from)
    .filter((e) => e.ev === 'text')
    .map((e) => e.text)
    .join('');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

// ---------------------------------------------------------------------------

console.log('engine protocol');

await onEvent((e) => e.ev === 'ready');

let hello;
await check('hello returns a configured snapshot', async () => {
  hello = await call('hello', { cwd: work });
  assert.equal(hello.state.configured, true);
  assert.equal(hello.state.main.provider, 'echo');
  assert.equal(hello.state.workspace, 'project');
  assert.ok(hello.commands.length > 10, 'commands metadata missing');
  assert.ok(hello.presets.some((p) => p.free), 'free tier preset missing');
  assert.ok(hello.state.themes.length > 10, 'themes missing');
});

await check('a prompt streams text and finishes', async () => {
  const from = events.length;
  const res = await call('send', { text: 'hello there' });
  assert.equal(res.kind, 'done');
  assert.match(textSince(from), /Echo: hello there/);
  assert.ok(res.state.stats.outputTokens > 0, 'usage was not recorded');
});

await check('tool calls surface as start/end events', async () => {
  await call('clear');
  const from = events.length;
  await call('send', { text: 'tool:list_files {"path":"."}' });
  const started = events.slice(from).find((e) => e.ev === 'tool_start');
  const ended = events.slice(from).find((e) => e.ev === 'tool_end');
  assert.ok(started, 'no tool_start event');
  assert.equal(started.call.name, 'list_files');
  assert.ok(ended, 'no tool_end event');
  assert.match(ended.result, /README\.md/);
});

await check('permission requests round-trip', async () => {
  // The echo provider only emits a tool call while the history has no tool
  // result in it, so each tool check starts from a clean conversation.
  await call('clear');
  const from = events.length;
  const done = call('send', { text: 'tool:run_shell {"command":"printf permission-ok"}' });
  const ask = await onEvent((e) => e.ev === 'permission');
  assert.equal(ask.request.kind, 'shell');
  assert.match(ask.request.detail, /permission-ok/);
  await call('answer', { askId: ask.askId, value: 'once' });
  await done;
  const ended = events.slice(from).find((e) => e.ev === 'tool_end');
  assert.match(ended.result, /permission-ok/);
});

await check('denying a permission stops the tool', async () => {
  await call('clear');
  const from = events.length;
  const done = call('send', { text: 'tool:run_shell {"command":"printf nope"}' });
  const ask = await onEvent((e) => e.ev === 'permission' && events.indexOf(e) >= from);
  await call('answer', { askId: ask.askId, value: 'deny' });
  await done;
  const ended = events.slice(from).find((e) => e.ev === 'tool_end');
  assert.match(ended.result, /Denied by user/);
});

await check('slash commands run through the shared handler', async () => {
  const from = events.length;
  const res = await call('send', { text: '/help' });
  assert.equal(res.kind, 'done');
  const notice = events.slice(from).find((e) => e.ev === 'notice');
  assert.match(notice.text, /\/model/);
});

await check('unknown slash commands are reported', async () => {
  const res = await call('send', { text: '/definitely-not-a-command' });
  assert.equal(res.kind, 'unknown');
});

await check('settings changes persist to config', async () => {
  const res = await call('configure', { caveman: 'ultra', permissionMode: 'auto', theme: 'codex' });
  assert.equal(res.state.caveman, 'ultra');
  assert.equal(res.state.permissionMode, 'auto');
  assert.equal(res.state.theme, 'codex');
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, '.eaon', 'config.json'), 'utf8'));
  assert.equal(onDisk.ui.theme, 'codex');
  assert.equal(onDisk.caveman.level, 'ultra');
});

await check('auto mode skips the permission prompt', async () => {
  await call('clear');
  const from = events.length;
  await call('send', { text: 'tool:run_shell {"command":"printf auto-ok"}' });
  assert.ok(!events.slice(from).some((e) => e.ev === 'permission'), 'still asked in auto mode');
  const ended = events.slice(from).find((e) => e.ev === 'tool_end');
  assert.match(ended.result, /auto-ok/);
});

await check('workspace can move to another folder', async () => {
  const other = path.join(home, 'other');
  fs.mkdirSync(other, { recursive: true });
  const res = await call('open_workspace', { cwd: other });
  assert.equal(res.state.workspace, 'other');
  assert.equal(res.git.repo, false);
});

await check('clear resets the conversation', async () => {
  const res = await call('clear');
  assert.ok(res.state);
});

await check('model list fetch falls back for the free tier', async () => {
  const res = await call('fetch_models', { presetId: 'osaii', apiKey: '', baseUrl: 'http://127.0.0.1:9/v1' });
  assert.ok(res.models.length > 0, 'no fallback models offered');
  assert.ok(res.models.every((m) => m.startsWith('poolside/')));
});

// ---------------------------------------------------------------------------

console.log('renderer markdown');

await check('code fences render highlighted and escaped', async () => {
  const html = renderMarkdown('Try this:\n\n```js\nconst x = 1; // note\n```\n');
  assert.match(html, /class="code-block"/);
  assert.match(html, /tok-keyword/);
  assert.match(html, /tok-comment/);
});

await check('html in model output is escaped', async () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> and `<b>code</b>`');
  assert.ok(!html.includes('<img'), 'raw html survived');
  assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
});

await check('lists, headings and inline styles render', async () => {
  const html = renderMarkdown('## Title\n\n- one **bold**\n- two `code`\n\n> quote\n');
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<li>one <strong>bold<\/strong><\/li>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<blockquote>/);
});

await check('diffs are colorized', async () => {
  const html = renderDiff('@@ -1 +1 @@\n-old\n+new');
  assert.match(html, /diff-hunk/);
  assert.match(html, /diff-add/);
  assert.match(html, /diff-del/);
});

await check('unknown languages fall back to plain escaping', async () => {
  assert.equal(highlight('<x>', 'brainfuck'), '&lt;x&gt;');
});

// ---------------------------------------------------------------------------
// The checks above all run the engine out of the repo, where dist/ inherits
// "type": "module" from the root package.json. Inside the .app there is no
// such ancestor, so the bundle has to declare it itself — a mistake that is
// invisible in development and fatal on a user's machine. Boot the engine from
// the staged bundle layout to prove it.

console.log('packaged bundle');

await check('staged engine boots the way it will inside the .app', async () => {
  const staged = path.join(macapp, 'resources', 'engine');
  execFileSync('node', [path.join(macapp, 'scripts', 'package-engine.mjs')], { stdio: 'pipe' });

  assert.ok(fs.existsSync(path.join(staged, 'server.mjs')), 'server.mjs was not staged');
  const marker = path.join(staged, 'dist', 'package.json');
  assert.ok(fs.existsSync(marker), 'dist/package.json module marker is missing');
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).type, 'module');
  assert.ok(!fs.existsSync(path.join(staged, 'dist', 'ui')), 'the TUI shipped in the GUI bundle');

  // Copy the staged engine somewhere with no package.json above it at all —
  // exactly the situation inside Contents/Resources.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-bundle-'));
  fs.cpSync(staged, isolated, { recursive: true });

  const child = fork(path.join(isolated, 'server.mjs'), [path.join(isolated, 'dist')], {
    env: { ...process.env, HOME: home },
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b));

  try {
    const state = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`engine never became ready. stderr:\n${stderr.slice(0, 600)}`)), 20000);
      child.on('exit', (code) => reject(new Error(`engine exited (${code}). stderr:\n${stderr.slice(0, 600)}`)));
      child.on('message', (msg) => {
        if (msg.ev === 'ready') child.send({ id: 1, type: 'hello', cwd: work });
        if (msg.id === 1) {
          clearTimeout(timer);
          msg.ok ? resolve(msg.result.state) : reject(new Error(msg.error));
        }
      });
    });
    assert.equal(state.configured, true);
    assert.equal(state.main.provider, 'echo');
  } finally {
    child.kill();
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

await call('shutdown').catch(() => {});
engine.kill();
fs.rmSync(home, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
