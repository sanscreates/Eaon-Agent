// Caveman mode — inspired by github.com/JuliusBrussee/caveman (MIT).
// "why use many token when few do trick"
// Eaon re-implements the idea natively: a style block injected into the system
// prompt, slash commands, and session/lifetime savings estimates.

import fs from "node:fs";
import { STATS_PATH, ensureDirs } from "./config.js";
import type { CavemanLevel } from "./types.js";
import { fmtTokens } from "./tokens.js";

export const CAVEMAN_LEVELS: CavemanLevel[] = ["off", "lite", "full", "ultra", "wenyan"];

const COMMON = `Rules that apply at every level:
- Keep ALL code, shell commands, file paths, URLs, error messages, diffs and identifiers byte-for-byte exact. Never compress those.
- Never drop technical content, warnings, or steps. Compress style, not substance.
- Write in the same language the user writes in.`;

export function cavemanPrompt(level: CavemanLevel): string {
  switch (level) {
    case "off":
      return "";
    case "lite":
      return `Response style — CAVEMAN LITE:
Write normal sentences, but cut all filler: no greetings, no "Sure!", no "I'd be happy to help", no restating the question, no summary of what you just did unless asked. Get straight to the point.
${COMMON}`;
    case "full":
      return `Response style — CAVEMAN FULL (default):
Talk like caveman. Short fragments. Drop articles and filler words where meaning stays clear. No greetings, no apologies, no restating the question, no fluff. Example: instead of "The reason your component re-renders is that a new object reference is created on every render cycle" write "New object ref each render. Wrap in useMemo."
${COMMON}`;
    case "ultra":
      return `Response style — CAVEMAN ULTRA:
Maximum compression. Telegram style. Fragments only. "Bug in auth middleware. Token check use < not <=. Fix:" — that short. Use arrows, symbols, abbreviations. Lists over prose. Code speaks for itself.
${COMMON}`;
    case "wenyan":
      return `Response style — CAVEMAN WENYAN (文言):
Answer in classical Chinese (文言文) — the densest natural language per token. Keep code, commands, paths, and error messages in their original form. If the user writes in another language and seems not to read Chinese, fall back to CAVEMAN FULL in their language instead.
${COMMON}`;
  }
}

/** Rough estimate of how much longer the reply would have been without caveman.
 *  Based on the caveman benchmark averages (full ≈ 65% output reduction). */
export function cavemanSavingsFactor(level: CavemanLevel): number {
  switch (level) {
    case "off": return 1;
    case "lite": return 1.3;
    case "full": return 2.86; // 65% saved => verbose ≈ 2.86x terse
    case "ultra": return 3.6;
    case "wenyan": return 3.2;
  }
}

// ---------------- lifetime stats (~/.eaon/stats.json) ----------------

export interface LifetimeStats {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  compressorTokens: number;
  compressedTokens: number;
  cavemanSavedEst: number;
  toolCalls: number;
}

export function loadLifetime(): LifetimeStats {
  try {
    return { sessions: 0, inputTokens: 0, outputTokens: 0, compressorTokens: 0, compressedTokens: 0, cavemanSavedEst: 0, toolCalls: 0, ...JSON.parse(fs.readFileSync(STATS_PATH, "utf8")) };
  } catch {
    return { sessions: 0, inputTokens: 0, outputTokens: 0, compressorTokens: 0, compressedTokens: 0, cavemanSavedEst: 0, toolCalls: 0 };
  }
}

export function addLifetime(delta: Partial<LifetimeStats>): LifetimeStats {
  const cur = loadLifetime();
  const next: any = { ...cur };
  for (const k of Object.keys(delta) as (keyof LifetimeStats)[]) next[k] = (cur[k] ?? 0) + (delta[k] ?? 0);
  ensureDirs();
  fs.writeFileSync(STATS_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function statsLine(saved: number): string {
  return `⛏ ${fmtTokens(saved)} tokens saved (est.)`;
}

export const CAVEMAN_HELP = `Caveman mode — same answers, fewer tokens. Inspired by JuliusBrussee/caveman (MIT).
  /caveman [off|lite|full|ultra|wenyan]   set compression level (default: full)
  /caveman-help                           this reference
  /caveman-stats                          session + lifetime token savings
  /caveman-compress <file>                rewrite a memory/doc file in caveman style (~46% smaller, forever)
  /caveman-commit                         draft a ≤50-char conventional commit from staged changes
  /caveman-review                         one-line review comments for the current diff`;
