// Config loading/saving. Config lives in ~/.eaon/config.json
// Project-level overrides live in <cwd>/.eaon/config.json (merged shallowly).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EaonConfig, Macro, McpServerConfig } from "./types.js";

export const EAON_HOME = path.join(os.homedir(), ".eaon");
export const CONFIG_PATH = path.join(EAON_HOME, "config.json");
export const MACROS_PATH = path.join(EAON_HOME, "macros.json");
export const STATS_PATH = path.join(EAON_HOME, "stats.json");
export const SESSIONS_DIR = path.join(EAON_HOME, "sessions");
export const SKILLS_DIR = path.join(EAON_HOME, "skills");
export const PLUGINS_DIR = path.join(EAON_HOME, "plugins");

const LATEST_VERSION_URL = "https://registry.npmjs.org/eaon-agent/latest";

export function ensureDirs(): void {
  for (const d of [EAON_HOME, SESSIONS_DIR, SKILLS_DIR, PLUGINS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function defaultConfig(): EaonConfig {
  return {
    version: 1,
    providers: [],
    compression: { enabled: true, keepLast: 5, thresholdTokens: 20000 },
    caveman: { enabled: true, level: "full" },
    permissions: { mode: "confirm", allow: [] },
    mcpServers: {},
    ui: { showTokens: true, maxToolResultChars: 12000, theme: "amber" },
  };
}

export async function checkForUpdate(): Promise<string | null> {
  try {
    const res = await fetch(LATEST_VERSION_URL);
    if (!res.ok) return null;
    const j: any = await res.json();
    const latest = j["dist-tags"]?.latest;
    if (!latest) return null;
    return latest;
  } catch {
    return null;
  }
}

/** Expand ${VAR} references in a string from process.env. */
export function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

function deepMerge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over as T;
  if (typeof base === "object" && base !== null && typeof over === "object") {
    const out: any = { ...(base as any) };
    for (const k of Object.keys(over)) out[k] = deepMerge((base as any)[k], over[k]);
    return out;
  }
  return over as T;
}

function readJson(p: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

export function loadConfig(cwd: string = process.cwd()): EaonConfig {
  ensureDirs();
  let cfg = defaultConfig();
  const global = readJson(CONFIG_PATH);
  if (global) cfg = deepMerge(cfg, global);
  // project override
  const proj = readJson(path.join(cwd, ".eaon", "config.json"));
  if (proj) cfg = deepMerge(cfg, proj);
  // expand env vars in api keys / headers / mcp env
  for (const p of cfg.providers) {
    if (p.apiKey) p.apiKey = expandEnv(p.apiKey);
    if (p.headers) for (const k of Object.keys(p.headers)) p.headers[k] = expandEnv(p.headers[k]);
  }
  for (const s of Object.values(cfg.mcpServers)) {
    if (s.env) for (const k of Object.keys(s.env)) s.env[k] = expandEnv(s.env[k]);
  }
  return cfg;
}

export function saveConfig(cfg: EaonConfig): void {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function configExists(): boolean {
  const cfg = readJson(CONFIG_PATH);
  return !!(cfg && Array.isArray(cfg.providers) && cfg.providers.length > 0 && cfg.main);
}

// ---------------- macros ----------------

export function loadUserMacros(): Macro[] {
  const raw = readJson(MACROS_PATH);
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).map(([name, v]: [string, any]) => ({
    name,
    description: v.description ?? "",
    prompt: v.prompt ?? "",
  }));
}

export function saveUserMacro(m: Macro): void {
  const raw = readJson(MACROS_PATH) ?? {};
  raw[m.name] = { description: m.description, prompt: m.prompt };
  ensureDirs();
  fs.writeFileSync(MACROS_PATH, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

export function deleteUserMacro(name: string): boolean {
  const raw = readJson(MACROS_PATH);
  if (!raw || !raw[name]) return false;
  delete raw[name];
  fs.writeFileSync(MACROS_PATH, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return true;
}

// ---------------- plugins ----------------

export interface PluginManifest {
  name: string;
  version?: string;
  mcpServers?: Record<string, McpServerConfig>;
  macros?: Record<string, { description?: string; prompt: string }>;
}

export function loadPlugins(cwd: string): PluginManifest[] {
  const out: PluginManifest[] = [];
  const roots = [PLUGINS_DIR, path.join(cwd, ".eaon", "plugins")];
  for (const root of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const manifest = readJson(path.join(root, e.name, "plugin.json"));
      if (manifest && manifest.name) out.push(manifest as PluginManifest);
    }
  }
  return out;
}
