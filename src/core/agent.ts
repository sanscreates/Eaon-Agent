// Agent — the main conversation loop.
// - Streams text from the provider
// - Executes tool calls IN PARALLEL when the model batches them
// - Auto-compresses history via the cheap compressor model
// - Can spawn sub-agents with different model configs

import { cavemanSavingsFactor } from "../caveman.js";
import { backendFor, matchModel, resolveModel } from "../providers/registry.js";
import { getTool, toolSchemas } from "../tools/index.js";
import { fmtTokens } from "../tokens.js";
import { toolResultCache } from "../cache.js";
import type { AgentHooks, ModelRef, Msg, ToolCall } from "../types.js";
import { compressIfNeeded } from "./compressor.js";
import { buildSystemPrompt } from "./prompts.js";
import type { Runtime } from "./runtime.js";

const DEFAULT_MAX_TURNS = 40;
const TOOL_RESULT_CAP = 12_000;

export class Agent {
  messages: Msg[] = [];
  private hooks: AgentHooks;

  constructor(private rt: Runtime, hooks?: AgentHooks) {
    this.hooks = hooks ?? rt.hooks;
    this.messages.push({ role: "system", content: buildSystemPrompt(rt) });
    rt.runSubagent = (task, modelQuery, maxTurns) => this.runSubagent(task, modelQuery, maxTurns);
    rt.compressNow = async () => {
      const r = await compressIfNeeded(this.rt, this.messages, true);
      return r.compressed
        ? `Compressed ${r.removedMessages} messages: ~${fmtTokens(r.beforeTokens)} → ~${fmtTokens(r.afterTokens)} tokens.`
        : "Nothing to compress (history too short or compression disabled).";
    };
  }

  rebuildSystem(): void {
    this.messages[0] = { role: "system", content: buildSystemPrompt(this.rt) };
  }

  clear(): void {
    this.messages = [this.messages[0]];
    this.rt.session.todos = [];
  }

  private currentModel(): ModelRef {
    if (!this.rt.cfg.main) throw new Error("No main model configured. Run: eaon-agent setup");
    return this.rt.cfg.main;
  }

  setModel(ref: ModelRef): void {
    this.rt.cfg.main = ref;
    this.rebuildSystem();
  }

  private async execTool(call: ToolCall): Promise<string> {
    const tool = getTool(call.name);
    if (!tool) return `Error: unknown tool '${call.name}'.`;

    const cacheKey = call.name === "run_shell" ? `shell:${call.args?.command}` :
      call.name === "glob" ? `glob:${call.args?.pattern}` :
      call.name === "grep" ? `grep:${call.args?.pattern}:${call.args?.path}` :
      call.name === "list_files" ? `ls:${call.args?.path}` : null;

    if (cacheKey) {
      const cached = toolResultCache.get(cacheKey);
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
    if (result.length > TOOL_RESULT_CAP) result = result.slice(0, TOOL_RESULT_CAP) + `\n… (result truncated at ${TOOL_RESULT_CAP} chars)`;
    this.hooks.onToolEnd?.(call, result, Date.now() - start);

    if (cacheKey) {
      toolResultCache.set(cacheKey, result);
    }

    return result;
  }

  /** Run one user turn. Returns the final assistant text. */
  async run(input: string, opts: { maxTurns?: number; modelOverride?: ModelRef; silent?: boolean } = {}): Promise<string> {
    const rt = this.rt;
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.messages.push({ role: "user", content: input });

    let finalText = "";
    for (let turn = 0; turn < maxTurns; turn++) {
      await compressIfNeeded(rt, this.messages);

      const ref = opts.modelOverride ?? this.currentModel();
      const { provider, model } = resolveModel(rt.cfg, ref);
      this.hooks.onThinking?.();

      let result;
      try {
        result = await backendFor(provider).chat(
          { model, messages: this.messages, tools: toolSchemas(), temperature: 0.3 },
          provider,
          (e) => {
            if (e.type === "text" && e.text) this.hooks.onText?.(e.text);
          },
        );
      } catch (e: any) {
        this.hooks.onError?.(e.message ?? String(e));
        this.messages.push({ role: "assistant", content: `(provider error: ${e.message ?? e})` });
        throw e;
      }

      const { message, usage } = result;
      rt.session.stats.inputTokens += usage.input;
      rt.session.stats.outputTokens += usage.output;
      if (rt.cfg.caveman.enabled && rt.cfg.caveman.level !== "off") {
        rt.session.stats.cavemanSavedEst += Math.round(usage.output * (cavemanSavingsFactor(rt.cfg.caveman.level) - 1));
      }
      this.messages.push(message);

      if (!message.tool_calls?.length) {
        finalText = message.content;
        break;
      }

      // ---- parallel tool execution ----
      const calls = message.tool_calls;
      const results = await Promise.all(calls.map((c) => this.execTool(c)));
      for (let i = 0; i < calls.length; i++) {
        this.messages.push({ role: "tool", tool_call_id: calls[i].id, name: calls[i].name, content: results[i] });
      }
    }
    return finalText;
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
    const sub = new Agent(rt, subHooks);
    sub.messages = [{ role: "system", content: buildSystemPrompt(rt, { isSubagent: true }) }];

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
