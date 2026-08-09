// Single source of truth for the agent version: package.json, read at runtime.
// Works from src/ (dev) and dist/ (built + npm tarball, which always ships
// package.json). Previously the version was hardcoded in four places and they
// drifted apart (1.4.0 in the CLI while package.json said 1.5.1).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "1.5.2";

function readVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, "package.json");
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (j?.name === "eaon-agent" && typeof j.version === "string" && j.version) return j.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return FALLBACK_VERSION;
}

export const VERSION = readVersion();
