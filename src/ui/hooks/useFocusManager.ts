import { useCallback, useMemo, useState } from "react";
import type { FocusPane } from "../../types.js";

export function useFocusManager() {
  const [focusedPane, setFocusedPane] = useState<FocusPane>("chat");

  const panes: FocusPane[] = useMemo(() => ["sidebar", "chat", "context", "input"], []);

  const focusNext = useCallback(() => {
    setFocusedPane((prev) => {
      const idx = panes.indexOf(prev);
      return panes[(idx + 1) % panes.length];
    });
  }, [panes]);

  const focusPrev = useCallback(() => {
    setFocusedPane((prev) => {
      const idx = panes.indexOf(prev);
      return panes[(idx - 1 + panes.length) % panes.length];
    });
  }, [panes]);

  const focusPane = useCallback((pane: FocusPane) => {
    setFocusedPane(pane);
  }, []);

  const isFocused = useCallback((pane: FocusPane) => focusedPane === pane, [focusedPane]);

  return { focusedPane, focusNext, focusPrev, focusPane, isFocused };
}