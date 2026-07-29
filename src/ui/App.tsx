// Main TUI application.

import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useMemo, useRef, useState } from "react";
import { addLifetime } from "../caveman.js";
import { configExists } from "../config.js";
import { Agent } from "../core/agent.js";
import { handleSlash, HELP_TEXT, type CommandIO } from "../core/commands.js";
import type { Runtime } from "../core/runtime.js";
import { listAllModels } from "../providers/registry.js";
import { fmtTokens } from "../tokens.js";
import type { ModelRef, PermissionDecision } from "../types.js";
import { ChatInput, ItemView, Markdown, PermissionPrompt, Select, Spinner, WelcomeScreen, type ChatItem } from "./components.js";
import { Onboarding } from "./Onboarding.js";

type Overlay = "none" | "model" | "setup" | "welcome" | "themes";

export function App(props: { rt: Runtime; forceSetup?: boolean }): React.ReactElement {
  const { exit } = useApp();
  const rt = props.rt;

  const [items, setItems] = useState<ChatItem[]>([]);
  const [liveText, setLiveText] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(props.forceSetup ? "setup" : (configExists() ? "welcome" : "none"));
  const [needsOnboarding, setNeedsOnboarding] = useState(!configExists() && !props.forceSetup);
  const [welcomeDone, setWelcomeDone] = useState(false);
  const [permReq, setPermReq] = useState<{ req: any; resolve: (d: PermissionDecision) => void } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [statsTick, setStatsTick] = useState(0);
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
        text: `Eaon Agent v1.2.0 — main: ${m ? `${m.provider}/${m.model}` : "not configured"} · compressor: ${rt.cfg.compressor?.model ?? "off"} · ⛏ ${rt.cfg.caveman.level} · /help for commands`,
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

  useInput((input, key) => {
    if (key.ctrl && input === "c") { doExit(); return; }
    if (overlay === "welcome" && key.return) { setWelcomeDone(true); setOverlay("none"); return; }
    if (key.escape && busy) { cancelledRef.current = true; return; }
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
    requestExit: doExit,
  };

  const onSubmit = async (text: string) => {
    if (busy || overlay !== "none" || needsOnboarding) return;
    setHistory((h) => [...h.slice(-99), text]);

    if (text === "/theme") {
      setOverlay("themes");
      return;
    }

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

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={items}>{(it) => <ItemView key={it.id} item={it} />}</Static>

      {liveText ? (
        <Box marginTop={1} flexDirection="column">
          <Markdown text={liveText} />
        </Box>
      ) : null}

      {thinking && !liveText ? <Spinner label={`${mainLabel} thinking…`} /> : null}

      {permReq ? (
        <PermissionPrompt
          req={permReq.req}
          onDecision={(d) => {
            permReq.resolve(d);
            setPermReq(null);
          }}
        />
      ) : null}

      {overlay === "model" ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
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

       {overlay === "none" && !needsOnboarding ? (
         <Box flexDirection="column" marginTop={1}>
           <ChatInput
             onSubmit={onSubmit}
             disabled={busy || !!permReq}
             history={history}
             placeholder={busy ? "working…" : "ask anything · /help · \\ + Enter for newline"}
           />
           <Text dimColor>
             {` ${mainLabel}`}
             {rt.cfg.caveman.level !== "off" ? ` · ⛏ ${rt.cfg.caveman.level}` : ""}
             {rt.cfg.ui.showTokens ? ` · in ${fmtTokens(s.inputTokens)} out ${fmtTokens(s.outputTokens)} · saved ⛏${fmtTokens(saved)}` : ""}
             {rt.permissions.mode !== "confirm" ? ` · [${rt.permissions.mode}]` : ""}
           </Text>
         </Box>
       ) : null}

       {overlay === "welcome" && !needsOnboarding ? (
         <WelcomeScreen />
       ) : null}

       {overlay === "themes" ? (
         <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
           <Text bold>Pick a theme:</Text>
           <Text>  amber   — orange-yellow, warm</Text>
           <Text>  emerald — green, calm</Text>
           <Text>  slate   — gray, subtle</Text>
           <Text>  sky     — blue, cool</Text>
           <Text> </Text>
           <Text dimColor>use /theme &lt;name&gt; to switch</Text>
         </Box>
       ) : null}
     </Box>
   );
 }

export { HELP_TEXT };
