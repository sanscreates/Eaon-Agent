// ${VAR} expansion from process.env. Leaf module (no imports) so provider
// backends can use it without a config → registry → backend import cycle.

/** Expand ${VAR} references in a string from process.env. */
export function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}
