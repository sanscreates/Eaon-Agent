#!/usr/bin/env node
/**
 * Eaon Bridge — PTY sidecar.
 *
 * A tiny Node process that owns the real PTY on behalf of the desktop shell.
 * It is spawned by the Electron main process and runs under the SAME bundled
 * Node (engine/runtime/darwin-{arch}/bin/node) as the agent, so node-pty is
 * compiled for that ABI and Electron never rebuilds anything native.
 *
 * Protocol (newline-delimited JSON on stdin/stdout):
 *   in   spawn {node, script, cwd, env, rows, cols}
 *   in   input {data}
 *   in   resize {cols, rows}
 *   in   kill
 *   out  ready                          after the PTY is created
 *   out  output {data}                  base64 of utf8 bytes
 *   out  exit  {code}                   PTY session ended
 *   out  notice {message}               diagnostics (spawn failures, etc.)
 *
 * The bridge writes a `ready` only after the PTY actually exists, so the main
 * process (and the renderer) always see the agent as "booted" once ready
 * arrives — no need to probe the agent's own TTY readiness.
 */

import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = __dirname;

let session = null; // { pty: IPty }

/** Emit one JSON line to the main process. */
function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch {
    /* stdout gone; nothing we can do */
  }
}

/** Kill the current PTY (if any) and drop the reference. */
function teardown() {
  if (session) {
    try {
      session.pty.kill();
    } catch {
      /* already dead */
    }
    session = null;
  }
}

/** Handle a `spawn` request: create the PTY and run the agent inside it. */
function handleSpawn(msg) {
  const { node, script, cwd, env, rows = 24, cols = 80 } = msg ?? {};
  if (!node || !script || !cwd) {
    send({ type: 'notice', message: `bad spawn message: node/script/cwd required (${JSON.stringify({ node, script, cwd })})` });
    return;
  }

  teardown();

  let proc;
  try {
    proc = pty.spawn(node, [script], {
      name: 'xterm-256color',
      cols: Math.max(1, Number.isFinite(cols) ? cols : 80),
      rows: Math.max(1, Number.isFinite(rows) ? rows : 24),
      cwd,
      env: { ...process.env, ...(env ?? {}) },
    });
  } catch (err) {
    send({ type: 'notice', message: `pty spawn failed for ${script}: ${err.message}` });
    return;
  }

  // Feed PTY output back to the main process as base64 of the utf8 bytes so
  // the framing is unambiguous even if the terminal data contains newlines.
  proc.onData((data) => {
    let b64;
    try {
      b64 = Buffer.from(data, 'utf8').toString('base64');
    } catch {
      return;
    }
    send({ type: 'output', data: b64 });
  });

  proc.onExit(({ exitCode, signal }) => {
    if (session?.pty === proc) session = null;
    send({ type: 'exit', code: typeof exitCode === 'number' ? exitCode : null, signal: signal ?? null });
  });

  session = { pty: proc };
  send({ type: 'ready' });
}

function handleInput(data) {
  if (session && typeof data === 'string') {
    try {
      session.pty.write(data);
    } catch {
      /* pty closed */
    }
  }
}

function handleResize(cols, rows) {
  if (session && Number.isFinite(cols) && Number.isFinite(rows)) {
    try {
      session.pty.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      /* pty closed */
    }
  }
}

function handleKill() {
  teardown();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Line-driven stdin loop
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore malformed lines
  }
  if (!msg || typeof msg !== 'object') return;
  try {
    switch (msg.type) {
      case 'spawn': handleSpawn(msg); break;
      case 'input': handleInput(msg.data); break;
      case 'resize': handleResize(msg.cols, msg.rows); break;
      case 'kill': handleKill(); break;
      default: break;
    }
  } catch (err) {
    send({ type: 'notice', message: `failed to handle ${msg.type}: ${err.message}` });
  }
});

// stdin EOF (main closed its end) — tear down anything still alive and exit.
rl.on('close', () => {
  teardown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  teardown();
  process.exit(0);
});

process.on('SIGINT', () => {
  teardown();
  process.exit(0);
});