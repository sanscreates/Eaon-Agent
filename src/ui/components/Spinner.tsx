import { Text } from "ink";
import React, { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label, color }: { label?: string; color?: string }): React.ReactElement {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((x) => (x + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text>
      <Text color={color ?? "#f4b942"}>{FRAMES[f]}</Text>
      {label ? <Text dimColor> {label}</Text> : null}
    </Text>
  );
}