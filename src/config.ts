// Config loading/saving. Config lives in ~/.eaon/config.json
// Project-level overrides live in <cwd>/.eaon/config.json (merged shallowly).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDER_PRESETS } from "./providers/registry.js";
import type { EaonConfig, Macro, McpServerConfig, ModelRef, Provider } from "./types.js";

export const EAON_HOME = path.join(os.homedir(), ".eaon");
export const CONFIG_PATH = path.join(EAON_HOME, "config.json");
export const MACROS_PATH = path.join(EAON_HOME, "macros.json");
export const STATS_PATH = path.join(EAON_HOME, "stats.json");
export const SESSIONS_DIR = path.join(EAON_HOME, "sessions");
export const SKILLS_DIR = path.join(EAON_HOME, "skills");
export const PLUGINS_DIR = path.join(EAON_HOME, "plugins");

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
    ui: { showTokens: true, maxToolResultChars: 12000, theme: "eaon" },
  };
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

// ---------------- free tier ----------------

export const FREE_TIER_PROVIDER_ID = "osaii";
/** Default main model on the free tier: strongest poolside model. */
export const FREE_TIER_MAIN_MODEL = "poolside/laguna-s-2.1";

/** Zero-setup free tier: configure the built-in OSAII poolside provider and set
 *  the main model when none exists yet. Single-model mode (no compressor).
 *  Returns true when something was written. */
export function applyFreeTier(cwd: string = process.cwd()): boolean {
  const preset = PROVIDER_PRESETS.find((p) => p.id === FREE_TIER_PROVIDER_ID);
  if (!preset) return false;
  const cfg = loadConfig(cwd);
  let changed = false;
  if (!cfg.providers.some((p) => p.id === preset.id)) {
    cfg.providers.push({
      id: preset.id,
      name: preset.name,
      type: "openai",
      baseUrl: preset.baseUrl,
      models: preset.fallbackModels ?? [],
    });
    changed = true;
  }
  if (!cfg.main) {
    cfg.main = { provider: preset.id, model: FREE_TIER_MAIN_MODEL };
    changed = true;
  }
  if (!changed) return false;
  saveConfig(cfg);
  return true;
}

// ---------------- provider & model management ----------------
// Shared by the TUI /provider command and the Mac app's engine. All helpers
// mutate `cfg` in place (the live Runtime config object) and keep the
// main/compressor model refs consistent with what still exists.

export interface ProviderPatch {
  name?: string;
  type?: Provider["type"];
  /** null removes the field; undefined leaves it untouched. */
  baseUrl?: string | null;
  apiKey?: string | null;
}

/** What happened to the main/compressor refs while removing something. */
export interface RefChanges {
  /** new main ref when it had to move, null when it was cleared */
  mainSwitchedTo?: ModelRef;
  mainCleared?: boolean;
  compressorCleared?: boolean;
}

export function refChangesText(c: RefChanges): string {
  const parts: string[] = [];
  if (c.mainSwitchedTo) parts.push(`main → ${c.mainSwitchedTo.provider}/${c.mainSwitchedTo.model}`);
  if (c.mainCleared) parts.push("main model unset (pick one with /model or setup)");
  if (c.compressorCleared) parts.push("compressor → same as main");
  return parts.join(" · ");
}

/** Pick a fallback main model: prefer the same provider, then any provider. */
function fallbackMain(cfg: EaonConfig, providerId?: string): ModelRef | undefined {
  const same = providerId ? cfg.providers.find((p) => p.id === providerId) : undefined;
  if (same?.models.length) return { provider: same.id, model: same.models[0] };
  const any = cfg.providers.find((p) => p.models.length);
  return any ? { provider: any.id, model: any.models[0] } : undefined;
}

/** Edit a provider's name/type/base URL/API key. Only keys present in `patch` change. */
export function updateProvider(cfg: EaonConfig, id: string, patch: ProviderPatch): Provider | undefined {
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) return undefined;
  if (patch.name !== undefined && patch.name.trim()) p.name = patch.name.trim();
  if (patch.type !== undefined && ["openai", "anthropic", "echo"].includes(patch.type)) p.type = patch.type;
  if (patch.baseUrl !== undefined) p.baseUrl = patch.baseUrl?.trim() || undefined;
  if (patch.apiKey !== undefined) p.apiKey = patch.apiKey?.trim() || undefined;
  return p;
}

/** Delete a provider. Main/compressor refs that pointed at it are moved or cleared. */
export function removeProvider(cfg: EaonConfig, id: string): { removed: boolean } & RefChanges {
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx === -1) return { removed: false };
  const heldMain = cfg.main?.provider === id;
  const heldCompressor = cfg.compressor?.provider === id;
  cfg.providers.splice(idx, 1);
  const out: { removed: boolean } & RefChanges = { removed: true };
  if (heldCompressor) {
    delete cfg.compressor;
    out.compressorCleared = true;
  }
  if (heldMain) {
    const next = fallbackMain(cfg);
    if (next) {
      cfg.main = next;
      out.mainSwitchedTo = next;
    } else {
      delete cfg.main;
      out.mainCleared = true;
    }
  }
  return out;
}

/** Add a model id to a provider. Returns false when provider or model is missing/duplicate. */
export function addProviderModel(cfg: EaonConfig, providerId: string, model: string): boolean {
  const p = cfg.providers.find((x) => x.id === providerId);
  const id = model.trim();
  if (!p || !id || p.models.includes(id)) return false;
  p.models.push(id);
  return true;
}

/** Delete a model from a provider, fixing main/compressor refs that pointed at it. */
export function removeProviderModel(cfg: EaonConfig, providerId: string, model: string): { removed: boolean } & RefChanges {
  const p = cfg.providers.find((x) => x.id === providerId);
  if (!p) return { removed: false };
  const idx = p.models.indexOf(model);
  if (idx === -1) return { removed: false };
  p.models.splice(idx, 1);
  const out: { removed: boolean } & RefChanges = { removed: true };
  if (cfg.compressor?.provider === providerId && cfg.compressor?.model === model) {
    delete cfg.compressor;
    out.compressorCleared = true;
  }
  if (cfg.main?.provider === providerId && cfg.main?.model === model) {
    const next = fallbackMain(cfg, providerId);
    if (next) {
      cfg.main = next;
      out.mainSwitchedTo = next;
    } else {
      delete cfg.main;
      out.mainCleared = true;
    }
  }
  return out;
}

/** Rename a model id, keeping main/compressor refs in sync. */
export function renameProviderModel(cfg: EaonConfig, providerId: string, from: string, to: string): boolean {
  const p = cfg.providers.find((x) => x.id === providerId);
  const next = to.trim();
  if (!p || !next || p.models.indexOf(from) === -1 || p.models.includes(next)) return false;
  p.models[p.models.indexOf(from)] = next;
  if (cfg.main?.provider === providerId && cfg.main?.model === from) cfg.main.model = next;
  if (cfg.compressor?.provider === providerId && cfg.compressor?.model === from) cfg.compressor.model = next;
  return true;
}

// ---------------- macros ----------------

export function loadUserMacros(): Macro[] {
  const raw = readJson(MACROS_PATH);
  if (!raw || typeof raw !== "object") return [];
  // Version 1 used a name -> { prompt } map. Keep it readable so existing
  // user macros become literal output macros after upgrading.
  const entries = Array.isArray(raw.macros) ? raw.macros.map((m: any) => [m.name, m]) : Object.entries(raw);
  return entries.flatMap(([name, v]: [string, any]) => {
    if (typeof name !== "string" || !name.trim() || !v || typeof v !== "object") return [];
    return [{
    name,
    description: v.description ?? "",
    text: v.text ?? v.prompt ?? "",
    }];
  });
}

export function saveUserMacro(m: Macro): void {
  const current = loadUserMacros().filter((item) => item.name !== m.name);
  current.push(m);
  ensureDirs();
  fs.writeFileSync(MACROS_PATH, JSON.stringify({ version: 2, macros: current }, null, 2) + "\n", "utf8");
}

export function deleteUserMacro(name: string): boolean {
  const current = loadUserMacros();
  if (!current.some((m) => m.name === name)) return false;
  ensureDirs();
  fs.writeFileSync(MACROS_PATH, JSON.stringify({ version: 2, macros: current.filter((m) => m.name !== name) }, null, 2) + "\n", "utf8");
  return true;
}

// ---------------- plugins ----------------

export interface PluginManifest {
  name: string;
  version?: string;
  mcpServers?: Record<string, McpServerConfig>;
  macros?: Record<string, { description?: string; text?: string; prompt?: string }>;
  commands?: Record<string, { description?: string; command: string }>;
  themes?: Record<
    string,
    {
      name?: string;
      description?: string;
      accent: string;
      code?: string;
      border?: string;
      success?: string;
      error?: string;
      bg?: string;
      muted?: string;
    }
  >;
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
