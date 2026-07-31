// Shared test bootstrap: an isolated fake HOME with an offline "echo"
// provider config. Import this FIRST, before any dist module, so
// config.js picks up the fake home when its module-level paths are built.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "eaon-test-home-"));
process.env.HOME = home;

const eaonDir = path.join(home, ".eaon");
fs.mkdirSync(eaonDir, { recursive: true });
fs.writeFileSync(
  path.join(eaonDir, "config.json"),
  JSON.stringify(
    {
      version: 1,
      providers: [{ id: "echo", name: "Echo", type: "echo", models: ["echo-1"] }],
      main: { provider: "echo", model: "echo-1" },
      compressor: { provider: "echo", model: "echo-1" },
      compression: { enabled: true, keepLast: 5, thresholdTokens: 20000 },
      caveman: { enabled: false, level: "off" },
      permissions: { mode: "auto", allow: [] },
      mcpServers: {},
      ui: { showTokens: true, maxToolResultChars: 12000, theme: "midnight" },
    },
    null,
    2,
  ),
);

export const TEST_HOME = home;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
export function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}
export async function waitFor(name, fn, timeoutMs = 4000, stepMs = 40) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await wait(stepMs);
  }
  check(name, false);
  return false;
}
export function testSummary(label) {
  if (failures > 0) {
    console.error(`${label}: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`${label}: all passed`);
}
