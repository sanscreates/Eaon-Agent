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
stdin.write("\u001b[5~"); // PgUp
stdin.write("\u001b[5~");
await waitFor("scroll indicator appears after PgUp", () => (uiFrame() ?? "").includes("scrolled —"));
const scrolled = uiFrame() ?? "";
check("header fixed while scrolled", scrolled.includes("EAON") && scrolled.includes("NEW SESSION"));
check("status bar fixed while scrolled", scrolled.includes("Ready"));
check("earlier history visible while scrolled", /message number [0-8]\b/.test(scrolled));

// Scroll back to the live bottom
for (let i = 0; i < 6; i++) stdin.write("\u001b[6~"); // PgDn
await waitFor("back at live view after PgDn", () => !(uiFrame() ?? "").includes("scrolled —"));
check("latest reply visible again", (uiFrame() ?? "").includes("Echo: message number 11"));

// Keystroke batching hazard: when the terminal delivers text and Enter in
// ONE read (busy render loop, paste, SSH/tmux), Ink reports the whole chunk
// as input with key.return === false. It must still submit — previously the
// text was silently appended with a newline instead, so messages typed
// while the UI was busy never reached history and scrolling showed nothing.
stdin.write("single chunk submit with plenty of padding text\r");
await waitFor("batched text+Enter chunk submits", () => (uiFrame() ?? "").includes("Echo: single chunk submit"), 4000);

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

// Ctrl+U / Ctrl+D scroll too (keyboards without PgUp/PgDn)
stdin.write("\u0015"); // ^U
await waitFor("^U scrolls up", () => (uiFrame() ?? "").includes("scrolled —"));
check("chrome fixed while scrolled via ^U", (uiFrame() ?? "").includes("EAON") && (uiFrame() ?? "").includes("Ready"));
for (let i = 0; i < 6; i++) stdin.write("\u0004"); // ^D
await waitFor("^D returns to live view", () => !(uiFrame() ?? "").includes("scrolled —"));

// Theme switch repaints immediately with the new theme (no blank screen,
// no extra keypress needed)
stdin.type("/theme dracula");
stdin.write("\r");
await waitFor("theme switch confirmation renders", () => (uiFrame() ?? "").includes("Theme: Dracula"));
check("UI repainted immediately after theme switch", (uiFrame() ?? "").includes("EAON") && (uiFrame() ?? "").includes("NEW SESSION"));
check("header shows new theme name", (uiFrame() ?? "").includes("Dracula · echo/echo-1"));

rt.shutdown();
unmount();
cleanup();

// ------------------------------------------------- default foreground survival
// macOS light mode: the terminal's default foreground is black, and every
// chalk-styled segment ends in \x1b[0m, reverting unstyled text to that black.
// The stream wrapper must re-apply the theme default foreground after each
// reset, and the background painter must set it before the first frame.
{
  const { FakeStdout, FakeStderr, FakeStdin } = await import("./fake-tty.mjs");
  const { render: inkRender } = await import("ink");
  const { installDefaultFg, defaultFgSeq } = await import("../dist/ui/default-fg.js");
  const chalk = (await import("chalk")).default;
  // A non-TTY stream makes chalk suppress styling (level 0), so ink would emit
  // no SGR codes at all. Force a real-terminal level so resets appear.
  chalk.level = 2;
  const stdout = new FakeStdout();
  installDefaultFg(stdout);
  const instance = inkRender(React.createElement(App, { rt: new Runtime({ cwd: TEST_HOME }) }), {
    stdout,
    stderr: new FakeStderr(),
    stdin: new FakeStdin(),
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await waitFor("default fg registered after first paint", () => defaultFgSeq() !== "");
  const fgSeq = defaultFgSeq();
  await waitFor("a full frame renders", () => stdout.frames.some((f) => f.includes("EAON")));
  check("default fg is set before the first frame", stdout.frames[0].includes(fgSeq));
  const fullFrame = stdout.frames.join("");
  // chalk v5 resets with granular codes: \x1b[39m (default fg) and \x1b[0m
  // (full reset). Both must be re-armed with the theme default foreground.
  const resets = fullFrame.match(/\x1b\[(?:0|39)m/g) ?? [];
  const rearmed = fullFrame.match(/\x1b\[(?:0|39)m\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
  check(`every fg reset is re-armed with the default fg (${rearmed.length}/${resets.length})`, resets.length > 0 && rearmed.length === resets.length);
  instance.unmount();
  chalk.level = 0;
}

testSummary("tui.test");
process.exit(0);
