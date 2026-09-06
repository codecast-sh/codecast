// The three answers a `--precheck` gate can give, and what each one means for
// the firing: exit 0 runs it, a non-zero exit skips it, and a command that
// never answers is a skip too rather than a stalled trigger.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTriggerPrecheck } from "./precheckRunner.js";
import { triggerPrecheckPassed, describeTriggerPrecheckFailure } from "@codecast/shared/contracts";

function withCwd(run: (cwd: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cast-precheck-test-"));
    try {
      await run(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

describe("runTriggerPrecheck", () => {
  test(
    "exit 0 passes and the run proceeds",
    withCwd(async (cwd) => {
      const result = await runTriggerPrecheck({ command: "exit 0", cwd });
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.error).toBeUndefined();
      expect(triggerPrecheckPassed(result)).toBe(true);
    }),
  );

  test(
    "a non-zero exit fails, keeping the code and the command's output",
    withCwd(async (cwd) => {
      const result = await runTriggerPrecheck({
        command: "echo nothing changed; echo details >&2; exit 7",
        cwd,
      });
      expect(result.exitCode).toBe(7);
      expect(result.timedOut).toBe(false);
      expect(result.output).toContain("nothing changed");
      expect(result.output).toContain("details");
      expect(triggerPrecheckPassed(result)).toBe(false);
      expect(describeTriggerPrecheckFailure(result)).toBe("precheck exited 7");
    }),
  );

  test(
    "a command that never answers times out, and its children die with it",
    withCwd(async (cwd) => {
      const started = Date.now();
      const result = await runTriggerPrecheck({
        command: "sleep 30 | cat",
        cwd,
        timeoutMs: 300,
      });
      expect(result.timedOut).toBe(true);
      // A timeout's exit status is the signal, which says nothing about the
      // check — the runner refuses to report one.
      expect(result.exitCode).toBeUndefined();
      expect(triggerPrecheckPassed(result)).toBe(false);
      expect(describeTriggerPrecheckFailure(result)).toContain("timed out");
      // It returns on the timeout, not when the sleep would have finished.
      expect(Date.now() - started).toBeLessThan(10_000);
    }),
  );

  test(
    "the command runs in the directory it was given",
    withCwd(async (cwd) => {
      const result = await runTriggerPrecheck({ command: "pwd", cwd });
      expect(result.exitCode).toBe(0);
      // macOS resolves /var through a symlink, so compare the leaf.
      expect(result.output?.trim().endsWith(cwd.split("/").pop()!)).toBe(true);
    }),
  );

  test(
    "agent env markers never reach the command",
    withCwd(async (cwd) => {
      process.env.CLAUDE_CODE_CHILD_SESSION = "1";
      try {
        const result = await runTriggerPrecheck({
          command: 'echo "marker=[${CLAUDE_CODE_CHILD_SESSION:-}]"',
          cwd,
        });
        expect(result.output).toContain("marker=[]");
      } finally {
        delete process.env.CLAUDE_CODE_CHILD_SESSION;
      }
    }),
  );

  test(
    "output is capped, keeping the tail where the failure explains itself",
    withCwd(async (cwd) => {
      const result = await runTriggerPrecheck({
        command: `for i in $(seq 1 3000); do echo "line $i"; done; exit 1`,
        cwd,
      });
      expect(result.output!.length).toBeLessThanOrEqual(2000);
      expect(result.output).toContain("line 3000");
      expect(result.output).not.toContain("line 1\n");
    }),
  );
});
