import { Box, Text } from "ink";
import React from "react";
import { useTerminalSize } from "../hooks/useTerminalSize.js";

interface HeaderProps {
  projectName: string;
  sessionName?: string;
  themeName: string;
  isFocused: boolean;
}

export function Header({
  projectName, sessionName, themeName, isFocused,
}: HeaderProps): React.ReactElement {
  const { cols } = useTerminalSize();
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? "#f4b942" : "gray"}
      paddingX={1}
      justifyContent="space-between"
      width="100%"
    >
      <Box>
        <Text bold color="#f4b942">EAON</Text>
        <Text dimColor> </Text>
        <Text bold>{projectName}</Text>
      </Box>
      <Box>
        {sessionName && cols > 60 ? (
          <Text dimColor>{sessionName}</Text>
        ) : null}
        {cols > 40 ? (
          <Text dimColor> {themeName}</Text>
        ) : null}
        <Text dimColor> </Text>
        <Text dimColor color="gray">/help</Text>
      </Box>
    </Box>
  );
}