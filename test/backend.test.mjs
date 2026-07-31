// Provider-backend and MCP regression tests — all offline.

import { check, testSummary } from "./helpers.mjs";

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

testSummary("backend.test");
process.exit(0);
