// Compression regression tests — run entirely offline against the echo provider.

import { check, testSummary } from "./helpers.mjs";

const { Runtime } = await import("../dist/core/runtime.js");
const { Agent } = await import("../dist/core/agent.js");
const { compressIfNeeded, COMPRESSED_OPEN } = await import("../dist/core/compressor.js");
const { estimateMessages } = await import("../dist/tokens.js");

function rt() {
  return new Runtime({ headless: true, autoYes: true });
}

const bulk = (n) => "x".repeat(n);

/** One user turn followed by many assistant/tool round trips — the shape a real
 *  agentic turn has, and the shape that used to be uncompressible. */
function toolHeavyHistory(pairs = 20) {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "Refactor the auth module." },
  ];
  for (let i = 0; i < pairs; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, name: "read_file", args: { path: `src/f${i}.ts` } }] });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, name: "read_file", content: `file ${i}\n` + bulk(4000) });
  }
  return msgs;
}

// ---------------------------------------------------------------- 1
{
  const r = rt();
  r.cfg.compression.thresholdTokens = 5000;
  const msgs = toolHeavyHistory();
  const before = estimateMessages(msgs);
  const res = await compressIfNeeded(r, msgs);
  check("tool-heavy single turn is compressed", res.compressed === true);
  check("tool-heavy compression shrinks the history", estimateMessages(msgs) < before);
  check("compressed block is present", msgs.some((m) => m.content?.startsWith(COMPRESSED_OPEN)));
  r.shutdown();
}

// ---------------------------------------------------------------- 2
{
  const r = rt();
  r.cfg.compression.thresholdTokens = 5000;
  const msgs = toolHeavyHistory();
  await compressIfNeeded(r, msgs);
  // every tool result must still have its originating tool_call in history
  const ids = new Set(msgs.flatMap((m) => (m.tool_calls ?? []).map((t) => t.id)));
  const orphans = msgs.filter((m) => m.role === "tool" && !ids.has(m.tool_call_id));
  check("no orphaned tool results after compression", orphans.length === 0);
  // and no assistant tool_call may be left without its result
  const resultIds = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  const dangling = msgs.flatMap((m) => (m.tool_calls ?? [])).filter((t) => !resultIds.has(t.id));
  check("no dangling tool calls after compression", dangling.length === 0);
  r.shutdown();
}

// ---------------------------------------------------------------- 3
{
  const r = rt();
  const a = new Agent(r);
  // give the main agent a history worth compressing
  a.messages.push(...toolHeavyHistory(10).slice(1));
  const beforeLen = a.messages.length;

  await r.runSubagent("say hi"); // sub-agents must not steal the runtime hooks

  const out = await r.compressNow();
  check("compressNow still targets the main agent after a sub-agent ran", out.startsWith("Compressed"));
  check("main agent history actually shrank", a.messages.length < beforeLen);
  r.shutdown();
}

// ---------------------------------------------------------------- 4
{
  const r = rt();
  r.cfg.compression.thresholdTokens = 5000;
  const msgs = toolHeavyHistory(60); // ~240k chars of tool output
  let seen = 0;
  const orig = (await import("../dist/providers/echo.js")).echoBackend.chat;
  (await import("../dist/providers/echo.js")).echoBackend.chat = async (params, cfg, onEvent) => {
    seen = Math.max(seen, params.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0));
    return orig(params, cfg, onEvent);
  };
  await compressIfNeeded(r, msgs);
  (await import("../dist/providers/echo.js")).echoBackend.chat = orig;
  check(`compressor input is bounded (saw ${seen} chars)`, seen < 120_000);
  r.shutdown();
}

// ---------------------------------------------------------------- 5
{
  const r = rt();
  r.cfg.compression.thresholdTokens = 5000;
  const msgs = toolHeavyHistory(20);
  await compressIfNeeded(r, msgs);
  const first = msgs.length;
  await compressIfNeeded(r, msgs); // nothing new happened since
  check("re-compressing an already-compressed history is a no-op", msgs.length === first);
  r.shutdown();
}

// ---------------------------------------------------------------- 6
{
  // Providers reject two messages of the same role in a row, so the block that
  // replaces the region must fit the tail it is spliced in front of.
  const alternates = (msgs) => {
    for (let i = 1; i < msgs.length; i++) {
      const a = msgs[i - 1].role;
      const b = msgs[i].role;
      if (a === "tool" || b === "tool") continue;
      if (a === b) return false;
    }
    return true;
  };

  for (const pairs of [7, 8, 9, 10]) {
    const r = rt();
    r.cfg.compression.thresholdTokens = 5000;
    const msgs = toolHeavyHistory(pairs);
    msgs.push({ role: "assistant", content: "done" }, { role: "user", content: "now the tests" });
    const res = await compressIfNeeded(r, msgs);
    check(`roles still alternate after compressing ${pairs} pairs`, res.compressed && alternates(msgs));
    r.shutdown();
  }
}

// ---------------------------------------------------------------- 7
{
  // A tail of oversized messages must not be kept whole — otherwise the context
  // stays over threshold and every following turn pays for another compression.
  const r = rt();
  r.cfg.compression.thresholdTokens = 8000;
  r.cfg.compression.keepLast = 5;
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
  ];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, name: "grep", args: { pattern: "x" } }] });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, name: "grep", content: bulk(20_000) });
  }
  await compressIfNeeded(r, msgs);
  check("oversized tail is trimmed below threshold", estimateMessages(msgs) < 8000 * 1.1);
  r.shutdown();
}

// ---------------------------------------------------------------- 8
{
  const { toolSchemas } = await import("../dist/tools/index.js");
  const sub = toolSchemas({ forSubagent: true }).map((t) => t.name);
  check("sub-agents cannot spawn nested sub-agents", !sub.includes("spawn_agent"));
  check("sub-agents cannot compress the main context", !sub.includes("compress_now"));
  check("sub-agents keep the file tools", sub.includes("read_file") && sub.includes("edit_file"));
}

// ---------------------------------------------------------------- 9
{
  const { isReadOnlyCommand } = await import("../dist/tools/shell.js");
  check("git status is cacheable", isReadOnlyCommand("git status"));
  check("git commit is not cacheable", !isReadOnlyCommand("git commit -m x"));
  check("npm test is not cacheable", !isReadOnlyCommand("npm test"));
  check("chained command is not treated as read-only", !isReadOnlyCommand("ls . ; rm -rf /tmp/x"));
  check("piped command is not treated as read-only", !isReadOnlyCommand("cat a | sh"));
  check("command substitution is not treated as read-only", !isReadOnlyCommand("echo `rm -rf x`"));
}

testSummary("compression.test");
process.exit(0);
