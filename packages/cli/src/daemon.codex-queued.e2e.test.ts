import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectViaTmux, TEST_SCRATCH_DIRNAME } from "./daemon.js";
import { shellQuote, spawnHarness, waitFor, type Harness } from "./test-helpers/messagingHarness.js";
import { tmuxRun } from "./tmux.js";
import { spawnSync } from "node:child_process";

describe.skipIf(!Bun.which("tmux"))("Codex queued delivery through real tmux", () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.tearDown();
    harness = undefined;
  });

  for (const layout of ["queue", "clipped"]) {
    test(`preserves the active turn and delivers all reports (${layout})`, async () => {
      const scratch = join(tmpdir(), TEST_SCRATCH_DIRNAME);
      mkdirSync(scratch, { recursive: true });
      const cwd = mkdtempSync(join(scratch, "codex-queue-"));
      const statePath = join(cwd, "state.json");
      const finishPath = join(cwd, "finish");
      const fixture = join(dirname(fileURLToPath(import.meta.url)), "test-helpers/codexQueuedTui.ts");
      harness = spawnHarness({
        cwd,
        jsonlPath: statePath,
        command: `exec ${[process.execPath, fixture, statePath, finishPath, layout].map(shellQuote).join(" ")}`,
      });
      const state = (): { active: boolean; interrupts: number; queued: string[]; delivered: string[] } => JSON.parse(readFileSync(statePath, "utf8"));
      await waitFor(() => existsSync(statePath));
      console.log("pane debug", JSON.stringify(harness.capturePane()));
      console.log("capture result", tmuxRun(["capture-pane", "-p", "-J", "-t", harness.tmuxSession, "-S", "-50"]));
      console.log("native capture", spawnSync("tmux", ["capture-pane", "-p", "-J", "-t", harness.tmuxSession, "-S", "-50"], { encoding: "utf8", timeout: 1000, killSignal: "SIGKILL" }));
      const reports = [
        '<session-message from="worker-a">\nChecks passed.\nKeep the original turn running.\n</session-message>',
        '<session-message from="worker-b">\nSecond report: preserve both messages exactly.\n</session-message>',
      ];
      for (const report of reports) await injectViaTmux(`${harness.tmuxSession}:0.0`, report, "codex");
      expect(state()).toEqual({ active: true, interrupts: 0, queued: ["Existing worker report.", ...reports], delivered: [] });
      writeFileSync(finishPath, "ready");
      await waitFor(() => !state().active);
      expect(state()).toEqual({ active: false, interrupts: 0, queued: [], delivered: ["Existing worker report.", ...reports] });
      await injectViaTmux(`${harness.tmuxSession}:0.0`, "One report after completion.", "codex");
      expect(state().delivered).toEqual(["Existing worker report.", ...reports, "One report after completion."]);
      expect(state().interrupts).toBe(0);
    }, 30_000);
  }
});
