// Slash commands shared by TUI and headless mode.

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CAVEMAN_HELP, CAVEMAN_LEVELS, addLifetime, loadLifetime } from "../caveman.js";
import { checkForUpdate, saveConfig } from "../config.js";
import type { Agent } from "./agent.js";
import { matchModel } from "../providers/registry.js";
import { backendFor, resolveModel } from "../providers/registry.js";
import { fmtTokens } from "../tokens.js";
import type { CavemanLevel, ModelRef } from "../types.js";
import type { Runtime } from "./runtime.js";

const execP = promisify(exec);

export interface CommandIO {
  print(text: string): void;
  pickModel(): Promise<ModelRef | null>;
  reopenSetup(): void;
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
  /m <name> [args]         run a macro
  /macro list|add|rm       manage macros (add: /macro add <name> <prompt with {{args}}>)
  /skills                  list skills (loaded on demand by the model)
  /mcp                     list MCP servers
  /permissions <mode>      confirm | auto | readonly
  /init                    generate EAON.md project memory
  /setup                   re-run onboarding (providers/models)
  /exit                    quit
  /update                  check for a newer version of eaon-agent

${CAVEMAN_HELP}

Tips: end a line with \\ to add a newline. ↑/↓ for history. Sub-agents, parallel
tool calls, and context compression are automatic — that is where the tokens go.`;

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
        io.print(list.map((m) => `  /${m.name}${m.builtin ? " (builtin)" : ""} — ${m.description}`).join("\n"));
        return { kind: "done" };
      }
      if (sub === "add") {
        const name = args[1];
        const prompt = cmdLine.split(/\s+/).slice(3).join(" ") + (restParts.length ? "\n" + restParts.join("\n") : "");
        if (!name || !prompt.trim()) {
          io.print("Usage: /macro add <name> <prompt text, use {{args}} for arguments>");
          return { kind: "done" };
        }
        rt.macros.add({ name, description: prompt.slice(0, 60), prompt: prompt.trim() });
        io.print(`Macro /${name} saved.`);
        return { kind: "done" };
      }
      if (sub === "rm") {
        io.print(rt.macros.remove(args[1] ?? "") ? `Macro /${args[1]} removed.` : `No user macro named '${args[1]}'.`);
        return { kind: "done" };
      }
      io.print("Usage: /macro list|add|rm");
      return { kind: "done" };
    }
    case "/m": {
      const name = args[0];
      const m = name ? rt.macros.get(name) : undefined;
      if (!m) {
        io.print(`No macro named '${name ?? ""}'. Try /macro list`);
        return { kind: "done" };
      }
      const macroArgs = args.slice(1).join(" ") + (restParts.length ? "\n" + restParts.join("\n") : "");
      return { kind: "send", display: `/${m.name} ${macroArgs}`.trim(), prompt: rt.macros.expand(m, macroArgs) };
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
      const latest = await checkForUpdate();
      if (!latest) {
        io.print("Could not check for updates (no network).");
        return { kind: "done" };
      }
      const current = "1.1.0";
      const ok = latest.localeCompare(current, undefined, { numeric: true, sensitivity: "base" }) === 1;
      if (ok) {
        io.print(`Update available: ${current} → ${latest}. Run: npm install -g eaon-agent@latest`);
      } else {
        io.print(`eaon-agent is up to date (${current}).`);
      }
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
    default:
      return { kind: "unknown" };
  }
}

export { addLifetime, loadLifetime };
