import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";

type NotificationKind = "success" | "warning" | "error" | "info";

interface NotificationProps {
  message: string;
  kind?: NotificationKind;
  duration?: number;
  onDone?: () => void;
}

const kindColors: Record<NotificationKind, string> = {
  success: "#86c06a",
  warning: "#f4b942",
  error: "#ef6b73",
  info: "gray",
};

export function Notification({
  message, kind = "info", duration = 3000, onDone,
}: NotificationProps): React.ReactElement {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setVisible(false);
      onDone?.();
    }, duration);
    return () => clearTimeout(t);
  }, [duration, onDone]);

  if (!visible) return <Text> </Text>;

  const prefix = kind === "error" ? "✖" : kind === "success" ? "✔" : kind === "warning" ? "⚠" : "ℹ";

  return (
    <Box>
      <Text color={kindColors[kind]}>
        {prefix} {message}
      </Text>
    </Box>
  );
}