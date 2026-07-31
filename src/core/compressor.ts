// Two-model context compression.
// The cheap compressor model summarizes everything except a recent tail; the
// expensive main model always works on a small context.
//
// Two properties matter and are easy to get wrong:
//   1. The tail must never begin in the middle of a tool-call chain, or the
//      provider rejects the request for an orphaned tool result.
//   2. The compressor must read a bounded amount of text. A 200k-char history
//      and a 20k-char one should cost the same call, or compression itself
//      becomes the slow, expensive part.

import { backendFor, resolveModel } from "../providers/registry.js";
import { estimateMessage, estimateMessages } from "../tokens.js";
import type { Msg } from "../types.js";
import { COMPRESSOR_PROMPT } from "./prompts.js";
import type { Runtime } from "./runtime.js";

export const COMPRESSED_OPEN = "<compressed_context>";
export const COMPRESSED_CLOSE = "</compressed_context>";

/** Hard ceiling on what the compressor model is asked to read. */
const MAX_INPUT_CHARS = 48_000;
/** A summary longer than this stops paying for itself. */
const MAX_SUMMARY_TOKENS = 1600;
const CALL_TIMEOUT_MS = 90_000;
/** After a failure, don't hammer a broken endpoint on every single turn. */
const FAILURE_BACKOFF_MS = 60_000;
/** Below this a compressor round trip costs more than it saves. */
const MIN_REGION_TOKENS = 600;
/** Manual /compress still needs something worth summarizing. */
const MIN_FORCED_REGION_TOKENS = 200;

const backoffUntil = new WeakMap<Runtime, number>();

function isCompressedMsg(m: Msg): boolean {
  return m.role === "user" && typeof m.content === "string" && m.content.startsWith(COMPRESSED_OPEN);
}

/** Text between the markers. Tolerates a block whose closing tag was lost. */
function summaryBody(content: string): string {
  const end = content.lastIndexOf(COMPRESSED_CLOSE);
  return content.slice(COMPRESSED_OPEN.length, end < 0 ? undefined : end).trim();
}

/** Indices at which the kept tail may begin.
 *  A `tool` message needs the assistant message that requested it, so the tail
 *  can never start there. Earlier summaries are folded into the new one rather
 *  than kept, so they are not cut points either. */
function validCuts(messages: Msg[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < messages.length; i++) {
    if (messages[i].role === "tool") continue;
    if (isCompressedMsg(messages[i])) continue;
    out.push(i);
  }
  return out;
}

/** suffix[i] = estimated tokens of messages[i..]. */
function suffixTokens(messages: Msg[]): number[] {
  const s = new Array<number>(messages.length + 1).fill(0);
  for (let i = messages.length - 1; i >= 0; i--) s[i] = s[i + 1] + estimateMessage(messages[i]);
  return s;
}

/** Where to split. Keeps `keepLast` messages when they fit, fewer when the tail
 *  alone would blow the budget — otherwise a handful of huge tool results keeps
 *  the context over threshold and re-triggers compression every turn. */
function chooseCut(messages: Msg[], keepLast: number, tailBudget: number): number {
  const cuts = validCuts(messages);
  if (!cuts.length) return -1;
  const suffix = suffixTokens(messages);
  const want = messages.length - keepLast;

  let idx = 0;
  for (let i = 0; i < cuts.length && cuts[i] <= want; i++) idx = i;
  while (idx + 1 < cuts.length && suffix[cuts[idx]] > tailBudget) idx++;
  return cuts[idx];
}

/** Keep both ends of an over-long body: the head says what it is, the tail is
 *  where errors and results live. */
function truncateBody(body: string, cap: number): string {
  if (body.length <= cap) return body;
  const head = Math.max(1, Math.floor(cap * 0.7));
  const tail = Math.max(0, cap - head);
  return `${body.slice(0, head)}\n…[${body.length - cap} chars elided]…\n${tail ? body.slice(body.length - tail) : ""}`;
}

/** Render the region for the compressor under a hard character budget.
 *  Walks newest-first so recent turns keep detail and ancient ones degrade to
 *  one-liners, then flips back to chronological order. */
function condense(region: Msg[], budget: number): string {
  const priors = region.filter(isCompressedMsg);
  let priorText = "";
  if (priors.length) {
    // Reserved up front: losing the running summary would lose the whole session.
    const body = priors.map((m) => summaryBody(m.content)).join("\n\n");
    priorText = `[earlier summary — fold this in, drop what it says that is now outdated]\n${truncateBody(body, Math.floor(budget * 0.4))}`;
    budget -= priorText.length;
  }

  const seen = new Set<string>();
  const parts: string[] = [];
  let remaining = Math.max(1000, budget);

  for (let i = region.length - 1; i >= 0; i--) {
    const m = region[i];
    if (m.role === "system" || isCompressedMsg(m)) continue;

    const who = m.role === "tool" ? `tool result${m.name ? ` (${m.name})` : ""}` : m.role;
    const raw = m.content ?? "";
    if (m.role === "tool" && raw) {
      if (seen.has(raw)) {
        const dup = `[${who}] identical to a later result`;
        parts.push(dup);
        remaining -= dup.length;
        continue;
      }
      seen.add(raw);
    }

    const calls = m.tool_calls?.length
      ? " | calls: " + m.tool_calls.map((tc) => `${tc.name}(${truncateBody(JSON.stringify(tc.args ?? {}), 200)})`).join("; ")
      : "";
    const entry = `[${who}]${calls}\n${truncateBody(raw, Math.max(300, Math.floor(remaining / 4)))}`;
    parts.push(entry);
    remaining -= entry.length;

    if (remaining <= 0) {
      if (i > 0) parts.push(`[${i} older message(s) omitted to fit the compressor input budget]`);
      break;
    }
  }

  return [priorText, ...parts.reverse()].filter(Boolean).join("\n\n");
}

/** Combine the caller's cancellation with our own timeout. `AbortSignal.any`
 *  is not available on Node 18, which we still support. */
function linkedSignal(outer: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  if (outer?.aborted) ac.abort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

export interface CompressionResult {
  compressed: boolean;
  removedMessages: number;
  beforeTokens: number;
  afterTokens: number;
}

const NONE: CompressionResult = { compressed: false, removedMessages: 0, beforeTokens: 0, afterTokens: 0 };

/** Compress in place if the history exceeds the configured threshold. */
export async function compressIfNeeded(rt: Runtime, messages: Msg[], force = false, signal?: AbortSignal): Promise<CompressionResult> {
  const cfg = rt.cfg;
  if (!cfg.compression.enabled && !force) return NONE;
  if (!cfg.compressor) return NONE;
  if (!force && Date.now() < (backoffUntil.get(rt) ?? 0)) return NONE;

  const threshold = Math.max(2000, cfg.compression.thresholdTokens);
  if (!force && estimateMessages(messages) < threshold) return NONE;

  const keepLast = Math.max(2, cfg.compression.keepLast);
  // Half the threshold, so one more large tool result does not immediately
  // trigger the next compression.
  const cut = chooseCut(messages, keepLast, Math.floor(threshold / 2));
  if (cut < 2) return NONE;

  const region = messages.slice(1, cut);
  if (!region.length) return NONE;
  const beforeTokens = estimateMessages(region);
  if (beforeTokens < (force ? MIN_FORCED_REGION_TOKENS : MIN_REGION_TOKENS)) return NONE;

  let provider, model;
  try {
    ({ provider, model } = resolveModel(cfg, cfg.compressor));
  } catch {
    return NONE;
  }

  const link = linkedSignal(signal, CALL_TIMEOUT_MS);
  let summary = "";
  try {
    const { message, usage } = await backendFor(provider).chat(
      {
        model,
        messages: [
          { role: "system", content: COMPRESSOR_PROMPT },
          { role: "user", content: condense(region, MAX_INPUT_CHARS) },
        ],
        maxTokens: MAX_SUMMARY_TOKENS,
        temperature: 0.2,
        signal: link.signal,
      },
      provider,
      () => {},
    );
    summary = message.content.trim();
    rt.session.stats.compressorInput += usage.input;
    rt.session.stats.compressorOutput += usage.output;
  } catch (e: any) {
    if (signal?.aborted) return NONE; // user cancelled — not a compressor failure
    backoffUntil.set(rt, Date.now() + FAILURE_BACKOFF_MS);
    rt.hooks.onError?.(`Compression failed (keeping full context): ${e?.message ?? e}`);
    return NONE;
  } finally {
    link.dispose();
  }

  if (!summary) {
    backoffUntil.set(rt, Date.now() + FAILURE_BACKOFF_MS);
    return NONE;
  }
  backoffUntil.delete(rt);

  const block: Msg = { role: "user", content: `${COMPRESSED_OPEN}\n${summary}\n${COMPRESSED_CLOSE}` };
  // Bridge with an acknowledgement only when the tail resumes with another user
  // message; otherwise the roles already alternate and the ack is pure overhead.
  const replacement: Msg[] =
    messages[cut].role === "user"
      ? [block, { role: "assistant", content: "Understood — continuing from the compressed context above." }]
      : [block];

  const afterTokens = estimateMessages(replacement);
  if (afterTokens >= beforeTokens) {
    // A summary bigger than its source helps nobody, and retrying next turn
    // would just buy the same bad trade again.
    backoffUntil.set(rt, Date.now() + FAILURE_BACKOFF_MS);
    return NONE;
  }

  messages.splice(1, region.length, ...replacement);
  rt.session.stats.compressionEvents++;
  rt.session.stats.compressedTokens += beforeTokens - afterTokens;
  rt.hooks.onCompression?.(region.length, beforeTokens, afterTokens);
  return { compressed: true, removedMessages: region.length, beforeTokens, afterTokens };
}
