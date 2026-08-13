// Shared Ink components: markdown-ish rendering, tool views, input, spinner, select.

import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { hexToRgb, type Theme } from "../themes.js";
import type { PermissionDecision, PermissionRequest, ToolCall } from "../types.js";
import { isMouseInput, type ClickRegion } from "./mouse.js";

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
      const c = item.call;
      const keyArg = c ? String(c.args?.command ?? c.args?.path ?? c.args?.query ?? c.args?.task ?? c.args?.url ?? c.args?.name ?? "").slice(0, 70) : "";
      // mirror the rendered head line (⏺ name arg ✓ 0.0s) and wrap it —
      // long commands span 2+ lines, and underestimating viewport heights
      // makes the history render as sparse garbage
      let n = wrapEstimate(`⏺ ${c?.name ?? ""} ${keyArg} ✓ 0.0s`.length, width);
      if (!item.running && item.result?.startsWith("Error")) {
        n += item.result
          .split("\n")
          .slice(0, 4)
          .reduce((m, l) => m + wrapEstimate(l.length + 2, width), 0);
      }
      return n;
    }
    case "subagent":
      return plainTextLines(`⏺ sub-agent ${item.text?.slice(0, 90) ?? ""} ✓`, width);
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
          <Text bold color={accent}{"> "}</Text>
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
            <Text color={item.running ? accent : success}>{item.running ? "◌" : "●"} </Text>
            <Text bold color={accent}>{c?.name}</Text>
            {keyArg ? <Text dimColor> {keyArg}</Text> : null}
            {item.running ? <Text color={accent}> …</Text> : null}
            {item.ms !== undefined && !item.running ? <Text dimColor> · {(item.ms / 1000).toFixed(1)}s</Text> : null}
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
  "Machine learning is the future, and the future is here. — Fei-Fei Li",
  "Artificial intelligence is the new electricity. — Andrew Ng",
  "The real problem is not whether machines think, but whether men do. — B.F. Skinner",
  "The question is not whether intelligent machines can have any emotions, but whether machines can be intelligent without any emotions. — Marvin Minsky",
  "Why use many tokens when few do the trick? — Eaon proverb",
];

function pickRandomQuote(): string {
  return ML_QUOTES[Math.floor(Math.random() * ML_QUOTES.length)];
}

const EAON_ART = [
  "███████╗ █████╗  ██████╗ ███╗   ██╗",
  "██╔════╝██╔══██╗██╔═══██╗████╗  ██║",
  "█████╗  ███████║██║   ██║██╔██╗ ██║",
  "██╔══╝  ██╔══██║██║   ██║██║╚██╗██║",
  "███████╗██║  ██║╚██████╔╝██║ ╚████║",
  "╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
];

/** Interpolate between two "#rrggbb" colors; falls back to `a` on bad input. */
function lerpHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  const mix = ca.map((v, i) => Math.round(v + (cb[i] - v) * t)) as [number, number, number];
  return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
}

export type WelcomeAction = "start" | "setup" | "quit";

const WELCOME_BUTTONS: { id: string; label: string; action: WelcomeAction }[] = [
  { id: "welcome-start", label: "⏎ start", action: "start" },
  { id: "welcome-setup", label: "s setup", action: "setup" },
  { id: "welcome-quit", label: "q quit", action: "quit" },
];
const BUTTON_GAP = 2;

/**
 * First-load splash: gradient ASCII logo revealed line by line, a welcome
 * card, clickable buttons, and a quote that types itself out. The layout is
 * fully deterministic (every offset computed from known widths), so the
 * buttons can report exact click regions via onLayout.
 */
export function WelcomeScreen(props: {
  theme?: Theme;
  workspace?: string;
  mainLabel?: string;
  terminalRows?: number;
  columns?: number;
  onAction?: (a: WelcomeAction) => void;
  onLayout?: (rects: ClickRegion[]) => void;
}): React.ReactElement {
  const [quote] = useState(pickRandomQuote);
  const [step, setStep] = useState(0);
  const theme = props.theme;
  const accent = theme?.accent ?? "yellow";
  const muted = theme?.muted ?? "gray";
  const border = theme?.border ?? "yellow";
  const columns = props.columns ?? 80;
  const rows = props.terminalRows ?? 24;

  // Animation clock: art reveal (1 line/tick), then the quote types out.
  const totalSteps = EAON_ART.length + Math.ceil(quote.length / 3) + 4;
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s >= totalSteps ? s : s + 1)), 50);
    return () => clearInterval(t);
  }, [totalSteps]);

  // ---- deterministic layout (needed for click regions) ----
  // The splash must fit exactly under the top bar: on short terminals the
  // ASCII art drops out so nothing ever overflows the fixed root.
  const workspace = props.workspace ?? "current workspace";
  const mainLabel = props.mainLabel ?? "";
  const tagline = "agentic coding, in your terminal";
  const quoteText = quote.length > columns - 16 ? quote.slice(0, Math.max(10, columns - 19)) + "…" : quote;
  const buttonW = WELCOME_BUTTONS.map((b) => b.label.length + 2 /* paddingX */ + 2 /* border */);
  const buttonsRowW = buttonW.reduce((a, b) => a + b, 0) + BUTTON_GAP * (WELCOME_BUTTONS.length - 1);
  const cardContentW = Math.max(
    "Welcome back".length,
    workspace.length + 2,
    mainLabel.length + 2,
    buttonsRowW,
    quoteText.length,
    30,
  );
  const cardW = cardContentW + 4 /* paddingX=2 */ + 2 /* border */;
  const availH = Math.max(8, rows - 3); // rows under the top bar
  const showArt = availH >= 22 && columns >= EAON_ART[0].length + 8;
  const cardH = 11; // border2 + Welcome back + workspace + model + gap + buttons(3) + gap + quote
  const rowsBeforeCard = showArt ? EAON_ART.length + 1 + 1 + 1 : 1 + 1; // art+gap+tagline+gap | tagline+gap
  const contentH = rowsBeforeCard + cardH + 1 /* gap */ + 1 /* hints */;
  const topPad = Math.max(0, Math.floor((availH - contentH) / 2));
  const firstContentRow = 4 + topPad; // 1-based; top bar is rows 1-3
  const cardTop = firstContentRow + rowsBeforeCard; // 1-based top border row of the card
  const buttonsTop = cardTop + 1 /* border */ + 4; /* Welcome back / workspace / model / gap */
  const innerW = columns - 2; // root paddingX
  const cardX = 2 + Math.max(0, Math.floor((innerW - cardW) / 2)); // 1-based left border column

  // Click regions for the buttons. Reported synchronously during render
  // (the callback only writes a ref), so a click can never race the effect
  // flush — the regions exist the moment the buttons are on screen.
  const onActionRef = useRef(props.onAction);
  onActionRef.current = props.onAction;
  if (props.onLayout) {
    const rects: ClickRegion[] = [];
    const rowPad = Math.max(0, Math.floor((cardContentW - buttonsRowW) / 2));
    let x = cardX + 1 /* border */ + 2 /* paddingX */ + rowPad;
    for (let i = 0; i < WELCOME_BUTTONS.length; i++) {
      const b = WELCOME_BUTTONS[i];
      rects.push({
        id: b.id,
        x1: x,
        y1: buttonsTop,
        x2: x + buttonW[i] - 1,
        y2: buttonsTop + 2,
        onClick: () => onActionRef.current?.(b.action),
      });
      x += buttonW[i] + BUTTON_GAP;
    }
    props.onLayout(rects);
  }

  const artShown = Math.min(EAON_ART.length, step);
  const quoteChars = Math.max(0, Math.min(quoteText.length, (step - EAON_ART.length - 1) * 3));
  const typing = quoteChars < quoteText.length;
  const gradA = accent;
  const gradB = theme?.code ?? accent;

  return (
    <Box flexDirection="column" height={availH} flexShrink={0}>
      {topPad > 0 ? <Box height={topPad} flexShrink={0} /> : null}
      <Box flexDirection="column" alignItems="center" flexShrink={0}>
        {showArt
          ? EAON_ART.map((line, i) => (
              <Text key={i} bold color={i < artShown ? lerpHex(gradA, gradB, EAON_ART.length <= 1 ? 0 : i / (EAON_ART.length - 1)) : undefined}>
                {i < artShown ? line : " ".repeat(line.length)}
              </Text>
            ))
          : null}
        {showArt ? <Text> </Text> : null}
        <Text dimColor>{tagline}</Text>
        <Text> </Text>
        <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={2} width={cardW} flexShrink={0}>
          <Text bold color={accent}>Welcome back</Text>
          <Text>  {workspace}</Text>
          <Text dimColor>  {mainLabel}</Text>
          <Text> </Text>
          <Box flexDirection="row" paddingLeft={Math.max(0, Math.floor((cardContentW - buttonsRowW) / 2))}>
            {WELCOME_BUTTONS.map((b, i) => (
              <Box key={b.id} borderStyle="round" borderColor={i === 0 ? accent : border} paddingX={1} marginRight={i < WELCOME_BUTTONS.length - 1 ? BUTTON_GAP : 0}>
                <Text bold={i === 0} color={i === 0 ? accent : undefined} dimColor={i !== 0}>{b.label}</Text>
              </Box>
            ))}
          </Box>
          <Text> </Text>
          <Text italic dimColor>
            {quoteText.slice(0, quoteChars)}
            {typing ? <Text color={accent}>▌</Text> : null}
          </Text>
        </Box>
        <Text> </Text>
        <Text color={muted}>Enter start · s setup · q quit — or click a button</Text>
      </Box>
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
    <Box flexDirection="column" width={25} minHeight={1} flexShrink={0} borderStyle="single" borderColor={props.theme.border} paddingX={1}>
      <Text bold color={props.theme.accent}>WORKSPACE</Text>
      <Text> </Text>
      <Text color={props.theme.accent} wrap="truncate">◆ {props.workspace}</Text>
      <Text dimColor>  current session</Text>
      <Text> </Text>
      <Text bold>SESSION</Text>
      <Text color={props.theme.accent} wrap="truncate">  ◉ New session</Text>
      <Text dimColor>  /clear reset</Text>
      <Text dimColor>  /stats tokens</Text>
      <Text dimColor>  /help  commands</Text>
      <Box flexGrow={1} />
      <Text bold>RUNTIME</Text>
      <Text dimColor wrap="truncate">  model   {props.mainLabel}</Text>
      <Text dimColor wrap="truncate">  perms   {props.permissionMode}</Text>
      <Text dimColor wrap="truncate">  caveman {props.cavemanLevel}</Text>
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

export function StatusBar(props: { theme: Theme; text: string; busy?: boolean }): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor={props.theme.border} paddingX={1}>
      <Text color={props.busy ? props.theme.accent : props.theme.success}>{props.busy ? "◌" : "●"} </Text>
      <Text dimColor wrap="truncate">{props.text}</Text>
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

/** A visual row of the input editor: text plus the flat index it starts at. */
export interface DisplayLine {
  text: string;
  start: number;
}

/**
 * Split the input value into visual rows: real newlines first, then hard
 * wraps at `width`. The cursor's row/column is derived from these, and mouse
 * clicks map back through them to a flat character index.
 */
export function displayLines(value: string, width: number): DisplayLine[] {
  const w = Math.max(4, width);
  const out: DisplayLine[] = [];
  const n = value.length;
  let start = 0;
  while (start <= n) {
    let end = value.indexOf("\n", start);
    if (end === -1) end = n;
    if (end - start <= w) {
      out.push({ text: value.slice(start, end), start });
    } else {
      let s = start;
      while (s < end) {
        out.push({ text: value.slice(s, Math.min(s + w, end)), start: s });
        s += w;
      }
    }
    start = end + 1;
  }
  if (!out.length) out.push({ text: "", start: 0 });
  return out;
}

/** Slash-command suggestions for the autocomplete dropdown. */
export function slashSuggestions(
  value: string,
  commands: { name: string; description: string }[],
  limit = 6,
): { name: string; description: string }[] {
  if (!value.startsWith("/") || value.includes("\n") || value.includes(" ")) return [];
  const q = value.slice(1).toLowerCase();
  return commands.filter((c) => c.name.startsWith(q)).slice(0, limit);
}

/** Where a click should put the cursor: visual row/column relative to the text area. */
export interface InputClick {
  n: number; // monotonically increasing, so repeated identical clicks still fire
  line: number;
  col: number;
}

const DEFAULT_HINTS = [
  "ask anything · / for commands · \\ + Enter for a newline",
  "PgUp/PgDn or the mouse wheel scrolls the chat",
  "Tab completes a /command · ↑/↓ recall history",
  "Esc cancels a running task · /theme changes the palette",
];

export function ChatInput(props: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  busy?: boolean;
  history: string[];
  placeholder?: string;
  accent?: string;
  muted?: string;
  /** Outer width of the input box in terminal cells. */
  width?: number;
  /** Slash commands for the Tab-completion dropdown. */
  suggestions?: { name: string; description: string }[];
  /** Reports the current value on every edit (the parent sizes the viewport). */
  onValueChange?: (value: string) => void;
  /** Click-to-position signal from the app's mouse handling. */
  click?: InputClick;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);
  const [histStash, setHistStash] = useState("");
  const [hintIdx, setHintIdx] = useState(() => Math.floor(Math.random() * DEFAULT_HINTS.length));
  const [sugSel, setSugSel] = useState(0);
  // Mirror value/cursor/histIdx in refs: Ink drains all buffered keystrokes
  // in one batch, so handlers firing in the same tick would otherwise see
  // stale state and drop the last typed characters on submit.
  const valueRef = useRef("");
  const cursorRef = useRef(0);
  const histIdxRef = useRef(-1);
  const onValueChangeRef = useRef(props.onValueChange);
  onValueChangeRef.current = props.onValueChange;
  const setVal = (v: string | ((prev: string) => string), cur?: number) => {
    const next = typeof v === "function" ? v(valueRef.current) : v;
    valueRef.current = next;
    setValue(next);
    const c = cur ?? next.length;
    cursorRef.current = c;
    setCursor(c);
    onValueChangeRef.current?.(next);
  };
  const setCur = (c: number | ((prev: number) => number)) => {
    const next = typeof c === "function" ? c(cursorRef.current) : c;
    const clamped = Math.max(0, Math.min(valueRef.current.length, next));
    cursorRef.current = clamped;
    setCursor(clamped);
  };
  const setHist = (i: number) => {
    histIdxRef.current = i;
    setHistIdx(i);
  };

  // Rotate the idle placeholder hint.
  useEffect(() => {
    const t = setInterval(() => setHintIdx((i) => (i + 1) % DEFAULT_HINTS.length), 6000);
    return () => clearInterval(t);
  }, []);

  const width = props.width ?? 78;
  const textWidth = Math.max(4, width - 4 /* border+paddingX */ - 2 /* prompt */);

  // Click-to-position: map the visual row/col back to a flat index.
  const clickN = props.click?.n ?? 0;
  useEffect(() => {
    if (!clickN || !props.click) return;
    const lines = displayLines(valueRef.current, textWidth);
    const li = Math.max(0, Math.min(lines.length - 1, props.click.line));
    const line = lines[li];
    setCur(line.start + Math.max(0, Math.min(line.text.length, props.click.col)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clickN]);

  const insert = (s: string) => {
    const v = valueRef.current;
    const c = cursorRef.current;
    setVal(v.slice(0, c) + s + v.slice(c), c + s.length);
  };

  const submitCurrent = () => {
    const current = valueRef.current;
    if (current.endsWith("\\")) {
      setVal(current.slice(0, -1) + "\n");
      return;
    }
    const t = current.trim();
    if (t) props.onSubmit(t);
    setVal("", 0);
    setHist(-1);
  };

  const sug = slashSuggestions(value, props.suggestions ?? []);

  useInput(
    (input, key) => {
      if (props.disabled) return;
      if (isMouseInput(input)) return; // mouse sequences are handled by the app
      if (key.return) {
        submitCurrent();
        return;
      }
      if (key.tab && sug.length) {
        const pick = sug[Math.min(sugSel, sug.length - 1)];
        setVal(`/${pick.name} `);
        setSugSel(0);
        return;
      }
      if (key.leftArrow) { setCur((c) => c - 1); return; }
      if (key.rightArrow) { setCur((c) => c + 1); return; }
      if (key.ctrl && input.toLowerCase() === "a") { setCur(0); return; }
      if (key.ctrl && input.toLowerCase() === "e") { setCur(valueRef.current.length); return; }
      if (key.ctrl && input.toLowerCase() === "w") {
        // delete the word left of the cursor
        const v = valueRef.current;
        let c = cursorRef.current;
        while (c > 0 && v[c - 1] === " ") c--;
        while (c > 0 && v[c - 1] !== " ") c--;
        setVal(v.slice(0, c) + v.slice(cursorRef.current), c);
        return;
      }
      if (key.ctrl && input.toLowerCase() === "k") {
        setVal(valueRef.current.slice(0, cursorRef.current), cursorRef.current);
        return;
      }
      if (key.backspace || key.delete) {
        const v = valueRef.current;
        const c = cursorRef.current;
        if (c > 0) setVal(v.slice(0, c - 1) + v.slice(c), c - 1);
        return;
      }
      if (key.upArrow) {
        const h = props.history;
        if (!h.length) return;
        if (histIdxRef.current < 0) setHistStash(valueRef.current);
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
          setVal(histStash, histStash.length);
        } else {
          setHist(idx);
          setVal(props.history[idx]);
        }
        return;
      }
      if (key.escape) {
        setVal("", 0);
        setHist(-1);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        // Ink hands us whatever arrived in one read() as a single chunk.
        // Rapid typing, bracketed paste, or a busy render loop can merge
        // printable text AND the Enter key into one `input` string with
        // key.return === false — previously that silently appended a
        // newline instead of submitting, so messages typed while the UI
        // was busy never entered history (and scrolling showed nothing).
        // Split on carriage returns and replay the submit logic at every
        // boundary so behavior is identical no matter how reads batch.
        const parts = input.split("\r");
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) insert(parts[i]);
          if (i === parts.length - 1) break;
          submitCurrent();
        }
      }
    },
    { isActive: !props.disabled },
  );

  const accent = props.accent ?? "yellow";
  const borderColor = props.disabled ? (props.muted ?? "gray") : accent;
  const lines = displayLines(value, textWidth);

  // Locate the cursor: a boundary position belongs to the next visual row
  // when the row continues (hard wrap), and to this row at a real newline.
  let curLine = lines.length - 1;
  let curCol = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const lineEnd = L.start + L.text.length;
    const continues = i < lines.length - 1 && lines[i + 1].start === lineEnd;
    if (cursor < lineEnd || (cursor === lineEnd && (!continues || i === lines.length - 1))) {
      curLine = i;
      curCol = cursor - L.start;
      break;
    }
  }

  const placeholder = props.placeholder ?? DEFAULT_HINTS[hintIdx];
  const cursorBlock = (ch: string, key?: number) => (
    <Text key={key} backgroundColor={props.disabled ? undefined : accent} color={props.disabled ? (props.muted ?? "gray") : "#000000"}>
      {props.disabled ? "▌" : ch}
    </Text>
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} flexShrink={0}>
        {value === "" ? (
          <Box>
            <Text bold color={borderColor}>{"❯ "}</Text>
            {cursorBlock(" ")}
            <Text dimColor>{props.disabled ? ` ${placeholder}` : placeholder}</Text>
          </Box>
        ) : (
          lines.map((L, i) => (
            <Box key={i}>
              <Text bold color={borderColor}>{i === 0 ? "❯ " : "│ "}</Text>
              <Text>
                {i === curLine ? (
                  <>
                    {L.text.slice(0, curCol)}
                    {cursorBlock(L.text[curCol] ?? " ")}
                    {L.text.slice(curCol + 1)}
                  </>
                ) : (
                  L.text
                )}
              </Text>
            </Box>
          ))
        )}
      </Box>
      {sug.length ? (
        <Box flexDirection="column" paddingX={2}>
          {sug.map((s, i) => (
            <Text key={s.name} color={i === sugSel ? accent : undefined} bold={i === sugSel} dimColor={i !== sugSel}>
              {i === sugSel ? "❯ " : "  "}/{s.name}
              <Text dimColor>  {s.description}</Text>
            </Text>
          ))}
          <Text dimColor>  Tab to complete</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------- Select ----------------

export function Select(props: {
  items: { label: string; value: string; hint?: string }[];
  onSelect: (value: string) => void;
  limit?: number;
  accent?: string;
  /** 1-based screen position of this list's first row — enables click regions. */
  origin?: { x: number; y: number };
  onLayout?: (rects: ClickRegion[]) => void;
}): React.ReactElement {
  const [idx, setIdx] = useState(0);
  const idxRef = useRef(0);
  const setIdxBoth = (v: number | ((prev: number) => number)) => {
    const next = typeof v === "function" ? v(idxRef.current) : v;
    idxRef.current = next;
    setIdx(next);
  };
  useInput((input, key) => {
    if (isMouseInput(input)) return;
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

  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;
  const origin = props.origin;
  // Synchronous rect reporting (see WelcomeScreen) — clicks must work the
  // moment the list is visible.
  if (props.onLayout && origin) {
    props.onLayout(
      visible.map((it, i) => ({
        id: `select-${it.value}`,
        x1: origin.x,
        y1: origin.y + i,
        x2: origin.x + 60,
        y2: origin.y + i,
        onClick: () => onSelectRef.current(it.value),
      })),
    );
  }

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
    if (isMouseInput(input)) return;
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
    if (input && !key.ctrl && !key.meta) {
      // Same merged-chunk hazard as ChatInput: the Enter key can arrive
      // inside the text chunk as a trailing "\r" with key.return === false.
      const parts = input.split("\r");
      if (parts[0]) setVal((v) => v + parts[0]);
      if (parts.length > 1) {
        const current = valueRef.current;
        if (current.trim() || props.allowEmpty) props.onSubmit(current.trim());
      }
    }
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

const PERM_DETAIL_LIMIT = 10;

/** Detail rows rendered for a request (truncated list + optional "…" line). */
function permDetailRows(req: PermissionRequest): number {
  const detail = req.detail ?? "";
  if (!detail) return 0;
  const n = detail.split("\n").length;
  return Math.min(PERM_DETAIL_LIMIT, n) + (n > PERM_DETAIL_LIMIT ? 1 : 0);
}

/** Rendered height of the prompt (border + title + detail + gap + buttons). */
export function permissionPromptHeight(req: PermissionRequest): number {
  return 2 + 1 + permDetailRows(req) + 1 + 1;
}

export function PermissionPrompt(props: {
  req: PermissionRequest;
  onDecision: (d: PermissionDecision) => void;
  theme?: Theme;
  /** 1-based screen position of the first content char (inside the border). */
  origin?: { x: number; y: number };
  onLayout?: (rects: ClickRegion[]) => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    const c = input.toLowerCase();
    if (c === "y") props.onDecision("once");
    else if (c === "a" && props.req.kind === "shell") props.onDecision("always");
    else if (c === "n" || key.escape) props.onDecision("deny");
  });
  const accent = props.theme?.accent ?? "yellow";
  const success = props.theme?.success ?? "green";
  const error = props.theme?.error ?? "red";
  const detail = props.req.detail ?? "";
  const allDetail = detail ? detail.split("\n") : [];
  const lines = allDetail.slice(0, PERM_DETAIL_LIMIT);
  const buttons: { id: string; label: string; color: string; decision: PermissionDecision }[] = [
    { id: "perm-y", label: "[y] allow once", color: success, decision: "once" },
    ...(props.req.kind === "shell" ? [{ id: "perm-a", label: "[a] always", color: accent, decision: "always" as PermissionDecision }] : []),
    { id: "perm-n", label: "[n] deny", color: error, decision: "deny" },
  ];
  const GAP = "   ";

  const onDecisionRef = useRef(props.onDecision);
  onDecisionRef.current = props.onDecision;
  const origin = props.origin;
  const buttonsRow = (origin?.y ?? 0) + 1 /* title */ + permDetailRows(props.req) + 1 /* gap */;
  // Synchronous rect reporting (see WelcomeScreen).
  if (props.onLayout && origin) {
    let x = origin.x;
    props.onLayout(
      buttons.map((b) => {
        const r: ClickRegion = {
          id: b.id,
          x1: x,
          y1: buttonsRow,
          x2: x + b.label.length - 1,
          y2: buttonsRow,
          onClick: () => onDecisionRef.current(b.decision),
        };
        x += b.label.length + GAP.length;
        return r;
      }),
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Text bold color={accent}>Permission: {props.req.label}</Text>
      {lines.map((l, i) => (
        <Text key={i} color={l.startsWith("+") ? success : l.startsWith("-") ? error : undefined} dimColor={!l.startsWith("+") && !l.startsWith("-")}>
          {l.slice(0, 200)}
        </Text>
      ))}
      {allDetail.length > PERM_DETAIL_LIMIT ? <Text dimColor>  … ({allDetail.length - PERM_DETAIL_LIMIT} more lines)</Text> : null}
      <Text> </Text>
      <Text>
        {buttons.map((b, i) => (
          <Text key={b.id}>
            <Text bold color={b.color}>{b.label.slice(0, 3)}</Text>
            {b.label.slice(3)}
            {i < buttons.length - 1 ? GAP : ""}
          </Text>
        ))}
        <Text dimColor>  · click or press a key</Text>
      </Text>
    </Box>
  );
}
