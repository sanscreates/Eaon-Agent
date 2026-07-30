// Shared Ink components: markdown-ish rendering, tool views, input, spinner, select.

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import type { Theme } from "../themes.js";
import type { PermissionDecision, PermissionRequest, ToolCall } from "../types.js";

// ---------------- Markdown-lite ----------------

function Inline({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g);
  return (
    <Text wrap="wrap">
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <Text key={i} bold>{p.slice(2, -2)}</Text>;
        if (p.startsWith("`") && p.endsWith("`")) return <Text key={i} color="yellow">{p.slice(1, -1)}</Text>;
        if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <Text key={i} italic>{p.slice(1, -1)}</Text>;
        return <Text key={i}>{p}</Text>;
      })}
    </Text>
  );
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const blocks: React.ReactElement[] = [];
  const lines = text.split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <Box key={k++} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={0}>
          {lang ? <Text dimColor>{lang}</Text> : null}
          <Text color="yellow">{code.join("\n")}</Text>
        </Box>,
      );
      continue;
    }
    const header = line.match(/^(#{1,6})\s+(.*)$/);
    if (header) {
      blocks.push(<Text key={k++} bold color="yellow">{header[2]}</Text>);
      i++;
      continue;
    }
    const list = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (list) {
      blocks.push(
        <Box key={k++} flexDirection="row">
          <Text>{list[1]}{list[2]} </Text>
          <Inline text={list[3]} />
        </Box>,
      );
      i++;
      continue;
    }
    blocks.push(<Inline key={k++} text={line} />);
    i++;
  }
  return <Box flexDirection="column">{blocks}</Box>;
}

// ---------------- Chat items ----------------

export type ItemKind = "user" | "assistant" | "tool" | "notice" | "error" | "subagent";

export interface ChatItem {
  id: number;
  kind: ItemKind;
  text?: string;
  call?: ToolCall;
  result?: string;
  ms?: number;
  running?: boolean;
  detail?: string;
}

export function ItemView({ item }: { item: ChatItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text bold color="yellow">{"> "}</Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Markdown text={item.text ?? ""} />
        </Box>
      );
    case "tool": {
      const c = item.call;
      const keyArg = c ? String(c.args?.command ?? c.args?.path ?? c.args?.query ?? c.args?.task ?? c.args?.url ?? c.args?.name ?? "").slice(0, 70) : "";
      return (
        <Box flexDirection="column">
          <Text>
            <Text color="yellow">⏺ </Text>
            <Text bold color="yellow">{c?.name}</Text>
            {keyArg ? <Text dimColor> {keyArg}</Text> : null}
            {item.running ? <Text color="yellow"> …</Text> : <Text color="green"> ✓</Text>}
            {item.ms !== undefined && !item.running ? <Text dimColor> {(item.ms / 1000).toFixed(1)}s</Text> : null}
          </Text>
          {!item.running && item.result?.startsWith("Error") ? <Text color="red">  {item.result.split("\n").slice(0, 4).join("\n  ")}</Text> : null}
        </Box>
      );
    }
    case "subagent":
      return (
        <Text>
          <Text color="yellow">⏺ sub-agent </Text>
          <Text dimColor>{item.text?.slice(0, 90)}</Text>
          {item.running ? <Text color="yellow"> …</Text> : <Text color="green"> ✓</Text>}
        </Text>
      );
    case "notice":
      return <Text dimColor>  {item.text}</Text>;
    case "error":
      return <Text color="red">✖ {item.text}</Text>;
  }
}

function wrappedRows(text: string, width: number): number {
  const lineWidth = Math.max(1, width);
  return text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / lineWidth)), 0);
}

function itemRows(item: ChatItem, width: number): number {
  const margin = item.kind === "user" || item.kind === "assistant" ? 1 : 0;
  if (item.kind === "assistant") return margin + wrappedRows(item.text ?? "", width);
  if (item.kind === "notice" || item.kind === "error") return margin + wrappedRows(item.text ?? "", width);
  if (item.kind === "subagent") return margin + 1;
  if (item.kind === "tool" && !item.running && item.result?.startsWith("Error")) return 2;
  return 1;
}

interface MessageSegment {
  key: string;
  rows: number;
  view: React.ReactElement;
}

/**
 * A fixed-height chat viewport. Ink clips overflowing children but does not
 * provide a scroll container, so this component chooses the visible message
 * window and keeps PageUp/PageDown scoped to the conversation.
 */
export function MessageViewport(props: {
  items: ChatItem[];
  liveText: string;
  thinking: boolean;
  mainLabel: string;
  height: number;
  width: number;
}): React.ReactElement {
  const contentHeight = Math.max(2, props.height - 1);
  const segments: MessageSegment[] = props.items.map((item) => ({
    key: `item-${item.id}`,
    rows: itemRows(item, props.width),
    view: <ItemView key={item.id} item={item} />,
  }));

  if (props.liveText) {
    segments.push({
      key: "live",
      rows: wrappedRows(props.liveText, props.width),
      view: <Box key="live" marginTop={1} flexDirection="column"><Markdown text={props.liveText} /></Box>,
    });
  } else if (props.thinking) {
    segments.push({ key: "thinking", rows: 1, view: <Spinner key="thinking" label={`${props.mainLabel} thinking…`} /> });
  }

  const totalRows = segments.reduce((rows, segment) => rows + segment.rows, 0);
  const maxScroll = Math.max(0, totalRows - contentHeight);
  const [scrollFromBottom, setScrollFromBottom] = useState(0);

  useEffect(() => {
    // New messages should follow the live conversation at the bottom.
    setScrollFromBottom(0);
  }, [props.items.length]);

  useEffect(() => {
    setScrollFromBottom((value) => Math.min(value, maxScroll));
  }, [maxScroll]);

  useInput((_, key) => {
    const page = Math.max(1, contentHeight - 1);
    if (key.pageUp) setScrollFromBottom((value) => Math.min(maxScroll, value + page));
    if (key.pageDown) setScrollFromBottom((value) => Math.max(0, value - page));
  });

  let end = segments.length;
  let skipRows = Math.min(scrollFromBottom, maxScroll);
  while (end > 0 && skipRows >= segments[end - 1].rows) {
    skipRows -= segments[end - 1].rows;
    end--;
  }

  let start = end;
  let visibleRows = 0;
  while (start > 0 && visibleRows + segments[start - 1].rows <= contentHeight) {
    visibleRows += segments[start - 1].rows;
    start--;
  }
  // Keep an oversized latest message in the viewport so it can be clipped
  // rather than rendering an empty pane.
  if (start === end && end > 0) start = end - 1;

  const visible = segments.slice(start, end);
  const indicator = maxScroll > 0
    ? scrollFromBottom > 0
      ? "PgUp older  ·  PgDn newer"
      : "PgUp scroll messages  ·  at latest"
    : "";

  return (
    <Box flexDirection="column" height={Math.max(3, props.height)} overflow="hidden" flexShrink={0}>
      <Box flexDirection="column" height={contentHeight} overflowY="hidden" justifyContent={scrollFromBottom === 0 ? "flex-end" : "flex-start"}>
        <Box flexDirection="column">
          {visible.map((segment) => segment.view)}
        </Box>
      </Box>
      <Box height={1} justifyContent="flex-end">
        <Text dimColor>{indicator}</Text>
      </Box>
    </Box>
  );
}

// ---------------- Welcome screen ----------------

const ML_QUOTES = [
  "Any sufficiently advanced technology is indistinguishable from magic. — Arthur C. Clarke",
  "The question of whether a computer can think is no more interesting than the question of whether a submarine can swim. — Edsger Dijkstra",
  "We are approaching a time when machines will be able to outperform humans at almost any task. — Geoffrey Hinton",
  "The development of full artificial intelligence could spell the end of the human race. — Stephen Hawking",
  "Machine learning is the future, and the future is here. — Fei-Fei Li",
  "The biggest risk is not taking any risk. In a world thats changing really quickly, the only strategy that is guaranteed to fail is not taking risks. — Mark Zuckerberg",
  "Artificial intelligence is the new electricity. — Andrew Ng",
  "If you think AI is smart, you havent met a human yet. — unknown",
  "The first rule of any technology used in a business is that automation applied to an efficient operation will magnify the efficiency. — Bill Gates",
  "The real problem is not whether machines think, but whether men do. — B.F. Skinner",
  "I think we should be very careful about artificial intelligence. If I had to guess at what our biggest existential threat is, it is probably that. — Elon Musk",
  "The question is not whether intelligent machines can have any emotions, but whether machines can be intelligent without any emotions. — Marvin Minsky",
];

function pickRandomQuote(): string {
  return ML_QUOTES[Math.floor(Math.random() * ML_QUOTES.length)];
}

export function WelcomeScreen(props: {
  theme?: Theme;
  workspace?: string;
  mainLabel?: string;
  terminalRows?: number;
}): React.ReactElement {
  const [quote] = useState(pickRandomQuote);
  const theme = props.theme;

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
      minHeight={Math.max(12, (props.terminalRows ?? 24) - 2)}
      paddingX={2}
    >
      <Text bold color={theme?.accent ?? "yellow"}>EAON</Text>
      <Text dimColor>agentic coding, in your terminal</Text>
      <Text> </Text>
      <Box flexDirection="column" alignItems="center" borderStyle="round" borderColor={theme?.border ?? "yellow"} paddingX={3} paddingY={1}>
        <Text bold color={theme?.accent ?? "yellow"}>Welcome back</Text>
        <Text>{props.workspace ?? "current workspace"}</Text>
        {props.mainLabel ? <Text dimColor>{props.mainLabel}</Text> : null}
        <Text> </Text>
        <Text color={theme?.accent ?? "yellow"}>{quote}</Text>
      </Box>
      <Text> </Text>
      <Text dimColor>Enter start  ·  S setup  ·  Ctrl+C quit</Text>
    </Box>
  );
}

export function WorkspaceRail(props: {
  theme: Theme;
  workspace: string;
  mainLabel: string;
  permissionMode: string;
  cavemanLevel: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width={25} minHeight={1} borderStyle="single" borderColor={props.theme.border} paddingX={1}>
      <Text bold color={props.theme.accent}>WORKSPACE</Text>
      <Text> </Text>
      <Text color={props.theme.accent}>◆ {props.workspace}</Text>
      <Text dimColor>  current session</Text>
      <Text> </Text>
      <Text bold>SESSION</Text>
      <Text color={props.theme.accent}>  ◉ New session</Text>
      <Text dimColor>  /clear  reset context</Text>
      <Text dimColor>  /stats  token usage</Text>
      <Text dimColor>  /help   commands</Text>
      <Box flexGrow={1} />
      <Text bold>RUNTIME</Text>
      <Text dimColor>  model       {props.mainLabel}</Text>
      <Text dimColor>  permissions {props.permissionMode}</Text>
      <Text dimColor>  caveman     {props.cavemanLevel}</Text>
    </Box>
  );
}

export function SessionHeader(props: { theme: Theme; workspace: string; mainLabel: string }): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor={props.theme.border} paddingX={1} justifyContent="space-between">
      <Text bold color={props.theme.accent}>NEW SESSION</Text>
      <Text dimColor>{props.workspace} · {props.mainLabel}</Text>
    </Box>
  );
}

export function StatusBar(props: { theme: Theme; text: string }): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor={props.theme.border} paddingX={1}>
      <Text color={props.theme.accent}>● </Text>
      <Text dimColor>{props.text}</Text>
    </Box>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label }: { label?: string }): React.ReactElement {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((x) => (x + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text>
      <Text color="yellow">{FRAMES[f]}</Text>
      {label ? <Text dimColor> {label}</Text> : null}
    </Text>
  );
}

// ---------------- Input ----------------

export function ChatInput(props: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  history: string[];
  placeholder?: string;
  accent?: string;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [histIdx, setHistIdx] = useState(-1);

  useInput(
    (input, key) => {
      if (props.disabled) return;
      if (key.return) {
        if (value.endsWith("\\")) {
          setValue(value.slice(0, -1) + "\n");
          return;
        }
        const t = value.trim();
        if (t) props.onSubmit(t);
        setValue("");
        setHistIdx(-1);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (key.upArrow) {
        const h = props.history;
        if (!h.length) return;
        const idx = histIdx < 0 ? h.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(idx);
        setValue(h[idx]);
        return;
      }
      if (key.downArrow) {
        if (histIdx < 0) return;
        const idx = histIdx + 1;
        if (idx >= props.history.length) {
          setHistIdx(-1);
          setValue("");
        } else {
          setHistIdx(idx);
          setValue(props.history[idx]);
        }
        return;
      }
      if (key.escape) {
        setValue("");
        setHistIdx(-1);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setValue((v) => v + input.replace(/\r/g, "\n"));
      }
    },
    { isActive: !props.disabled },
  );

  const display = value || props.placeholder || "";
  return (
    <Box borderStyle="round" borderColor={props.accent ?? "gray"} paddingX={1}>
      <Text bold color={props.accent ?? "yellow"}>{"❯ "}</Text>
      <Text wrap="wrap" dimColor={!value}>{display}</Text>
      <Text color="yellow">▌</Text>
    </Box>
  );
}

// ---------------- Select ----------------

export function Select(props: {
  items: { label: string; value: string; hint?: string }[];
  onSelect: (value: string) => void;
  limit?: number;
}): React.ReactElement {
  const [idx, setIdx] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(props.items.length - 1, i + 1));
    else if (key.return) props.onSelect(props.items[idx]?.value);
    else if (input) {
      const n = parseInt(input, 10);
      if (!isNaN(n) && n >= 1 && n <= props.items.length) props.onSelect(props.items[n - 1].value);
    }
  });
  const limit = props.limit ?? 12;
  const start = Math.max(0, Math.min(idx - Math.floor(limit / 2), props.items.length - limit));
  const visible = props.items.slice(start, start + limit);
  return (
    <Box flexDirection="column">
      {visible.map((it, i) => (
        <Text key={it.value} color={start + i === idx ? "yellow" : undefined} bold={start + i === idx}>
          {start + i === idx ? "❯ " : "  "}
          {it.label}
          {it.hint ? <Text dimColor>  {it.hint}</Text> : null}
        </Text>
      ))}
      {props.items.length > limit ? <Text dimColor>  ({idx + 1}/{props.items.length})</Text> : null}
    </Box>
  );
}

// ---------------- Text field (single line) ----------------

export function TextField(props: {
  label: string;
  defaultValue?: string;
  mask?: boolean;
  onSubmit: (value: string) => void;
  allowEmpty?: boolean;
}): React.ReactElement {
  const [value, setValue] = useState(props.defaultValue ?? "");
  useInput((input, key) => {
    if (key.return) {
      if (!value.trim() && !props.allowEmpty) return;
      props.onSubmit(value.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
  });
  return (
    <Box>
      <Text bold>{props.label}: </Text>
      <Text>{props.mask ? "•".repeat(value.length) : value}</Text>
      <Text color="green">▌</Text>
    </Box>
  );
}

// ---------------- Permission prompt ----------------

export function PermissionPrompt(props: { req: PermissionRequest; onDecision: (d: PermissionDecision) => void }): React.ReactElement {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === "y") props.onDecision("once");
    else if (c === "a" && props.req.kind === "shell") props.onDecision("always");
    else if (c === "n" || key.escape) props.onDecision("deny");
  });
  const detail = props.req.detail ?? "";
  const lines = detail.split("\n").slice(0, 14);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Permission: {props.req.label}</Text>
      {detail ? (
        <Box flexDirection="column">
          {lines.map((l, i) => (
            <Text key={i} color={l.startsWith("+") ? "green" : l.startsWith("-") ? "red" : undefined} dimColor={!l.startsWith("+") && !l.startsWith("-")}>
              {l.slice(0, 200)}
            </Text>
          ))}
          {detail.split("\n").length > 14 ? <Text dimColor>  …</Text> : null}
        </Box>
      ) : null}
      <Text>
        <Text bold color="green">[y]</Text> allow once{"  "}
        {props.req.kind === "shell" ? (<><Text bold color="cyan">[a]</Text> always allow this command{"  "}</>) : null}
        <Text bold color="red">[n]</Text> deny
      </Text>
    </Box>
  );
}
