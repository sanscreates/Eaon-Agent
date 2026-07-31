// Fast token estimation. ~4 chars per token for English/code, slightly less for CJK.
// Honest labeling: these are estimates, used for thresholds and stats — never billing.

import type { Msg } from "./types.js";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x2e80 && c <= 0x9fff) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(rest / 4 + cjk / 1.5);
}

export function estimateMessage(m: Msg): number {
  let n = 4; // per-message overhead
  n += estimateTokens(m.content ?? "");
  if (m.tool_calls) {
    for (const tc of m.tool_calls) n += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.args ?? {}));
  }
  return n;
}

export function estimateMessages(msgs: Msg[]): number {
  let n = 0;
  for (const m of msgs) n += estimateMessage(m);
  return n;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}
