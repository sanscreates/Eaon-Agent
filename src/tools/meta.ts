// Meta tools: sub-agents, model discovery, lazy skill loading, and MCP.
// These are what make Eaon token-efficient: the model pulls capability into
// context only when it actually needs it.

import { bool, num, obj, registerTool, str } from "./index.js";

registerTool({
  subagentOk: false, // no nested sub-agents — keeps costs bounded
  schema: {
    name: "spawn_agent",
    description:
      "Spawn a sub-agent to handle a self-contained task in its own context, then return a summary. Ideal for: research, searching a big codebase, reading many files, repetitive edits — anything that would bloat the main context. Pick a cheap/fast model for simple tasks with the model parameter. Call list_available_models first if unsure what's configured.",
    parameters: obj({
      task: str("Complete, self-contained task description. The sub-agent sees no chat history — include all needed context."),
      model: str("Optional: model to use, e.g. 'deepseek-v4-flash' or 'openrouter/deepseek/...'. Omit to use the main model."),
      max_turns: num("Max tool-use turns (default 20)"),
    }, ["task"]),
  },
  async run(args, rt) {
    return await rt.runSubagent(String(args.task), args.model ? String(args.model) : undefined, Math.min(50, Number(args.max_turns ?? 20)));
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "list_available_models",
    description: "List every model configured across all providers (marks which is main/compressor). Use before spawn_agent to pick the right model.",
    parameters: obj({}, []),
  },
  async run(_args, rt) {
    return rt.listModelsText();
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "use_skill",
    description: "Load a skill's full instructions into context. Skill names/descriptions are listed in the system prompt — call this only when a task clearly matches one.",
    parameters: obj({
      name: str("Skill name"),
    }, ["name"]),
  },
  async run(args, rt) {
    const skill = rt.skills.get(String(args.name));
    if (!skill) return `Error: no skill named '${args.name}'. Available: ${rt.skills.list().map((s) => s.name).join(", ") || "(none)"}`;
    return `# Skill: ${skill.name}\n\n${skill.body}`;
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "macro_define",
    description: "Create or update a reusable output macro. After it succeeds, insert <<macro:name>> in a response or file content to substitute its exact text. Use only when a reusable snippet is genuinely useful; there are no built-in macros.",
    parameters: obj({
      name: str("Macro name: starts with a letter; use only letters, numbers, _ or -"),
      text: str("Exact replacement text. May contain multiple lines."),
      description: str("Short description of when to use the macro"),
    }, ["name", "text"]),
  },
  async run(args, rt) {
    const name = String(args.name ?? "");
    const text = String(args.text ?? "");
    if (!text) return "Error: macro text cannot be empty.";
    const ok = await rt.permissions.check({
      kind: "write",
      label: `Save macro <<macro:${name}>>`,
      detail: text.split("\n").slice(0, 20).join("\n"),
    });
    if (!ok) return "Denied by user.";
    try {
      rt.macros.add({ name, description: String(args.description ?? "").trim() || text.trim().split("\n")[0].slice(0, 100), text });
      return `Saved <<macro:${name}>> (${text.split("\n").length} lines). You can now insert <<macro:${name}>> wherever this exact text belongs.`;
    } catch (e: any) {
      return `Error: ${e.message ?? String(e)}`;
    }
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "mcp_list_tools",
    description: "List tools exposed by a configured MCP server (names + descriptions + schemas). Lazy: only call when you intend to use that server.",
    parameters: obj({
      server: str("MCP server name from config"),
    }, ["server"]),
  },
  async run(args, rt) {
    return await rt.mcp.listToolsText(String(args.server));
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "mcp_call_tool",
    description: "Call a tool on a configured MCP server. Discover tools first with mcp_list_tools.",
    parameters: obj({
      server: str("MCP server name"),
      tool: str("Tool name on that server"),
      arguments: { type: "object", description: "Tool arguments as a JSON object", additionalProperties: true },
    }, ["server", "tool"]),
  },
  async run(args, rt) {
    const ok = await rt.permissions.check({ kind: "mcp", label: `MCP ${args.server} → ${args.tool}`, detail: JSON.stringify(args.arguments ?? {}).slice(0, 300) });
    if (!ok) return "Denied by user.";
    return await rt.mcp.callToolText(String(args.server), String(args.tool), (args.arguments as Record<string, any>) ?? {});
  },
});

registerTool({
  subagentOk: false,
  schema: {
    name: "compress_now",
    description: "Manually trigger context compression: everything except the most recent messages is summarized by the cheap compressor model. Normally automatic.",
    parameters: obj({}, []),
  },
  async run(_args, rt) {
    return await rt.compressNow();
  },
});
