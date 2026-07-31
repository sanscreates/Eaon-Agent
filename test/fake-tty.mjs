// Minimal fake TTY for rendering the Ink app in tests, in the spirit of
// ink-testing-library but with a complete stdin (Ink 4.4 calls ref()/unref()
// when enabling raw mode, which ink-testing-library@3 does not implement).

import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";

export class FakeStdout extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this._lastFrame = undefined;
  }
  get columns() {
    return 100;
  }
  get rows() {
    return 24;
  }
  write = (frame) => {
    this.frames.push(frame);
    this._lastFrame = frame;
    return true;
  };
  lastFrame = () => this._lastFrame;
}

export class FakeStderr extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this._lastFrame = undefined;
  }
  write = (frame) => {
    this.frames.push(frame);
    this._lastFrame = frame;
    return true;
  };
  lastFrame = () => this._lastFrame;
}

export class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this._buffer = [];
  }
  isTTY = true;
  write = (data) => {
    this._buffer.push(String(data));
    this.emit("readable");
  };
  /** Type text key-by-key, like a real terminal delivers keystrokes. */
  type = (text) => {
    for (const ch of text) this.write(ch);
  };
  addListener(event, fn) {
    const r = super.addListener(event, fn);
    if (event === "readable" && this._buffer.length) setImmediate(() => this.emit("readable"));
    return r;
  }
  on(event, fn) {
    return this.addListener(event, fn);
  }
  read() {
    return this._buffer.length ? this._buffer.shift() : null;
  }
  setEncoding() {}
  setRawMode() {}
  ref() {}
  unref() {}
  resume() {}
  pause() {}
}

/** Render an Ink element against fake streams. debug:true -> full frames. */
export function renderFake(tree) {
  const stdout = new FakeStdout();
  const stderr = new FakeStderr();
  const stdin = new FakeStdin();
  const instance = inkRender(tree, {
    stdout,
    stderr,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    rerender: instance.rerender,
    unmount: instance.unmount,
    cleanup: instance.cleanup,
    stdout,
    stderr,
    stdin,
    frames: stdout.frames,
    lastFrame: stdout.lastFrame,
  };
}
