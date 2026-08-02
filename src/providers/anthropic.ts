// Native Anthropic backend (api.anthropic.com/v1/messages) with streaming + tools.

import type { ChatParams, Msg, Provider, StreamEvent, ToolCall } from "../types.js";
import { checkRes, fetchRetry, LIST_TIMEOUT_MS, sseEvents, type ChatResult, type LLMBackend } from "./base.js";

/** Map our flat history onto the Messages API shape.
 *
 *  Three rules the API enforces that a raw mapping violates:
 *  roles must alternate (a turn that hits max_turns mid-tool-loop leaves tool
 *  results directly before the next user message), text blocks may not be
 *  empty, and the first message must be from the user. */
export function toAnthropicMessages(params: ChatParams): { system: string; messages: any[] } {
  let system = "";
  const out: any[] = [];

  const push = (role: "user" | "assistant", content: any[]): void => {
    if (!content.length) return; // a message with nothing in it carries nothing
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };

  for (const m of params.messages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + (m.content ?? "");
      continue;
    }
    if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content || "(no output)" }]);
      continue;
    }
    const content: any[] = [];
    if (m.content) content.push({ type: "text", text: m.content });
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
    }
    push(m.role === "assistant" ? "assistant" : "user", content);
  }

  while (out.length && out[0].role !== "user") out.shift();
  return { system, messages: out };
}

export const anthropicBackend: LLMBackend = {
  type: "anthropic",

  async chat(params: ChatParams, cfg: Provider, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
    const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const { system, messages } = toAnthropicMessages(params);
    const body: any = {
      model: params.model,
      max_tokens: params.maxTokens ?? 8192,
      messages,
      stream: true,
    };
    if (system) body.system = system;
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    if (params.temperature !== undefined) body.temperature = params.temperature;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(cfg.headers ?? {}),
    };
    if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;

    const res = await fetchRetry(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal: params.signal });
    await checkRes(res, `${cfg.name ?? cfg.id} chat`, cfg);

    let text = "";
    const blocks = new Map<number, { kind: "text" | "tool"; id: string; name: string; json: string }>();
    const usage = { input: 0, output: 0 };

    for await (const data of sseEvents(res)) {
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      switch (j.type) {
        case "message_start":
          usage.input = j.message?.usage?.input_tokens ?? usage.input;
          usage.output = j.message?.usage?.output_tokens ?? usage.output;
          break;
        case "content_block_start": {
          const i = j.index ?? 0;
          const b = j.content_block ?? {};
          if (b.type === "tool_use") blocks.set(i, { kind: "tool", id: b.id ?? `toolu_${i}`, name: b.name ?? "", json: "" });
          else blocks.set(i, { kind: "text", id: "", name: "", json: "" });
          break;
        }
        case "content_block_delta": {
          const i = j.index ?? 0;
          const acc = blocks.get(i);
          const d = j.delta ?? {};
          if (d.type === "text_delta" && typeof d.text === "string") {
            text += d.text;
            onEvent({ type: "text", text: d.text });
          } else if (d.type === "input_json_delta" && acc) {
            acc.json += d.partial_json ?? "";
          }
          break;
        }
        case "message_delta":
          usage.output = j.usage?.output_tokens ?? usage.output;
          break;
      }
    }

    const tool_calls: ToolCall[] = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, b]) => b.kind === "tool")
      .map(([, b]) => {
        let args: Record<string, any> = {};
        try {
          args = b.json ? JSON.parse(b.json) : {};
        } catch {
          args = { __raw: b.json };
        }
        return { id: b.id, name: b.name, args };
      });

    const message: Msg = { role: "assistant", content: text, ...(tool_calls.length ? { tool_calls } : {}) };
    return { message, usage };
  },

  async listModels(cfg: Provider): Promise<string[]> {
    const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01", ...(cfg.headers ?? {}) };
    if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
    const res = await fetchRetry(`${base}/v1/models?limit=100`, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    await checkRes(res, `${cfg.name ?? cfg.id} model list`, cfg);
    const j: any = await res.json();
    return ((j.data ?? []).map((m: any) => m.id).filter(Boolean) as string[]).sort();
  },
};
