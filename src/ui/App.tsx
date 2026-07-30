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
  MessageViewport,
  PermissionPrompt,
  Select,
  SessionHeader,
  StatusBar,
  WelcomeScreen,
  WorkspaceRail,
  type ChatItem,
} from "./components.js";
import { Onboarding } from "./Onboarding.js";

type Overlay = "none" | "model" | "setup" | "welcome";

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
  const cancelledRef = useRef(false);

  const idRef = useRef(1);
  const liveRef = useRef("");
  const itemsRef = useRef<ChatItem[]>([]);
  const subagentItemRef = useRef<number | null>(null);
  const modelResolverRef = useRef<((m: ModelRef | null) => void) | null>(null);

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

  return (
    <Box flexDirection="column" width={terminalSize.columns} minHeight={terminalSize.rows} height={overlay === "welcome" ? undefined : terminalSize.rows} paddingX={1}>
      <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between">
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

          <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingLeft={showRail ? 1 : 0}>
            <SessionHeader theme={theme} workspace={workspace} mainLabel={mainLabel} />
            <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
              <MessageViewport
                items={items}
                liveText={liveText}
                thinking={thinking}
                mainLabel={mainLabel}
                height={Math.max(4, terminalSize.rows - (overlay === "none" && !needsOnboarding ? 14 : 7))}
                width={Math.max(20, terminalSize.columns - (showRail ? 30 : 4))}
              />
              <Box flexGrow={1} />

              {overlay === "model" ? (
                <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
                  <Text bold>Pick main model (Enter to select):</Text>
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
                    }}
                  />
                </Box>
              ) : null}

              {overlay === "setup" || needsOnboarding ? (
                <Onboarding
                  onDone={() => {
                    rt.reload();
                    agent.rebuildSystem();
                    setOverlay("none");
                    setNeedsOnboarding(false);
                    pushItem({ kind: "notice", text: `Setup complete — main: ${rt.cfg.main?.provider}/${rt.cfg.main?.model} · compressor: ${rt.cfg.compressor?.model}. Go.` });
                  }}
                />
              ) : null}
            </Box>

            {permReq ? (
              <PermissionPrompt
                req={permReq.req}
                onDecision={(d) => {
                  permReq.resolve(d);
                  setPermReq(null);
                }}
              />
            ) : null}

            {overlay === "none" && !needsOnboarding ? (
              <Box flexDirection="column" marginTop={1}>
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
          </Box>
        </Box>
      )}
    </Box>
  );
}

export { HELP_TEXT };
