import { Box, Text, useApp, useInput } from "ink";
import React, { useMemo, useRef, useState } from "react";
import { addLifetime } from "../caveman.js";
import { configExists } from "../config.js";
import { Agent } from "../core/agent.js";
import { handleSlash, HELP_TEXT, type CommandIO } from "../core/commands.js";
import type { Runtime } from "../core/runtime.js";
import { listAllModels } from "../providers/registry.js";
import { fmtTokens } from "../tokens.js";
import { themeFor } from "../themes.js";
import type { ModelRef, PermissionDecision } from "../types.js";
import { useFocusManager } from "./hooks/useFocusManager.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";

import { ItemView, PermissionPrompt, Select, WelcomeScreen, type ChatItem } from "./components.js";
import { Onboarding } from "./Onboarding.js";
import { Header } from "./components/Header.js";
import { StatusBar } from "./components/StatusBar.js";
import { Sidebar } from "./components/Sidebar.js";
import { ContextPanel } from "./components/ContextPanel.js";
import { ChatStream } from "./components/ChatStream.js";
import { InputBar } from "./components/InputBar.js";

type Overlay = "none" | "model" | "setup" | "welcome";

export function App(props: { rt: Runtime; forceSetup?: boolean }): React.ReactElement {
  const { exit } = useApp();
  const rt = props.rt;

  const [items, setItems] = useState<ChatItem[]>([]);
  const [liveText, setLiveText] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(props.forceSetup ? "setup" : (configExists() ? "welcome" : "none"));
  const [needsOnboarding, setNeedsOnboarding] = useState(!configExists() && !props.forceSetup);
  const [welcomeDone, setWelcomeDone] = useState(false);
  const [permReq, setPermReq] = useState<{ req: any; resolve: (d: PermissionDecision) => void } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [statsTick, setStatsTick] = useState(0);
  const [themeTick, setThemeTick] = useState(0);
  const cancelledRef = useRef(false);
  const { focusedPane, focusNext, focusPrev, focusPane, isFocused } = useFocusManager();
  const { cols, rows } = useTerminalSize();

  const idRef = useRef(1);
  const liveRef = useRef("");
  const itemsRef = useRef<ChatItem[]>([]);
  const subagentItemRef = useRef<number | null>(null);
  const modelResolverRef = useRef<((m: ModelRef | null) => void) | null>(null);
  const inputValueRef = useRef("");
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);

  const nextId = () => idRef.current++;

  const pushItem = (item: Omit<ChatItem, "id">): number => {
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
        text: `Eaon Agent v1.3.0 — main: ${m ? `${m.provider}/${m.model}` : "not configured"} · compressor: ${rt.cfg.compressor?.model ?? "off"} · ⛏ ${rt.cfg.caveman.level} · /help for commands`,
      });
    }
  }, [needsOnboarding]);

  const doExit = () => {
    const s = rt.session.stats;
    addLifetime({
      sessions: 1,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      compressorTokens: s.compressorInput + s.compressorOutput,
      compressedTokens: s.compressedTokens,
      cavemanSavedEst: s.cavemanSavedEst,
      toolCalls: s.toolCalls,
    });
    rt.shutdown();
    exit();
    setTimeout(() => process.exit(0), 100);
  };

  const leaderActiveRef = useRef(false);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { doExit(); return; }
    if (overlay === "welcome" && key.return) { setWelcomeDone(true); setOverlay("none"); return; }
    if (key.escape) {
      if (busy) { cancelledRef.current = true; agent.cancel(); return; }
      if (overlay !== "none") { setOverlay("none"); return; }
      if (inputValueRef.current) { setInputValue(""); inputValueRef.current = ""; return; }
      focusPane("chat");
      return;
    }

    // Leader key chord: Ctrl+X
    if (key.ctrl && input === "x") { leaderActiveRef.current = true; return; }
    if (leaderActiveRef.current) {
      leaderActiveRef.current = false;
      if (input === "s" || input === "S") { focusPane("sidebar"); return; }
      if (input === "c" || input === "C") { focusPane("chat"); return; }
      if (input === "r" || input === "R") { focusPane("context"); return; }
      if (input === "i" || input === "I") { focusPane("input"); return; }
      if (input === "t" || input === "T") {
        const themes = ["eaon", "absolutely", "absolutely-2", "codex", "violet", "phosphor"];
        const cur = rt.cfg.ui.theme;
        const idx = themes.indexOf(cur);
        const next = themes[(idx + 1) % themes.length];
        rt.cfg.ui.theme = next;
        setThemeTick((n) => n + 1);
        pushItem({ kind: "notice", text: `Theme → ${next}` });
        return;
      }
      if (input === "q" || input === "Q") { doExit(); return; }
      return;
    }

    // Tab / Shift+Tab for focus cycling
    if (key.tab) {
      if (key.shift) focusPrev();
      else focusNext();
      return;
    }

    // Input pane gets keyboard when focused
    if (isFocused("input") && !busy && !permReq && overlay === "none") {
      if (key.return) {
        if (inputValue.endsWith("\\")) {
          setInputValue((v) => v.slice(0, -1) + "\n");
          inputValueRef.current = inputValue.slice(0, -1) + "\n";
          return;
        }
        const t = inputValue.trim();
        if (t) {
          setHistory((h) => [...h.slice(-99), t]);
          historyRef.current = [...historyRef.current.slice(-99), t];
          setInputValue("");
          inputValueRef.current = "";
          histIdxRef.current = -1;
          focusPane("chat");
          onSubmit(t);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setInputValue((v) => v.slice(0, -1));
        inputValueRef.current = inputValueRef.current.slice(0, -1);
        return;
      }
      if (key.upArrow) {
        const h = historyRef.current;
        if (!h.length) return;
        const idx = histIdxRef.current < 0 ? h.length - 1 : Math.max(0, histIdxRef.current - 1);
        histIdxRef.current = idx;
        const val = h[idx];
        setInputValue(val);
        inputValueRef.current = val;
        return;
      }
      if (key.downArrow) {
        if (histIdxRef.current < 0) return;
        const idx = histIdxRef.current + 1;
        if (idx >= historyRef.current.length) {
          histIdxRef.current = -1;
          setInputValue("");
          inputValueRef.current = "";
        } else {
          histIdxRef.current = idx;
          const val = historyRef.current[idx];
          setInputValue(val);
          inputValueRef.current = val;
        }
        return;
      }
      if (key.escape) {
        setInputValue("");
        inputValueRef.current = "";
        histIdxRef.current = -1;
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setInputValue((v) => v + input.replace(/\r/g, "\n"));
        inputValueRef.current += input.replace(/\r/g, "\n");
      }
      return;
    }

    // Chat pane scrolling
    if (isFocused("chat")) {
      if (key.upArrow || (key.ctrl && input === "u")) {
        return;
      }
      if (key.downArrow || (key.ctrl && input === "d")) {
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
  const compressorLabel = rt.cfg.compressor?.model ?? "";
  const theme = themeFor(rt.cfg.ui.theme);

  const projectName = rt.cwd.split("/").pop() ?? "eaon";

  // Determine chat height based on terminal size
  const headerHeight = 3;
  const statusHeight = 1;
  const inputHeight = 3;
  const chatHeight = rows - headerHeight - statusHeight - inputHeight;

  return (
    <Box flexDirection="column" width="100%">
      <Header
        projectName={projectName}
        sessionName=""
        themeName={theme.name}
        isFocused={isFocused("chat") || isFocused("input")}
      />

      <Box flexDirection="row" flexGrow={1}>
        {cols >= 60 ? (
          <Box width={Math.max(20, Math.floor(cols * 0.16))} flexShrink={0}>
            <Sidebar
              sessionName="default"
              mainLabel={mainLabel}
              compressorLabel={compressorLabel}
              mcpCount={rt.mcp.names().length}
              isFocused={isFocused("sidebar")}
              cols={cols}
            />
          </Box>
        ) : null}

        <Box flexGrow={1} flexDirection="column">
          {/* Static items - persistent rendering */}
          <Box flexGrow={1} flexDirection="column">
            <ChatStream
              items={items}
              liveText={liveText}
              thinking={thinking && !liveText}
              mainLabel={mainLabel}
              height={chatHeight}
              isFocused={isFocused("chat")}
            />
          </Box>

          {/* Permission prompt overlay */}
          {permReq ? (
            <PermissionPrompt
              req={permReq.req}
              onDecision={(d) => {
                permReq.resolve(d);
                setPermReq(null);
                focusPane("input");
              }}
            />
          ) : null}

          {/* Input bar */}
          {overlay === "none" && !needsOnboarding ? (
            <InputBar
              value={inputValue}
              onChange={(v) => { setInputValue(v); inputValueRef.current = v; }}
              onSubmit={onSubmit}
              disabled={busy || !!permReq}
              history={history}
              placeholder={busy ? "working… Esc cancel" : "ask anything · /help · \\ + Enter newline"}
              cavemanLevel={rt.cfg.caveman.level !== "off" ? rt.cfg.caveman.level : undefined}
              isFocused={isFocused("input")}
            />
          ) : null}

          {/* Status bar */}
          <StatusBar
            mainLabel={mainLabel}
            cavemanLevel={rt.cfg.caveman.level}
            stats={s}
            isFocused={false}
          />
        </Box>

        {/* Right context panel */}
        {cols >= 90 && !needsOnboarding && overlay !== "setup" ? (
          <Box width={Math.max(18, Math.floor(cols * 0.18))} flexShrink={0}>
            <ContextPanel
              cwd={rt.cwd}
              stats={s}
              isFocused={isFocused("context")}
            />
          </Box>
        ) : null}
      </Box>

      {/* Model picker overlay */}
      {overlay === "model" ? (
        <Box flexDirection="column" borderStyle="round" borderColor="#69b7ff" paddingX={1} marginY={1}>
          <Text bold color="#69b7ff">Pick main model (Enter to select):</Text>
          <Select
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
              focusPane("input");
            }}
          />
        </Box>
      ) : null}

      {/* Onboarding overlay */}
      {overlay === "setup" || needsOnboarding ? (
        <Box flexDirection="column" borderStyle="round" borderColor="#f4b942" paddingX={2} paddingY={1} marginY={1}>
          <Onboarding
            onDone={() => {
              rt.reload();
              agent.rebuildSystem();
              setOverlay("none");
              setNeedsOnboarding(false);
              pushItem({ kind: "notice", text: `Setup complete — main: ${rt.cfg.main?.provider}/${rt.cfg.main?.model} · compressor: ${rt.cfg.compressor?.model}. Go.` });
              focusPane("input");
            }}
          />
        </Box>
      ) : null}

      {/* Welcome overlay */}
      {overlay === "welcome" && !needsOnboarding ? (
        <WelcomeScreen />
      ) : null}
    </Box>
  );
}

export { HELP_TEXT };