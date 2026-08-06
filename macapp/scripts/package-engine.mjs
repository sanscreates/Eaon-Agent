#!/usr/bin/env node
/**
 * Eaon Agent — engine packager.
 *
 * Builds `macapp/resources/engine` from the agent repo root, so that the
 * desktop app ships with:
 *   dist/                  compiled agent (tsc output)
 *   node_modules/          agent prod deps + node-pty
 *   bridge.mjs             this repo's PTY sidecar (copied from macapp/bridge.mjs)
 *   runtime/darwin-<arch>/ unpacked official Node tarball (bin, lib/node_modules/npm, include, ...)
 *   manifest.json          version + node + arch metadata
 *
 * node-pty is compiled against the BUNDLED node (installed via the bundled
 * npm-cli.js), so the PTY sidecar and the agent share one ABI — no native
 * rebuilds are ever needed inside Electron.
 *
 * Usage:  node scripts/package-engine.mjs [agentRoot]
 *
 * Idempotent: cleans `resources/engine` on each run. Requires network access
 * (nodejs.org download + npm registry) and a macOS toolchain for node-gyp.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url)); // macapp/scripts
const APP_ROOT = path.resolve(HERE, '..'); // macapp
const DEFAULT_AGENT_ROOT = path.resolve(HERE, '../..'); // repo root
const AGENT_ROOT = path.resolve(process.argv[2] ?? DEFAULT_AGENT_ROOT);

// Keep in sync with the desktop app's version + the node pinned in the manifest.
const DESKTOP_VERSION = '1.5.0';
const NODE_VERSION = '22.17.0';
const ENGINE_DIR = path.join(APP_ROOT, 'resources', 'engine');
const ENGINE_PKG_NAME = 'node-v' + NODE_VERSION;

const fail = (msg) => {
  console.error('\n[eao-engine] ERROR:', msg, '\n');
  process.exit(1);
};
const log = (msg) => console.log(`[eao-engine] ${msg}`);

/** Run a command, inheriting all stdio. Throws (exits 1) on non-zero status. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) fail(`failed to exec \`${cmd} ${args.join(' ')}\`: ${r.error.message}`);
  if (r.status !== 0) {
    fail(`\`${cmd} ${args.join(' ')}\` exited ${r.status}${r.signal ? ` (${r.signal})` : ''}`);
  }
}

const arch = (process.env.EAON_ARCH || process.arch) === 'arm64' ? 'arm64' : 'x64';
const runtimePath = path.join(ENGINE_DIR, 'runtime', `darwin-${arch}`);
const bundledNode = path.join(runtimePath, 'bin', 'node');

// ---------------------------------------------------------------------------
// Step 0 — sanity-check the agent project
// ---------------------------------------------------------------------------

const agentPkgPath = path.join(AGENT_ROOT, 'package.json');
if (!fs.existsSync(agentPkgPath)) fail(`No package.json at ${AGENT_ROOT}. Pass the repo root as argv[2].`);
const agentPkg = JSON.parse(fs.readFileSync(agentPkgPath, 'utf8'));
log(`packaging agent ${agentPkg.name}@${agentPkg.version} (arch=${arch})`);

// ---------------------------------------------------------------------------
// Step 1 — build the agent (bare tsc), then leave node_modules prod-only
// ---------------------------------------------------------------------------

if (!fs.existsSync(path.join(AGENT_ROOT, 'node_modules', '.bin', 'tsc'))) {
  log('installing full deps (needs typescript for the build)...');
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: AGENT_ROOT });
}

log('building agent (tsc -p tsconfig.json)...');
run('npm', ['run', 'build'], { cwd: AGENT_ROOT });

const distEntry = path.join(AGENT_ROOT, 'dist', 'index.js');
if (!fs.existsSync(distEntry)) fail(`build produced no ${distEntry}`);

log('pruning node_modules to production-only for packaging...');
run('npm', ['prune', '--omit=dev'], { cwd: AGENT_ROOT });

// ---------------------------------------------------------------------------
// Step 2 — reset the engine directory
// ---------------------------------------------------------------------------
fs.rmSync(ENGINE_DIR, { recursive: true, force: true });
fs.mkdirSync(ENGINE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Step 3 — copy the agent bits
// ---------------------------------------------------------------------------
fs.cpSync(path.join(AGENT_ROOT, 'node_modules'), path.join(ENGINE_DIR, 'node_modules'), { recursive: true });
fs.cpSync(path.join(AGENT_ROOT, 'dist'), path.join(ENGINE_DIR, 'dist'), { recursive: true });

for (const f of ['package.json', 'README.md', 'LICENSE']) {
  const src = path.join(AGENT_ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ENGINE_DIR, f));
}

log('agent copied (node_modules + dist + package.json/README/LICENSE)');
log('size so far: ' + fmtBytes(dirSize(ENGINE_DIR)));

// ---------------------------------------------------------------------------
// Step 4 — download & unpack the official Node runtime
// ---------------------------------------------------------------------------
const nodeTar = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-engine-'));
const tmpTar = path.join(tmpWork, 'node.tar.gz');

log(`downloading ${nodeTar} ...`);
const res = await fetch(nodeTar);
if (!res.ok) fail(`Node download failed: HTTP ${res.status} ${res.statusText}`);
fs.writeFileSync(tmpTar, Buffer.from(await res.arrayBuffer()));

log('extracting runtime tar...');
run('tar', ['-xzf', tmpTar, '-C', tmpWork]);

const extractRoot = path.join(tmpWork, `node-v${NODE_VERSION}-darwin-${arch}`);
if (!fs.existsSync(path.join(extractRoot, 'bin', 'node'))) fail(`tarball did not contain node binary (${extractRoot})`);

fs.mkdirSync(runtimePath, { recursive: true });
fs.cpSync(extractRoot, runtimePath, { recursive: true });
fs.rmSync(tmpWork, { recursive: true, force: true });
log(`node runtime installed at ${runtimePath} (node ${NODE_VERSION})`);
run(bundledNode, ['--version']);

// ---------------------------------------------------------------------------
// Step 5 — install node-pty with the bundled npm (ABI match)
// ---------------------------------------------------------------------------
const npmCli = path.join(runtimePath, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!fs.existsSync(npmCli)) fail(`bundled npm-cli missing at ${npmCli}`);
log('installing node-pty against the bundled node ABI...');

// node-pty >=1.1 ships NAPI prebuilt binaries (darwin-x64 / darwin-arm64 / …) which are
// loaded by the bundled node with no ABI mismatch. npm *can* drop the exec bit on
// `spawn-helper` when it extracts those prebuilds, which makes posix_spawnp fail with
// EACCES ("posix_spawnp failed") on macOS. Re-assert the exec bit defensively.
const ptyRoot = path.join(ENGINE_DIR, 'node_modules', 'node-pty');
// Install the node-pty native module along with the agent's production deps.
// --omit=dev matters: ENGINE_DIR/package.json is the agent's own, which still
// lists devDeps (typescript, @types/*). Without the flag npm would re-install
// all of them here, bloating every DMG by ~30 MB for packages the agent never
// runs. Production deps (commander/ink/react) are kept and verified below.
run(bundledNode, [npmCli, 'install', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error', `--prefix=${ENGINE_DIR}`, 'node-pty@^1.0.0'], { cwd: ENGINE_DIR });

const prebuildsDir = path.join(ptyRoot, 'prebuilds');
if (fs.existsSync(prebuildsDir)) {
  for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const helper of ['spawn-helper', 'conpty.dll', 'conpty_console_list.dll']) {
      const p = path.join(prebuildsDir, entry.name, helper);
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
  }
  log('ensured spawn-helper binaries are executable');
}

// End-to-end probe: load node-pty and run a real PTY round-trip. If this fails the
// engine would be useless, so fail loudly rather than ship a broken runtime.
const ptyEntry = path.join(ptyRoot, 'lib', 'index.js');
if (!fs.existsSync(ptyEntry)) fail('node-pty install did not produce node_modules/node-pty/lib/index.js');
for (const pkg of ['react', 'ink', 'commander']) {
  if (!fs.existsSync(path.join(ENGINE_DIR, 'node_modules', pkg, 'package.json'))) {
    fail(`engine node_modules missing agent dep "${pkg}" after node-pty install`);
  }
}
log('probing node-pty with a real PTY spawn...');
const probe = `
const pty = require('node-pty');
const sh = pty.spawn('/bin/sh', ['-c', 'printf PON-OK'], {
  name: 'xterm-256color', cols: 40, rows: 10,
  cwd: ${JSON.stringify(ENGINE_DIR)}, env: process.env,
});
let got = '';
sh.onData((d) => { got += d; });
sh.onExit((e) => {
  if (e.exitCode !== 0) { process.stderr.write('pty child exited ' + e.exitCode + '\\n'); process.exit(2); }
  if (!got.includes('PON-OK')) { process.stderr.write('unexpected stdout: ' + JSON.stringify(got) + '\\n'); process.exit(3); }
  console.log('node-pty probe OK');
  process.exit(0);
});
setTimeout(() => { console.error('node-pty probe timed out'); process.exit(4); }, 10000);
`;
const probeRes = spawnSync(bundledNode, ['-e', probe], { cwd: ENGINE_DIR, stdio: 'inherit' });
if (probeRes.status !== 0) fail(`node-pty is not usable (probe exited ${probeRes.status})`);

// ---------------------------------------------------------------------------
// Step 6 — copy the bridge, write the manifest, summarize
// ---------------------------------------------------------------------------
fs.copyFileSync(path.join(APP_ROOT, 'bridge.mjs'), path.join(ENGINE_DIR, 'bridge.mjs'));
log('bridge.mjs copied into engine');

const manifest = {
  version: DESKTOP_VERSION,
  engineVersion: agentPkg.version,
  node: NODE_VERSION,
  arch,
  port: process.version,
};
fs.writeFileSync(path.join(ENGINE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
log('manifest.json written: ' + JSON.stringify(manifest));

log(`done. engine = ${ENGINE_DIR} (${fmtBytes(dirSize(ENGINE_DIR))}, node ${NODE_VERSION} ${arch})`);

// ---------------------------------------------------------------------------
function dirSize(p) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) total += dirSize(full);
      else if (e.isSymbolicLink()) total += 0;
      else total += fs.statSync(full).size;
    }
  } catch { /* ignore */ }
  return total;
}
function fmtBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}