import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectViaTmux, TEST_SCRATCH_DIRNAME } from "../daemon.js";
import { shellQuote, spawnHarness, waitFor } from "./messagingHarness.js";

const layout = process.argv[2];
async function verify() {
  const scratch = join(tmpdir(), TEST_SCRATCH_DIRNAME);
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(join(scratch, "codex-queue-"));
  const statePath = join(cwd, "state.json");
  const finishPath = join(cwd, "finish");
  const fixture = fileURLToPath(new URL("./codexQueuedTui.ts", import.meta.url));
  const harness = spawnHarness({ cwd, jsonlPath: statePath, tmuxPrefix: "codex-queue-test", command: `exec bun ${[fixture, statePath, finishPath, layout].map(shellQuote).join(" ")}` });
  const state = (): { active: boolean; interrupts: number; queued: string[]; delivered: string[] } => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => harness.capturePane().includes("Ask Codex"));
    const reports = [
      '<session-message from="worker-a">\nChecks passed.\nKeep the original turn running.\n</session-message>',
      '<session-message from="worker-b">\nSecond report: preserve both messages exactly.\n</session-message>',
    ];
    for (const report of reports) await injectViaTmux(`${harness.tmuxSession}:0.0`, report, "codex");
    assert.deepEqual(state(), { active: true, interrupts: 0, queued: ["Existing worker report.", ...reports], delivered: [] });
    writeFileSync(finishPath, "ready");
    await waitFor(() => !state().active);
    assert.deepEqual(state(), { active: false, interrupts: 0, queued: [], delivered: ["Existing worker report.", ...reports] });
    await injectViaTmux(`${harness.tmuxSession}:0.0`, "One report after completion.", "codex");
    assert.deepEqual(state().delivered, ["Existing worker report.", ...reports, "One report after completion."]);
    assert.equal(state().interrupts, 0);
  } finally {
    harness.tearDown();
  }
}
await verify();
console.log(`Verified Codex ${layout} delivery without interruption.`);
process.exit(0);
