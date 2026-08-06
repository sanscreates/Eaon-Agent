#!/usr/bin/env node
/**
 * Eaon Agent — headless end-to-end smoke test.
 *
 * Proves the whole stack works WITHOUT Electron: it speaks the bridge protocol
 * directly to `engine/bridge.mjs`, which opens a real PTY running the packaged
 * agent. Verifies:
 *   - the engine layout from package-engine.mjs is present,
 *   - a PTY spawns and the agent renders UI text (isolated HOME, so the user's
 *     real ~/.eaon is never touched),
 *   - a resize round-trip does not kill the session,
 *   - Enter is accepted and Ctrl-C ends the agent with exit code 0.
 *
 * Usage: node e2e/smoke.mjs [engineDir]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MACAPP_ROOT = path.resolve(__dirname, '..');
const ENGINE_DIR = path.resolve(process.argv[2] ?? path.join(MACAPP_ROOT, 'resources', 'engine'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`\nSMOKE FAIL: ${msg}\n`);
  process.exit(1);
};
const log = (msg) => console.log(`[smoke] ${msg}`);

const arch = () => (process.arch === 'arm64' ? 'arm64' : 'x64');
const stripAnsi = (s) =>
  s.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><#]/g, '');

/**
 * Wraps the bridge child: buffers stdout, splits newline-delimited JSON,
 * decodes base64 output into `rawOut`, and resolves pending waiters by type.
 */
class BridgeDriver {
  constructor(child) {
    this.child = child;
    this.rawOut = '';
    this.lines = [];
    this.sawExit = false;
    this.childExitPromise = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    this.waiters = [];
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && typeof msg === 'object') this.onMessage(msg);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
  }

  onMessage(msg) {
    if (msg.type === 'output' && typeof msg.data === 'string') {
      this.rawOut += Buffer.from(msg.data, 'base64').toString('utf8');
    }
    if (msg.type === 'exit') this.sawExit = true;
    this.lines.push(msg);
    const matched = this.waiters.filter((w) => w.type === msg.type);
    this.waiters = this.waiters.filter((w) => w.type !== msg.type);
    for (const w of matched) {
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  }

  waitFor(type, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${label ?? 'waitFor'} timed out after ${timeoutMs}ms looking for {type:"${type}"}`));
      }, timeoutMs);
      this.waiters.push({ type, resolve, timer });
    });
  }

  send(msg) {
    try {
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      /* pipe closed */
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Engine layout
// ---------------------------------------------------------------------------

if (!fs.existsSync(ENGINE_DIR)) fail(`engine dir missing: ${ENGINE_DIR}`);
const nodeBin = path.join(ENGINE_DIR, 'runtime', `darwin-${arch()}`, 'bin', 'node');
const bridge = path.join(ENGINE_DIR, 'bridge.mjs');
const dist = path.join(ENGINE_DIR, 'dist', 'index.js');
for (const [label, p] of [
  ['node binary', nodeBin],
  ['bridge.mjs', bridge],
  ['dist/index.js', dist],
]) {
  if (!fs.existsSync(p)) fail(`engine layout incomplete: ${label} missing at ${p}`);
}
log(`engine ok: ${ENGINE_DIR}`);

// ---------------------------------------------------------------------------
// 2. Isolated environment (never touch the user's real ~/.eaon)
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-smoke-'));
const isolatedHome = path.join(tmpRoot, 'home');
const workspace = path.join(tmpRoot, 'workspace');
fs.mkdirSync(isolatedHome);
fs.mkdirSync(workspace);

const env = {
  ...process.env,
  HOME: isolatedHome,
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERM_PROGRAM: 'Eaon Agent Smoke',
};

// ---------------------------------------------------------------------------
// 3. Spawn the bridge and boot the agent in a PTY
// ---------------------------------------------------------------------------

const child = spawn(nodeBin, [bridge], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: ENGINE_DIR,
  env: { ...process.env },
});
const driver = new BridgeDriver(child);

driver.send({
  type: 'spawn',
  node: nodeBin,
  script: dist,
  cwd: workspace,
  env,
  rows: 30,
  cols: 100,
});

log('waiting for bridge ready (PTY spawned)...');
try {
  await driver.waitFor('ready', 15000, 'PTY spawn');
} catch (err) {
  fail(`${err.message}\n--- buffered output ---\n${excerpt(driver.rawOut)}`);
}
log('PTY ready. waiting for the agent to paint...');
await sleep(800);

// ---------------------------------------------------------------------------
// 4. First frame must contain printable UI text
// ---------------------------------------------------------------------------

const text = stripAnsi(driver.rawOut);
log(`agent painted ${driver.rawOut.length} bytes (${text.length} printable)`);
if (text.length < 60) {
  fail(`agent output too empty — is it rendering?\n--- buffered ---\n${excerpt(driver.rawOut)}`);
}
if (!/(eaon|welcome|cvars|agentic)/i.test(text)) {
  fail(`expected Eaon UI strings in output, none found.\n--- buffered ---\n${excerpt(driver.rawOut)}`);
}
log('agent UI confirmed on screen');

// ---------------------------------------------------------------------------
// 5. Resize round-trip must not crash the session
// ---------------------------------------------------------------------------

driver.send({ type: 'resize', cols: 120, rows: 40 });
await sleep(600);
if (driver.sawExit) fail('session exited during resize round-trip');
log('resize round-trip ok');

// ---------------------------------------------------------------------------
// 6. Enter → then Ctrl-C → expect a clean PTY exit with code 0
// ---------------------------------------------------------------------------

driver.send({ type: 'input', data: '\r' });
await sleep(1500);
driver.send({ type: 'input', data: '\x03' });

log('waiting for agent exit...');
let exitMsg;
try {
  exitMsg = await driver.waitFor('exit', 10000, 'agent PTY exit');
} catch (err) {
  fail(`${err.message}\n--- last 800 chars ---\n${excerpt(driver.rawOut, 800)}`);
}
if (exitMsg.code !== 0) fail(`agent exited with code ${exitMsg.code} (expected 0)`);
log('agent exited cleanly with code 0');

// 7. Tear the bridge down (kills the bridge process)
driver.send({ type: 'kill' });
const { code: bridgeCode } = await driver.childExitPromise;
if (bridgeCode !== null && bridgeCode !== 0) fail(`bridge exited ${bridgeCode}`);

fs.rmSync(tmpRoot, { recursive: true, force: true });
log('SMOKE OK');
process.exit(0);

// ---------------------------------------------------------------------------

function excerpt(raw, max = 1200) {
  const t = stripAnsi(raw);
  const slice = t.length > max ? `...${t.slice(-max)}` : t;
  return slice
    .split('\n')
    .slice(-30)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((l) => l.length > 1)
    .join('\n');
}