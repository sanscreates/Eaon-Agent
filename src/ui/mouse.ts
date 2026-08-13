// Mouse support: SGR extended mouse reporting (wheel + clicks).
//
// The terminal is asked for `\x1b[?1000h` (clicks), `\x1b[?1002h` (drags)
// and `\x1b[?1006h` (SGR coordinates). Events then arrive on stdin as
// `\x1b[<button;x;yM` (press/wheel) and `\x1b[<button;x;ym` (release).
// Ink's keypress parser does not know these CSI sequences: it strips the
// leading ESC and delivers the rest — `[<64;15;7M` — as plain `input`
// text with every key flag false. So parsing works from the string alone
// and every text-input component must ignore these sequences (they would
// otherwise be inserted as literal text).

export type MouseKind = "wheel-up" | "wheel-down" | "press" | "release" | "other";

export interface MouseEvent {
  kind: MouseKind;
  button: number;
  /** 1-based terminal cell coordinates. */
  x: number;
  y: number;
}

const MOUSE_RE = /\[<(\d+);(\d+);(\d+)([Mm])/g;

/** True when an Ink `input` chunk carries (or is) a mouse sequence. */
export function isMouseInput(input: string): boolean {
  return input.startsWith("[<") && /\[<\d+;\d+;\d+[Mm]/.test(input);
}

/** Parse every mouse event contained in an Ink `input` chunk. */
export function parseMouseEvents(input: string): MouseEvent[] {
  if (!isMouseInput(input)) return [];
  const out: MouseEvent[] = [];
  MOUSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MOUSE_RE.exec(input))) {
    const button = parseInt(m[1], 10);
    const x = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    const final = m[4];
    let kind: MouseKind;
    if (button === 64) kind = "wheel-up";
    else if (button === 65) kind = "wheel-down";
    else if (final === "m") kind = "release";
    else if (button === 0) kind = "press";
    else kind = "other"; // drags, motion, middle/right buttons
    out.push({ kind, button, x, y });
  }
  return out;
}

/** A clickable screen region, in 1-based terminal cells (inclusive). */
export interface ClickRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Stable id for press/release pairing. */
  id: string;
  onClick: () => void;
}

export function inRegion(r: ClickRegion, x: number, y: number): boolean {
  return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
}

const ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1002l\x1b[?1006l\x1b[?1000l";

/**
 * Turn mouse reporting on while the app is mounted. The cleanup reverses
 * the modes so the terminal's own selection keeps working after exit.
 * Extra safety hooks restore the mode on SIGINT/SIGTERM paths that skip
 * React unmount.
 */
export function enableMouse(stdout: NodeJS.WriteStream): () => void {
  stdout.write(ENABLE);
  const restore = () => {
    try {
      stdout.write(DISABLE);
    } catch {
      /* stream already closed */
    }
  };
  process.once("SIGINT", restore);
  process.once("SIGTERM", restore);
  return () => {
    restore();
    process.off("SIGINT", restore);
    process.off("SIGTERM", restore);
  };
}
