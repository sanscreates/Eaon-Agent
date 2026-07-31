// Runtime — shared session state: config, permissions, MCP, skills, macros,
// todos, stats. One per CLI invocation; sub-agents share it.

import "../tools/fs.js";
import "../tools/shell.js";
import "../tools/web.js";
import "../tools/todo.js";
import "../tools/meta.js";

import { loadConfig, loadPlugins, type PluginManifest } from "../config.js";
import { McpManager } from "../mcp/client.js";
import { listAllModels } from "../providers/registry.js";
import { registerPluginThemes, themesFromManifest } from "../themes.js";
import type { AgentHooks, EaonConfig, SessionStats } from "../types.js";
import { MacroRegistry } from "./macros.js";
import { Permissions } from "./permissions.js";
import { SkillRegistry } from "./skills.js";

/** Wire plugin-contributed subsystems: MCP servers and themes. */
function applyPlugins(plugins: PluginManifest[], cfg: EaonConfig): McpManager {
  const pluginServers = Object.assign({}, ...plugins.map((p) => p.mcpServers ?? {}));
  registerPluginThemes(plugins.flatMap((p) => themesFromManifest(p.name, p.themes)));
  return new McpManager({ ...pluginServers, ...cfg.mcpServers });
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export class Runtime {
  cfg: EaonConfig;
  cwd: string;
  hooks: AgentHooks;
  permissions: Permissions;
  mcp: McpManager;
  skills: SkillRegistry;
  macros: MacroRegistry;
  session: { todos: TodoItem[]; stats: SessionStats };
  /** Wired up by Agent — sub-agent execution entry point. */
  runSubagent: (task: string, modelQuery?: string, maxTurns?: number) => Promise<string> = async () => "Error: agent not ready";
  compressNow: () => Promise<string> = async () => "Error: agent not ready";

  constructor(opts: { cwd?: string; hooks?: AgentHooks; headless?: boolean; autoYes?: boolean } = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.cfg = loadConfig(this.cwd);
    if (opts.autoYes) this.cfg.permissions.mode = "auto";
    this.hooks = opts.hooks ?? {};
    this.permissions = new Permissions(this.cfg, this.hooks.askPermission, !opts.headless);
    this.mcp = applyPlugins(loadPlugins(this.cwd), this.cfg);
    this.skills = new SkillRegistry(this.cwd);
    this.macros = new MacroRegistry(this.cwd);
    this.session = {
      todos: [],
      stats: {
        startedAt: Date.now(),
        inputTokens: 0,
        outputTokens: 0,
        compressorInput: 0,
        compressorOutput: 0,
        compressionEvents: 0,
        compressedTokens: 0,
        toolCalls: 0,
        subagentCalls: 0,
        cavemanSavedEst: 0,
      },
    };
  }

  listModelsText(): string {
    const all = listAllModels(this.cfg);
    if (!all.length) return "No models configured. Run: eaon-agent setup";
    return all.map((m) => `- ${m.provider}/${m.model}${m.role ? ` (${m.role})` : ""}`).join("\n");
  }

  /** Re-read config from disk (after /setup) and rebuild subsystems in place. */
  reload(): void {
    const fresh = loadConfig(this.cwd);
    // mutate in place so Permissions and friends keep the same reference
    for (const k of Object.keys(this.cfg) as (keyof EaonConfig)[]) delete (this.cfg as any)[k];
    Object.assign(this.cfg, fresh);
    this.mcp.killAll();
    this.mcp = applyPlugins(loadPlugins(this.cwd), this.cfg);
    this.skills = new SkillRegistry(this.cwd);
    this.macros = new MacroRegistry(this.cwd);
  }

  shutdown(): void {
    this.mcp.killAll();
  }
}
