// Ink/chalk wrap every styled segment in SGR reset sequences — chalk v5 uses
// granular resets: \x1b[39m (default foreground) and \x1b[22m/\x1b[23m/\x1b[24m
// (attribute offs), plus \x1b[0m for a full reset. The fg resets (0m, 39m)
// revert unstyled text to the terminal's DEFAULT foreground — black in light
// mode on macOS. Painting a default foreground once before the frame is not
// enough: the first styled element resets it, and every unstyled <Text> after
// that comes out black-on-dark. This module re-applies the theme's default
// foreground after every fg reset at the stream level, so unstyled text stays
// readable in any OS color mode without coloring every <Text> by hand.

let activeFgSeq = "";

/** Set by the theme background painter whenever the theme changes. */
export function setDefaultFgSeq(seq: string): void {
  activeFgSeq = seq;
}

/** Current default-foreground escape sequence ("" when not set). */
export function defaultFgSeq(): string {
  return activeFgSeq;
}

let installed = false;

/** Wrap a writable stream so every foreground reset (SGR 0/39) is followed by
 *  the active default-foreground sequence. Idempotent. Call before the UI
 *  renders its first frame. */
export function installDefaultFg(stream: NodeJS.WriteStream): void {
  if (installed) return;
  installed = true;
  const origWrite = stream.write.bind(stream);
  const fgReset = /\x1b\[(?:0|39)m/g;
  stream.write = ((chunk: any, encoding?: any, cb?: any): boolean => {
    if (!activeFgSeq) return origWrite(chunk, encoding, cb);
    if (typeof chunk === "string") {
      if (fgReset.test(chunk)) {
        fgReset.lastIndex = 0;
        chunk = chunk.replace(fgReset, (m: string) => `${m}${activeFgSeq}`);
      }
    } else if (Buffer.isBuffer(chunk) && fgReset.test(chunk.toString("binary"))) {
      fgReset.lastIndex = 0;
      chunk = chunk.toString("binary").replace(fgReset, (m: string) => `${m}${activeFgSeq}`);
    }
    return origWrite(chunk, encoding, cb);
  }) as any;
}
