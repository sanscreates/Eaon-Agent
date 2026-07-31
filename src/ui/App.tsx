// Main TUI application.

import path from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { addLifetime } from "../caveman.js";
import { configExists } from "../config.js";
import { Agent } from "../core/agent.js";
import { handleSlash, HELP_TEXT, type CommandIO } from "../core/commands.js";
import type { Runtime } from "../core/runtime.js";
import { listAllModels } from "../providers/registry.js";
import { fmtTokens } from "../tokens.js";
import { themeFor } from "../themes.js";
import type { ModelRef, PermissionDecision } from "../types.js";
import {
  ChatInput,
  estimateItemLines,
  estimateMarkdownLines,
  ItemView,
  Markdown,
  PermissionPrompt,
  Select,
  SessionHeader,
  Spinner,
  StatusBar,
  tailFitText,
  WelcomeScreen,
  WorkspaceRail,
  type ChatItem,
} from "./components.js";
import { Onboarding } from "./Onboarding.js";

type Overlay = "none" | "model" | "setup" | "welcome";

/**
 * Slice the chat history to the items that fit the viewport budget (in
 * terminal lines), honoring a line-based scroll offset from the bottom.
 * Heights are overestimated on purpose, so the slice never overflows.
 */
function windowChat(
  items: ChatItem[],
  heights: number[],
  budget: number,
  scrollOffset: number,
): { start: number; end: number; maxOffset: number; effectiveOffset: number } {
  const total = heights.reduce((a, b) => a + b, 0);
  const maxOffset = Math.max(0, total - budget);
  const o = Math.min(Math.max(0, scrollOffset), maxOffset);
  // hide whole items covered by the scroll offset, from the bottom up
  let end = items.length;
  let skipped = 0;
  while (end > 0 && skipped + heights[end - 1] <= o) {
    skipped += heights[end - 1];
    end--;
  }
  // fill the remaining budget backwards from the window end
  let start = end;
  let used = 0;
  while (start > 0 && used + heights[start - 1] <= budget) {
    used += heights[start - 1];
    start--;
  }
  // an item taller than the viewport still must render (top-clipped by the
  // overflow-hidden box) — never show an empty window
  if (start === end && end > 0) start = end - 1;
  return { start, end, maxOffset, effectiveOffset: o };
}

/** Terminal lines available to the chat viewport for the given chrome state. */
function chatBudgetLines(rows: number, opts: { input: boolean; permReq: boolean; modelPicker: boolean }): number {
  let chrome = 3; // top bar
  chrome += 3; // session header
  if (opts.input) chrome += 1 + 3 + 3; // marginTop + input box + status bar
  if (opts.permReq) chrome += 16; // permission prompt allowance
  if (opts.modelPicker) chrome += 14; // model picker allowance
  return Math.max(4, rows - chrome - 1); // 1 line slack
}

/** Usable text width inside the chat viewport. */
function chatTextWidth(columns: number, showRail: boolean): number {
  return Math.max(16, columns - 2 /* root paddingX */ - (showRail ? 27 : 0) - 2 /* chat paddingX */);
}

/** Parse "#rrggbb" into rgb parts; null for non-hex colors. */
function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Paint the real terminal background with the theme color. Ink 4's Box has no
 * backgroundColor prop, so we set the terminal's current background rendition
 * directly; erase operations (bce) and unstyled cells then pick it up.
 */
function useTerminalBackground(stdout: NodeJS.WriteStream, bg: string): void {
  const applied = useRef("");
  // Write during render, NOT in an effect: Ink clears + repaints the full
  // frame on every commit (the app is always exactly `rows` tall), so the
  // rendition must be set before that write. A post-paint write — or an
  // erase here — left the screen blank/solid until the next keystroke.
  if (applied.current !== bg) {
    const rgb = hexToRgb(bg);
    if (rgb) {
      applied.current = bg;
      stdout.write(`\u001b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`);
    }
  }
  useEffect(() => () => { stdout.write("\u001b[49m"); }, [stdout]);
}

export function App(props: { rt: Runtime; forceSetup?: boolean }): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rt = props.rt;

  const [terminalSize, setTerminalSize] = useState({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });

  useEffect(() => {
    const updateSize = () => setTerminalSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", updateSize);
    updateSize();
    return () => { stdout.off("resize", updateSize); };
  }, [stdout]);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [liveText, setLiveText] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(props.forceSetup ? "setup" : (configExists() ? "welcome" : "none"));
  const [needsOnboarding, setNeedsOnboarding] = useState(!configExists() && !props.forceSetup);
  const [permReq, setPermReq] = useState<{ req: any; resolve: (d: PermissionDecision) => void } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [statsTick, setStatsTick] = useState(0);
  const [themeTick, setThemeTick] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const cancelledRef = useRef(false);

  const idRef = useRef(1);
  const liveRef = useRef("");
  const itemsRef = useRef<ChatItem[]>([]);
  const subagentItemRef = useRef<number | null>(null);
  const modelResolverRef = useRef<((m: ModelRef | null) => void) | null>(null);

  const nextId = () => idRef.current++;

  // Long texts are stored as multiple items so the viewport window and
  // PgUp/PgDn scrollback can move through them; single items are atomic.
  const MAX_ITEM_LINES = 12;

  const pushItem = (item: Omit<ChatItem, "id">): number => {
    const text = item.text;
    if (text && (item.kind === "user" || item.kind === "assistant" || item.kind === "notice" || item.kind === "error")) {
      const lines = text.split("\n");
      if (lines.length > MAX_ITEM_LINES) {
        let firstId = 0;
        for (let i = 0; i < lines.length; i += MAX_ITEM_LINES) {
          const id = nextId();
          if (!firstId) firstId = id;
          itemsRef.current = [...itemsRef.current, { ...item, text: lines.slice(i, i + MAX_ITEM_LINES).join("\n"), id }];
        }
        setItems(itemsRef.current);
        return firstId;
      }
    }
    const id = nextId();
    itemsRef.current = [...itemsRef.current, { ...item, id }];
    setItems(itemsRef.current);
    return id;
  };

  const updateItem = (id: number, patch: Partial<ChatItem>) => {
    itemsRef.current = itemsRef.current.map((it) => (it.id === id ? { ...it, ...patch } : it));
    setItems(itemsRef.current);
  };

  const flushLive = () => {
    const t = liveRef.current.trim();
    if (t) pushItem({ kind: "assistant", text: t });
    liveRef.current = "";
    setLiveText("");
  };

  const agent = useMemo(() => {
    rt.hooks = {
      onThinking: () => {
        if (cancelledRef.current) return;
        setBusy(true);
        setThinking(true);
      },
      onText: (t) => {
        if (cancelledRef.current) return;
        setThinking(false);
        liveRef.current += t;
        setLiveText(liveRef.current);
        setStatsTick((x) => x + 1);
      },
      onToolStart: (call) => {
        if (cancelledRef.current) return;
        setThinking(false);
        flushLive();
        pushItem({ kind: "tool", call, running: true });
      },
      onToolEnd: (call, result, ms) => {
        if (cancelledRef.current) return;
        const it = [...itemsRef.current].reverse().find((x) => x.kind === "tool" && x.call?.id === call.id);
        if (it) updateItem(it.id, { result, ms, running: false });
        setStatsTick((x) => x + 1);
      },
      onNotice: (text) => { if (!cancelledRef.current) pushItem({ kind: "notice", text }); },
      onError: (text) => {
        if (cancelledRef.current) return;
        flushLive();
        pushItem({ kind: "error", text });
      },
      onCompression: (removed, before, after) => {
        if (cancelledRef.current) return;
        pushItem({ kind: "notice", text: `⚡ context compressed: ${removed} msgs, ~${fmtTokens(before)} → ~${fmtTokens(after)} tokens (compressor model)` });
      },
      onSubagentStart: (task, model) => {
        if (cancelledRef.current) return;
        flushLive();
        subagentItemRef.current = pushItem({ kind: "subagent", text: `${model} — ${task}`, running: true });
      },
      onSubagentEnd: () => {
        if (cancelledRef.current) return;
        if (subagentItemRef.current) updateItem(subagentItemRef.current, { running: false });
        subagentItemRef.current = null;
      },
      askPermission: (req) =>
        new Promise<PermissionDecision>((resolve) => {
          setPermReq({ req, resolve });
        }),
    };
    const a = new Agent(rt);
    return a;
  }, []);

  // banner
  useMemo(() => {
    if (!needsOnboarding) {
      const m = rt.cfg.main;
      pushItem({
        kind: "notice",
        text: `Eaon Agent v1.4.0 — main: ${m ? `${m.provider}/${m.model}` : "not configured"} · compressor: ${rt.cfg.compressor?.model ?? "off"} · ⛏ ${rt.cfg.caveman.level} · /help for commands`,
      });
    }
  }, [needsOnboarding]);

  const doExit = () => {
    const s = rt.session.stats;
    try {
      addLifetime({
        sessions: 1,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        compressorTokens: s.compressorInput + s.compressorOutput,
        compressedTokens: s.compressedTokens,
        cavemanSavedEst: s.cavemanSavedEst,
        toolCalls: s.toolCalls,
      });
    } catch {
      // A read-only home directory should not prevent the TUI from exiting.
    }
    try { rt.shutdown(); } catch { /* best-effort cleanup */ }
    exit();
    setTimeout(() => process.exit(0), 100);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") { doExit(); return; }
    if (overlay === "welcome") {
      if (key.return) { setOverlay("none"); return; }
      if (input.toLowerCase() === "s") { setOverlay("setup"); return; }
      return;
    }
    if (key.escape && busy) { cancelledRef.current = true; agent.cancel(); return; }
    // Chat scrollback: PgUp/PgDn — or ^U/^D on keyboards without paging
    // keys — move through history (in lines) while the header, input box
    // and status bar stay fixed in place.
    if (overlay === "none" && !needsOnboarding) {
      const scrollUp = key.pageUp || (key.ctrl && input.toLowerCase() === "u");
      const scrollDown = key.pageDown || (key.ctrl && input.toLowerCase() === "d");
      if (scrollUp || scrollDown) {
        const budget = chatBudgetLines(terminalSize.rows, { input: true, permReq: !!permReq, modelPicker: false });
        const width = chatTextWidth(terminalSize.columns, showRail);
        const heights = itemsRef.current.map((it) => estimateItemLines(it, width));
        const { maxOffset } = windowChat(itemsRef.current, heights, budget, scrollOffset);
        const step = Math.max(1, budget - 2);
        setScrollOffset((o) => Math.min(Math.max(0, scrollUp ? o + step : o - step), maxOffset));
        return;
      }
    }
  });

  const runAgent = async (prompt: string) => {
    setBusy(true);
    cancelledRef.current = false;
    try {
      await agent.run(prompt);
    } catch {
      // error already surfaced via onError
    } finally {
      flushLive();
      setBusy(false);
      setThinking(false);
      setStatsTick((x) => x + 1);
      if (cancelledRef.current) {
        pushItem({ kind: "notice", text: "Task cancelled." });
      }
    }
  };

  const io: CommandIO = {
    print: (text) => pushItem({ kind: "notice", text }),
    pickModel: () =>
      new Promise<ModelRef | null>((resolve) => {
        modelResolverRef.current = resolve;
        setOverlay("model");
      }),
    reopenSetup: () => setOverlay("setup"),
    refreshTheme: () => setThemeTick((n) => n + 1),
    requestExit: doExit,
  };

  const onSubmit = async (text: string) => {
    if (busy || overlay !== "none" || needsOnboarding) return;
    setHistory((h) => [...h.slice(-99), text]);
    setScrollOffset(0);

    if (text.startsWith("/")) {
      const result = await handleSlash(text, rt, agent, io);
      if (result.kind === "send") {
        pushItem({ kind: "user", text: result.display });
        await runAgent(result.prompt);
      } else if (result.kind === "unknown") {
        pushItem({ kind: "error", text: `Unknown command: ${text.split(" ")[0]} — try /help` });
      }
      return;
    }
    pushItem({ kind: "user", text });
    await runAgent(text);
  };

  const s = rt.session.stats;
  const saved = s.compressedTokens + s.cavemanSavedEst;
  const mainLabel = rt.cfg.main ? `${rt.cfg.main.provider}/${rt.cfg.main.model}` : "no model";
  const theme = themeFor(rt.cfg.ui.theme);
  const workspace = path.basename(rt.cwd) || rt.cwd;
  const showRail = terminalSize.columns >= 90 && overlay !== "setup" && !needsOnboarding;
  const statusText = busy
    ? "Working…  Esc cancel"
    : permReq
      ? "Permission required"
      : `Ready  ·  ${workspace}  ·  Enter send  ·  /help commands`;
  const inSetup = overlay === "setup" || needsOnboarding;
  // Window the chat history to the viewport budget (terminal lines). This is
  // what keeps the chrome fixed: the rendered tree is always <= rows tall,
  // so the top UI can never be pushed into scrollback again.
  const chatWidth = chatTextWidth(terminalSize.columns, showRail);
  const itemHeights = items.map((it) => estimateItemLines(it, chatWidth));
  const baseBudget = chatBudgetLines(terminalSize.rows, {
    input: overlay === "none",
    permReq: !!permReq,
    modelPicker: overlay === "model",
  });
  // Streaming text is tail-sliced to what fits the screen; the full text is
  // stored (chunked) in the history once the turn ends.
  const liveView = liveText ? tailFitText(liveText, chatWidth, Math.max(2, baseBudget - 2), true) : "";
  const liveLines = liveView ? 1 + estimateMarkdownLines(liveView, chatWidth) : 0;
  const thinkingLines = thinking && !liveText ? 1 : 0;
  const budget = Math.max(2, baseBudget - liveLines - thinkingLines - (scrollOffset > 0 ? 1 : 0));
  let win = windowChat(items, itemHeights, budget, scrollOffset);
  if (win.start > 0) {
    // the "earlier history" hint line itself takes one line
    win = windowChat(items, itemHeights, Math.max(2, budget - 1), scrollOffset);
  }
  const itemBudget = win.start > 0 ? Math.max(2, budget - 1) : budget;
  const effectiveOffset = win.effectiveOffset;
  // A viewport-taller first item is tail-sliced so nothing ever overflows.
  const visibleItems = items.slice(win.start, win.end).map((it, idx) => {
    if (idx === 0 && it.text && itemHeights[win.start] > itemBudget) {
      return { ...it, text: tailFitText(it.text, chatWidth, itemBudget, it.kind === "assistant") };
    }
    return it;
  });
  useTerminalBackground(stdout, theme.bg);

  // The root box is exactly the terminal size and never grows: chrome (top
  // bar, session header, input, status bar) is fixed, and only the chat
  // viewport scrolls. Before this, minHeight let the tree overflow the
  // terminal, pushing the top UI into scrollback.
  return (
    <Box flexDirection="column" width={terminalSize.columns} height={terminalSize.rows} paddingX={1}>
      <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between" flexShrink={0}>
        <Text bold color={theme.accent}>EAON <Text dimColor>· agentic workspace</Text></Text>
        <Text dimColor>{theme.name} · {mainLabel} · /theme</Text>
      </Box>

      {overlay === "welcome" && !needsOnboarding ? (
        <WelcomeScreen theme={theme} workspace={workspace} mainLabel={mainLabel} terminalRows={terminalSize.rows} />
      ) : (
        <Box flexDirection="row" flexGrow={1}>
          {showRail ? (
            <WorkspaceRail
              theme={theme}
              workspace={workspace}
              mainLabel={mainLabel}
              permissionMode={rt.permissions.mode}
              cavemanLevel={rt.cfg.caveman.enabled ? rt.cfg.caveman.level : "off"}
            />
          ) : null}

          <Box flexDirection="column" flexGrow={1} paddingLeft={showRail ? 1 : 0}>
            <SessionHeader theme={theme} workspace={workspace} mainLabel={mainLabel} />

            {inSetup ? (
              <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
                <Onboarding
                  theme={theme}
                  onDone={() => {
                    rt.reload();
                    agent.rebuildSystem();
                    setOverlay("none");
                    setNeedsOnboarding(false);
                    pushItem({ kind: "notice", text: `Setup complete — main: ${rt.cfg.main?.provider}/${rt.cfg.main?.model} · compressor: ${rt.cfg.compressor?.model}. Go.` });
                  }}
                />
              </Box>
            ) : (
              <>
                {/* Chat viewport: windowed to fit, bottom-anchored. */}
                <Box flexDirection="column" flexGrow={1} overflow="hidden" justifyContent="flex-end" paddingX={1}>
                  {win.start > 0 ? (
                    <Text dimColor>  ↑ {win.start} earlier item{win.start === 1 ? "" : "s"} — PgUp / ^U to scroll up</Text>
                  ) : null}

                  {visibleItems.map((it) => <ItemView key={it.id} item={it} theme={theme} />)}

                  {effectiveOffset > 0 ? (
                    <Text dimColor>  ↓ scrolled — {effectiveOffset} line{effectiveOffset === 1 ? "" : "s"} below · PgDn / ^D returns to live view</Text>
                  ) : null}

                  {liveView ? (
                    <Box marginTop={1} flexDirection="column">
                      <Markdown text={liveView} theme={theme} />
                    </Box>
                  ) : null}

                  {thinking && !liveText ? <Spinner label={`${mainLabel} thinking…`} color={theme.accent} /> : null}

                  {overlay === "model" ? (
                    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
                      <Text bold>Pick main model (Enter to select):</Text>
                      <Select
                        accent={theme.accent}
                        limit={8}
                        items={listAllModels(rt.cfg).map((m) => ({
                          label: `${m.provider}/${m.model}`,
                          value: `${m.provider}/${m.model}`,
                          hint: m.role,
                        }))}
                        onSelect={(v) => {
                          const [provider, ...rest] = v.split("/");
                          modelResolverRef.current?.({ provider, model: rest.join("/") });
                          modelResolverRef.current = null;
                          setOverlay("none");
                        }}
                      />
                    </Box>
                  ) : null}
                </Box>

                {permReq ? (
                  <PermissionPrompt
                    theme={theme}
                    req={permReq.req}
                    onDecision={(d) => {
                      permReq.resolve(d);
                      setPermReq(null);
                    }}
                  />
                ) : null}

                {overlay === "none" ? (
                  <Box flexDirection="column" marginTop={1} flexShrink={0}>
                    <ChatInput
                      onSubmit={onSubmit}
                      disabled={busy || !!permReq}
                      history={history}
                      accent={theme.accent}
                      placeholder={busy ? "working… Esc cancel" : "ask anything · /help · \\ + Enter newline"}
                    />
                    <StatusBar theme={theme} text={`${statusText}${rt.cfg.caveman.enabled ? `  ·  ⛏ ${rt.cfg.caveman.level}` : ""}${rt.cfg.ui.showTokens ? `  ·  in ${fmtTokens(s.inputTokens)} out ${fmtTokens(s.outputTokens)} saved ⛏${fmtTokens(saved)}` : ""}`} />
                  </Box>
                ) : null}
              </>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

export { HELP_TEXT };
