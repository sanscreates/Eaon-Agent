// Headless mode: eaon-agent -p "prompt" [--yes] [--model x] [--max-turns n]
// Prints the agent's work to stdout. Permissions: interactive y/a/n on a TTY,
// deny otherwise (unless --yes).

import readline from "node:readline";
import { addLifetime } from "./caveman.js";
import { Agent, wasReported } from "./core/agent.js";
import { Runtime } from "./core/runtime.js";
import { matchModel } from "./providers/registry.js";
import { fmtTokens } from "./tokens.js";
import type { ModelRef, PermissionDecision } from "./types.js";

export interface HeadlessOptions {
  prompt: string;
  yes?: boolean;
  modelQuery?: string;
  maxTurns?: number;
  showStats?: boolean;
}

function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const isTTY = process.stdin.isTTY === true;
  const rt = new Runtime({
    headless: true,
    autoYes: opts.yes,
    hooks: {
      onText: (t) => process.stdout.write(t),
      onToolStart: (call) => {
        const keyArg = String(call.args?.command ?? call.args?.path ?? call.args?.query ?? call.args?.task ?? "").slice(0, 70);
        process.stderr.write(`\x1b[35m⏺ ${call.name}\x1b[0m \x1b[2m${keyArg}\x1b[0m\n`);
      },
      onToolEnd: (call, _r, ms) => process.stderr.write(`\x1b[32m  ✓\x1b[0m \x1b[2m${(ms / 1000).toFixed(1)}s\x1b[0m\n`),
      onNotice: (t) => process.stderr.write(`\x1b[2m  ${t}\x1b[0m\n`),
      onError: (t) => process.stderr.write(`\x1b[31m✖ ${t}\x1b[0m\n`),
      onCompression: (n, b, a) => process.stderr.write(`\x1b[2m⚡ compressed ${n} msgs ~${fmtTokens(b)}→~${fmtTokens(a)} tok\x1b[0m\n`),
      onSubagentStart: (task, model) => process.stderr.write(`\x1b[34m⏺ sub-agent ${model}\x1b[0m \x1b[2m${task.slice(0, 80)}\x1b[0m\n`),
      onSubagentEnd: () => process.stderr.write(`\x1b[32m  ✓ sub-agent done\x1b[0m\n`),
      askPermission: async (req): Promise<PermissionDecision> => {
        if (opts.yes) return "once";
        if (!isTTY) return "deny";
        process.stderr.write(`\x1b[33mPermission: ${req.label}\x1b[0m\n${req.detail ? `\x1b[2m${String(req.detail).split("\n").slice(0, 10).join("\n")}\x1b[0m\n` : ""}`);
        const a = await askLine(req.kind === "shell" ? "[y] once · [a] always · [n] deny > " : "[y] allow · [n] deny > ");
        if (a === "a" && req.kind === "shell") return "always";
        return a === "y" || a === "yes" ? "once" : "deny";
      },
    },
  });

  if (!rt.cfg.main) {
    process.stderr.write("No provider configured. Run: eaon-agent setup\n");
    return 1;
  }

  let modelOverride: ModelRef | undefined;
  if (opts.modelQuery) {
    modelOverride = matchModel(rt.cfg, opts.modelQuery);
    if (!modelOverride) {
      process.stderr.write(`No model matching '${opts.modelQuery}'\n`);
      return 1;
    }
  }

  const agent = new Agent(rt);
  let code = 0;
  try {
    await agent.run(opts.prompt, { maxTurns: opts.maxTurns, modelOverride });
    process.stdout.write("\n");
  } catch (e: any) {
    // Provider errors already went through onError; anything else used to exit
    // 1 with no explanation at all.
    if (!wasReported(e)) process.stderr.write(`\x1b[31m✖ ${e?.message ?? String(e)}\x1b[0m\n`);
    code = 1;
  } finally {
    const s = rt.session.stats;
    addLifetime({
      sessions: 1,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      compressorTokens: s.compressorInput + s.compressorOutput,
      compressedTokens: s.compressedTokens,
      cavemanSavedEst: s.cavemanSavedEst,
      toolCalls: s.toolCalls,
    });
    if (opts.showStats) {
      process.stderr.write(
        `\n\x1b[2min ${fmtTokens(s.inputTokens)} · out ${fmtTokens(s.outputTokens)} · compressor ${fmtTokens(s.compressorInput + s.compressorOutput)} · saved ⛏${fmtTokens(s.compressedTokens + s.cavemanSavedEst)}\x1b[0m\n`,
      );
    }
    rt.shutdown();
  }
  return code;
}
