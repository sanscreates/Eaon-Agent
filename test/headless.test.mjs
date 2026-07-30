// Headless smoke test with the offline echo provider — exercises the full
// agent loop (chat + tool call) without any API key.

import { check, testSummary } from "./helpers.mjs";

const { runHeadless } = await import("../dist/headless.js");

// capture stdout writes from runHeadless
let out = "";
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  out += String(chunk);
  return origWrite(chunk, ...rest);
};

const code1 = await runHeadless({ prompt: "hello eaon", yes: true, showStats: false });
check("headless plain prompt exits 0", code1 === 0);
check("headless echoes the prompt", out.includes("Echo: hello eaon"));

// echo provider emits a tool call for "tool:<name> <json>"
const code2 = await runHeadless({ prompt: 'tool:list_files {"path": "."}', yes: true, showStats: false });
check("headless tool-call run exits 0", code2 === 0);
check("tool loop completed", out.includes("Tool returned"));

process.stdout.write = origWrite;
testSummary("headless.test");
process.exit(0);
