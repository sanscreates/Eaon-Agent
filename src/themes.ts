// Terminal palettes. Theme changes use Ink colors, so they work in ordinary terminals.

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
