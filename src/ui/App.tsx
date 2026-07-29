// Main TUI application.

import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useMemo, useRef, useState } from "react";
import { addLifetime } from "../caveman.js";
import { checkForUpdate, configExists } from "../config.js";
import { Agent } from "../core/agent.js";
import { handleSlash, HELP_TEXT, type CommandIO } from "../core/commands.js";
import type { Runtime } from "../core/runtime.js";
import { listAllModels } from "../providers/registry.js";
import { fmtTokens } from "../tokens.js";
import type { ModelRef, PermissionDecision } from "../types.js";
import { ChatInput, CubeEyes, ItemView, Markdown, PermissionPrompt, Select, Spinner, type ChatItem } from "./components.js";
import { Onboarding } from "./Onboarding.js";

type Overlay = "none" | "model" | "setup";

export function App(props: { rt: Runtime; forceSetup?: boolean }): React.ReactElement {
  const { exit } = useApp();
  const rt = props.rt;

  const [items, setItems] = useState<ChatItem[]>([]);
  const [liveText, setLiveText] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(props.forceSetup ? "setup" : "none");
  const [needsOnboarding, setNeedsOnboarding] = useState(!configExists() && !props.forceSetup);
  const [permReq, setPermReq] = useState<{ req: any; resolve: (d: PermissionDecision) => void } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [statsTick, setStatsTick] = useState(0);

  React.useEffect(() => {
    checkForUpdate().then((latest) => {
      if (!latest) return;
      const cur = "1.1.0";
      if (latest.localeCompare(cur, undefined, { numeric: true, sensitivity: "base" }) === 1) {
        pushItem({ kind: "notice", text: `Update available: ${cur} → ${latest} — run npm install -g eaon-agent@latest` });
      }
    });
  }, []);

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
        setBusy(true);
        setThinking(true);
      },
      onText: (t) => {
        setThinking(false);
        liveRef.current += t;
        setLiveText(liveRef.current);
        setStatsTick((x) => x + 1);
      },
      onToolStart: (call) => {
        setThinking(false);
        flushLive();
        pushItem({ kind: "tool", call, running: true });
      },
      onToolEnd: (call, result, ms) => {
        const it = [...itemsRef.current].reverse().find((x) => x.kind === "tool" && x.call?.id === call.id);
        if (it) updateItem(it.id, { result, ms, running: false });
        setStatsTick((x) => x + 1);
      },
      onNotice: (text) => pushItem({ kind: "notice", text }),
      onError: (text) => {
        flushLive();
        pushItem({ kind: "error", text });
      },
      onCompression: (removed, before, after) =>
        pushItem({ kind: "notice", text: `⚡ context compressed: ${removed} msgs, ~${fmtTokens(before)} → ~${fmtTokens(after)} tokens (compressor model)` }),
      onSubagentStart: (task, model) => {
        flushLive();
        subagentItemRef.current = pushItem({ kind: "subagent", text: `${model} — ${task}`, running: true });
      },
      onSubagentEnd: () => {
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
        text: `Eaon Agent v1.1.0 — main: ${m ? `${m.provider}/${m.model}` : "not configured"} · compressor: ${rt.cfg.compressor?.model ?? "off"} · ⛏ ${rt.cfg.caveman.level} · /help for commands`,
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
    if (key.ctrl && input === "c") doExit();
  });

  const runAgent = async (prompt: string) => {
    setBusy(true);
    try {
      await agent.run(prompt);
    } catch {
      // error already surfaced via onError
    } finally {
      flushLive();
      setBusy(false);
      setThinking(false);
      setStatsTick((x) => x + 1);
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
    <Box flexDirection="column">
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
          <CubeEyes />
        </Box>
      ) : null}
    </Box>
  );
}

export { HELP_TEXT };
