// File system tools: read_file, write_file, edit_file, list_files, glob, grep.

import fs from "node:fs";
import path from "node:path";
import { bool, num, obj, registerTool, str } from "./index.js";
import { diffLines } from "../diff.js";
import { toolResultCache } from "../cache.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", "__pycache__", ".eaon"]);

function resolve(rt: { cwd: string }, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(rt.cwd, p);
}

function fmtSize(n: number): string {
  return n > 1024 ? (n / 1024).toFixed(1) + "KB" : n + "B";
}

registerTool({
  subagentOk: true,
  schema: {
    name: "read_file",
    description: "Read a file with line numbers. Use offset/limit for big files.",
    parameters: obj({
      path: str("File path (absolute or relative to cwd)"),
      offset: num("1-based line to start at (default 1)"),
      limit: num("Max lines to read (default 400)"),
    }, ["path"]),
  },
  async run(args, rt) {
    const p = resolve(rt, String(args.path));
    if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return `Error: ${p} is a directory. Use list_files.`;
    if (stat.size > 2_000_000) return `Error: file too large (${fmtSize(stat.size)}). Read with offset/limit chunks.`;
    const lines = fs.readFileSync(p, "utf8").split("\n");
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.min(2000, Number(args.limit ?? 400));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((l, i) => `${offset + i}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
    const note = offset + limit - 1 < lines.length ? `\n(${lines.length - (offset + limit - 1)} more lines — use offset)` : "";
    return `${p} (${lines.length} lines)\n${body}${note}`;
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "write_file",
    description: "Create or overwrite a file with full content. Parent dirs are created.",
    parameters: obj({
      path: str("File path"),
      content: str("Full file content"),
    }, ["path", "content"]),
  },
  async run(args, rt) {
    const p = resolve(rt, String(args.path));
    const content = rt.macros.expandText(String(args.content ?? ""));
    const existed = fs.existsSync(p);
    const old = existed ? fs.readFileSync(p, "utf8") : "";
    const d = existed ? diffLines(old, content).slice(0, 60).map((l) => (l.kind === "add" ? `+${l.text}` : l.kind === "del" ? `-${l.text}` : ` ${l.text}`)).join("\n") : `(new file, ${content.split("\n").length} lines)`;
    const ok = await rt.permissions.check({ kind: "write", label: `${existed ? "Overwrite" : "Create"} ${path.relative(rt.cwd, p) || p}`, detail: d });
    if (!ok) return "Denied by user.";
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    toolResultCache.clear();
    rt.hooks.onNotice?.(`${existed ? "Updated" : "Created"} ${p}`);
    return `OK — wrote ${fmtSize(Buffer.byteLength(content))} to ${p}`;
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "edit_file",
    description: "Exact string replacement in a file. old_string must match uniquely (or use replace_all). Prefer this over write_file for edits — saves tokens.",
    parameters: obj({
      path: str("File path"),
      old_string: str("Exact text to replace (must be unique in file)"),
      new_string: str("Replacement text"),
      replace_all: bool("Replace every occurrence (default false)"),
    }, ["path", "old_string", "new_string"]),
  },
  async run(args, rt) {
    const p = resolve(rt, String(args.path));
    if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
    const oldStr = String(args.old_string ?? "");
    const newStr = rt.macros.expandText(String(args.new_string ?? ""));
    if (oldStr === newStr) return "Error: old_string and new_string are identical.";
    const text = fs.readFileSync(p, "utf8");
    const count = text.split(oldStr).length - 1;
    if (count === 0) return "Error: old_string not found in file.";
    if (count > 1 && !args.replace_all) return `Error: old_string occurs ${count} times. Add context to make it unique, or set replace_all.`;
    const updated = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    const d = diffLines(text, updated).slice(0, 80).map((l) => (l.kind === "add" ? `+${l.text}` : l.kind === "del" ? `-${l.text}` : ` ${l.text}`)).join("\n");
    const ok = await rt.permissions.check({ kind: "edit", label: `Edit ${path.relative(rt.cwd, p) || p} (${count} replacement${count > 1 ? "s" : ""})`, detail: d });
    if (!ok) return "Denied by user.";
    fs.writeFileSync(p, updated, "utf8");
    toolResultCache.clear();
    rt.hooks.onNotice?.(`Edited ${p}`);
    return `OK — ${count} replacement${count > 1 ? "s" : ""} in ${p}`;
  },
});

function walk(root: string, maxDepth: number, maxEntries: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let count = 0;
  let truncated = false;
  const rec = (dir: string, prefix: string, depth: number) => {
    if (depth > maxDepth || truncated) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (e.name.startsWith(".") && e.name !== ".eaon") continue;
      if (SKIP_DIRS.has(e.name)) continue;
      if (++count > maxEntries) {
        truncated = true;
        return;
      }
      lines.push(prefix + (e.isDirectory() ? e.name + "/" : e.name));
      if (e.isDirectory()) rec(path.join(dir, e.name), prefix + "  ", depth + 1);
    }
  };
  rec(root, "", 1);
  return { lines, truncated };
}

registerTool({
  subagentOk: true,
  schema: {
    name: "list_files",
    description: "Directory tree (skips node_modules/.git/etc).",
    parameters: obj({
      path: str("Directory (default: cwd)"),
      depth: num("Max depth (default 2)"),
    }, []),
  },
  async run(args, rt) {
    const p = resolve(rt, String(args.path ?? "."));
    if (!fs.existsSync(p)) return `Error: not found: ${p}`;
    const { lines, truncated } = walk(p, Math.min(6, Number(args.depth ?? 2)), 400);
    return `${p}\n${lines.join("\n")}${truncated ? "\n… (truncated)" : ""}`;
  },
});

function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      let j = i;
      while (j < pattern.length && pattern[j] !== "}") j++;
      const alts = pattern.slice(i + 1, j).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"));
      re += `(${alts.join("|")})`;
      i = j;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

registerTool({
  subagentOk: true,
  schema: {
    name: "glob",
    description: "Find files by glob pattern, e.g. 'src/**/*.ts'.",
    parameters: obj({
      pattern: str("Glob pattern"),
      path: str("Base directory (default: cwd)"),
    }, ["pattern"]),
  },
  async run(args, rt) {
    const base = resolve(rt, String(args.path ?? "."));
    const re = globToRegex(String(args.pattern));
    const matches: string[] = [];
    const rec = (dir: string) => {
      if (matches.length >= 200) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= 200) return;
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".eaon")) continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(base, full);
        if (e.isDirectory()) rec(full);
        else if (re.test(rel)) matches.push(rel);
      }
    };
    rec(base);
    return matches.length ? matches.join("\n") : "No matches.";
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "grep",
    description: "Regex search across files. Returns file:line: match.",
    parameters: obj({
      pattern: str("Regular expression"),
      path: str("File or directory (default: cwd)"),
      include: str("Only search files matching glob, e.g. '*.ts'"),
      ignore_case: bool("Case-insensitive (default false)"),
    }, ["pattern"]),
  },
  async run(args, rt) {
    const base = resolve(rt, String(args.path ?? "."));
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern), args.ignore_case ? "i" : "");
    } catch (e: any) {
      return `Error: bad regex: ${e.message}`;
    }
    const inc = args.include ? globToRegex(String(args.include)) : null;
    const hits: string[] = [];
    const maxHits = 100;
    const searchFile = (f: string) => {
      if (hits.length >= maxHits) return;
      let text: string;
      try {
        const st = fs.statSync(f);
        if (st.size > 1_000_000) return;
        text = fs.readFileSync(f, "utf8");
      } catch {
        return;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
        if (re.test(lines[i])) hits.push(`${path.relative(rt.cwd, f)}:${i + 1}: ${lines[i].slice(0, 300)}`);
      }
    };
    const rec = (dir: string) => {
      if (hits.length >= maxHits) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= maxHits) return;
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) rec(full);
        else if (!inc || inc.test(e.name)) searchFile(full);
      }
    };
    if (fs.statSync(base).isDirectory()) rec(base);
    else searchFile(base);
    return hits.length ? hits.join("\n") + (hits.length >= maxHits ? `\n… (capped at ${maxHits})` : "") : "No matches.";
  },
});
