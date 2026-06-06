import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { injectViaTmux } from "./daemon.js";

// Regression test for "clicking an AskUserQuestion option in the web card doesn't go
// through" (root-caused 2026-06-05 against Claude Code 2.1.166).
//
// The web sends the option as a poll keystroke: {__cc_poll, keys:["2"]}. The daemon's
// injectViaTmux used to send the bare digit. That works for a PLAIN AUQ menu (the digit
// auto-submits), but an AUQ whose options carry `preview`s renders side-by-side and the
// digit ONLY moves the highlight — its footer reads "Enter to select" — so the answer
// never landed. The fix is a closed loop: after the digit, if the SAME question is still
// on the pane, send Enter to confirm; if the menu is gone (auto-submitted), send nothing.
//
// This drives the REAL injectViaTmux against a tiny scripted menu that reproduces both
// behaviors, and asserts the selection lands in each. It needs tmux + python3; it skips
// (rather than fails) where they're unavailable so CI without them stays green.

function have(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN = have("tmux") && have("python3");

// A fake interactive menu. Uses the alternate screen + raw mode so it behaves like the
// Claude TUI: capture-pane sees the menu while it runs and the bare shell once it exits.
// `preview` mode: a digit moves the highlight, Enter confirms (mirrors a preview menu).
// `plain` mode: a digit auto-submits immediately (mirrors a plain menu).
const FAKE_MENU = `
import sys, tty, termios
ESC = chr(27)
CR = chr(13) + chr(10)
ALT_ON = ESC + "[?1049h"
ALT_OFF = ESC + "[?1049l"
CLEAR = ESC + "[2J" + ESC + "[H"
CURSOR = chr(0x276f)
mode = sys.argv[1] if len(sys.argv) > 1 else "preview"
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
def finish(result):
    sys.stdout.write(ALT_OFF + "RESULT=" + str(result) + CR)
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
            n = int(ch)
            if mode == "plain":
                finish(n)
                break
            sel = n - 1
            render()
        elif ch == chr(13) or ch == chr(10):
            if mode != "plain":
                finish(sel + 1)
                break
        elif ch == ESC:
            finish("ESC")
            break
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" }).toString();
}
function killSessionQuiet(session: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  } catch {}
}
function capture(target: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", target, "-S", "-80"], { encoding: "utf8" }).toString();
  } catch {
    return "";
  }
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

describe.skipIf(!CAN_RUN)("injectViaTmux poll: digit then Enter confirms a preview menu", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-poll-test-"));
  const pyPath = path.join(tmpDir, "fakemenu.py");
  fs.writeFileSync(pyPath, FAKE_MENU);

  async function runMode(mode: "preview" | "plain"): Promise<string> {
    const session = `cc-poll-${mode}-${process.pid}`;
    const target = `${session}:0.0`;
    killSessionQuiet(session);
    // Keep the pane alive after python exits so we can read RESULT off the main screen.
    tmux(["new-session", "-d", "-s", session, "-x", "120", "-y", "40", `python3 ${pyPath} ${mode}; echo __DONE__; sleep 60`]);
    try {
      const menuUp = await waitFor(() => capture(target).includes("Which option?"), 10_000);
      expect(menuUp).toBe(true);
      expect(capture(target)).not.toContain("RESULT=");

      // This is the exact payload the web card sends when the user clicks option 2.
      await injectViaTmux(target, JSON.stringify({ __cc_poll: true, keys: ["2"], display: "Bravo" }));

      const landed = await waitFor(() => capture(target).includes("RESULT="), 10_000);
      expect(landed).toBe(true);
      return capture(target);
    } finally {
      killSessionQuiet(session);
    }
  }

  test(
    "preview menu (digit only highlights): the follow-up Enter confirms option 2",
    async () => {
      const out = await runMode("preview");
      expect(out).toContain("RESULT=2");
    },
    30_000,
  );

  test(
    "plain menu (digit auto-submits): selection still lands, no regression",
    async () => {
      const out = await runMode("plain");
      expect(out).toContain("RESULT=2");
    },
    30_000,
  );
});
