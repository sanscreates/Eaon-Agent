import { Box, Text } from "ink";
import React, { useState } from "react";
import type { ToolCall } from "../../types.js";

interface ToolCallBlockProps {
  call: ToolCall;
  result?: string;
  ms?: number;
  running?: boolean;
}

export function ToolCallBlock({
  call, result, ms, running,
}: ToolCallBlockProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  const keyArg = String(
    call.args?.command ?? call.args?.path ?? call.args?.query ??
    call.args?.task ?? call.args?.url ?? call.args?.name ?? ""
  ).slice(0, 70);

  const borderColor = running ? "#f4b942" : (result?.startsWith("Error") ? "#ef6b73" : "#86c06a");

  return (
    <Box flexDirection="column" marginY={0}>
      <Box
        borderStyle={expanded ? "round" : undefined}
        borderColor={borderColor}
        paddingX={1}
      >
        <Text>
          <Text color="yellow">{running ? "⚡" : "✓"} </Text>
          <Text bold color={borderColor}>{call.name}</Text>
          {keyArg ? <Text dimColor> {keyArg}</Text> : null}
          {!running && ms !== undefined ? <Text dimColor> {(ms / 1000).toFixed(1)}s</Text> : null}
          <Text color="gray" dimColor> {"["}</Text>
          <Text
            color="gray"
            dimColor
            bold={!expanded}
          >
            {expanded ? "−" : "+"}
          </Text>
          <Text color="gray" dimColor>{"]"}</Text>
        </Text>
      </Box>
      {expanded ? (
        <Box flexDirection="column" paddingX={2} marginTop={0}>
          <Text dimColor>Args:</Text>
          <Text color="gray">{JSON.stringify(call.args, null, 1)}</Text>
          {result ? (
            <>
              <Text dimColor>Result:</Text>
              <Text color={result.startsWith("Error") ? "red" : "gray"}>
                {result.split("\n").slice(0, 8).join("\n")}
                {result.split("\n").length > 8 ? "\n…" : ""}
              </Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}