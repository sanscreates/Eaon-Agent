import { Box, Text } from "ink";
import React from "react";
import type { SessionStats } from "../../types.js";
import { fmtTokens } from "../../tokens.js";

interface StatusBarProps {
  mainLabel: string;
  cavemanLevel: string;
  stats: SessionStats;
  isFocused: boolean;
}

export function StatusBar({
  mainLabel, cavemanLevel, stats, isFocused,
}: StatusBarProps): React.ReactElement {
  const mins = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
  const saved = stats.compressedTokens + stats.cavemanSavedEst;

  const left = (
    <Box>
      <Text color={mainLabel ? "green" : "red"}>● </Text>
      <Text dimColor>{mainLabel || "no model"}</Text>
    </Box>
  );

  const center = cavemanLevel !== "off" ? (
    <Text dimColor>⛏ {cavemanLevel}</Text>
  ) : null;

  const right = (
    <Box>
      <Text dimColor>in {fmtTokens(stats.inputTokens)}</Text>
      <Text dimColor> out {fmtTokens(stats.outputTokens)}</Text>
      {saved > 0 ? <Text dimColor> ↯{fmtTokens(saved)}</Text> : null}
      <Text dimColor> {mins}m</Text>
    </Box>
  );

  return (
    <Box
      width="100%"
      justifyContent="space-between"
      paddingX={1}
      borderStyle={isFocused ? "round" : undefined}
      borderColor={isFocused ? "#f4b942" : undefined}
    >
      {left}
      {center}
      {right}
    </Box>
  );
}