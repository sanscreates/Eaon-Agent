import { Box, Text } from "ink";
import React from "react";

function highlightLine(line: string, lang: string): React.ReactElement[] {
  const parts: React.ReactElement[] = [];
  let remaining = line;
  let key = 0;

  if (lang === "diff") {
    if (line.startsWith("+")) return [<Text key={0} color="green">{line}</Text>];
    if (line.startsWith("-")) return [<Text key={0} color="red">{line}</Text>];
    if (line.startsWith("@")) return [<Text key={0} color="#bd93f9">{line}</Text>];
    return [<Text key={0}>{line}</Text>];
  }

  const patterns: [RegExp, string][] = [
    [/"([^"\\]|\\.)*"/g, "#f1fa8c"],
    [/'([^'\\]|\\.)*'/g, "#f1fa8c"],
    [/`([^`\\]|\\.)*`/g, "#f1fa8c"],
    [/\b(function|const|let|var|if|else|for|while|return|import|export|from|async|await|class|new|throw|try|catch|typeof|instanceof|in|of|def|public|private|static)\b/g, "#ff79c6"],
    [/\b(true|false|null|undefined|NaN|void|this|super)\b/g, "#bd93f9"],
    [/\b(\d+\.?\d*)\b/g, "#bd93f9"],
    [/\/\/.*$/g, "#6272a4"],
    [/#.*$/g, "#6272a4"],
  ];

  const segments: { text: string; color?: string }[] = [{ text: remaining }];

  for (const [re, color] of patterns) {
    const newSegs: { text: string; color?: string }[] = [];
    for (const seg of segments) {
      if (seg.color) { newSegs.push(seg); continue; }
      let last = 0;
      let match: RegExpExecArray | null;
      const regex = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      while ((match = regex.exec(seg.text)) !== null) {
        if (match.index > last) newSegs.push({ text: seg.text.slice(last, match.index) });
        newSegs.push({ text: match[0], color });
        last = regex.lastIndex;
      }
      if (last < seg.text.length) newSegs.push({ text: seg.text.slice(last) });
    }
    segments.length = 0;
    segments.push(...newSegs);
  }

  for (const seg of segments) {
    if (seg.text) parts.push(<Text key={key++} color={seg.color}>{seg.text}</Text>);
  }
  return parts;
}

function highlightCode(code: string, lang: string): React.ReactElement[] {
  return code.split("\n").map((line, i) => (
    <Box key={i}>
      <Text>{highlightLine(line, lang)}</Text>
    </Box>
  ));
}

interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  showCopy?: boolean;
  compact?: boolean;
}

export function CodeBlock({
  code, language = "", filename, compact,
}: CodeBlockProps): React.ReactElement {
  const headerParts = [language].filter(Boolean);
  if (filename) headerParts.push(filename);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={compact ? 0 : 1}>
      {headerParts.length > 0 ? (
        <Box justifyContent="space-between">
          <Text dimColor>{headerParts.join(" • ")}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column">
        {highlightCode(code, language)}
      </Box>
    </Box>
  );
}