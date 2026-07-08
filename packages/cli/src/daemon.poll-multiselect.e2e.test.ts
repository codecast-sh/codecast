import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { injectViaTmux } from "./daemon.js";
import { tmuxRun } from "./tmux.js";

// Covers the multiSelect AskUserQuestion key protocol (verified against Claude Code
// 2.1.201): on a multiSelect question a digit TOGGLES that option's checkbox and the
// menu stays up; Right advances to the next tab; the form parks on a final "Review
// your answers" pane whose cursor sits on "1. Submit answers".
//
// Two behaviors under test, against a fake TUI that mirrors the above:
// 1. A `multi` poll ({keys:["1","3","Right","Enter"], multi:true}) must be driven
//    verbatim. The closed-loop confirm (digit didn't advance → press Enter) that plain
//    polls rely on would re-toggle the highlighted row here and corrupt the selection.
// 2. A legacy multi-question poll (one digit per question, no trailing submit) stalls
//    on the review pane — CC ≥2.1.x no longer auto-continues. The daemon detects the
//    pane after the steps run and confirms it.
//
// Needs tmux + python3; skips (rather than fails) where they're unavailable.

function have(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN = have("tmux") && have("python3");

// A fake interactive form. Alternate screen + raw mode like the Claude TUI. Two modes:
// `multiselect`: one checkbox question — a digit moves the highlight to that row and
//   toggles it, Enter toggles the HIGHLIGHTED row (so a spurious confirm-Enter corrupts
//   state), Right advances to the review pane.
// `multiq`: two single-select questions — a digit answers and auto-advances; the form
//   then parks on the review pane (models CC ≥2.1.x no-auto-continue).
// Review pane: Enter or 1 submits, 2/Esc cancels.
const FAKE_FORM = `
import sys, tty, termios
ESC = chr(27)
CR = chr(13) + chr(10)
ALT_ON = ESC + "[?1049h"
ALT_OFF = ESC + "[?1049l"
CLEAR = ESC + "[2J" + ESC + "[H"
CURSOR = chr(0x276f)
mode = sys.argv[1] if len(sys.argv) > 1 else "multiselect"

def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()

def finish(result):
    out(ALT_OFF + "RESULT=" + str(result) + CR)

def read_key():
    ch = sys.stdin.read(1)
    if ch != ESC:
        return ch
    ch2 = sys.stdin.read(1)
    if ch2 in ("[", "O"):
        return "ARROW_" + sys.stdin.read(1)
    return "ESC"

FOOTER = "Enter to select / up down to navigate / Esc to cancel" + CR

def render_review():
    out(CLEAR + "Review your answers" + CR + "Ready to submit your answers?" + CR
        + CURSOR + " 1. Submit answers" + CR + "  2. Cancel" + CR + FOOTER)

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    out(ALT_ON)
    state = "form"
    if mode == "multiselect":
        checked = set()
        sel = 0
        def render_form():
            parts = [CLEAR, "Pick toppings" + CR]
            for i, o in enumerate(["Ham", "Olives", "Onion"]):
                mark = "[x]" if (i + 1) in checked else "[ ]"
                cur = CURSOR if i == sel else " "
                parts.append(cur + " " + str(i + 1) + ". " + mark + " " + o + CR)
            parts.append(FOOTER)
            out("".join(parts))
        render_form()
        while True:
            k = read_key()
            if state == "form":
                if k in ("1", "2", "3"):
                    sel = int(k) - 1
                    checked.symmetric_difference_update({int(k)})
                    render_form()
                elif k in (chr(13), chr(10)):
                    checked.symmetric_difference_update({sel + 1})
                    render_form()
                elif k == "ARROW_C":
                    state = "review"
                    render_review()
                elif k == "ESC":
                    finish("ESC")
                    break
            else:
                if k in (chr(13), chr(10), "1"):
                    finish(",".join(str(x) for x in sorted(checked)))
                    break
                if k in ("2", "ESC"):
                    finish("CANCELLED")
                    break
    else:
        answers = []
        questions = [("First question?", ["Alpha", "Bravo"]), ("Second question?", ["One", "Two"])]
        def render_q(qi):
            q, opts = questions[qi]
            parts = [CLEAR, q + CR]
            for i, o in enumerate(opts):
                cur = CURSOR if i == 0 else " "
                parts.append(cur + " " + str(i + 1) + ". " + o + CR)
            parts.append(FOOTER)
            out("".join(parts))
        qi = 0
        render_q(qi)
        while True:
            k = read_key()
            if state == "form":
                if k in ("1", "2"):
                    answers.append(k)
                    qi += 1
                    if qi >= len(questions):
                        state = "review"
                        render_review()
                    else:
                        render_q(qi)
                elif k == "ESC":
                    finish("ESC")
                    break
            else:
                if k in (chr(13), chr(10), "1"):
                    finish(",".join(answers))
                    break
                if k in ("2", "ESC"):
                    finish("CANCELLED")
                    break
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

function tmux(args: string[]): string {
  return tmuxRun(args).stdout;
}
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

describe.skipIf(!CAN_RUN)("injectViaTmux poll: multiSelect and review-pane forms", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-poll-multi-test-"));
  const pyPath = path.join(tmpDir, "fakeform.py");
  fs.writeFileSync(pyPath, FAKE_FORM);

  async function run(mode: "multiselect" | "multiq", firstQuestion: string, payload: object): Promise<string> {
    const session = `cc-poll-${mode}-${process.pid}`;
    const target = `${session}:0.0`;
    killSessionQuiet(session);
    tmux(["new-session", "-d", "-s", session, "-x", "120", "-y", "40", `python3 ${pyPath} ${mode}; echo __DONE__; sleep 60`]);
    try {
      const menuUp = await waitFor(() => capture(target).includes(firstQuestion), 10_000);
      expect(menuUp).toBe(true);
      expect(capture(target)).not.toContain("RESULT=");

      await injectViaTmux(target, JSON.stringify(payload));

      const landed = await waitFor(() => capture(target).includes("RESULT="), 10_000);
      expect(landed).toBe(true);
      return capture(target);
    } finally {
      killSessionQuiet(session);
    }
  }

  test(
    "multi poll: toggle digits are sent without confirm-Enter, Right+Enter submits the review pane",
    async () => {
      // Exactly what the web card sends for Ham + Onion on a multiSelect question.
      const out = await run("multiselect", "Pick toppings", {
        __cc_poll: true, keys: ["1", "3", "Right", "Enter"], multi: true, display: "Ham, Onion",
      });
      expect(out).toContain("RESULT=1,3");
    },
    30_000,
  );

  test(
    "legacy multi-question poll (digits only): the review pane is detected and confirmed",
    async () => {
      const out = await run("multiq", "First question?", {
        __cc_poll: true, keys: ["1", "2"], display: "Alpha, Two",
      });
      expect(out).toContain("RESULT=1,2");
    },
    30_000,
  );
});
