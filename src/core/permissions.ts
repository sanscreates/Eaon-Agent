// Permissions — confirm-before-run with allowlist (default), auto, readonly.

import { saveConfig } from "../config.js";
import type { EaonConfig, PermissionDecision, PermissionRequest } from "../types.js";

export class Permissions {
  /** Session-only allowlist (exact shell commands). */
  private sessionAllow = new Set<string>();
  /** Prompts must run one at a time: parallel tool calls each asking at once
   *  overwrote each other's prompt (TUI/app keep a single prompt slot), and the
   *  overwritten request's promise never resolved — the agent hung forever. */
  private askQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private cfg: EaonConfig,
    private ask?: (req: PermissionRequest) => Promise<PermissionDecision>,
    private persistAllow = true,
  ) {}

  get mode(): "confirm" | "auto" | "readonly" {
    return this.cfg.permissions.mode;
  }

  setMode(mode: "confirm" | "auto" | "readonly"): void {
    this.cfg.permissions.mode = mode;
  }

  private askSerialized(req: PermissionRequest): Promise<PermissionDecision> {
    if (!this.ask) return Promise.resolve("deny");
    const ask = this.ask;
    const run = this.askQueue.then(() => ask(req));
    // Keep the chain alive regardless of individual outcomes.
    this.askQueue = run.catch(() => {});
    return run;
  }

  private allowedByList(command: string): boolean {
    if (this.sessionAllow.has(command)) return true;
    for (const pat of this.cfg.permissions.allow) {
      if (pat.endsWith("*")) {
        if (command.startsWith(pat.slice(0, -1))) return true;
      } else if (command === pat) return true;
    }
    return false;
  }

  /** Shell commands get pattern allowlisting. Returns true if approved. */
  async checkShell(command: string): Promise<boolean> {
    if (this.mode === "auto") return true;
    if (this.mode === "readonly") return false;
    if (this.allowedByList(command)) return true;
    if (!this.ask) return false;
    const decision = await this.askSerialized({ kind: "shell", label: "Run shell command", detail: command });
    if (decision === "always") {
      this.sessionAllow.add(command);
      if (this.persistAllow) {
        this.cfg.permissions.allow.push(command);
        try {
          saveConfig(this.cfg);
        } catch {}
      }
      return true;
    }
    return decision === "once";
  }

  /** Generic check for writes/edits/fetches/mcp calls. */
  async check(req: PermissionRequest): Promise<boolean> {
    if (this.mode === "auto") return true;
    if (this.mode === "readonly") {
      if (req.kind === "write" || req.kind === "edit") return false;
      if (req.kind === "fetch") return true;
    }
    if (!this.ask) return req.kind === "fetch"; // headless without --yes: allow reads only
    const decision = await this.askSerialized(req);
    return decision !== "deny";
  }
}
