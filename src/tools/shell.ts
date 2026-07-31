// Shell tool with confirm-before-run + allowlist.

import { spawn } from "node:child_process";
import { toolResultCache } from "../cache.js";
import { num, obj, registerTool, str } from "./index.js";

const SAFE_PREFIXES = ["ls", "pwd", "echo", "cat", "head", "tail", "wc", "which", "whoami", "date", "uname", "git status", "git log", "git diff", "git show", "git branch"];

/** Commands that only observe: safe to skip the permission prompt, and safe to
 *  serve from cache. Anything with a shell operator can chain into a write, so
 *  it does not qualify however innocent the first word looks. */
export function isReadOnlyCommand(command: string): boolean {
  const c = command.trim();
  if (!c || /[;&|><`$(){}]/.test(c)) return false;
  return SAFE_PREFIXES.some((p) => c === p || c.startsWith(p + " "));
}

registerTool({
  subagentOk: true,
  schema: {
    name: "run_shell",
    description: "Run a shell command in the project directory. Output is captured and truncated. Use for builds, tests, git, package managers, etc.",
    parameters: obj({
      command: str("The shell command to run"),
      timeout: num("Timeout in seconds (default 60, max 600)"),
    }, ["command"]),
  },
  async run(args, rt) {
    const command = String(args.command ?? "").trim();
    if (!command) return "Error: empty command.";
    const timeoutSec = Math.min(600, Math.max(1, Number(args.timeout ?? 60)));

    const readOnly = isReadOnlyCommand(command);
    if (!readOnly) {
      const ok = await rt.permissions.checkShell(command);
      if (!ok) return "Denied by user.";
      // Anything that can write invalidates what we already read back.
      toolResultCache.clear();
    }

    return await new Promise<string>((resolveP) => {
      const child = spawn(command, { cwd: rt.cwd, shell: true, env: { ...process.env, FORCE_COLOR: "0", CI: "1", PAGER: "cat", GIT_PAGER: "cat" } });
      let out = "";
      let err = "";
      let killed = false;
      const cap = 30_000;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeoutSec * 1000);
      child.stdout?.on("data", (d) => {
        if (out.length < cap) out += d.toString();
      });
      child.stderr?.on("data", (d) => {
        if (err.length < cap) err += d.toString();
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolveP(`Error: ${e.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const parts: string[] = [];
        if (out.trim()) parts.push(out.length >= cap ? out.slice(0, cap) + "\n… (stdout truncated)" : out.trimEnd());
        if (err.trim()) parts.push("stderr:\n" + (err.length >= cap ? err.slice(0, cap) + "\n… (stderr truncated)" : err.trimEnd()));
        parts.push(killed ? `[killed after ${timeoutSec}s]` : `[exit ${code ?? "?"}]`);
        resolveP(parts.join("\n") || "[no output]");
      });
    });
  },
});
