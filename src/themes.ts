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

// ---------------- readability guarantee ----------------
// The theme's `bg` becomes the terminal's real background, so every role
// color must stay readable against it — regardless of terminal/app theme,
// OS light-dark mode, or plugin-author choices. Several built-in roles
// (borders, muted hints) originally sat below 3.5: contrast ratio, invisible
// on the darkened surface. `ensureContrast` nudges any role that fails toward
// the far edge (white on dark bgs, black on light bgs) while preserving its
// hue, so a light theme can never render dark-on-dark text.

export function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(rgb: [number, number, number]): string {
  return "#" + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("");
}

/** Relative luminance of a "#rrggbb" color, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** WCAG contrast ratio between two hex colors (1 = no contrast, 21 = max). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Return a variant of `color` that clears at least `min` contrast against
 * `bg`, stepping toward the light edge on dark backgrounds and the dark edge
 * on light ones so the hue is preserved. Already-safe colors pass through
 * unchanged; extreme mid-tone backgrounds settle at their physical best.
 */
export function ensureContrast(color: string, bg: string, min = 4.0): string {
  if (contrastRatio(color, bg) >= min) return color;
  const start = hexToRgb(color);
  if (!start) return color;
  const dark = luminance(bg) < 0.5;
  let cur: [number, number, number] = start;
  let out = color;
  for (let i = 0; i < 64; i++) {
    const t = 0.3;
    cur = dark
      ? [
          cur[0] + (255 - cur[0]) * t,
          cur[1] + (255 - cur[1]) * t,
          cur[2] + (255 - cur[2]) * t,
        ]
      : [cur[0] * (1 - t), cur[1] * (1 - t), cur[2] * (1 - t)];
    out = rgbToHex(cur);
    if (contrastRatio(out, bg) >= min) return out;
  }
  return out;
}

// Text roles should at least meet WCAG AA for normal text; borders are
// decorations/UI, so the (lower) large-text bar applies.
const MIN_TEXT_CONTRAST = 4.0;
const MIN_UI_CONTRAST = 3.0;

// Theme → contrast-safe theme, memoized per theme object (plugin themes can be
// registered/re-registered over time, so cache by instance, not by id).
const readableCache = new WeakMap<Theme, Theme>();

/**
 * A theme whose roles are guaranteed readable against its own `bg`. Built-in
 * themes are authored to clear the threshold; plugins/old configs get nudged
 * automatically instead of rendering invisible text.
 */
export function readableTheme(t: Theme): Theme {
  const hit = readableCache.get(t);
  if (hit) return hit;
  const safe: Theme = {
    ...t,
    accent: ensureContrast(t.accent, t.bg, MIN_TEXT_CONTRAST),
    code: ensureContrast(t.code, t.bg, MIN_TEXT_CONTRAST),
    border: ensureContrast(t.border, t.bg, MIN_UI_CONTRAST),
    success: ensureContrast(t.success, t.bg, MIN_TEXT_CONTRAST),
    error: ensureContrast(t.error, t.bg, MIN_TEXT_CONTRAST),
    muted: ensureContrast(t.muted, t.bg, MIN_TEXT_CONTRAST),
  };
  readableCache.set(t, safe);
  return safe;
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
  // ---------------- light (white-ish) themes ----------------
  // Light background themes requested for terminals in light mode. The same
  // luminance-derived default foreground + ensureContrast guarantees keep
  // every role readable on a mirror-white surface.
  { id: "paper", name: "Paper", description: "Crisp white, warm amber ink", accent: "#b45309", code: "#0f766e", border: "#a08b5f", success: "#15803d", error: "#b91c1c", bg: "#f7f3ec", muted: "#6b5d40" },
  { id: "snow", name: "Snow", description: "Pure white, indigo highlights", accent: "#1d4ed8", code: "#6d28d9", border: "#7c8aa0", success: "#15803d", error: "#b91c1c", bg: "#ffffff", muted: "#5b6472" },
  { id: "linen", name: "Linen", description: "Soft beige, terracotta", accent: "#a2410d", code: "#0d9488", border: "#a0885c", success: "#15803d", error: "#b91c1c", bg: "#f6efe6", muted: "#6e6150" },
  { id: "mist", name: "Mist", description: "Airy grey-blue, indigo", accent: "#1e40af", code: "#5b21b6", border: "#93a1b5", success: "#15803d", error: "#b91c1c", bg: "#eef2f7", muted: "#5d6577" },
  { id: "cream", name: "Cream", description: "Milk-white, honey and teal", accent: "#a16207", code: "#0f766e", border: "#b79e63", success: "#15803d", error: "#b91c1c", bg: "#fdfbf3", muted: "#6d6148" },
  { id: "dawn", name: "Dawn", description: "Sunrise-white, warm amber", accent: "#a1440f", code: "#0f766e", border: "#b3945f", success: "#15803d", error: "#b91c1c", bg: "#fff8ee", muted: "#6b5c42" },
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
  return readableTheme(findTheme(id ?? "") ?? DEFAULT_THEME);
}
