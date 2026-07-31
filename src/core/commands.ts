// Slash commands shared by TUI and headless mode.

import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CAVEMAN_HELP, CAVEMAN_LEVELS, addLifetime, loadLifetime } from "../caveman.js";
import { loadConfig, loadPlugins, saveConfig } from "../config.js";
import { findTheme, allThemes } from "../themes.js";
import type { Agent } from "./agent.js";
import { matchModel } from "../providers/registry.js";
import { backendFor, resolveModel } from "../providers/registry.js";
import { fmtTokens } from "../tokens.js";
import type { CavemanLevel, ModelRef } from "../types.js";
import type { Runtime } from "./runtime.js";

const execP = promisify(exec);
const execFileP = promisify(execFile);

interface NativeCommand {
  name: string;
  description: string;
  command: string;
  source: string;
}

const BUILTIN_NATIVE_COMMANDS: NativeCommand[] = [
  { name: "github", description: "GitHub CLI commands, no MCP setup", command: "gh", source: "built-in" },
  { name: "git", description: "Git commands, no MCP setup", command: "git", source: "built-in" },
  { name: "docker", description: "Docker CLI (containers, images, compose)", command: "docker", source: "built-in" },
  { name: "npm", description: "Node package manager", command: "npm", source: "built-in" },
  { name: "node", description: "Run Node.js one-liners and scripts", command: "node", source: "built-in" },
  { name: "python", description: "Run Python 3 one-liners and scripts", command: "python3", source: "built-in" },
  { name: "make", description: "Run Makefile targets", command: "make", source: "built-in" },
  { name: "cargo", description: "Rust toolchain commands", command: "cargo", source: "built-in" },
  { name: "kubectl", description: "Kubernetes cluster commands", command: "kubectl", source: "built-in" },
  { name: "terraform", description: "Infrastructure-as-code commands", command: "terraform", source: "built-in" },
];

function nativeCommands(rt: Runtime): NativeCommand[] {
  const external = loadPlugins(rt.cwd).flatMap((plugin) =>
    Object.entries(plugin.commands ?? {}).flatMap(([name, value]) =>
      /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) && value?.command && !/\s/.test(value.command)
        ? [{ name, description: value.description ?? "", command: value.command, source: plugin.name }]
        : [],
    ),
  );
  return [...BUILTIN_NATIVE_COMMANDS, ...external];
}

function commandArgs(input: string): string[] {
  const parts = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return parts.map((part) => part.replace(/^"|"$/g, ""));
}

export interface CommandIO {
  print(text: string): void;
  pickModel(): Promise<ModelRef | null>;
  reopenSetup(): void;
  refreshTheme(): void;
  requestExit(): void;
}

export type CommandResult = { kind: "done" } | { kind: "send"; display: string; prompt: string } | { kind: "unknown" };

async function callModel(rt: Runtime, ref: ModelRef, system: string, user: string): Promise<string> {
  const { provider, model } = resolveModel(rt.cfg, ref);
  const { message } = await backendFor(provider).chat(
    { model, messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 2048, temperature: 0.2 },
    provider,
    () => {},
  );
  return message.content.trim();
}

function compressorRef(rt: Runtime): ModelRef | undefined {
  return rt.cfg.compressor ?? rt.cfg.main;
}

async function git(rt: Runtime, args: string): Promise<string> {
  try {
    const { stdout } = await execP(`git ${args}`, { cwd: rt.cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    throw new Error(e.message?.slice(0, 300) ?? "git failed");
  }
}

function sessionStatsText(rt: Runtime): string {
  const s = rt.session.stats;
  const mins = ((Date.now() - s.startedAt) / 60000).toFixed(1);
  const saved = s.compressedTokens + s.cavemanSavedEst;
  return [
    `Session: ${mins} min`,
    `  main model    in ${fmtTokens(s.inputTokens)} / out ${fmtTokens(s.outputTokens)} tokens`,
    `  compressor    in ${fmtTokens(s.compressorInput)} / out ${fmtTokens(s.compressorOutput)} tokens (${s.compressionEvents} compressions)`,
    `  tools         ${s.toolCalls} calls, ${s.subagentCalls} sub-agents`,
    `  saved (est.)  ⛏ ${fmtTokens(saved)} tokens (${fmtTokens(s.compressedTokens)} compression + ${fmtTokens(s.cavemanSavedEst)} caveman)`,
  ].join("\n");
}

export const HELP_TEXT = `Eaon Agent — commands
  /help                    this help
  /model [query]           switch main model (interactive picker if no query)
  /models                  list all configured models
  /compress                compress context now (auto otherwise)
  /clear                   clear conversation
  /stats                   session token stats
  /theme [name]            choose terminal palette
  /plugins                 list plugins and native commands (/git /docker /npm …)
  /github <args>           GitHub CLI without MCP setup
  /macro list|set|rm       manage output macros (set supports multiline text)
  /skills                  list skills (loaded on demand by the model)
  /mcp                     list MCP servers
  /permissions <mode>      confirm | auto | readonly
  /init                    generate EAON.md project memory
  /setup                   re-run onboarding (providers/models)
/exit                    quit
/update                  check for a newer version of eaon-agent

${CAVEMAN_HELP}

Tips: end a line with \\ to add a newline. ↑/↓ for history. PgUp/PgDn (or
^U/^D) scroll the chat while the header and input stay fixed. Press Escape to
cancel a running task. Sub-agents, parallel tool calls, and context compression
are automatic — that is where the tokens go.`;

export async function handleSlash(raw: string, rt: Runtime, agent: Agent, io: CommandIO): Promise<CommandResult> {
  const [cmdLine, ...restParts] = raw.trim().split("\n");
  const parts = cmdLine.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const rest = [...args.join(" ") ? [args.join(" ")] : [], ...restParts].join("\n").trim();

  switch (cmd) {
    case "/help":
      io.print(HELP_TEXT);
      return { kind: "done" };
    case "/exit":
    case "/quit":
      io.requestExit();
      return { kind: "done" };
    case "/clear":
      agent.clear();
      io.print("Conversation cleared.");
      return { kind: "done" };
    case "/stats":
    case "/cost":
      io.print(sessionStatsText(rt));
      return { kind: "done" };
    case "/theme": {
      if (!rest || rest === "list") {
        io.print(`Themes:\n${allThemes().map((theme) => `  ${theme.id === rt.cfg.ui.theme ? "*" : " "} ${theme.id.padEnd(14)} ${theme.name} — ${theme.description}${theme.source ? ` (plugin: ${theme.source})` : ""}`).join("\n")}\nUse: /theme <name>`);
        return { kind: "done" };
      }
      const theme = findTheme(rest);
      if (!theme) {
        io.print(`Unknown theme '${rest}'. Use /theme list.`);
        return { kind: "done" };
      }
      rt.cfg.ui.theme = theme.id;
      try { saveConfig(rt.cfg); } catch {}
      io.refreshTheme();
      io.print(`Theme: ${theme.name}`);
      return { kind: "done" };
    }
    case "/plugins": {
      const commands = nativeCommands(rt);
      const plugins = loadPlugins(rt.cwd);
      const lines = ["Native commands:"];
      lines.push(
        ...commands.map((item) => `  /${item.name} <args>${item.description ? ` — ${item.description}` : ""} (${item.source})`),
      );
      if (plugins.length) {
        lines.push("", "Installed plugins:");
        for (const p of plugins) {
          const provides: string[] = [];
          if (p.commands && Object.keys(p.commands).length) provides.push(`${Object.keys(p.commands).length} command(s)`);
          if (p.macros && Object.keys(p.macros).length) provides.push(`${Object.keys(p.macros).length} macro(s)`);
          if (p.mcpServers && Object.keys(p.mcpServers).length) provides.push(`${Object.keys(p.mcpServers).length} MCP server(s)`);
          if (p.themes && Object.keys(p.themes).length) provides.push(`${Object.keys(p.themes).length} theme(s)`);
          lines.push(`  ${p.name}${p.version ? ` v${p.version}` : ""}${provides.length ? ` — ${provides.join(", ")}` : ""}`);
        }
      } else {
        lines.push("", "No plugins installed. Drop a folder with plugin.json into ~/.eaon/plugins/ — it can contribute commands, macros, MCP servers, skills and themes.");
      }
      io.print(lines.join("\n"));
      return { kind: "done" };
    }
    case "/models":
      io.print(rt.listModelsText());
      return { kind: "done" };
    case "/model": {
      if (rest) {
        const ref = matchModel(rt.cfg, rest);
        if (!ref) {
          io.print(`No model matching '${rest}'.`);
          return { kind: "done" };
        }
        agent.setModel(ref);
        try { saveConfig(rt.cfg); } catch {}
        io.print(`Main model → ${ref.provider}/${ref.model}`);
        return { kind: "done" };
      }
      const picked = await io.pickModel();
      if (picked) {
        agent.setModel(picked);
        try { saveConfig(rt.cfg); } catch {}
        io.print(`Main model → ${picked.provider}/${picked.model}`);
      }
      return { kind: "done" };
    }
    case "/compress":
      io.print(await rt.compressNow());
      return { kind: "done" };
    case "/skills": {
      const list = rt.skills.list();
      io.print(list.length ? list.map((s) => `  ${s.name} (${s.source}) — ${s.description}`).join("\n") : "No skills found.");
      return { kind: "done" };
    }
    case "/mcp": {
      const names = rt.mcp.names();
      io.print(names.length ? `MCP servers:\n${names.map((n) => `  ${n}`).join("\n")}` : "No MCP servers configured. Add mcpServers to ~/.eaon/config.json");
      return { kind: "done" };
    }
    case "/permissions": {
      const mode = rest as "confirm" | "auto" | "readonly";
      if (!["confirm", "auto", "readonly"].includes(mode)) {
        io.print(`Current mode: ${rt.permissions.mode}. Use: /permissions confirm|auto|readonly`);
        return { kind: "done" };
      }
      rt.permissions.setMode(mode);
      try { saveConfig(rt.cfg); } catch {}
      io.print(`Permission mode → ${mode}`);
      return { kind: "done" };
    }
    case "/macro": {
      const sub = args[0];
      if (sub === "list" || !sub) {
        const list = rt.macros.list();
        io.print(list.length ? list.map((m) => `  <<macro:${m.name}>>${m.description ? ` — ${m.description}` : ""}`).join("\n") : "No macros are defined. Eaon has no built-in macros.");
        return { kind: "done" };
      }
      if (sub === "set" || sub === "add") {
        const name = args[1];
        const text = cmdLine.split(/\s+/).slice(3).join(" ") + (restParts.length ? "\n" + restParts.join("\n") : "");
        if (!name || !text.trim()) {
          io.print("Usage: /macro set <name> <text>. Continue on following lines for multiline text.");
          return { kind: "done" };
        }
        try {
          rt.macros.add({ name, description: text.trim().split("\n")[0].slice(0, 100), text });
          io.print(`Macro <<macro:${name}>> saved (${text.split("\n").length} lines).`);
        } catch (e: any) {
          io.print(e.message ?? String(e));
        }
        return { kind: "done" };
      }
      if (sub === "rm") {
        io.print(rt.macros.remove(args[1] ?? "") ? `Macro /${args[1]} removed.` : `No user macro named '${args[1]}'.`);
        return { kind: "done" };
      }
      io.print("Usage: /macro list|set|rm");
      return { kind: "done" };
    }
    case "/init":
      return {
        kind: "send",
        display: "/init",
        prompt:
          "Analyze this project (list_files, read key files like package.json/README) and write an EAON.md in the project root: purpose, stack, build/test commands, code style, key directories, conventions. Compact — this file is loaded into context every session, so every line must earn its tokens.",
      };
    case "/setup":
      io.reopenSetup();
      return { kind: "done" };
    case "/update": {
      io.print("To update eaon-agent, run:");
      io.print("  curl -fsSL https://raw.githubusercontent.com/sanscreates/Eaon-Agent/main/install.sh | bash");
      return { kind: "done" };
    }
    case "/caveman": {
      if (!rest) {
        io.print(`Caveman level: ${rt.cfg.caveman.enabled ? rt.cfg.caveman.level : "off"}\n${CAVEMAN_HELP}`);
        return { kind: "done" };
      }
      const level = rest.toLowerCase() as CavemanLevel;
      if (!CAVEMAN_LEVELS.includes(level)) {
        io.print(`Unknown level '${rest}'. Use: ${CAVEMAN_LEVELS.join(" | ")}`);
        return { kind: "done" };
      }
      rt.cfg.caveman = { enabled: level !== "off", level };
      try { saveConfig(rt.cfg); } catch {}
      agent.rebuildSystem();
      io.print(level === "off" ? "Caveman off. Normal mode." : `Caveman ${level}. Mouth smaller, brain same. ⛏`);
      return { kind: "done" };
    }
    case "/caveman-stats": {
      const life = loadLifetime();
      io.print(
        sessionStatsText(rt) +
          `\n\nLifetime:\n  ${life.sessions} sessions, in ${fmtTokens(life.inputTokens)} / out ${fmtTokens(life.outputTokens)}\n  saved (est.): ⛏ ${fmtTokens(life.compressedTokens + life.cavemanSavedEst)} tokens`,
      );
      return { kind: "done" };
    }
    case "/caveman-compress": {
      const file = rest;
      if (!file) {
        io.print("Usage: /caveman-compress <file>");
        return { kind: "done" };
      }
      const p = path.isAbsolute(file) ? file : path.resolve(rt.cwd, file);
      if (!fs.existsSync(p)) {
        io.print(`File not found: ${p}`);
        return { kind: "done" };
      }
      const ref = compressorRef(rt);
      if (!ref) {
        io.print("No compressor model configured.");
        return { kind: "done" };
      }
      const original = fs.readFileSync(p, "utf8");
      io.print(`Compressing ${file} (${fmtTokens(original.length / 4)} tokens)…`);
      try {
        const compressed = await callModel(
          rt,
          ref,
          `Rewrite the following memory/documentation file in compressed caveman style. Rules: bullet fragments, no filler, keep ALL code, commands, paths, URLs and identifiers byte-for-byte exact. Target ~50% of original size. Output only the rewritten file.`,
          original.slice(0, 60_000),
        );
        fs.writeFileSync(p + ".bak", original, "utf8");
        fs.writeFileSync(p, compressed + "\n", "utf8");
        io.print(`Done: ${fmtTokens(original.length / 4)} → ~${fmtTokens(compressed.length / 4)} tokens (backup: ${path.basename(p)}.bak)`);
      } catch (e: any) {
        io.print(`Failed: ${e.message}`);
      }
      return { kind: "done" };
    }
    case "/caveman-commit": {
      try {
        const staged = await git(rt, "diff --staged");
        if (!staged.trim()) {
          io.print("Nothing staged. Stage changes first (git add).");
          return { kind: "done" };
        }
        const ref = compressorRef(rt);
        if (!ref) {
          io.print("No compressor model configured.");
          return { kind: "done" };
        }
        const msg = await callModel(
          rt,
          ref,
          "Write a conventional commit message for this diff. Subject ≤50 chars, type(scope): subject, why over what. Output ONLY the message, no quotes.",
          staged.slice(0, 30_000),
        );
        io.print(`Suggested commit:\n  ${msg.split("\n")[0]}\nRun: git commit -m "${msg.split("\n")[0].replace(/"/g, '\\"')}"`);
      } catch (e: any) {
        io.print(`Failed: ${e.message}`);
      }
      return { kind: "done" };
    }
    case "/caveman-review": {
      try {
        const diff = (await git(rt, "diff HEAD")) || (await git(rt, "diff"));
        if (!diff.trim()) {
          io.print("No changes to review.");
          return { kind: "done" };
        }
        io.print("Reviewing diff with sub-agent…");
        const report = await rt.runSubagent(
          `Review this diff. One line per finding: \`L<n>: 🔴 bug/🟠 risk/🟡 style: <what>. <fix>\` Worst first. If clean, one line saying so.\n\n${diff.slice(0, 40_000)}`,
          undefined,
          6,
        );
        io.print(report.replace("[sub-agent", "[review"));
      } catch (e: any) {
        io.print(`Failed: ${e.message}`);
      }
      return { kind: "done" };
    }
    default: {
      const native = nativeCommands(rt).find((item) => `/${item.name}` === cmd);
      if (!native) return { kind: "unknown" };
      const argsForCommand = commandArgs(rest);
      const preview = [native.command, ...argsForCommand].join(" ");
      if (!(await rt.permissions.checkShell(preview))) {
        io.print("Denied by user.");
        return { kind: "done" };
      }
      try {
        const { stdout, stderr } = await execFileP(native.command, argsForCommand, { cwd: rt.cwd, maxBuffer: 4 * 1024 * 1024 });
        io.print((stdout || stderr).trim() || `/${native.name} completed.`);
      } catch (e: any) {
        io.print(`Failed: ${(e.stderr || e.message || String(e)).slice(0, 1000)}`);
      }
      return { kind: "done" };
    }
  }
}

export { addLifetime, loadLifetime };
