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
  // An apiKey written as ${VAR} expands to "" when the variable is not exported,
  // which reaches the provider as "no key at all" — worth naming explicitly.
  const hint =
    res.status === 401 || res.status === 403
      ? "\nCheck the provider's API key in ~/.eaon/config.json. ${VAR} references expand from the environment eaon-agent runs in — an unset variable becomes an empty key."
      : "";
  throw new Error(`${what} failed: HTTP ${res.status} ${detail}${hint}`);
}

/** Model listing blocks onboarding behind a spinner, so it must not hang on a
 *  wrong base URL. */
export const LIST_TIMEOUT_MS = 20_000;

/** Rate limits and upstream hiccups. Anything else is the caller's problem and
 *  retrying it just wastes time. */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(30_000, Math.max(0, secs * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(30_000, Math.max(0, at - Date.now())) : undefined;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bounded retries on transient failures. Only ever retries before any of the
 *  response body reaches the caller, so a stream that already started printing
 *  is never restarted. Request bodies here are strings, so replaying is safe. */
export async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal as AbortSignal | undefined;
  for (let attempt = 0; ; attempt++) {
    const lastAttempt = attempt >= MAX_ATTEMPTS - 1;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e: any) {
      if (lastAttempt || signal?.aborted || e?.name === "AbortError") throw e;
      await sleep(backoffMs(attempt), signal);
      continue;
    }
    if (res.ok || lastAttempt || !RETRY_STATUSES.has(res.status)) return res;
    const wait = retryAfterMs(res) ?? backoffMs(attempt);
    try {
      await res.body?.cancel(); // free the socket before sleeping
    } catch {}
    await sleep(wait, signal);
  }
}

export function authHeaders(cfg: Provider, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...(cfg.headers ?? {}), ...extra };
  if (cfg.apiKey) h["Authorization"] = `Bearer ${cfg.apiKey}`;
  return h;
}
