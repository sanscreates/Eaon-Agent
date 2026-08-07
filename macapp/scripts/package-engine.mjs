#!/usr/bin/env node
// Stage the agent for bundling.
//
// The app ships the compiled agent exactly as npm would install it: dist/ plus
// the engine script that drives it. Electron's own binary runs it (with
// ELECTRON_RUN_AS_NODE), so there is no second Node runtime to download and
// nothing native to rebuild.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const macapp = path.resolve(here, '..');
const repo = path.resolve(macapp, '..');
const dist = path.join(repo, 'dist');
const out = path.join(macapp, 'resources', 'engine');

function build() {
  console.log('building the agent (tsc)…');
  execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
}

if (!fs.existsSync(path.join(dist, 'core', 'runtime.js'))) build();

// Rebuild when a source file is newer than what we last compiled — otherwise a
// packaged app can quietly ship yesterday's agent.
const newest = (dir) => {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return latest;
};
if (newest(path.join(repo, 'src')) > newest(dist)) build();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(dist, path.join(out, 'dist'), { recursive: true });
fs.cpSync(path.join(macapp, 'engine', 'server.mjs'), path.join(out, 'server.mjs'));

// The TUI half of the build is dead weight in a GUI app — and it is the only
// part that needs ink/react, so dropping it keeps the bundle dependency-free.
fs.rmSync(path.join(out, 'dist', 'ui'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'dist', 'index.js'), { force: true });

// The agent compiles to ESM and relies on the repo's root package.json
// ("type": "module") to say so. Copied into the app bundle it loses that
// ancestor, and Node falls back to CommonJS — every `import` in dist/ then
// dies with "Cannot use import statement outside a module". Restate the module
// type next to the code so it travels with it.
fs.writeFileSync(path.join(out, 'dist', 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

const count = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`engine staged: ${count(out)} files in resources/engine`);
