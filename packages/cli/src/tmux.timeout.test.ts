// Regression test for the "tmux call spins forever" class of bug.
//
// A tmux client whose server dies mid-protocol wedges in a 100% CPU loop and
// ignores SIGTERM, so a raw spawnSync/execSync without a timeout leaves a zombie
// that outlives `bun test` (the symptom that prompted this: two capture-pane
// processes burning a core for 11 hours after a test run). Every tmux spawn must
// go through a wrapper that defaults to a hard timeout + SIGKILL. This test pins
// that contract on tmuxRun.
//
// We can't easily make a real tmux server die mid-protocol, but `tmux wait-for
// <channel>` blocks indefinitely until another client signals the channel — a
// deterministic stand-in for an unresponsive tmux call. Without the wrapper's
// timeout this test would hang until bun's own test timeout and fail.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { tmuxRun } from "./tmux.js";

function hasTmux(): boolean {
  try {
    execFileSync("which", ["tmux"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasTmux())("tmuxRun timeout hardening", () => {
  test("a blocking tmux call is reaped by the timeout instead of spinning forever", () => {
    const channel = `cc-timeout-probe-${process.pid}`;
    const start = Date.now();
    const r = tmuxRun(["wait-for", channel], { timeout: 800 });
    const elapsed = Date.now() - start;
    // Reaped right around the 800ms deadline — nowhere near hanging. If the
    // timeout weren't wired, wait-for would block until bun kills the test.
    expect(elapsed).toBeLessThan(5000);
    // Killed by signal (or errored) → never a clean exit 0.
    expect(r.status).not.toBe(0);
  }, 15_000);

  test("a healthy tmux call still returns its output and exit 0", () => {
    const r = tmuxRun(["-V"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("tmux");
  });
});
