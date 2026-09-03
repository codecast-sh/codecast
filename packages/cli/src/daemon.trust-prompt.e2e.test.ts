import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acceptTrustPrompt } from "./daemon.js";
import { tmuxRun } from "./tmux.js";

// Regression test for jx745rs5 (2026-09-03): a session that could never be
// delivered to, because the daemon "accepted" the workspace trust dialog by
// pressing Enter — and "No, exit" is the DEFAULT highlight, so every acceptance
// quit the agent. The pane died, the resume rebuilt it, and the next Enter killed
// it again. Verified against Claude Code 2.1.259:
//
//     ❯ No, exit
//       Yes, I trust this folder
//     Enter to confirm · Esc to cancel
//
// Drives the REAL helper against a REAL dialog in an untrusted temp directory,
// and asserts the outcome that actually matters: the agent is still running.

function have(bin: string): boolean {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; }
}
const CLAUDE_BIN = `${os.homedir()}/.codecast/bin/claude`;
const CAN_RUN = have("tmux") && fs.existsSync(CLAUDE_BIN);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const capture = (t: string) => tmuxRun(["capture-pane", "-p", "-J", "-t", t, "-S", "-40"]).stdout ?? "";

describe.skipIf(!CAN_RUN)("acceptTrustPrompt", () => {
  test("selects the affirmative option and leaves the agent running", async () => {
    // A directory the user has never opened: guarantees the trust dialog.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-trust-"));
    const session = `zz-trust-e2e-${process.pid}`;
    tmuxRun(["kill-session", "-t", session]);
    tmuxRun(["new-session", "-d", "-s", session, "-x", "220", "-y", "50", "-c", dir,
             `${CLAUDE_BIN} --dangerously-skip-permissions`]);
    try {
      let sawDialog = false;
      for (let i = 0; i < 40 && !sawDialog; i++) {
        await sleep(500);
        sawDialog = /Quick safety check|trust this folder/i.test(capture(`${session}:0.0`));
      }
      expect(sawDialog).toBe(true);
      // The pane must show "No, exit" highlighted — the whole reason a blind
      // Enter was fatal. If Claude Code ever changes the default, this catches it.
      expect(capture(`${session}:0.0`)).toMatch(/❯\s*No, exit/);

      expect(await acceptTrustPrompt(`${session}:0.0`)).toBe(true);

      await sleep(3000);
      // The outcome that matters: the agent survived and reached its composer.
      expect(tmuxRun(["has-session", "-t", session]).status).toBe(0);
      const after = capture(`${session}:0.0`);
      expect(after).not.toMatch(/Quick safety check/i);
      expect(after).toMatch(/Claude Code v|bypass permissions|Try "/);
    } finally {
      tmuxRun(["kill-session", "-t", session]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
