import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import fs from "node:fs";
import path from "node:path";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  depth: number;
}

interface FileTreeProps {
  cwd: string;
  depth?: number;
  onSelect?: (filePath: string) => void;
  maxItems?: number;
}

function buildTree(root: string, maxDepth: number, maxItems: number): FileEntry[] {
  const result: FileEntry[] = [];
  const skip = new Set(["node_modules", ".git", ".eaon", "dist", ".next", ".cache", "target"]);
  const skipFiles = new Set([".DS_Store", "package-lock.json", "yarn.lock"]);

  function walk(dir: string, depth: number) {
    if (depth > maxDepth || result.length >= maxItems) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (result.length >= maxItems) break;
        if (skip.has(entry.name) || skipFiles.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(root, fullPath);
        result.push({ name: entry.name, path: fullPath, type: entry.isDirectory() ? "dir" : "file", depth });
        if (entry.isDirectory()) walk(fullPath, depth + 1);
      }
    } catch {}
  }

  walk(root, 0);
  return result;
}

export function FileTree({ cwd, depth = 3, onSelect, maxItems = 30 }: FileTreeProps): React.ReactElement {
  const [entries, setEntries] = useState<FileEntry[]>([]);

  useEffect(() => {
    setEntries(buildTree(cwd, depth, maxItems));
  }, [cwd, depth, maxItems]);

  if (!entries.length) return <Text dimColor>No files</Text>;

  return (
    <Box flexDirection="column">
      {entries.map((entry) => (
        <Box key={entry.path} marginLeft={entry.depth}>
          <Text dimColor>
            {entry.type === "dir" ? "📁" : "📄"} {entry.name}
          </Text>
        </Box>
      ))}
      {entries.length >= maxItems ? <Text dimColor>… more</Text> : null}
    </Box>
  );
}