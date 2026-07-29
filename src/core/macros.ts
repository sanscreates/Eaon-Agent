// Macros — literal output snippets. A model writes <<macro:name>> and Eaon
// substitutes the user-defined text wherever it appears, including file writes.

import { deleteUserMacro, loadPlugins, loadUserMacros, saveUserMacro } from "../config.js";
import type { Macro } from "../types.js";

const MACRO_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MACRO_TOKEN = /<<macro:([A-Za-z][A-Za-z0-9_-]*)>>/g;

export class MacroRegistry {
  private macros = new Map<string, Macro>();

  constructor(cwd: string) {
    for (const p of loadPlugins(cwd)) {
      for (const [name, v] of Object.entries(p.macros ?? {})) {
        if (MACRO_NAME.test(name) && (v.text ?? v.prompt) !== undefined) {
          this.macros.set(name, { name, description: v.description ?? "", text: v.text ?? v.prompt ?? "" });
        }
      }
    }
    for (const m of loadUserMacros()) this.macros.set(m.name, m);
  }

  list(): Macro[] {
    return [...this.macros.values()];
  }

  get(name: string): Macro | undefined {
    return this.macros.get(name);
  }

  add(m: Macro): void {
    if (!MACRO_NAME.test(m.name)) throw new Error("Macro names must start with a letter and use only letters, numbers, _ or -.");
    saveUserMacro(m);
    this.macros.set(m.name, m);
  }

  remove(name: string): boolean {
    const ok = deleteUserMacro(name);
    if (ok) this.macros.delete(name);
    return ok;
  }

  /** Replace defined macro tokens. Unknown tokens remain visible for diagnosis. */
  expandText(input: string): string {
    return input.replace(MACRO_TOKEN, (token, name: string) => this.macros.get(name)?.text ?? token);
  }

  catalogText(): string {
    const all = this.list();
    if (!all.length) return "No macros are defined. There are no built-in macros.";
    return [
      "There are no built-in macros. Only these configured macros may be used:",
      ...all.map((m) => `- <<macro:${m.name}>>${m.description ? ` — ${m.description}` : ""}`),
    ].join("\n");
  }
}

/** Preserves streaming while withholding a partial macro token until complete. */
export class MacroStreamExpander {
  private pending = "";

  constructor(private macros: MacroRegistry) {}

  push(chunk: string): string {
    this.pending += chunk;
    const start = this.pending.indexOf("<<macro:");
    if (start < 0) return this.drainSafeSuffix();
    const end = this.pending.indexOf(">>", start + 8);
    if (end < 0) {
      const ready = this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      return ready;
    }
    const ready = this.pending.slice(0, end + 2);
    this.pending = this.pending.slice(end + 2);
    return this.macros.expandText(ready) + this.push("");
  }

  finish(): string {
    const text = this.macros.expandText(this.pending);
    this.pending = "";
    return text;
  }

  private drainSafeSuffix(): string {
    const marker = "<<macro:";
    const max = Math.min(marker.length - 1, this.pending.length);
    let keep = 0;
    for (let size = max; size > 0; size--) {
      if (this.pending.endsWith(marker.slice(0, size))) { keep = size; break; }
    }
    const ready = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    return ready;
  }
}
