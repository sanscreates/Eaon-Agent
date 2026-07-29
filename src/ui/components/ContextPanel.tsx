import { Box, Text } from "ink";
import React from "react";
import type { SessionStats } from "../../types.js";
import { fmtTokens } from "../../tokens.js";
import { FileTree } from "./FileTree.js";

interface ContextPanelProps {
  cwd: string;
  stats: SessionStats;
  isFocused: boolean;
}

function tokenBar(value: number, max: number, color: string): string {
  const width = Math.max(1, Math.min(10, Math.round((value / Math.max(1, max)) * 10)));
  return "█".repeat(width) + "░".repeat(Math.max(0, 10 - width));
}

export function ContextPanel({
  cwd, stats, isFocused,
}: ContextPanelProps): React.ReactElement {
  const maxTokenVal = Math.max(stats.inputTokens, stats.outputTokens, stats.compressorInput, 1000);
  const saved = stats.compressedTokens + stats.cavemanSavedEst;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? "#f4b942" : "gray"}
      paddingX={1}
      height="100%"
      width="100%"
    >
      <Text bold color="#f4b942">Stats</Text>
      <Text dimColor>in </Text>
      <Text>{fmtTokens(stats.inputTokens)}</Text>
      <Text color="gray">{tokenBar(stats.inputTokens, maxTokenVal, "blue")}</Text>

      <Text dimColor>out</Text>
      <Text>{fmtTokens(stats.outputTokens)}</Text>
      <Text color="gray">{tokenBar(stats.outputTokens, maxTokenVal, "green")}</Text>

      <Text dimColor>comp</Text>
      <Text>{fmtTokens(stats.compressorInput + stats.compressorOutput)}</Text>
      <Text color="gray">{tokenBar(stats.compressorInput + stats.compressorOutput, maxTokenVal, "#f4b942")}</Text>

      {saved > 0 ? (
        <>
          <Text dimColor>saved</Text>
          <Text color="#f4b942">⛏ {fmtTokens(saved)}</Text>
        </>
      ) : null}

      <Box marginY={0} />

      <Text bold color="#f4b942">Tools</Text>
      <Text dimColor>{stats.toolCalls} calls</Text>
      <Text dimColor>{stats.subagentCalls} sub-agents</Text>
      <Text dimColor>{stats.compressionEvents} compressions</Text>

      <Box marginY={0} />

      <Text bold color="#f4b942">Files</Text>
      <FileTree cwd={cwd} depth={2} maxItems={15} />
    </Box>
  );
}