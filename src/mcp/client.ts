// Minimal MCP client (stdio, newline-delimited JSON-RPC). No SDK dependency.
// Servers start lazily on first use and stay alive for the session.

import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "../types.js";

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
/** A server spewing newline-free output would otherwise grow the buffer until
 *  the process runs out of memory. */
const MAX_BUFFER = 8_000_000;

export class McpConnection {
  private child: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private startPromise: Promise<void> | null = null;

  constructor(private name: string, private cfg: McpServerConfig) {}

  private async ensureStarted(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const attempt = this.start();
    this.startPromise = attempt;
    try {
      await attempt;
    } catch (e) {
      // Don't cache the failure: a server that was not installed yet, or a
      // machine that was briefly out of memory, should get another chance.
      if (this.startPromise === attempt) this.startPromise = null;
      throw e;
    }
  }

  private async start(): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    // Without this listener a missing binary emits an unhandled 'error' event,
    // which takes the whole agent down over one typo in mcpServers config.
    child.on("error", (e) => this.failAll(new Error(`MCP server '${this.name}' failed to start: ${e.message}`)));
    child.stderr?.on("data", () => {}); // swallow server chatter
    child.stdout?.on("data", (d) => this.onData(d.toString()));
    child.on("exit", (code) => this.failAll(new Error(`MCP server '${this.name}' exited${code === null ? "" : ` (code ${code})`}`)));
    // A stdio server that cannot complete the handshake quickly is broken;
    // waiting the full call timeout just stalls the agent.
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "eaon-agent", version: "1.4.0" },
    }, HANDSHAKE_TIMEOUT_MS);
    this.notify("notifications/initialized", {});
  }

  private onData(data: string): void {
    this.buf += data;
    if (this.buf.length > MAX_BUFFER) {
      this.failAll(new Error(`MCP server '${this.name}' sent ${this.buf.length} bytes without a newline`));
      this.buf = "";
      return;
    }
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // A JSON-RPC response carries `result` or `error` and never `method`.
      // Without that check anything echoing our own request back — a
      // misconfigured command like `cat` — reads as a successful empty reply.
      if (msg.method !== undefined) continue;
      if (msg.id === undefined || !this.pending.has(msg.id)) continue;
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else if (!("result" in msg)) p.reject(new Error(`MCP server '${this.name}' sent a malformed response`));
      else p.resolve(msg.result);
    }
  }

  private failAll(e: Error): void {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.buf = "";
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    try {
      child?.kill();
    } catch {}
  }

  private request(method: string, params: any, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) return reject(new Error(`MCP server '${this.name}' not running`));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP '${this.name}' ${method} timed out (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e: any) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`MCP server '${this.name}' write failed: ${e?.message ?? e}`));
      }
    });
  }

  private notify(method: string, params: any): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: any }[]> {
    await this.ensureStarted();
    const res = await this.request("tools/list", {});
    return res?.tools ?? [];
  }

  async callTool(tool: string, args: Record<string, any>): Promise<string> {
    await this.ensureStarted();
    const res = await this.request("tools/call", { name: tool, arguments: args });
    if (res?.isError) {
      const txt = (res.content ?? []).map((c: any) => c.text ?? "").join("\n");
      throw new Error(txt || "MCP tool error");
    }
    const parts = (res?.content ?? []).map((c: any) => {
      if (c.type === "text") return c.text;
      if (c.type === "resource") return c.resource?.text ?? JSON.stringify(c.resource);
      return JSON.stringify(c);
    });
    return parts.join("\n") || "(empty result)";
  }

  kill(): void {
    try {
      this.child?.kill();
    } catch {}
    this.failAll(new Error("killed"));
  }
}

export class McpManager {
  private conns = new Map<string, McpConnection>();

  constructor(private servers: Record<string, McpServerConfig>) {}

  names(): string[] {
    return Object.keys(this.servers);
  }

  private conn(name: string): McpConnection {
    const cfg = this.servers[name];
    if (!cfg) throw new Error(`Unknown MCP server '${name}'. Configured: ${this.names().join(", ") || "(none)"}`);
    let c = this.conns.get(name);
    if (!c) {
      c = new McpConnection(name, cfg);
      this.conns.set(name, c);
    }
    return c;
  }

  async listToolsText(name: string): Promise<string> {
    const tools = await this.conn(name).listTools();
    if (!tools.length) return `Server '${name}' exposes no tools.`;
    return tools
      .map((t) => `- ${t.name}: ${(t.description ?? "").slice(0, 200)}\n  schema: ${JSON.stringify(t.inputSchema ?? {}).slice(0, 500)}`)
      .join("\n");
  }

  async callToolText(name: string, tool: string, args: Record<string, any>): Promise<string> {
    const out = await this.conn(name).callTool(tool, args);
    return out.length > 20_000 ? out.slice(0, 20_000) + "\n… (truncated)" : out;
  }

  killAll(): void {
    for (const c of this.conns.values()) c.kill();
    this.conns.clear();
  }
}
