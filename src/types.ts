// Shared types for Eaon Agent.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments object. */
  args: Record<string, any>;
}

export interface Msg {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface StreamEvent {
  type: "text" | "tool_call" | "done" | "usage" | "error";
  text?: string;
  tool_call?: ToolCall;
  usage?: TokenUsage;
  error?: string;
}

export interface ChatParams {
  model: string;
  messages: Msg[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema object
}

export interface Provider {
  id: string;
  name: string;
  type: "openai" | "anthropic" | "echo";
  baseUrl?: string;
  apiKey?: string; // may contain ${ENV_VAR} — expanded at load
  headers?: Record<string, string>;
  models: string[];
}

export interface ModelRef {
  provider: string; // provider id
  model: string;
}

export type CavemanLevel = "off" | "lite" | "full" | "ultra" | "wenyan";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface EaonConfig {
  version: number;
  providers: Provider[];
  main?: ModelRef;
  compressor?: ModelRef;
  compression: {
    enabled: boolean;
    keepLast: number; // raw messages kept verbatim at the tail
    thresholdTokens: number; // compress when estimated history exceeds this
  };
  caveman: {
    enabled: boolean;
    level: CavemanLevel;
  };
  permissions: {
    mode: "confirm" | "auto" | "readonly";
    allow: string[]; // exact shell commands or "prefix*" patterns
  };
  mcpServers: Record<string, McpServerConfig>;
  ui: {
    showTokens: boolean;
    maxToolResultChars: number;
  };
}

export interface Macro {
  name: string;
  description: string;
  prompt: string; // use {{args}} placeholder
  builtin?: boolean;
}

export interface SkillMeta {
  name: string;
  description: string;
  body: string;
  source: "builtin" | "user" | "project" | "plugin";
}

export interface SessionStats {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  compressorInput: number;
  compressorOutput: number;
  compressionEvents: number;
  compressedTokens: number; // estimated tokens removed from main context
  toolCalls: number;
  subagentCalls: number;
  cavemanSavedEst: number; // estimated output tokens saved by caveman mode
}

export type PermissionDecision = "once" | "always" | "deny";

export interface PermissionRequest {
  kind: "shell" | "write" | "edit" | "mcp" | "fetch";
  label: string; // short description shown to user
  detail?: string; // command, path, diff preview...
}

export interface AgentHooks {
  onText?: (text: string) => void;
  onThinking?: () => void;
  onToolStart?: (call: ToolCall) => void;
  onToolEnd?: (call: ToolCall, result: string, ms: number) => void;
  onNotice?: (text: string) => void;
  onError?: (text: string) => void;
  onCompression?: (removedMessages: number, beforeTok: number, afterTok: number) => void;
  onSubagentStart?: (task: string, model: string) => void;
  onSubagentEnd?: (task: string, ok: boolean) => void;
  askPermission?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface RunOptions {
  input: string;
  modelOverride?: ModelRef;
  maxTurns?: number;
  isSubagent?: boolean;
}
