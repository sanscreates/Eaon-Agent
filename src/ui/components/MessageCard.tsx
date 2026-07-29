import { Box, Text } from "ink";
import React from "react";
import type { ChatItem } from "../components.js";
import { CodeBlock } from "./CodeBlock.js";
import { ToolCallBlock } from "./ToolCallBlock.js";

function splitCodeFences(text: string): { type: "text" | "code"; content: string; lang?: string }[] {
  const blocks: { type: "text" | "code"; content: string; lang?: string }[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1];
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push({ type: "code", content: code.join("\n"), lang: lang || undefined });
    } else {
      const textLines: string[] = [];
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) textLines.push(lines[i++]);
      blocks.push({ type: "text", content: textLines.join("\n") });
    }
  }
  return blocks;
}

function InlineText({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g);
  return (
    <Text wrap="wrap">
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <Text key={i} bold>{p.slice(2, -2)}</Text>;
        if (p.startsWith("`") && p.endsWith("`")) return <Text key={i} color="#f1fa8c">{p.slice(1, -1)}</Text>;
        if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <Text key={i} italic>{p.slice(1, -1)}</Text>;
        return <Text key={i}>{p}</Text>;
      })}
    </Text>
  );
}

function MarkdownContent({ text }: { text: string }): React.ReactElement {
  const blocks = splitCodeFences(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        if (block.type === "code") {
          return <CodeBlock key={i} code={block.content} language={block.lang} compact />;
        }
        const lines = block.content.split("\n");
        return (
          <Box key={i} flexDirection="column">
            {lines.map((line, j) => {
              const header = line.match(/^(#{1,6})\s+(.*)$/);
              if (header) return <Text key={j} bold color="#f4b942">{header[2]}</Text>;
              const list = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
              if (list) {
                return (
                  <Box key={j} flexDirection="row">
                    <Text>{list[1]}{list[2]} </Text>
                    <InlineText text={list[3]} />
                  </Box>
                );
              }
              return <InlineText key={j} text={line} />;
            })}
          </Box>
        );
      })}
    </Box>
  );
}

const ROLE_AVATARS: Record<string, string> = {
  user: "🧑",
  assistant: "🤖",
  tool: "⚙️",
  subagent: "🔍",
  system: "📦",
};

interface MessageCardProps {
  item: ChatItem;
}

export function MessageCard({ item }: MessageCardProps): React.ReactElement {
  const avatar = ROLE_AVATARS[item.kind] ?? "•";
  const roleLabel = item.kind.charAt(0).toUpperCase() + item.kind.slice(1);

  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text>{avatar} </Text>
            <Text bold color="#f4b942">{roleLabel}</Text>
          </Box>
          <Box paddingX={3}>
            <Text bold wrap="wrap">{item.text}</Text>
          </Box>
        </Box>
      );

    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text>{avatar} </Text>
            <Text bold color="#86c06a">{roleLabel}</Text>
          </Box>
          <Box paddingX={3} flexDirection="column">
            <MarkdownContent text={item.text ?? ""} />
          </Box>
        </Box>
      );

    case "tool":
      return (
        <Box paddingX={2}>
          <ToolCallBlock
            call={item.call!}
            result={item.result}
            ms={item.ms}
            running={item.running}
          />
        </Box>
      );

    case "subagent":
      return (
        <Box paddingX={2} marginY={0}>
          <Text>
            <Text color="yellow">{avatar} </Text>
            <Text dimColor>{item.text?.slice(0, 90)}</Text>
            {item.running ? <Text color="yellow"> …</Text> : <Text color="green"> ✓</Text>}
          </Text>
        </Box>
      );

    case "notice":
      return <Text dimColor>  {item.text}</Text>;

    case "error":
      return (
        <Box borderStyle="round" borderColor="red" paddingX={1} marginY={0}>
          <Text color="red">✖ {item.text}</Text>
        </Box>
      );
  }
}