// Minimal line-based unified diff (LCS). Good enough for edit previews.

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

export function diffLines(oldText: string, newText: string, context = 3): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  // Peel off the identical head and tail before doing any real work. An
  // edit_file that touches three lines of a 3000-line file would otherwise pay
  // for a 3000x3000 LCS table on every single preview.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const n = midA.length;
  const m = midB.length;
  // LCS DP — cap to keep memory sane on huge rewrites
  if (n * m > 4_000_000) {
    return [
      { kind: "del", text: `(${a.length} lines removed)` },
      { kind: "add", text: `(${b.length} lines added)` },
    ];
  }

  const ops: DiffLine[] = [];
  const headSkipped = Math.max(0, pre - context);
  for (let k = headSkipped; k < pre; k++) ops.push({ kind: "ctx", text: a[k] });

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ kind: "ctx", text: midA[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", text: midA[i++] });
    } else {
      ops.push({ kind: "add", text: midB[j++] });
    }
  }
  while (i < n) ops.push({ kind: "del", text: midA[i++] });
  while (j < m) ops.push({ kind: "add", text: midB[j++] });

  const tailStart = a.length - suf;
  const tailEnd = Math.min(a.length, tailStart + context);
  for (let k = tailStart; k < tailEnd; k++) ops.push({ kind: "ctx", text: a[k] });

  // trim to hunks with `context` lines around changes
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].kind !== "ctx") {
      for (let t = Math.max(0, k - context); t <= Math.min(ops.length - 1, k + context); t++) keep[t] = true;
    }
  }
  const out: DiffLine[] = [];
  let skipping = false;
  for (let k = 0; k < ops.length; k++) {
    if (keep[k]) {
      if (skipping) out.push({ kind: "ctx", text: "  ⋮" });
      skipping = false;
      out.push(ops[k]);
    } else {
      skipping = true;
    }
  }
  if (!out.length) return out;
  // Mark the identical head/tail we never rendered, same as any other gap.
  if (headSkipped > 0) out.unshift({ kind: "ctx", text: "  ⋮" });
  if (tailEnd < a.length) out.push({ kind: "ctx", text: "  ⋮" });
  return out;
}

export function formatDiff(oldText: string, newText: string): string {
  return diffLines(oldText, newText)
    .map((l) => (l.kind === "add" ? `+ ${l.text}` : l.kind === "del" ? `- ${l.text}` : `  ${l.text}`))
    .join("\n");
}
