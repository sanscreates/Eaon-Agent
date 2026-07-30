// Terminal palettes. Theme changes use Ink colors, so they work in ordinary
// terminals (hex values use truecolor where the terminal supports it).
// `bg` paints the real terminal background of the whole app surface.

export interface Theme {
  id: string;
  name: string;
  description: string;
  accent: string;
  code: string;
  border: string;
  success: string;
  error: string;
  /** App background — applied to the root surface so the terminal itself is tinted. */
  bg: string;
  /** Secondary text color (labels, hints, metadata). */
  muted: string;
  /** Plugin id when the theme ships from a plugin (undefined = built-in). */
  source?: string;
}

export const THEMES: Theme[] = [
  { id: "eaon", name: "Eaon", description: "Default amber workshop", accent: "#f4b942", code: "#f4b942", border: "#f4b942", success: "#86c06a", error: "#ef6b73", bg: "#171208", muted: "#8a7a5c" },
  { id: "absolutely", name: "Absolutely", description: "Warm, Claude-inspired", accent: "#d97757", code: "#e58b6f", border: "#b9654d", success: "#7eab74", error: "#d95d66", bg: "#1c1210", muted: "#8d6f66" },
  { id: "absolutely-2", name: "Absolutely 2", description: "Clean, ChatGPT-inspired", accent: "#10a37f", code: "#19b58e", border: "#10a37f", success: "#45b56b", error: "#e85b67", bg: "#0d1714", muted: "#5f7d75" },
  { id: "codex", name: "Codex", description: "Electric blue, Codex-inspired", accent: "#69b7ff", code: "#8ac8ff", border: "#4d9ee8", success: "#74c990", error: "#ff737d", bg: "#0b1220", muted: "#5d7291" },
  { id: "violet", name: "Violet", description: "Deep violet terminal", accent: "#b89cff", code: "#c9b3ff", border: "#9475e8", success: "#77c99b", error: "#fa7e9a", bg: "#130f1f", muted: "#6f6394" },
  { id: "phosphor", name: "Phosphor", description: "Green-screen focus", accent: "#7ee787", code: "#9cf0a4", border: "#56b86b", success: "#7ee787", error: "#ff8c8c", bg: "#08130a", muted: "#527a58" },
  { id: "midnight", name: "Midnight", description: "Deep navy, cool steel accents", accent: "#7aa2f7", code: "#9dc0ff", border: "#3d59a1", success: "#9ece6a", error: "#f7768e", bg: "#0a0e1a", muted: "#565f89" },
  { id: "dracula", name: "Dracula", description: "Purple night, cyan highlights", accent: "#bd93f9", code: "#8be9fd", border: "#6272a4", success: "#50fa7b", error: "#ff5555", bg: "#191a26", muted: "#6272a4" },
  { id: "nord", name: "Nord", description: "Arctic frost palette", accent: "#88c0d0", code: "#81a1c1", border: "#4c566a", success: "#a3be8c", error: "#bf616a", bg: "#1c2230", muted: "#616e88" },
  { id: "solarized", name: "Solarized", description: "Solarized dark precision", accent: "#b58900", code: "#2aa198", border: "#586e75", success: "#859900", error: "#dc322f", bg: "#002b36", muted: "#586e75" },
  { id: "rose-pine", name: "Rose Pine", description: "Muted rose and pine", accent: "#ebbcba", code: "#9ccfd8", border: "#6e6a86", success: "#31748f", error: "#eb6f92", bg: "#191724", muted: "#6e6a86" },
  { id: "ember", name: "Ember", description: "Warm coals, high contrast", accent: "#ff9e64", code: "#ffb86c", border: "#a3572e", success: "#c3e88d", error: "#ff5370", bg: "#1a0f0a", muted: "#8a6350" },
  { id: "ocean", name: "Ocean", description: "Teal depths", accent: "#64d8cb", code: "#7fdbca", border: "#2e8b84", success: "#7ee787", error: "#ef6b73", bg: "#08191a", muted: "#4f7a78" },
];

export const DEFAULT_THEME = THEMES[0];

// ---------------- plugin themes ----------------

// Themes contributed by plugins (plugin.json "themes" field). Registered by
// the Runtime on startup and after /setup reloads.

const pluginThemes: Theme[] = [];

export function registerPluginThemes(themes: Theme[]): void {
  pluginThemes.length = 0;
  pluginThemes.push(...themes);
}

export function allThemes(): Theme[] {
  return [...THEMES, ...pluginThemes];
}

/** Convert a plugin manifest `themes` map into valid Theme objects. */
export function themesFromManifest(source: string, raw: unknown): Theme[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: Theme[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, any>)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
    if (!v || typeof v !== "object" || typeof v.accent !== "string" || !v.accent) continue;
    out.push({
      id,
      name: typeof v.name === "string" && v.name ? v.name : id,
      description: typeof v.description === "string" ? v.description : `from ${source}`,
      accent: v.accent,
      code: typeof v.code === "string" ? v.code : v.accent,
      border: typeof v.border === "string" ? v.border : v.accent,
      success: typeof v.success === "string" ? v.success : "#86c06a",
      error: typeof v.error === "string" ? v.error : "#ef6b73",
      bg: typeof v.bg === "string" ? v.bg : "#101010",
      muted: typeof v.muted === "string" ? v.muted : "#777777",
      source,
    });
  }
  return out;
}

export function findTheme(query: string): Theme | undefined {
  const normalized = query.trim().toLowerCase();
  return allThemes().find((theme) => theme.id === normalized || theme.name.toLowerCase() === normalized);
}

export function themeFor(id?: string): Theme {
  return findTheme(id ?? "") ?? DEFAULT_THEME;
}
