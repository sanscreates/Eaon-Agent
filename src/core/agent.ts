// Agent — the main conversation loop.
// - Streams text from the provider
// - Executes tool calls IN PARALLEL when the model batches them
// - Auto-compresses history via the cheap compressor model
// - Can spawn sub-agents with different model configs

import { cavemanSavingsFactor } from "../caveman.js";
import { backendFor, matchModel, resolveModel } from "../providers/registry.js";
import { getTool, toolSchemas } from "../tools/index.js";
import { isReadOnlyCommand } from "../tools/shell.js";
import { fmtTokens } from "../tokens.js";
import { toolResultCache } from "../cache.js";
import type { AgentHooks, ModelRef, Msg, ToolCall } from "../types.js";
import { compressIfNeeded } from "./compressor.js";
import { buildSystemPrompt } from "./prompts.js";
import { MacroStreamExpander } from "./macros.js";
import type { Runtime } from "./runtime.js";

const DEFAULT_MAX_TURNS = 40;
const TOOL_RESULT_CAP = 12_000;

const REPORTED = Symbol.for("eaon.reportedError");

/** Marks an error whose message the hooks already showed the user, so callers
 *  can decide whether to print it a second time. */
function markReported(e: unknown): void {
  if (e && typeof e === "object") (e as any)[REPORTED] = true;
}

export function wasReported(e: unknown): boolean {
  return !!(e && typeof e === "object" && (e as any)[REPORTED]);
}

export class Agent {
  messages: Msg[] = [];
  private hooks: AgentHooks;
  private abortController?: AbortController;
  private readonly isSubagent: boolean;

  constructor(private rt: Runtime, hooks?: AgentHooks, opts: { isSubagent?: boolean } = {}) {
    this.hooks = hooks ?? rt.hooks;
    this.isSubagent = opts.isSubagent === true;
    this.messages.push({ role: "system", content: buildSystemPrompt(rt, { isSubagent: this.isSubagent }) });
    // Only the top-level agent owns the runtime entry points. A sub-agent that
    // claimed them would leave /compress and spawn_agent pointing at its own
    // dead history once it finished.
    if (this.isSubagent) return;
    rt.runSubagent = (task, modelQuery, maxTurns) => this.runSubagent(task, modelQuery, maxTurns);
    rt.compressNow = async () => {
      const r = await compressIfNeeded(this.rt, this.messages, true);
      return r.compressed
        ? `Compressed ${r.removedMessages} messages: ~${fmtTokens(r.beforeTokens)} → ~${fmtTokens(r.afterTokens)} tokens.`
        : "Nothing to compress (history too short or compression disabled).";
    };
  }

  rebuildSystem(): void {
    this.messages[0] = { role: "system", content: buildSystemPrompt(this.rt, { isSubagent: this.isSubagent }) };
  }

  clear(): void {
    this.messages = [this.messages[0]];
    this.rt.session.todos = [];
  }

  /** Stop current model request. A running external tool completes normally. */
  cancel(): boolean {
    if (!this.abortController || this.abortController.signal.aborted) return false;
    this.abortController.abort();
    return true;
  }

  private currentModel(): ModelRef {
    if (!this.rt.cfg.main) throw new Error("No main model configured. Run: eaon-agent setup");
    return this.rt.cfg.main;
  }

  setModel(ref: ModelRef): void {
    this.rt.cfg.main = ref;
    this.rebuildSystem();
  }

  /** Cache key for tools that only observe. A tool that can change the world —
   *  including a shell command that is not read-only — must never be served
   *  from cache, or the second identical call silently does nothing. */
  private cacheKey(call: ToolCall): string | null {
    switch (call.name) {
      case "read_file":
        return `read:${call.args?.path}:${call.args?.offset ?? 1}:${call.args?.limit ?? 400}`;
      case "glob":
        return `glob:${call.args?.pattern}:${call.args?.path ?? "."}`;
      case "grep":
        return `grep:${call.args?.pattern}:${call.args?.path}:${call.args?.include ?? ""}:${call.args?.ignore_case ? 1 : 0}`;
      case "list_files":
        return `ls:${call.args?.path}:${call.args?.depth ?? 2}`;
      case "run_shell": {
        const command = String(call.args?.command ?? "");
        return isReadOnlyCommand(command) ? `shell:${command}` : null;
      }
      default:
        return null;
    }
  }

  private async execTool(call: ToolCall): Promise<string> {
    const tool = getTool(call.name);
    if (!tool) return `Error: unknown tool '${call.name}'.`;

    const key = this.cacheKey(call);
    if (key) {
      const cached = toolResultCache.get(key);
      if (cached !== undefined) {
        this.hooks.onToolStart?.(call);
        this.hooks.onToolEnd?.(call, "[cached]", 0);
        return cached;
      }
    }

    const start = Date.now();
    this.rt.session.stats.toolCalls++;
    this.hooks.onToolStart?.(call);
    let result: string;
    try {
      result = await tool.run(call.args ?? {}, this.rt);
    } catch (e: any) {
      result = `Error: ${e.message ?? String(e)}`;
    }
    const cap = Math.max(1000, Number(this.rt.cfg.ui.maxToolResultChars) || TOOL_RESULT_CAP);
    if (result.length > cap) result = result.slice(0, cap) + `\n… (result truncated at ${cap} chars)`;
    this.hooks.onToolEnd?.(call, result, Date.now() - start);

    // Denials and errors are about this moment, not about the file — caching
    // them would replay the refusal for the rest of the TTL.
    if (key && !result.startsWith("Error:") && !result.startsWith("Denied by user.")) toolResultCache.set(key, result);

    return result;
  }

  /** Run one user turn. Returns the final assistant text. */
  async run(input: string, opts: { maxTurns?: number; modelOverride?: ModelRef; silent?: boolean } = {}): Promise<string> {
    const rt = this.rt;
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    const controller = new AbortController();
    this.abortController = controller;
    try {
      this.messages.push({ role: "user", content: input });

      let finalText = "";
      let hitTurnLimit = true;
      for (let turn = 0; turn < maxTurns; turn++) {
      await compressIfNeeded(rt, this.messages, false, controller.signal);

      const ref = opts.modelOverride ?? this.currentModel();
      const { provider, model } = resolveModel(rt.cfg, ref);
      const macroStream = new MacroStreamExpander(rt.macros);
      this.hooks.onThinking?.();

      let result;
      try {
        result = await backendFor(provider).chat(
          { model, messages: this.messages, tools: toolSchemas({ forSubagent: this.isSubagent }), temperature: 0.3, signal: controller.signal },
          provider,
          (e) => {
            if (e.type === "text" && e.text) {
              const expanded = macroStream.push(e.text);
              if (expanded) this.hooks.onText?.(expanded);
            }
          },
        );
      } catch (e: any) {
        // Either way the turn ends on an assistant message, so the next user
        // message keeps the roles alternating.
        if (e?.name === "AbortError") {
          this.messages.push({ role: "assistant", content: "(cancelled)" });
          markReported(e);
          throw e;
        }
        this.hooks.onError?.(e.message ?? String(e));
        this.messages.push({ role: "assistant", content: `(provider error: ${e.message ?? e})` });
        markReported(e);
        throw e;
      }

      const { message: rawMessage, usage } = result;
      const tail = macroStream.finish();
      if (tail) this.hooks.onText?.(tail);
      const message = { ...rawMessage, content: rt.macros.expandText(rawMessage.content) };
      rt.session.stats.inputTokens += usage.input;
      rt.session.stats.outputTokens += usage.output;
      if (rt.cfg.caveman.enabled && rt.cfg.caveman.level !== "off") {
        rt.session.stats.cavemanSavedEst += Math.round(usage.output * (cavemanSavingsFactor(rt.cfg.caveman.level) - 1));
      }
      this.messages.push(message);

      if (!message.tool_calls?.length) {
        finalText = message.content;
        hitTurnLimit = false;
        break;
      }

      // ---- parallel tool execution ----
      const calls = message.tool_calls;
      const results = await Promise.all(calls.map((c) => this.execTool(c)));
      for (let i = 0; i < calls.length; i++) {
        this.messages.push({ role: "tool", tool_call_id: calls[i].id, name: calls[i].name, content: results[i] });
      }
      }
      if (hitTurnLimit) {
        // The loop stopped mid-tool-chain. Say so instead of returning an empty
        // string, and close the turn on an assistant message so the next user
        // message still lands on an alternating history.
        finalText = `Stopped after ${maxTurns} turns with work still in progress. Ask me to continue.`;
        this.messages.push({ role: "assistant", content: finalText });
        this.hooks.onNotice?.(`Turn limit reached (${maxTurns}). Ask to continue where it left off.`);
      }
      return finalText;
    } finally {
      if (this.abortController === controller) this.abortController = undefined;
    }
  }

  /** Sub-agent: own context, own model choice, compact report back. */
  private async runSubagent(task: string, modelQuery?: string, maxTurns = 20): Promise<string> {
    const rt = this.rt;
    let ref: ModelRef | undefined;
    if (modelQuery) ref = matchModel(rt.cfg, modelQuery);
    if (!ref) ref = rt.cfg.main;
    if (!ref) return "Error: no models configured.";

    rt.session.stats.subagentCalls++;
    const label = `${ref.provider}/${ref.model}`;
    this.hooks.onSubagentStart?.(task, label);

    const subHooks: AgentHooks = {}; // sub-agents work quietly; the parent narrates
    const sub = new Agent(rt, subHooks, { isSubagent: true });

    let ok = true;
    let report = "";
    try {
      report = await sub.run(task, { maxTurns, modelOverride: ref });
    } catch (e: any) {
      ok = false;
      report = `Sub-agent failed: ${e.message ?? e}`;
    }
    this.hooks.onSubagentEnd?.(task, ok);
    if (report.length > 6000) report = report.slice(0, 6000) + "\n… (report truncated)";
    return `[sub-agent ${label} report]\n${report || "(no report)"}`;
  }
}
