// Provider interface + shared SSE helpers.

import type { ChatParams, Msg, Provider, StreamEvent, TokenUsage } from "../types.js";

export interface ChatResult {
  message: Msg;
  usage: TokenUsage;
}

export interface LLMBackend {
  type: string;
  chat(params: ChatParams, cfg: Provider, onEvent: (e: StreamEvent) => void): Promise<ChatResult>;
  listModels?(cfg: Provider): Promise<string[]>;
}

/** Parse a Server-Sent-Events stream from a fetch Response body. */
export async function* sseEvents(res: Response): AsyncGenerator<string> {
  const body: any = res.body;
  if (!body) return;
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  // A stream that ends without a trailing newline still has one real event in
  // it — usually the last content delta or the usage record.
  buf += decoder.decode();
  const last = buf.trim();
  if (last.startsWith("data:")) yield last.slice(5).trim();
}

export async function checkRes(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 400);
  } catch {}
  throw new Error(`${what} failed: HTTP ${res.status} ${detail}`);
}

export function authHeaders(cfg: Provider, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...(cfg.headers ?? {}), ...extra };
  if (cfg.apiKey) h["Authorization"] = `Bearer ${cfg.apiKey}`;
  return h;
}
