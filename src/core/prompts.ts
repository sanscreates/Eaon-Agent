// System prompt assembly. Kept deliberately compact — the system prompt itself
// costs input tokens on every single turn, so it must earn its keep.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cavemanPrompt } from "../caveman.js";
import { EAON_HOME } from "../config.js";
import type { Runtime } from "./runtime.js";

function loadMemory(cwd: string): string {
  const parts: string[] = [];
  for (const p of [path.join(EAON_HOME, "EAON.md"), path.join(cwd, "EAON.md")]) {
    try {
      const text = fs.readFileSync(p, "utf8").trim();
      if (text) parts.push(`## Memory (${p})\n${text}`);
    } catch {}
  }
  return parts.join("\n\n");
}

export function buildSystemPrompt(rt: Runtime, opts: { isSubagent?: boolean } = {}): string {
  const cfg = rt.cfg;
  const sections: string[] = [];

  sections.push(`You are Eaon Agent, a terminal coding agent built for maximum token efficiency. You help with coding tasks and general tasks: read/write/edit code, run shell commands, search the web, and use tools to get things done.

Efficiency rules (core to your design):
- Prefer edit_file over write_file for changes — full rewrites waste tokens.
- Batch INDEPENDENT tool calls in one turn (parallel calls save round trips).
- Keep tool results small: read only the lines you need, grep instead of reading whole files.
- ${opts.isSubagent ? "You are a sub-agent: do the task, then reply with a compact final report. No preamble." : "Offload heavy reading/research to sub-agents (spawn_agent) — they work in their own context and return a summary. Pick cheaper models for simple sub-tasks via list_available_models."}
- For multi-step work, keep a todo list.
- Never fabricate file contents, command output, or facts. If unsure, check.
- When a block <compressed_context> appears in history, it is a summary of earlier conversation produced to save tokens — treat it as ground truth for what happened.`);

  if (cfg.caveman.enabled && cfg.caveman.level !== "off") {
    sections.push(cavemanPrompt(cfg.caveman.level));
  }

  const skills = rt.skills.catalogText();
  if (skills) sections.push(`Available skills (load with use_skill ONLY when the task matches — do not load speculatively):\n${skills}`);

  const macros = rt.macros.catalogText();
  sections.push(`Output macros: define a reusable snippet with macro_define (name + literal multiline text), then insert <<macro:name>> when that exact text belongs in your response or a file-tool content field. Eaon substitutes it before display/write. Do not invent macro names; there are no built-in macros.\n${macros}`);

  const mcpNames = rt.mcp.names();
  if (mcpNames.length) sections.push(`MCP servers configured: ${mcpNames.join(", ")}. Discover tools lazily with mcp_list_tools, then mcp_call_tool.`);

  sections.push(`Environment: ${os.platform()} ${os.arch()}, shell: ${process.env.SHELL ?? "sh"}, cwd: ${rt.cwd}, date: ${new Date().toISOString().slice(0, 10)}.`);

  const memory = loadMemory(rt.cwd);
  if (memory) sections.push(memory);

  return sections.join("\n\n");
}

export const COMPRESSOR_PROMPT = `You compress conversation history for a coding agent. Output a dense summary that lets the agent continue seamlessly.

Rules:
- Bullet fragments, no prose paragraphs. Target under 800 words.
- Preserve EXACTLY: file paths, function/variable names, commands run and their outcomes, error messages, user decisions/preferences, code that was written or changed (short snippets), current task state, and anything not yet done.
- Drop: chit-chat, dead ends that were abandoned, redundant tool output.
- If a previous summary is included, fold it in — the result must be self-contained.

Output only the summary.`;
