// TUI layout regression test.
// Bug fixed: a long chat used to push the top UI (header/session bar) into
// terminal scrollback — it was only reachable by scrolling the terminal.
// Now the root is exactly the terminal size, chrome is fixed, and the chat
// viewport clips/scrolls internally (PgUp/PgDn).
//
// Run: npm run build && node test/tui.test.mjs

import React from "react";
import { renderFake as render } from "./fake-tty.mjs";
import { check, wait, waitFor, testSummary, TEST_HOME } from "./helpers.mjs";

const { Runtime } = await import("../dist/core/runtime.js");
const { App } = await import("../dist/ui/App.js");

const ROWS = 24; // fake stdout has no rows -> App falls back to 24

const rt = new Runtime({ cwd: TEST_HOME });
const { lastFrame, frames, stdin, unmount, cleanup } = render(React.createElement(App, { rt }));

// The theme background paint writes its own tiny frame; always assert on the
// last real UI frame.
const uiFrame = () => [...frames].reverse().find((f) => f.includes("EAON"));

// Welcome overlay first (config exists)
await waitFor("welcome screen renders", () => lastFrame()?.includes("Welcome back"));
stdin.write("\r"); // Enter -> dismiss welcome
await waitFor("chat UI renders after welcome", () => !!uiFrame()?.includes("NEW SESSION"));

// Fill the chat well beyond one screen
for (let i = 0; i < 12; i++) {
  stdin.type(`message number ${i} with plenty of padding text to fill the line`);
  stdin.write("\r");
  await waitFor(`reply ${i} rendered`, () => (uiFrame() ?? "").includes(`Echo: message number ${i}`), 4000);
}
await wait(300);

const full = uiFrame() ?? "";
check("frame exists", full.length > 0);
check(`frame height fits terminal (${full.split("\n").length} <= ${ROWS})`, full.split("\n").length <= ROWS);
check("top header 'EAON' still visible after long chat", full.includes("EAON"));
check("session header still visible after long chat", full.includes("NEW SESSION"));
check("status bar still visible after long chat", full.includes("Ready"));
check("input box still visible after long chat", full.includes("▌"));
check("latest reply visible at bottom", full.includes("Echo: message number 11"));

// Scroll back through history: chrome must stay put
stdin.write("[5~"); // PgUp
stdin.write("[5~");
await waitFor("scroll indicator appears after PgUp", () => (uiFrame() ?? "").includes("scrolled —"));
const scrolled = uiFrame() ?? "";
check("header fixed while scrolled", scrolled.includes("EAON") && scrolled.includes("NEW SESSION"));
check("status bar fixed while scrolled", scrolled.includes("Ready"));

// Scroll back to the live bottom
for (let i = 0; i < 6; i++) stdin.write("[6~"); // PgDn
await waitFor("back at live view after PgDn", () => !(uiFrame() ?? "").includes("scrolled —"));
check("latest reply visible again", (uiFrame() ?? "").includes("Echo: message number 11"));

// Slash command output flows through the same fixed layout. The theme list
// is taller than the viewport, so its tail is shown (top replaced with "…").
stdin.type("/theme list");
stdin.write("\r");
await waitFor("/theme list output renders", () => (uiFrame() ?? "").includes("Use: /theme"));
check("oversized output keeps frame within terminal height", (uiFrame() ?? "").split("\n").length <= ROWS);
check("header still visible after /theme list", (uiFrame() ?? "").includes("EAON"));

// /help is even taller — same guarantees
stdin.type("/help");
stdin.write("\r");
await waitFor("/help output renders", () => (uiFrame() ?? "").includes("tokens go"));
check("/help keeps frame within terminal height", (uiFrame() ?? "").split("\n").length <= ROWS);
check("header still visible after /help", (uiFrame() ?? "").includes("EAON"));
check("input still visible after /help", (uiFrame() ?? "").includes("▌"));

rt.shutdown();
unmount();
cleanup();
testSummary("tui.test");
process.exit(0);
