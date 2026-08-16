// Provider-backend and MCP regression tests — all offline.

import { check, testSummary } from "./helpers.mjs";
import fs from "node:fs";

const { toAnthropicMessages } = await import("../dist/providers/anthropic.js");
const { sseEvents } = await import("../dist/providers/base.js");
const { McpManager } = await import("../dist/mcp/client.js");

// ------------------------------------------------- Anthropic message shaping
const roles = (msgs) => msgs.map((m) => m.role).join(",");
const alternates = (msgs) => msgs.every((m, i) => i === 0 || m.role !== msgs[i - 1].role);

{
  // A turn that hits max_turns mid-tool-loop leaves tool results directly
  // before the next user message. Raw mapping produced user,user.
  const { messages } = toAnthropicMessages({
    model: "m",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", name: "read_file", args: { path: "a" } }] },
      { role: "tool", tool_call_id: "t1", name: "read_file", content: "contents" },
      { role: "user", content: "actually, stop" },
    ],
  });
  check(`tool results merge with the following user turn (${roles(messages)})`, alternates(messages));
  check("first message is from the user", messages[0].role === "user");
}

{
  const { messages, system } = toAnthropicMessages({
    model: "m",
    messages: [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "" }, // model returned nothing
      { role: "user", content: "still there?" },
    ],
  });
  check("system messages are concatenated", system === "a\n\nb");
  check("empty assistant text is dropped, not sent as an empty block", alternates(messages) && messages.length === 1);
  check("no empty text blocks survive", messages.every((m) => m.content.every((c) => c.type !== "text" || c.text.length > 0)));
}

{
  const { messages } = toAnthropicMessages({
    model: "m",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", name: "x", args: {} }, { id: "t2", name: "y", args: {} }] },
      { role: "tool", tool_call_id: "t1", content: "one" },
      { role: "tool", tool_call_id: "t2", content: "" },
    ],
  });
  const results = messages[2].content;
  check("parallel tool results share one user message", results.length === 2);
  check("empty tool output is replaced, never sent blank", results[1].content === "(no output)");
}

// ------------------------------------------------- SSE framing
async function collect(chunks) {
  const body = (async function* () { for (const c of chunks) yield Buffer.from(c); })();
  const out = [];
  for await (const e of sseEvents({ body })) out.push(e);
  return out;
}

{
  const noTrailingNewline = await collect(['data: {"a":1}\n', 'data: {"b":2}']);
  check("final SSE event survives a missing trailing newline", noTrailingNewline.length === 2);

  const split = await collect(["data: {\"a\":", "1}\n"]);
  check("an event split across chunks is reassembled", split.length === 1 && split[0] === '{"a":1}');

  const multibyte = await collect([Buffer.from("data: héllo\n", "utf8").subarray(0, 8), Buffer.from("data: héllo\n", "utf8").subarray(8)]);
  check("a multi-byte character split across chunks decodes", multibyte[0] === "héllo");
}

// ------------------------------------------------- MCP failure modes
{
  const mgr = new McpManager({ broken: { command: "eaon-no-such-binary-xyz", args: [] } });
  let first = "";
  try { await mgr.listToolsText("broken"); } catch (e) { first = e.message; }
  check("a missing MCP binary rejects instead of crashing", first.includes("failed to start"));

  // and the failure is not cached forever
  let second = "";
  try { await mgr.listToolsText("broken"); } catch (e) { second = e.message; }
  check("a failed MCP server is retried on the next call", second.includes("failed to start"));
  mgr.killAll();
}

{
  // `cat` echoes our own request back; that must not read as a valid response.
  // (It should hang until the handshake timeout, not resolve with empty tools.)
  const mgr = new McpManager({ echoer: { command: "cat", args: [] } });
  let settled = "";
  mgr.listToolsText("echoer").then((v) => { settled = `resolved: ${v}`; }, () => { settled = "rejected"; });
  await new Promise((r) => setTimeout(r, 700));
  check(`an echoed request is not accepted as a reply (${settled || "still pending"})`, settled === "");
  mgr.killAll();
}

// ------------------------------------------------- transient-failure retries
{
  const { fetchRetry } = await import("../dist/providers/base.js");
  const realFetch = globalThis.fetch;
  const mk = (status, headers = {}) => new Response(status === 200 ? "ok" : "busy", { status, headers });

  let calls = 0;
  globalThis.fetch = async () => { calls++; return mk(calls < 3 ? 429 : 200); };
  const recovered = await fetchRetry("http://x", { method: "POST" });
  check(`429 is retried until it succeeds (${calls} attempts)`, calls === 3 && recovered.status === 200);

  calls = 0;
  globalThis.fetch = async () => { calls++; return mk(400); };
  const bad = await fetchRetry("http://x", { method: "POST" });
  check("a 400 is returned immediately, not retried", calls === 1 && bad.status === 400);

  calls = 0;
  globalThis.fetch = async () => { calls++; return mk(503); };
  const exhausted = await fetchRetry("http://x", { method: "POST" });
  check("retries are bounded and the last response is returned", calls === 3 && exhausted.status === 503);

  calls = 0;
  globalThis.fetch = async () => { calls++; return mk(429); };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  let aborted = "";
  try {
    await fetchRetry("http://x", { method: "POST", signal: ac.signal });
  } catch (e) {
    aborted = e.name;
  }
  check(`cancelling during backoff aborts instead of waiting (${aborted})`, aborted === "AbortError");

  globalThis.fetch = realFetch;
}

// ------------------------------------------------- free tier (OSAII poolside)
{
  const { PROVIDER_PRESETS } = await import("../dist/providers/registry.js");
  const osaii = PROVIDER_PRESETS.find((p) => p.free);
  check("free tier preset exists", !!osaii);
  check("free tier preset is named OSAII", osaii?.name.includes("OSAII") === true);
  check("free tier preset needs no API key", osaii?.keyEnv === "");
  check("free tier preset points at the osaii endpoint", osaii?.baseUrl === "https://osaii.wyvernhub.net/api/v1");
  check("free tier keeps only poolside models", osaii?.filter?.("poolside/laguna-s-2.1") === true && osaii?.filter?.("logfare/kimi-k3") === false);
  check("free tier ships fallback poolside models", Array.isArray(osaii?.fallbackModels) && osaii.fallbackModels.every((m) => m.startsWith("poolside/")));
}

{
  // applyFreeTier: fresh machine → zero-setup single-model config.
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { applyFreeTier, CONFIG_PATH } = await import("../dist/config.js");
  fs.rmSync(CONFIG_PATH, { force: true }); // simulate a fresh machine
  const freshCwd = fs.mkdtempSync(path.join(os.tmpdir(), "eaon-freetier-"));
  const wrote = applyFreeTier(freshCwd);
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  check("free tier auto-config writes the provider", wrote === true && cfg.providers.some((p) => p.id === "osaii"));
  check("free tier sets main to a poolside model", cfg.main?.provider === "osaii" && cfg.main?.model.startsWith("poolside/"));
  check("free tier is single-model (no compressor)", cfg.compressor === undefined);
  const again = applyFreeTier(freshCwd);
  check("free tier auto-config is idempotent", again === false);
}

// ------------------------------------------------- provider & model CRUD helpers
{
  const { addProviderModel, removeProvider, removeProviderModel, renameProviderModel, updateProvider } = await import("../dist/config.js");

  const baseCfg = () => ({
    version: 1,
    providers: [{ id: "echo", name: "Echo", type: "echo", models: ["echo-1"] }],
    main: { provider: "echo", model: "echo-1" },
    compressor: { provider: "echo", model: "echo-1" },
    compression: { enabled: true, keepLast: 5, thresholdTokens: 20000 },
    caveman: { enabled: false, level: "off" },
    permissions: { mode: "auto", allow: [] },
    mcpServers: {},
    ui: { showTokens: true, maxToolResultChars: 12000, theme: "midnight" },
  });

  const cfg = baseCfg();

  check("addProviderModel appends a model", addProviderModel(cfg, "echo", "echo-2") === true);
  check("addProviderModel rejects duplicates", addProviderModel(cfg, "echo", "echo-2") === false);
  check("added model is present", cfg.providers[0].models.includes("echo-2"));

  check("updateProvider changes the display name", updateProvider(cfg, "echo", { name: "Echo Offline" })?.name === "Echo Offline");
  check("updateProvider clears baseUrl when set to null", updateProvider(cfg, "echo", { baseUrl: null })?.baseUrl === undefined);

  check("renameProviderModel updates model id", renameProviderModel(cfg, "echo", "echo-2", "echo-second") === true);
  check("renamed model is gone", !cfg.providers[0].models.includes("echo-2"));
  check("renamed model is present", cfg.providers[0].models.includes("echo-second"));
  check("main ref follows renamed model", cfg.main.model === "echo-1");
  check("renameProviderModel rejects duplicate names", renameProviderModel(cfg, "echo", "echo-1", "echo-second") === false);

  check("removeProviderModel drops a model", removeProviderModel(cfg, "echo", "echo-second").removed === true);
  check("removed model is gone", !cfg.providers[0].models.includes("echo-second"));

  check("removeProvider deletes the provider and fixes main refs", (() => {
    const c = baseCfg();
    c.providers.push({ id: "fallback", name: "Fallback", type: "openai", baseUrl: "http://localhost:1/v1", models: ["fallback-m1"] });
    const res = removeProvider(c, "echo");
    return res.removed && c.providers.length === 1 && c.main.provider === "fallback" && c.main.model === "fallback-m1" && c.compressor === undefined;
  })());

  check("removeProvider clears main when no fallback exists", (() => {
    const c = baseCfg();
    const res = removeProvider(c, "echo");
    return res.removed && c.providers.length === 0 && c.main === undefined;
  })());
}

testSummary("backend.test");
process.exit(0);
