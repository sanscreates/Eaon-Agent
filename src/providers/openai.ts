// OpenAI-compatible backend — works with OpenAI, OpenRouter, DeepSeek, Groq,
// Together, Fireworks, Mistral, Cerebras, xAI, Ollama, LM Studio, and any
// endpoint that speaks /v1/chat/completions.

import type { ChatParams, Msg, Provider, StreamEvent, ToolCall } from "../types.js";
import { authHeaders, checkRes, fetchRetry, LIST_TIMEOUT_MS, sseEvents, type ChatResult, type LLMBackend } from "./base.js";

interface AccumTool {
  id: string;
  name: string;
  argStr: string;
  order: number;
}

export const openaiBackend: LLMBackend = {
  type: "openai",

  async chat(params: ChatParams, cfg: Provider, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
    const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const messages = params.messages.map((m) => {
      const out: any = { role: m.role, content: m.content ?? "" };
      if (m.tool_calls) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      if (m.role === "assistant" && !m.content && m.tool_calls) out.content = null;
      return out;
    });

    const body: any = {
      model: params.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.parallel_tool_calls = true;
    }
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;

    const res = await fetchRetry(`${base}/chat/completions`, {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify(body),
      signal: params.signal,
    });
    await checkRes(res, `${cfg.name ?? cfg.id} chat`, cfg);

    let text = "";
    const tools = new Map<string, AccumTool>();
    let lastToolKey = "";
    const usage = { input: 0, output: 0 };

    for await (const data of sseEvents(res)) {
      if (data === "[DONE]") break;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.usage) {
        usage.input = j.usage.prompt_tokens ?? usage.input;
        usage.output = j.usage.completion_tokens ?? usage.output;
      }
      const choice = j.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        onEvent({ type: "text", text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          // Not every OpenAI-compatible server sends `index`. Defaulting all of
          // them to 0 concatenated separate calls into one garbled entry, so
          // fall back to the id, then to continuing the call already in flight.
          const key =
            tc.index !== undefined && tc.index !== null ? `i${tc.index}` : tc.id ? `id${tc.id}` : lastToolKey || "i0";
          lastToolKey = key;
          let acc = tools.get(key);
          if (!acc) {
            acc = { id: "", name: "", argStr: "", order: typeof tc.index === "number" ? tc.index : tools.size };
            tools.set(key, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.argStr += tc.function.arguments;
        }
      }
    }

    const tool_calls: ToolCall[] = [...tools.values()]
      .sort((a, b) => a.order - b.order)
      .map((acc, i) => {
        let args: Record<string, any> = {};
        try {
          args = acc.argStr ? JSON.parse(acc.argStr) : {};
        } catch {
          args = { __raw: acc.argStr };
        }
        return { id: acc.id || `call_${i}`, name: acc.name, args };
      });

    const message: Msg = { role: "assistant", content: text, ...(tool_calls.length ? { tool_calls } : {}) };
    return { message, usage };
  },

  async listModels(cfg: Provider): Promise<string[]> {
    const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const res = await fetchRetry(`${base}/models`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    await checkRes(res, `${cfg.name ?? cfg.id} model list`, cfg);
    const j: any = await res.json();
    const ids = (j.data ?? []).map((m: any) => m.id).filter(Boolean) as string[];
    return ids.sort();
  },
};
