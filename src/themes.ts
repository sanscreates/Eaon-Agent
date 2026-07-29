// Terminal palettes with expanded design tokens.
// Each theme defines colors for every UI element.

import type { SyntaxTokens, ThemeTokens } from "./types.js";

export interface Theme {
  id: string;
  name: string;
  description: string;
  accent: string;
  code: string;
  border: string;
  success: string;
  error: string;
}

export const THEMES: Theme[] = [
  { id: "eaon", name: "Eaon", description: "Default amber workshop", accent: "#f4b942", code: "#f4b942", border: "#f4b942", success: "#86c06a", error: "#ef6b73" },
  { id: "absolutely", name: "Absolutely", description: "Warm, Claude-inspired", accent: "#d97757", code: "#e58b6f", border: "#b9654d", success: "#7eab74", error: "#d95d66" },
  { id: "absolutely-2", name: "Absolutely 2", description: "Clean, ChatGPT-inspired", accent: "#10a37f", code: "#19b58e", border: "#10a37f", success: "#45b56b", error: "#e85b67" },
  { id: "codex", name: "Codex", description: "Electric blue, Codex-inspired", accent: "#69b7ff", code: "#8ac8ff", border: "#4d9ee8", success: "#74c990", error: "#ff737d" },
  { id: "violet", name: "Violet", description: "Deep violet terminal", accent: "#b89cff", code: "#c9b3ff", border: "#9475e8", success: "#77c99b", error: "#fa7e9a" },
  { id: "phosphor", name: "Phosphor", description: "Green-screen focus", accent: "#7ee787", code: "#9cf0a4", border: "#56b86b", success: "#7ee787", error: "#ff8c8c" },
];

export const DEFAULT_THEME = THEMES[0];

export function findTheme(query: string): Theme | undefined {
  const normalized = query.trim().toLowerCase();
  return THEMES.find((theme) => theme.id === normalized || theme.name.toLowerCase() === normalized);
}

export function themeFor(id?: string): Theme {
  return findTheme(id ?? "") ?? DEFAULT_THEME;
}

const SYNTAX_DEFAULTS: SyntaxTokens = {
  keyword: "#ff79c6",
  string: "#f1fa8c",
  comment: "#6272a4",
  function: "#50fa7b",
  number: "#bd93f9",
  property: "#66d9ef",
  punctuation: "#f8f8f2",
};

const SYNTAX_CODEX: SyntaxTokens = {
  keyword: "#79b8ff",
  string: "#9ecbff",
  comment: "#6a737d",
  function: "#79c0ff",
  number: "#a5d6ff",
  property: "#79b8ff",
  punctuation: "#e1e4e8",
};

const SYNTAX_GREEN: SyntaxTokens = {
  keyword: "#7ee787",
  string: "#a5d6a5",
  comment: "#5c6e5c",
  function: "#79c97a",
  number: "#79c97a",
  property: "#7ee787",
  punctuation: "#c9d1c9",
};

const SYNTAX_WARM: SyntaxTokens = {
  keyword: "#e8a38c",
  string: "#f0c8b0",
  comment: "#7a6a62",
  function: "#c9a88c",
  number: "#d9b89c",
  property: "#e8a38c",
  punctuation: "#d4c4bc",
};

const SYNTAX_VIOLET: SyntaxTokens = {
  keyword: "#c9b3ff",
  string: "#e2d5ff",
  comment: "#7a6a9a",
  function: "#b8a0e8",
  number: "#d0b8ff",
  property: "#c9b3ff",
  punctuation: "#d4c8e8",
};

export function buildThemeTokens(id: string): ThemeTokens {
  const base = findTheme(id) ?? DEFAULT_THEME;

  let syntax = SYNTAX_DEFAULTS;
  if (id === "codex") syntax = SYNTAX_CODEX;
  else if (id === "phosphor") syntax = SYNTAX_GREEN;
  else if (id === "absolutely" || id === "absolutely-2") syntax = SYNTAX_WARM;
  else if (id === "violet") syntax = SYNTAX_VIOLET;

  return {
    id,
    name: base.name,
    bgPrimary: undefined,
    bgSecondary: undefined,
    bgTertiary: undefined,
    border: base.border,
    borderFocused: base.accent,
    textPrimary: undefined,
    textSecondary: "gray",
    textMuted: "gray",
    accent: base.accent,
    code: base.code,
    success: base.success,
    warning: base.accent,
    error: base.error,
    syntax,
  };
}