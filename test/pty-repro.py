#!/usr/bin/env python3
"""Drive the REAL built TUI in a pseudo-terminal and verify chat history
stays visible when scrolling up (user bug: "scrolls, but no history").

Covers two real-terminal hazards that the fake-tty tests cannot reach:
  1. The full Ink render path (throttle + clearTerminal) against a real pty.
  2. Keystroke batching: when the OS delivers text and Enter in ONE read,
     Ink reports the whole chunk as input with key.return === false. The
     input must still submit (regression: messages never entered history,
     so scrolling showed an empty area).

Needs: npm run build first; python3 with pyte (pip install pyte).
Exit code 0 = all checks passed.
"""
import json, os, pty, struct, subprocess, tempfile, termios, time, fcntl, sys

import pyte

ROWS, COLS = 45, 120
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

home = tempfile.mkdtemp(prefix="eaon-pty-")
os.makedirs(os.path.join(home, ".eaon"), exist_ok=True)
json.dump({
    "version": 1,
    "providers": [{"id": "echo", "name": "Echo", "type": "echo", "models": ["echo-1"]}],
    "main": {"provider": "echo", "model": "echo-1"},
    "compressor": {"provider": "echo", "model": "echo-1"},
    "compression": {"enabled": True, "keepLast": 5, "thresholdTokens": 20000},
    "caveman": {"enabled": False, "level": "off"},
    "permissions": {"mode": "auto", "allow": []},
    "mcpServers": {},
    "ui": {"showTokens": True, "maxToolResultChars": 12000, "theme": "midnight"},
}, open(os.path.join(home, ".eaon", "config.json"), "w"))

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
env = dict(os.environ, HOME=home, TERM="xterm-256color")
proc = subprocess.Popen(["node", "dist/index.js"], stdin=slave, stdout=slave, stderr=slave,
                        env=env, cwd=ROOT, close_fds=True)
os.close(slave)

buf = b""
def pump(seconds):
    global buf
    import select
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                buf += os.read(master, 65536)
            except OSError:
                break

def send(s):
    os.write(master, s.encode())

def type_keys(s):
    # a real terminal delivers keystrokes in small batches; let Enter arrive
    # as its own chunk for the baseline flow
    for ch in s:
        os.write(master, ch.encode())
        time.sleep(0.003)
    pump(0.05)
    os.write(master, b"\r")

def screen_text():
    screen = pyte.Screen(COLS, ROWS)
    pyte.Stream(screen).feed(buf.decode("utf-8", errors="replace"))
    return screen.display

checks = []
def check(name, ok):
    checks.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name)

pump(1.5)
send("\r")            # dismiss welcome
pump(0.8)

# Baseline: normal typing builds history
for i in range(8):
    type_keys(f"history message {i}")
    pump(0.9)

# Hazard: text + Enter delivered as ONE chunk (busy render loop, paste, SSH)
os.write(master, b"batched submit works\r")
pump(1.2)

live = screen_text()
check("batched chunk submitted (Echo: batched submit works)",
      any("Echo: batched submit works" in l for l in live))
check("batched chunk not stuck in input box",
      not any("batched submit works▌" in l or "batched submit works ▌" in l for l in live))

send("\x1b[5~")       # PgUp
pump(0.6)
send("\x1b[5~")
pump(0.8)

scrolled = screen_text()
joined = "\n".join(scrolled)
check("scroll indicator visible after PgUp", "scrolled —" in joined)
check("early history visible while scrolled (history message 0/1/2)",
      any(f"history message {i}" in joined for i in (0, 1, 2)))
check("fixed top bar visible while scrolled", "EAON" in joined)
check("fixed input box visible while scrolled", any("▌" in l for l in scrolled))
check("fixed status bar visible while scrolled", "Ready" in joined)

send("\x1b[6~")       # PgDn back to live
pump(0.4)
send("\x1b[6~")
pump(0.6)
back = "\n".join(screen_text())
check("PgDn returns to live view", "scrolled —" not in back)
check("latest reply visible again", "Echo: batched submit works" in back)

proc.terminate()
try:
    proc.wait(timeout=3)
except subprocess.TimeoutExpired:
    proc.kill()

if any(not ok for _, ok in checks) or "--dump" in sys.argv:
    print("\n=== FINAL SCREEN AFTER PgUp (real TUI, real Ink path) ===")
    for i, line in enumerate(scrolled):
        print(f"{i:02}|{line}")

sys.exit(0 if all(ok for _, ok in checks) else 1)
