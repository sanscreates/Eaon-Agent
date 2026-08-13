// Mouse wheel support: SGR extended mouse reporting (wheel only).
//
// The terminal is asked for `\x1b[?1000h` (button events — wheel scrolls
// arrive as buttons 64/65) and `\x1b[?1006h` (SGR coordinates). Events then
// arrive on stdin as `\x1b[<button;x;yM` (press/wheel) and `\x1b[<button;x;ym`
// (release). Ink's keypress parser does not know these CSI sequences: it
// strips the leading ESC and delivers the rest — `[<64;15;7M` — as plain
// `input` text with every key flag false. So detection works from the string
// alone, and every text-input component must ignore these sequences (they
// would otherwise be inserted as literal text).

/** True when an Ink `input` chunk carries (or is) a mouse sequence. */
export function isMouseInput(input: string): boolean {
  return input.startsWith("[<") && /\[<\d+;\d+;\d+[Mm]/.test(input);
}

const WHEEL_RE = /\[<(\d+);\d+;\d+M/g;

/**
 * Net wheel delta carried by an Ink `input` chunk: +1 per wheel-up notch,
 * -1 per wheel-down notch. Clicks and releases return 0 — only the wheel
 * is acted on.
 */
export function wheelDelta(input: string): number {
  if (!isMouseInput(input)) return 0;
  let delta = 0;
  WHEEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WHEEL_RE.exec(input))) {
    if (m[1] === "64") delta += 1;
    else if (m[1] === "65") delta -= 1;
  }
  return delta;
}

const ENABLE = "\x1b[?1000h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1000l";

/**
 * Turn mouse reporting on while the app is mounted (required for wheel
 * events). The cleanup reverses the modes so the terminal's own selection
 * keeps working after exit. Extra safety hooks restore the mode on
 * SIGINT/SIGTERM paths that skip React unmount.
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
