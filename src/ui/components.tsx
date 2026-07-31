// Shared Ink components: markdown-ish rendering, tool views, input, spinner, select.

import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import type { Theme } from "../themes.js";
import type { PermissionDecision, PermissionRequest, ToolCall } from "../types.js";

// ---------------- Markdown-lite ----------------

function Inline({ text, codeColor }: { text: string; codeColor?: string }): React.ReactElement {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g);
  return (
    <Text wrap="wrap">
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <Text key={i} bold>{p.slice(2, -2)}</Text>;
        if (p.startsWith("`") && p.endsWith("`")) return <Text key={i} color={codeColor ?? "yellow"}>{p.slice(1, -1)}</Text>;
        if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <Text key={i} italic>{p.slice(1, -1)}</Text>;
        return <Text key={i}>{p}</Text>;
      })}
    </Text>
  );
}

export function Markdown({ text, theme }: { text: string; theme?: Theme }): React.ReactElement {
  const codeColor = theme?.code ?? "yellow";
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
        <Box key={k++} flexDirection="column" borderStyle="round" borderColor={theme?.border ?? "gray"} paddingX={1} marginY={0}>
          {lang ? <Text color={theme?.muted ?? undefined} dimColor={!theme?.muted}>{lang}</Text> : null}
          <Text color={codeColor}>{code.join("\n")}</Text>
        </Box>,
      );
      continue;
    }
    const header = line.match(/^(#{1,6})\s+(.*)$/);
    if (header) {
      blocks.push(<Text key={k++} bold color={theme?.accent ?? "yellow"}>{header[2]}</Text>);
      i++;
      continue;
    }
    const list = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (list) {
      blocks.push(
        <Box key={k++} flexDirection="row">
          <Text>{list[1]}{list[2]} </Text>
          <Inline text={list[3]} codeColor={codeColor} />
        </Box>,
      );
      i++;
      continue;
    }
    blocks.push(<Inline key={k++} text={line} codeColor={codeColor} />);
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

// ---- line estimation for the scrollable chat viewport ----
// Deliberately conservative (overestimates): the viewport windows items by
// estimated height, so rounding up can only show fewer items, never overflow.

/** Estimated rendered lines for a string of `len` visible chars wrapped at `width`. */
export function wrapEstimate(len: number, width: number): number {
  const w = Math.max(8, width);
  return Math.max(1, Math.ceil(Math.max(1, len) / w));
}

/** Estimated rendered lines for plain (possibly multi-line) text. */
export function plainTextLines(text: string, width: number): number {
  return text.split("\n").reduce((n, line) => n + wrapEstimate(line.length, width), 0);
}

/** Estimated rendered lines for Markdown-rendered text (mirrors Markdown blocks). */
export function estimateMarkdownLines(text: string, width: number): number {
  const lines = text.split("\n");
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      let codeLines = 0;
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines += wrapEstimate(lines[i].length, Math.max(8, width - 4));
        i++;
      }
      i++;
      n += 2 + (lang ? 1 : 0) + Math.max(1, codeLines);
      continue;
    }
    n += wrapEstimate(line.length, width);
    i++;
  }
  return n;
}

/** Estimated rendered height of a chat item in lines. */
export function estimateItemLines(item: ChatItem, width: number): number {
  switch (item.kind) {
    case "user":
      return 1 + plainTextLines(item.text ?? "", Math.max(8, width - 2)); // marginTop + "> " prefix
    case "assistant":
      return 1 + estimateMarkdownLines(item.text ?? "", width);
    case "tool": {
      let n = 1;
      if (!item.running && item.result?.startsWith("Error")) {
        n += Math.min(4, item.result.split("\n").length);
      }
      return n;
    }
    case "subagent":
      return plainTextLines(`⏺ sub-agent ${item.text?.slice(0, 90) ?? ""}`, width);
    case "notice":
      return plainTextLines(item.text ?? "", Math.max(8, width - 2));
    case "error":
      return plainTextLines(item.text ?? "", Math.max(8, width - 2));
  }
}

/**
 * Keep the last lines of `text` that fit `budget` rendered lines, prefixed
 * with an ellipsis marker when truncated. Used for viewport-overflowing
 * items and for long streaming text, so the rendered tree never exceeds the
 * terminal height.
 */
export function tailFitText(text: string, width: number, budget: number, markdown: boolean): string {
  const lines = text.split("\n");
  // markdown fences add border lines; keep 2 lines of headroom for them
  const room = Math.max(1, budget - (markdown ? 2 : 0));
  let used = 0;
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = wrapEstimate(lines[i].length, width);
    if (used + l > room) break;
    used += l;
    n++;
  }
  if (n >= lines.length) return text;
  const kept = Math.max(1, n - 1); // 1 line for the ellipsis marker
  return "…\n" + lines.slice(-kept).join("\n");
}

export function ItemView({ item, theme }: { item: ChatItem; theme?: Theme }): React.ReactElement {
  const accent = theme?.accent ?? "yellow";
  const success = theme?.success ?? "green";
  const error = theme?.error ?? "red";
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text bold color={accent}>{"> "}</Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Markdown text={item.text ?? ""} theme={theme} />
        </Box>
      );
    case "tool": {
      const c = item.call;
      const keyArg = c ? String(c.args?.command ?? c.args?.path ?? c.args?.query ?? c.args?.task ?? c.args?.url ?? c.args?.name ?? "").slice(0, 70) : "";
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={accent}>⏺ </Text>
            <Text bold color={accent}>{c?.name}</Text>
            {keyArg ? <Text dimColor> {keyArg}</Text> : null}
            {item.running ? <Text color={accent}> …</Text> : <Text color={success}> ✓</Text>}
            {item.ms !== undefined && !item.running ? <Text dimColor> {(item.ms / 1000).toFixed(1)}s</Text> : null}
          </Text>
          {!item.running && item.result?.startsWith("Error") ? <Text color={error}>  {item.result.split("\n").slice(0, 4).join("\n  ")}</Text> : null}
        </Box>
      );
    }
    case "subagent":
      return (
        <Text>
          <Text color={accent}>⏺ sub-agent </Text>
          <Text dimColor>{item.text?.slice(0, 90)}</Text>
          {item.running ? <Text color={accent}> …</Text> : <Text color={success}> ✓</Text>}
        </Text>
      );
    case "notice":
      return <Text dimColor>  {item.text}</Text>;
    case "error":
      return <Text color={error}>✖ {item.text}</Text>;
  }
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
    <Box borderStyle="single" borderColor={props.theme.border} paddingX={1} justifyContent="space-between" flexShrink={0}>
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

export function Spinner({ label, color }: { label?: string; color?: string }): React.ReactElement {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((x) => (x + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text>
      <Text color={color ?? "yellow"}>{FRAMES[f]}</Text>
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
  // Mirror value/histIdx in refs: Ink drains all buffered keystrokes in one
  // batch, so handlers firing in the same tick would otherwise see stale
  // state and drop the last typed characters on submit.
  const valueRef = useRef("");
  const histIdxRef = useRef(-1);
  const setVal = (v: string | ((prev: string) => string)) => {
    const next = typeof v === "function" ? v(valueRef.current) : v;
    valueRef.current = next;
    setValue(next);
  };
  const setHist = (i: number) => {
    histIdxRef.current = i;
    setHistIdx(i);
  };

  useInput(
    (input, key) => {
      if (props.disabled) return;
      if (key.return) {
        const current = valueRef.current;
        if (current.endsWith("\\")) {
          setVal(current.slice(0, -1) + "\n");
          return;
        }
        const t = current.trim();
        if (t) props.onSubmit(t);
        setVal("");
        setHist(-1);
        return;
      }
      if (key.backspace || key.delete) {
        setVal((v) => v.slice(0, -1));
        return;
      }
      if (key.upArrow) {
        const h = props.history;
        if (!h.length) return;
        const idx = histIdxRef.current < 0 ? h.length - 1 : Math.max(0, histIdxRef.current - 1);
        setHist(idx);
        setVal(h[idx]);
        return;
      }
      if (key.downArrow) {
        if (histIdxRef.current < 0) return;
        const idx = histIdxRef.current + 1;
        if (idx >= props.history.length) {
          setHist(-1);
          setVal("");
        } else {
          setHist(idx);
          setVal(props.history[idx]);
        }
        return;
      }
      if (key.escape) {
        setVal("");
        setHist(-1);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setVal((v) => v + input.replace(/\r/g, "\n"));
      }
    },
    { isActive: !props.disabled },
  );

  const display = value || props.placeholder || "";
  return (
    <Box borderStyle="round" borderColor={props.accent ?? "gray"} paddingX={1}>
      <Text bold color={props.accent ?? "yellow"}>{"❯ "}</Text>
      <Text wrap="wrap" dimColor={!value}>{display}</Text>
      <Text color={props.accent ?? "yellow"}>▌</Text>
    </Box>
  );
}

// ---------------- Select ----------------

export function Select(props: {
  items: { label: string; value: string; hint?: string }[];
  onSelect: (value: string) => void;
  limit?: number;
  accent?: string;
}): React.ReactElement {
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(0);
  const setIdxBoth = (v: number | ((prev: number) => number)) => {
    const next = typeof v === "function" ? v(idxRef.current) : v;
    idxRef.current = next;
    setIdx(next);
  };
  useInput((input, key) => {
    if (key.upArrow) setIdxBoth((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdxBoth((i) => Math.min(props.items.length - 1, i + 1));
    else if (key.return) props.onSelect(props.items[idxRef.current]?.value);
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
        <Text key={it.value} color={start + i === idx ? (props.accent ?? "yellow") : undefined} bold={start + i === idx}>
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
  accent?: string;
}): React.ReactElement {
  const [value, setValue] = useState(props.defaultValue ?? "");
  const valueRef = useRef(props.defaultValue ?? "");
  const setVal = (v: string | ((prev: string) => string)) => {
    const next = typeof v === "function" ? v(valueRef.current) : v;
    valueRef.current = next;
    setValue(next);
  };
  useInput((input, key) => {
    if (key.return) {
      const current = valueRef.current;
      if (!current.trim() && !props.allowEmpty) return;
      props.onSubmit(current.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setVal((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) setVal((v) => v + input);
  });
  return (
    <Box>
      <Text bold>{props.label}: </Text>
      <Text>{props.mask ? "•".repeat(value.length) : value}</Text>
      <Text color={props.accent ?? "green"}>▌</Text>
    </Box>
  );
}

// ---------------- Permission prompt ----------------

export function PermissionPrompt(props: { req: PermissionRequest; onDecision: (d: PermissionDecision) => void; theme?: Theme }): React.ReactElement {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === "y") props.onDecision("once");
    else if (c === "a" && props.req.kind === "shell") props.onDecision("always");
    else if (c === "n" || key.escape) props.onDecision("deny");
  });
  const accent = props.theme?.accent ?? "yellow";
  const success = props.theme?.success ?? "green";
  const error = props.theme?.error ?? "red";
  const detail = props.req.detail ?? "";
  const lines = detail.split("\n").slice(0, 14);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Text bold color={accent}>Permission: {props.req.label}</Text>
      {detail ? (
        <Box flexDirection="column">
          {lines.map((l, i) => (
            <Text key={i} color={l.startsWith("+") ? success : l.startsWith("-") ? error : undefined} dimColor={!l.startsWith("+") && !l.startsWith("-")}>
              {l.slice(0, 200)}
            </Text>
          ))}
          {detail.split("\n").length > 14 ? <Text dimColor>  …</Text> : null}
        </Box>
      ) : null}
      <Text>
        <Text bold color={success}>[y]</Text> allow once{"  "}
        {props.req.kind === "shell" ? (<><Text bold color={accent}>[a]</Text> always allow this command{"  "}</>) : null}
        <Text bold color={error}>[n]</Text> deny
      </Text>
    </Box>
  );
}
