import { Box, Text } from "ink";
import React, { useCallback, useMemo, useRef, useState } from "react";
import type { ChatItem } from "../components.js";
import { MessageCard } from "./MessageCard.js";

interface ChatStreamProps {
  items: ChatItem[];
  liveText?: string;
  thinking?: boolean;
  mainLabel?: string;
  height: number;
  isFocused: boolean;
}

const LINE_ESTIMATES: Record<string, number> = {
  user: 2,
  assistant: 3,
  tool: 2,
  subagent: 1,
  notice: 1,
  error: 2,
};

function estimateLines(item: ChatItem, maxCols: number): number {
  const base = LINE_ESTIMATES[item.kind] ?? 1;
  const text = item.text ?? "";
  const textLines = text ? Math.max(1, Math.ceil(text.length / maxCols)) : 0;
  if (item.kind === "assistant") {
    const fences = text.split("\n").filter(l => l.trimStart().startsWith("```")).length;
    const fenceLines = fences * 2;
    const codeLines = text.split("\n").filter(l => l.trimStart().startsWith("```")).length > 0
      ? text.split("\n").length * 0.3 : 0;
    return base + textLines + fenceLines + Math.round(codeLines);
  }
  if (item.kind === "tool" && item.running === false && item.result) {
    return base + Math.min(4, Math.ceil(item.result.length / maxCols));
  }
  return base + textLines;
}

export function ChatStream({
  items, liveText, thinking, mainLabel, height, isFocused,
}: ChatStreamProps): React.ReactElement {
  const [scrollOffset, setScrollOffset] = useState(0);
  const autoScroll = useRef(true);
  const cols = process.stdout.columns ?? 80;
  const effectiveCols = Math.max(40, cols - 8);
  const maxVisibleLines = height - 2;

  const lineCounts = useMemo(() => {
    return items.map((it) => estimateLines(it, effectiveCols));
  }, [items, effectiveCols]);

  const totalLines = useMemo(() => {
    let total = lineCounts.reduce((a, b) => a + b, 0);
    if (liveText) total += Math.max(1, Math.ceil(liveText.length / effectiveCols)) + 1;
    if (thinking && !liveText) total += 1;
    return total;
  }, [lineCounts, liveText, thinking, effectiveCols]);

  const visibleStart = useMemo(() => {
    if (autoScroll.current || scrollOffset <= 0) return 0;
    return scrollOffset;
  }, [scrollOffset, autoScroll]);

  const visibleEnd = useMemo(() => {
    return Math.min(visibleStart + maxVisibleLines, items.length);
  }, [visibleStart, maxVisibleLines, items.length]);

  const visibleItems = useMemo(() => {
    return items.slice(visibleStart, visibleEnd);
  }, [items, visibleStart, visibleEnd]);

  const scrollUp = useCallback(() => {
    autoScroll.current = false;
    setScrollOffset((prev) => Math.max(0, prev - 3));
  }, []);

  const scrollDown = useCallback(() => {
    setScrollOffset((prev) => {
      const next = prev + 3;
      if (next + maxVisibleLines >= items.length) {
        autoScroll.current = true;
        return 0;
      }
      return next;
    });
  }, [items.length, maxVisibleLines]);

  const canScrollUp = visibleStart > 0;
  const canScrollDown = visibleStart + maxVisibleLines < items.length;

  return (
    <Box flexDirection="column" flexGrow={1} height={height}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {items.length === 0 && !liveText && !thinking ? (
            <Text dimColor>No messages yet.</Text>
          ) : (
            visibleItems.map((it) => <MessageCard key={it.id} item={it} />)
          )}

          {liveText ? (
            <Box marginTop={1} flexDirection="column" paddingX={3}>
              <Text wrap="wrap">{liveText}</Text>
            </Box>
          ) : null}

          {thinking && !liveText ? (
            <Text>
              <Text color="#f4b942">⠋ </Text>
              {mainLabel ? <Text dimColor>{mainLabel} thinking…</Text> : null}
            </Text>
          ) : null}
        </Box>

        {canScrollUp || canScrollDown ? (
          <Box flexDirection="column" width={1} justifyContent="center">
            {canScrollUp ? <Text dimColor>▲</Text> : <Text> </Text>}
            <Text dimColor>│</Text>
            <Text dimColor>│</Text>
            {canScrollDown ? <Text dimColor>▼</Text> : <Text> </Text>}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}