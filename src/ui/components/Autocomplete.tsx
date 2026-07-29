import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import fs from "node:fs";
import path from "node:path";

interface AutocompleteProps {
  prefix: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}

interface AutocompleteItem {
  label: string;
  value: string;
  type: "file" | "command";
}

const COMMANDS = [
  { label: "/help", value: "/help" },
  { label: "/model", value: "/model " },
  { label: "/models", value: "/models" },
  { label: "/stats", value: "/stats" },
  { label: "/clear", value: "/clear" },
  { label: "/theme", value: "/theme " },
  { label: "/exit", value: "/exit" },
  { label: "/setup", value: "/setup" },
  { label: "/compress", value: "/compress" },
  { label: "/skills", value: "/skills" },
  { label: "/mcp", value: "/mcp" },
  { label: "/permissions", value: "/permissions " },
  { label: "/macro", value: "/macro " },
  { label: "/init", value: "/init" },
  { label: "/plugins", value: "/plugins" },
  { label: "/caveman", value: "/caveman " },
  { label: "/caveman-stats", value: "/caveman-stats" },
  { label: "/caveman-compress", value: "/caveman-compress " },
];

export function Autocomplete({
  prefix, onSelect, onClose,
}: AutocompleteProps): React.ReactElement {
  const [items, setItems] = useState<AutocompleteItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    const isCommand = prefix.startsWith("/");
    const query = prefix.slice(1).toLowerCase();

    if (isCommand) {
      const filtered = COMMANDS
        .filter((c) => c.label.toLowerCase().includes(query))
        .map((c) => ({ label: c.label, value: c.value, type: "command" as const }));
      setItems(filtered);
      setSelectedIdx(0);
    } else if (prefix.startsWith("@")) {
      const fileQuery = prefix.slice(1).toLowerCase();
      const cwd = process.cwd();
      const files: AutocompleteItem[] = [];
      try {
        const entries = fs.readdirSync(cwd, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          if (entry.name.toLowerCase().includes(fileQuery)) {
            files.push({
              label: entry.name + (entry.isDirectory() ? "/" : ""),
              value: entry.name + (entry.isDirectory() ? "/" : ""),
              type: "file",
            });
          }
        }
      } catch {}
      setItems(files.slice(0, 15));
      setSelectedIdx(0);
    } else {
      setItems([]);
    }
  }, [prefix]);

  if (!items.length) return <Text> </Text>;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={0}
    >
      {items.map((item, i) => (
        <Box key={item.value}>
          <Text bold={i === selectedIdx} color={i === selectedIdx ? "#f4b942" : undefined}>
            {i === selectedIdx ? "❯ " : "  "}
            {item.type === "command" ? "⌘" : "📄"} {item.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}