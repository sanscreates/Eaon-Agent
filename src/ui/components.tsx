// Shared Ink components: markdown-ish rendering, tool views, input, spinner, select.

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
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

// ---------------- Welcome screen ----------------

export function WelcomeScreen(): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text bold color="yellow">Eaon Agent v1.1</Text>
      <Text dimColor>token-efficient terminal AI coding agent</Text>
      <Text> </Text>
      <Text color="yellow">╭─────────────────────────────────────╮</Text>
      <Text color="yellow">│  "why use many tokens when few      │</Text>
      <Text color="yellow">│   do the trick"                      │</Text>
      <Text color="yellow">╰─────────────────────────────────────╯</Text>
      <Text> </Text>
      <Text dimColor>press Enter to start · /setup to configure</Text>
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
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="yellow">{"❯ "}</Text>
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
