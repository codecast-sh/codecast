import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { injectViaTmux } from "./daemon.js";
import { tmuxRun } from "./tmux.js";

// End-to-end regression for the "211" bug (root-caused 2026-06-27 against Claude Code).
//
// Answering a multi-question AskUserQuestion with a mix of menu picks and a custom
// ("Other") free-text answer used to: (1) Escape mid-loop, declining the WHOLE poll, then
// (2) dribble the remaining option digits ("2","1","1") into the reopened prompt box. The
// fix: a free-text answer declines the menu exactly ONCE (Escape) and types the answer; the
// leftover option digits are never sent.
//
// This drives the REAL injectViaTmux against a fake menu that, on Escape, captures every
// byte typed afterward — so we can assert the answer lands AND that no stray option digits
// follow it. Needs tmux + python3; skips (not fails) where they're unavailable.

function have(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN = have("tmux") && have("python3");

// A fake interactive menu that mirrors the Claude TUI's alt-screen + raw mode. On Escape it
// leaves the alt screen, prints DECLINED, then echoes everything typed for the next ~2s as
// CAPTURED=[...] (CR/LF made visible). Digits are kept verbatim so a dribble would show.
const FAKE_MENU = `
import sys, tty, termios, select
ESC = chr(27)
CR = chr(13) + chr(10)
ALT_ON = ESC + "[?1049h"
ALT_OFF = ESC + "[?1049l"
CLEAR = ESC + "[2J" + ESC + "[H"
CURSOR = chr(0x276f)
options = ["Alpha", "Bravo", "Charlie"]
sel = 0
def render():
    parts = [CLEAR, "Which option?" + CR]
    for i, o in enumerate(options):
        mark = CURSOR if i == sel else " "
        parts.append(mark + " " + str(i + 1) + ". " + o + CR)
    parts.append("Enter to select / up down to navigate / Esc to cancel" + CR)
    sys.stdout.write("".join(parts))
    sys.stdout.flush()
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    sys.stdout.write(ALT_ON)
    sys.stdout.flush()
    render()
    while True:
        ch = sys.stdin.read(1)
        if ch in ("1", "2", "3"):
            sel = int(ch) - 1
            render()
        elif ch == chr(13) or ch == chr(10):
            pass
        elif ch == ESC:
            sys.stdout.write(ALT_OFF + "DECLINED" + CR)
            sys.stdout.flush()
            captured = ""
            while True:
                r, _, _ = select.select([fd], [], [], 2.0)
                if not r:
                    break
                c = sys.stdin.read(1)
                if not c:
                    break
                captured += c
            shown = captured.replace(chr(13), "<CR>").replace(chr(10), "<LF>")
            sys.stdout.write("CAPTURED=[" + shown + "]" + CR)
            sys.stdout.flush()
            break
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

function killSessionQuiet(session: string): void {
  tmuxRun(["kill-session", "-t", session]);
}
function capture(target: string): string {
  return tmuxRun(["capture-pane", "-p", "-J", "-t", target, "-S", "-80"]).stdout;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(150);
  }
  return fn();
}

describe.skipIf(!CAN_RUN)("injectViaTmux poll: a free-text answer declines once, no digit dribble", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-decline-test-"));
  const pyPath = path.join(tmpDir, "fakemenu.py");
  fs.writeFileSync(pyPath, FAKE_MENU);

  async function runPayload(label: string, payload: object): Promise<string> {
    const session = `cc-decline-${label}-${process.pid}`;
    const target = `${session}:0.0`;
    killSessionQuiet(session);
    tmuxRun(["new-session", "-d", "-s", session, "-x", "120", "-y", "40", `python3 ${pyPath}; echo __DONE__; sleep 60`]);
    try {
      const menuUp = await waitFor(() => capture(target).includes("Which option?"), 10_000);
      expect(menuUp).toBe(true);
      await injectViaTmux(target, JSON.stringify(payload));
      const done = await waitFor(() => capture(target).includes("CAPTURED="), 10_000);
      expect(done).toBe(true);
      return capture(target);
    } finally {
      killSessionQuiet(session);
    }
  }

  // What the web sends today for a custom answer: prose in `text`, no menu keys.
  test(
    "text-only payload: menu is declined and the answer is typed",
    async () => {
      const out = await runPayload("text", { __cc_poll: true, text: "useZEBRAintro" });
      expect(out).toContain("DECLINED");
      const captured = out.match(/CAPTURED=\[([^\]]*)\]/)?.[1] ?? "";
      expect(captured).toContain("ZEBRA");
      // No menu keystrokes exist in this payload, so nothing but the answer is typed.
      expect(captured.replace(/<CR>|<LF>/g, "")).not.toMatch(/\d/);
    },
    30_000,
  );

  // The exact pre-fix shape that produced "211": one Other step plus trailing option
  // digits. The fix must decline once, type the Other text, and send NONE of the digits.
  test(
    "old embedded-text shape: the trailing option digits never dribble in",
    async () => {
      const out = await runPayload("steps", {
        __cc_poll: true,
        steps: [{ key: "5", text: "useZEBRAintro" }, { key: "2" }, { key: "1" }, { key: "1" }],
      });
      expect(out).toContain("DECLINED");
      const captured = out.match(/CAPTURED=\[([^\]]*)\]/)?.[1] ?? "";
      expect(captured).toContain("ZEBRA");
      // The "2","1","1" steps must NOT be replayed after the decline (the "211" bug).
      expect(captured.replace(/<CR>|<LF>/g, "")).not.toMatch(/\d/);
    },
    30_000,
  );
});
