// Theme + native-plugin tests.
// Covers: extended built-in theme set (with real background colors),
// plugin-contributed themes/macros/commands via plugin.json, and the
// /theme and /plugins slash commands.

import fs from "node:fs";
import path from "node:path";
import { check, testSummary, TEST_HOME } from "./helpers.mjs";

const { themeFor, findTheme, allThemes, themesFromManifest, readableTheme, contrastRatio, luminance } = await import("../dist/themes.js");
const { Runtime } = await import("../dist/core/runtime.js");
const { handleSlash } = await import("../dist/core/commands.js");

// ---- built-in themes ----
const NEW_THEMES = ["midnight", "dracula", "nord", "solarized", "rose-pine", "ember", "ocean"];
for (const id of NEW_THEMES) {
  check(`built-in theme '${id}' exists`, !!findTheme(id));
}
check("original themes still present", ["eaon", "absolutely", "absolutely-2", "codex", "violet", "phosphor"].every((id) => !!findTheme(id)));
check("every theme has a real hex background color", allThemes().every((t) => /^#[0-9a-fA-F]{6}$/.test(t.bg)));
check("every theme has a muted color", allThemes().every((t) => typeof t.muted === "string" && t.muted.length > 0));
check("themeFor falls back to default for unknown ids", themeFor("does-not-exist").id === "eaon");

// ---- light (white-ish) themes ----
const LIGHT_THEMES = ["paper", "snow", "linen", "mist", "cream", "dawn"];
for (const id of LIGHT_THEMES) {
  check(`light theme '${id}' exists`, !!findTheme(id));
}
check("light themes all use light backgrounds", LIGHT_THEMES.every((id) => luminance(findTheme(id).bg) > 0.5));

// ---- readability guarantee ----
// The theme background is painted as the terminal's real surface, so every
// role must clear a minimum contrast ratio against it (WCAG AA: 4.0 for text,
// 3.0 for UI/borders) — regardless of OS light/dark mode or terminal defaults.
for (const t of allThemes()) {
  const safe = readableTheme(t);
  for (const role of ["accent", "code", "success", "error", "muted"]) {
    const r = contrastRatio(safe[role], t.bg);
    check(`'${t.id}' ${role} readable against bg (${r.toFixed(2)})`, r >= 4.0);
  }
  const rb = contrastRatio(safe.border, t.bg);
  check(`'${t.id}' border readable against bg (${rb.toFixed(2)})`, rb >= 3.0);
}
check("already-readable theme colors pass through unchanged", readableTheme(findTheme("eaon")).accent === "#f4b942");

// ---- themesFromManifest validation ----
const parsed = themesFromManifest("demo", {
  "demo-dark": { name: "Demo Dark", accent: "#aabbcc" },
  "bad id with spaces": { accent: "#aabbcc" },
  "no-accent": { name: "Missing accent" },
});
check("manifest parser keeps valid theme", parsed.length === 1 && parsed[0].id === "demo-dark");
check("manifest parser fills defaults", parsed[0].code === "#aabbcc" && !!parsed[0].bg && !!parsed[0].muted);
check("manifest parser tags source plugin", parsed[0].source === "demo");

// ---- plugin loading end-to-end ----
const pluginDir = path.join(TEST_HOME, ".eaon", "plugins", "demo");
fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(
  path.join(pluginDir, "plugin.json"),
  JSON.stringify({
    name: "demo",
    version: "0.1.0",
    commands: { "demo-cmd": { description: "demo command", command: "echo" } },
    macros: { "demo-macro": { description: "demo macro", text: "hello from plugin" } },
    themes: { "demo-dark": { name: "Demo Dark", description: "plugin theme", accent: "#aabbcc", bg: "#101020" } },
  }),
);

const rt = new Runtime({ cwd: TEST_HOME });
check("plugin theme registered via Runtime", findTheme("demo-dark")?.source === "demo");
check("plugin theme appears in allThemes()", allThemes().some((t) => t.id === "demo-dark"));
check("plugin macro loaded", rt.macros.get("demo-macro")?.text === "hello from plugin");
check("macro expansion works", rt.macros.expandText("say <<macro:demo-macro>>!") === "say hello from plugin!");

// ---- slash commands ----
const io = (() => {
  const out = [];
  return {
    lines: out,
    print: (t) => out.push(t),
    pickModel: async () => null,
    reopenSetup: () => {},
    refreshTheme: () => {},
    requestExit: () => {},
  };
})();
const dummyAgent = {};

await handleSlash("/theme list", rt, dummyAgent, io);
const themeList = io.lines.join("\n");
check("/theme list shows plugin theme with source", themeList.includes("demo-dark") && themeList.includes("(plugin: demo)"));

await handleSlash("/plugins", rt, dummyAgent, io);
const pluginsOut = io.lines.join("\n");
for (const cmd of ["github", "git", "docker", "npm", "node", "python", "make", "cargo", "kubectl", "terraform"]) {
  check(`/plugins lists built-in native command /${cmd}`, pluginsOut.includes(`/${cmd} <args>`));
}
check("/plugins lists plugin command /demo-cmd", pluginsOut.includes("/demo-cmd <args>"));
check("/plugins shows installed plugin with contents", pluginsOut.includes("demo v0.1.0") && pluginsOut.includes("1 theme(s)") && pluginsOut.includes("1 macro(s)") && pluginsOut.includes("1 command(s)"));

// /theme actually switches to a plugin theme
await handleSlash("/theme demo-dark", rt, dummyAgent, io);
check("/theme demo-dark switches theme", rt.cfg.ui.theme === "demo-dark");
check("themeFor resolves plugin theme bg", themeFor(rt.cfg.ui.theme).bg === "#101020");

rt.shutdown();
testSummary("themes-plugins.test");
process.exit(0);
