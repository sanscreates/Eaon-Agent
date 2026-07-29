import { Box, Text } from "ink";
import React from "react";
import type { FocusPane } from "../../types.js";

interface SidebarProps {
  sessionName: string;
  mainLabel: string;
  compressorLabel: string;
  mcpCount: number;
  isFocused: boolean;
  cols: number;
}

export function Sidebar({
  sessionName, mainLabel, compressorLabel, mcpCount, isFocused, cols,
}: SidebarProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isFocused ? "#f4b942" : "gray"}
      paddingX={1}
      height="100%"
      width="100%"
    >
      <Text bold color="#f4b942">Session</Text>
      <Text dimColor>{sessionName}</Text>
      <Box marginY={0} />

      <Text bold color="#f4b942">Models</Text>
      <Text dimColor>Main:</Text>
      <Text color="green">●</Text><Text> {mainLabel}</Text>
      {compressorLabel ? (
        <>
          <Text dimColor>Comp:</Text>
          <Text color="#f4b942">●</Text><Text> {compressorLabel}</Text>
        </>
      ) : null}
      <Box marginY={0} />

      <Text bold color="#f4b942">MCP</Text>
      <Text dimColor>{mcpCount} server{mcpCount !== 1 ? "s" : ""}</Text>
      {mcpCount > 0 ? <Text color="green">● active</Text> : <Text dimColor>○ none</Text>}
      <Box marginY={0} />

      <Text bold color="#f4b942">Keys</Text>
      {cols > 30 ? (
        <>
          <Text dimColor>⌃X→S Sidebar</Text>
          <Text dimColor>⌃X→C Chat</Text>
          <Text dimColor>⌃X→R Context</Text>
          <Text dimColor>⌃X→I Input</Text>
          <Text dimColor>⌃X→Q Quit</Text>
        </>
      ) : null}
    </Box>
  );
}