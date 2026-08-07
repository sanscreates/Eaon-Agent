#!/usr/bin/env node
/**
 * Eaon Engine — the desktop app's link to the agent.
 *
 * This process imports the compiled agent (dist/) and drives it directly: same
 * Runtime, same Agent loop, same slash commands, same permission model as the
 * TUI. Nothing about the agent changes; the GUI is just another front end.
 *
 * There is no terminal here — no PTY, no ANSI. The app speaks structured
 * messages over Node's IPC channel, so the renderer gets real objects (tool
 * calls, diffs, token counts) instead of screen-scraped text.
 *
 *   request   { id, type, ... }        app  -> engine
 *   response  { id, ok, result|error } engine -> app
 *   event     { ev, ... }              engine -> app (unsolicited)
 *
 * Usage: node server.mjs <path-to-dist>
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileP = promisify(execFile);

const DIST = path.resolve(process.argv[2] ?? "");
if (!DIST || !fs.existsSync(path.join(DIST, "core", "runtime.js"))) {
  process.stderr.write(`eaon-engine: no agent build at ${DIST}\n`);
  process.exit(2);
}

const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);

const [
  { Runtime },
  { Agent },
  { handleSlash, HELP_TEXT },
  { addLifetime, loadLifetime, CAVEMAN_LEVELS },
  config,
  registry,
  themes,
  { fmtTokens },
] = await Promise.all([
  load("core/runtime.js"),
  load("core/agent.js"),
  load("core/commands.js"),
  load("caveman.js"),
  load("config.js"),
  load("providers/registry.js"),
  load("themes.js"),
  load("tokens.js"),
]);

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

function post(msg) {
  try {
    process.send?.(msg);
  } catch {
    /* parent gone */
  }
}

function emit(ev, data = {}) {
  post({ ev, ...data });
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

/** Pending questions the UI still has to answer, by id. */
const pending = new Map();
let askSeq = 1;

function ask(kind, payload) {
  const id = `ask${askSeq++}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    emit(kind, { askId: id, ...payload });
  });
}

let session = null; // { rt, agent, cwd }
let busy = false;

const hooks = {
  onThinking: () => emit("thinking"),
  onText: (text) => emit("text", { text }),
  onToolStart: (call) => emit("tool_start", { call: plainCall(call) }),
  onToolEnd: (call, result, ms) => emit("tool_end", { id: call.id, name: call.name, result, ms }),
  onNotice: (text) => emit("notice", { text }),
  onError: (text) => emit("error", { text }),
  onCompression: (removed, before, after) =>
    emit("compression", { removed, before, after, label: `context compressed: ${removed} msgs, ~${fmtTokens(before)} → ~${fmtTokens(after)} tokens` }),
  onSubagentStart: (task, model) => emit("subagent_start", { task, model }),
  onSubagentEnd: (task, ok) => emit("subagent_end", { task, ok }),
  askPermission: (req) => ask("permission", { request: { kind: req.kind, label: req.label, detail: req.detail ?? "" } }),
};

/** Tool calls cross IPC as plain JSON — drop anything unserializable. */
function plainCall(call) {
  let args = {};
  try {
    args = JSON.parse(JSON.stringify(call.args ?? {}));
  } catch {
    args = {};
  }
  return { id: call.id, name: call.name, args };
}

function openSession(cwd) {
  closeSession();
  const rt = new Runtime({ cwd, hooks });
  const agent = new Agent(rt);
  session = { rt, agent, cwd: rt.cwd };
  return session;
}

function closeSession() {
  if (!session) return;
  try {
    const s = session.rt.session.stats;
    addLifetime({
      sessions: 1,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      compressorTokens: s.compressorInput + s.compressorOutput,
      compressedTokens: s.compressedTokens,
      cavemanSavedEst: s.cavemanSavedEst,
      toolCalls: s.toolCalls,
    });
  } catch {
    /* read-only home — not worth failing over */
  }
  try {
    session.rt.shutdown();
  } catch {
    /* best effort */
  }
  session = null;
}

// ---------------------------------------------------------------------------
// state snapshots
// ---------------------------------------------------------------------------

async function gitInfo(cwd) {
  const run = async (args) => {
    try {
      const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 2 * 1024 * 1024 });
      return stdout;
    } catch {
      return "";
    }
  };
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch) return { repo: false, branch: "", files: [] };
  const files = (await run(["status", "--porcelain=v1", "--untracked-files=normal"]))
    .split("\n")
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => ({ status: line.slice(0, 2).trim() || "?", path: line.slice(3).trim() }));
  return { repo: true, branch, files };
}

function statsOf(rt) {
  const s = rt.session.stats;
  return {
    ...s,
    saved: s.compressedTokens + s.cavemanSavedEst,
    elapsedMs: Date.now() - s.startedAt,
  };
}

function snapshot() {
  const rt = session.rt;
  const cfg = rt.cfg;
  return {
    cwd: rt.cwd,
    workspace: path.basename(rt.cwd) || rt.cwd,
    home: config.EAON_HOME,
    configPath: config.CONFIG_PATH,
    configured: !!cfg.main,
    main: cfg.main ?? null,
    compressor: cfg.compressor ?? null,
    permissionMode: cfg.permissions.mode,
    caveman: cfg.caveman.enabled ? cfg.caveman.level : "off",
    theme: cfg.ui.theme,
    showTokens: cfg.ui.showTokens !== false,
    compression: cfg.compression,
    models: registry.listAllModels(cfg),
    providers: cfg.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, models: p.models.length })),
    themes: themes.allThemes().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      accent: t.accent,
      bg: t.bg,
      muted: t.muted,
      border: t.border,
      code: t.code,
      success: t.success,
      error: t.error,
      source: t.source ?? null,
    })),
    skills: rt.skills.list().map((s) => ({ name: s.name, description: s.description, source: s.source })),
    macros: rt.macros.list().map((m) => ({ name: m.name, description: m.description })),
    mcp: rt.mcp.names(),
    plugins: config.loadPlugins(rt.cwd).map((p) => ({ name: p.name, version: p.version ?? "" })),
    stats: statsOf(rt),
    lifetime: safeLifetime(),
    cavemanLevels: CAVEMAN_LEVELS,
    busy,
  };
}

function safeLifetime() {
  try {
    return loadLifetime();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// command surface (metadata for the composer's autocomplete)
// ---------------------------------------------------------------------------

const COMMANDS = [
  { name: "/help", args: "", description: "Command reference" },
  { name: "/model", args: "[query]", description: "Switch the main model" },
  { name: "/models", args: "", description: "List every configured model" },
  { name: "/compress", args: "", description: "Compress context now" },
  { name: "/clear", args: "", description: "Clear the conversation" },
  { name: "/stats", args: "", description: "Session token stats" },
  { name: "/theme", args: "[name]", description: "Change the palette" },
  { name: "/plugins", args: "", description: "Plugins and native commands" },
  { name: "/skills", args: "", description: "Skills the model can load" },
  { name: "/mcp", args: "", description: "MCP servers" },
  { name: "/macro", args: "list|set|rm", description: "Manage output macros" },
  { name: "/permissions", args: "confirm|auto|readonly", description: "Permission mode" },
  { name: "/caveman", args: "off|lite|full|ultra|wenyan", description: "Output compression level" },
  { name: "/caveman-stats", args: "", description: "Session + lifetime savings" },
  { name: "/caveman-compress", args: "<file>", description: "Rewrite a memory file, compressed" },
  { name: "/caveman-commit", args: "", description: "Commit message for staged changes" },
  { name: "/caveman-review", args: "", description: "Review the diff with a sub-agent" },
  { name: "/init", args: "", description: "Generate EAON.md project memory" },
  { name: "/setup", args: "", description: "Re-run provider onboarding" },
  { name: "/update", args: "", description: "How to update Eaon" },
  { name: "/github", args: "<args>", description: "GitHub CLI, no MCP setup" },
  { name: "/git", args: "<args>", description: "Git commands" },
  { name: "/docker", args: "<args>", description: "Docker CLI" },
  { name: "/npm", args: "<args>", description: "Node package manager" },
  { name: "/node", args: "<args>", description: "Run Node one-liners" },
  { name: "/python", args: "<args>", description: "Run Python 3 one-liners" },
  { name: "/make", args: "<args>", description: "Run Makefile targets" },
  { name: "/cargo", args: "<args>", description: "Rust toolchain" },
  { name: "/kubectl", args: "<args>", description: "Kubernetes commands" },
  { name: "/terraform", args: "<args>", description: "Infrastructure as code" },
];

// ---------------------------------------------------------------------------
// slash-command IO
// ---------------------------------------------------------------------------

const io = {
  print: (text) => emit("notice", { text }),
  pickModel: async () => {
    const value = await ask("pick_model", { models: registry.listAllModels(session.rt.cfg) });
    if (!value) return null;
    const [provider, ...rest] = String(value).split("/");
    return { provider, model: rest.join("/") };
  },
  reopenSetup: () => emit("open_setup"),
  refreshTheme: () => emit("config", { state: snapshot() }),
  requestExit: () => emit("exit_requested"),
};

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

const handlers = {
  async hello({ cwd }) {
    openSession(cwd && fs.existsSync(cwd) ? cwd : process.cwd());
    return {
      version: process.env.EAON_APP_VERSION || "1.5.0",
      help: HELP_TEXT,
      commands: COMMANDS,
      presets: registry.PROVIDER_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        keyEnv: p.keyEnv,
        hint: p.hint,
        free: !!p.free,
        hasKeyInEnv: !!(p.keyEnv && process.env[p.keyEnv]),
      })),
      state: snapshot(),
      git: await gitInfo(session.rt.cwd),
    };
  },

  async state() {
    return { state: snapshot() };
  },

  async git() {
    return await gitInfo(session.rt.cwd);
  },

  async diff({ file }) {
    const cwd = session.rt.cwd;
    const args = file ? ["diff", "--no-color", "--", file] : ["diff", "--no-color"];
    try {
      let { stdout } = await execFileP("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
      if (!stdout.trim() && file) {
        // Untracked file: show it as an addition rather than an empty diff.
        const abs = path.resolve(cwd, file);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const body = fs.readFileSync(abs, "utf8").split("\n").slice(0, 2000);
          stdout = [`+++ ${file} (untracked)`, ...body.map((l) => `+${l}`)].join("\n");
        }
      }
      return { diff: stdout };
    } catch (e) {
      return { diff: "", error: e.message ?? String(e) };
    }
  },

  async send({ text }) {
    if (busy) throw new Error("A turn is already running.");
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return { kind: "empty" };
    const { rt, agent } = session;

    if (trimmed.startsWith("/")) {
      busy = true;
      emit("busy", { busy: true });
      try {
        const result = await handleSlash(trimmed, rt, agent, io);
        if (result.kind === "unknown") return { kind: "unknown" };
        if (result.kind !== "send") return { kind: "done", state: snapshot() };
        // /init and friends turn into a real prompt.
        const out = await runTurn(result.prompt);
        return { ...out, display: result.display };
      } finally {
        busy = false;
        emit("busy", { busy: false });
        emit("config", { state: snapshot() });
      }
    }

    busy = true;
    emit("busy", { busy: true });
    try {
      return await runTurn(trimmed);
    } finally {
      busy = false;
      emit("busy", { busy: false });
      emit("config", { state: snapshot() });
    }
  },

  async cancel() {
    return { cancelled: session?.agent.cancel() ?? false };
  },

  async answer({ askId, value }) {
    const resolve = pending.get(askId);
    if (!resolve) return { ok: false };
    pending.delete(askId);
    resolve(value);
    return { ok: true };
  },

  async clear() {
    session.agent.clear();
    return { state: snapshot() };
  },

  async open_workspace({ cwd }) {
    if (!cwd || !fs.existsSync(cwd)) throw new Error(`No such folder: ${cwd}`);
    openSession(cwd);
    return { state: snapshot(), git: await gitInfo(cwd) };
  },

  async compress() {
    return { text: await session.rt.compressNow(), state: snapshot() };
  },

  /** Everything the settings surface can change, in one place. */
  async configure(patch) {
    const { rt, agent } = session;
    const cfg = rt.cfg;
    if (patch.theme) {
      const theme = themes.findTheme(patch.theme);
      if (theme) cfg.ui.theme = theme.id;
    }
    if (patch.permissionMode && ["confirm", "auto", "readonly"].includes(patch.permissionMode)) {
      rt.permissions.setMode(patch.permissionMode);
    }
    if (patch.caveman && CAVEMAN_LEVELS.includes(patch.caveman)) {
      cfg.caveman = { enabled: patch.caveman !== "off", level: patch.caveman };
      agent.rebuildSystem();
    }
    if (patch.model) {
      const ref = registry.matchModel(cfg, patch.model);
      if (ref) agent.setModel(ref);
    }
    if (patch.compressor !== undefined) {
      if (!patch.compressor) delete cfg.compressor;
      else {
        const ref = registry.matchModel(cfg, patch.compressor);
        if (ref) cfg.compressor = ref;
      }
    }
    if (typeof patch.showTokens === "boolean") cfg.ui.showTokens = patch.showTokens;
    if (typeof patch.compressionEnabled === "boolean") cfg.compression.enabled = patch.compressionEnabled;
    if (Number.isFinite(patch.thresholdTokens)) cfg.compression.thresholdTokens = Math.max(2000, Math.round(patch.thresholdTokens));
    try {
      config.saveConfig(cfg);
    } catch {
      /* keep the in-memory change even if the disk write fails */
    }
    return { state: snapshot() };
  },

  /** Onboarding: ask a provider what models it serves. */
  async fetch_models({ presetId, apiKey, baseUrl }) {
    const preset = registry.PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) throw new Error(`Unknown provider: ${presetId}`);
    const provider = {
      id: preset.id,
      name: preset.name,
      type: preset.type,
      baseUrl: baseUrl || preset.baseUrl,
      apiKey: apiKey || undefined,
      models: [],
    };
    try {
      let list = (await registry.backendFor(provider).listModels?.(provider)) ?? [];
      if (preset.filter) list = list.filter(preset.filter);
      if (!list.length) throw new Error("the provider returned an empty model list");
      return { models: list };
    } catch (e) {
      if (preset.fallbackModels?.length) return { models: preset.fallbackModels, fallback: true };
      return { models: [], error: e.message ?? String(e) };
    }
  },

  /** Onboarding: write the provider + model choices to ~/.eaon/config.json. */
  async save_setup({ presetId, apiKey, baseUrl, models, mainModel, compressorModel, caveman }) {
    const preset = registry.PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) throw new Error(`Unknown provider: ${presetId}`);
    if (!mainModel) throw new Error("Pick a main model.");
    const cfg = config.loadConfig(session.rt.cwd);
    const provider = {
      id: preset.id,
      name: preset.name,
      type: preset.type,
      baseUrl: baseUrl || preset.baseUrl || undefined,
      apiKey: apiKey || undefined,
      models: models?.length ? models : [mainModel],
    };
    cfg.providers = [...cfg.providers.filter((p) => p.id !== provider.id), provider];
    cfg.main = { provider: provider.id, model: mainModel };
    if (compressorModel) cfg.compressor = { provider: provider.id, model: compressorModel };
    else delete cfg.compressor;
    if (caveman && CAVEMAN_LEVELS.includes(caveman)) cfg.caveman = { enabled: caveman !== "off", level: caveman };
    config.saveConfig(cfg);
    session.rt.reload();
    session.agent.rebuildSystem();
    return { state: snapshot() };
  },

  async free_tier() {
    config.applyFreeTier(session.rt.cwd);
    session.rt.reload();
    session.agent.rebuildSystem();
    return { state: snapshot() };
  },

  async shutdown() {
    closeSession();
    return { ok: true };
  },
};

async function runTurn(prompt) {
  try {
    const text = await session.agent.run(prompt);
    return { kind: "done", text, state: snapshot() };
  } catch (e) {
    // Provider/abort errors already reached the UI through onError.
    return { kind: "failed", error: e?.message ?? String(e), state: snapshot() };
  }
}

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  const { id, type } = msg;
  const handler = handlers[type];
  if (!handler) {
    post({ id, ok: false, error: `Unknown request: ${type}` });
    return;
  }
  try {
    const result = await handler(msg);
    post({ id, ok: true, result });
  } catch (e) {
    post({ id, ok: false, error: e?.message ?? String(e) });
  }
});

process.on("disconnect", () => {
  closeSession();
  process.exit(0);
});

emit("ready");
