import { Box } from "ink";
import React from "react";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import type { FocusPane } from "../../types.js";

interface LayoutProps {
  sidebar: React.ReactNode;
  chat: React.ReactNode;
  contextPanel?: React.ReactNode;
  header: React.ReactNode;
  statusBar: React.ReactNode;
  inputBar: React.ReactNode;
  focusedPane: FocusPane;
}

const SIDEBAR_MIN = 24;
const CONTEXT_MIN = 20;

export function Layout({
  sidebar, chat, contextPanel, header, statusBar, inputBar,
}: LayoutProps): React.ReactElement {
  const { cols } = useTerminalSize();
  const hasContext = contextPanel !== undefined && cols >= 100;

  const sidebarWidth = Math.max(SIDEBAR_MIN, Math.floor(cols * 0.18));
  const contextWidth = hasContext ? Math.max(CONTEXT_MIN, Math.floor(cols * 0.2)) : 0;
  const chatFlex = cols - sidebarWidth - contextWidth;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box width="100%">
        {header}
      </Box>

      <Box flexDirection="row" flexGrow={1} width="100%">
        <Box width={sidebarWidth} flexShrink={0}>
          {sidebar}
        </Box>

        <Box flexGrow={1} width={chatFlex} flexDirection="column">
          <Box flexGrow={1} flexDirection="column">
            {chat}
          </Box>
          <Box width="100%">
            {inputBar}
          </Box>
        </Box>

        {hasContext ? (
          <Box width={contextWidth} flexShrink={0}>
            {contextPanel}
          </Box>
        ) : null}
      </Box>

      <Box width="100%">
        {statusBar}
      </Box>
    </Box>
  );
}