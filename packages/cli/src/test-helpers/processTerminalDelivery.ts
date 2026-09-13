import "./isolatedTmuxServer.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "../proc.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheSessionProcess, getCachedSessionProcess, injectViaTmux, reconcileSessionLiveness, resolveLiveTmuxTarget, setSyncServiceForTests, TEST_SCRATCH_DIRNAME } from "../daemon.js";
import { shellQuote, spawnHarness, waitFor } from "./messagingHarness.js";
import { tmuxRunAsync } from "../tmux.js";
import type { SyncService } from "../syncService.js";

async function verify() {
  const scratch = join(tmpdir(), TEST_SCRATCH_DIRNAME);
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(join(scratch, "process-terminal-"));
  const statePath = join(cwd, "state.json");
  const finishPath = join(cwd, "finish");
  const sessionId = randomUUID();
  const fixture = fileURLToPath(new URL("./codexQueuedTui.ts", import.meta.url));
  const harness = spawnHarness({ cwd, jsonlPath: statePath, tmuxPrefix: "terminal-route-test", command: `exec bun ${[fixture, statePath, finishPath, "queue"].map(shellQuote).join(" ")}` });
  const state = (): { active: boolean; interrupts: number; queued: string[]; delivered: string[] } => JSON.parse(readFileSync(statePath, "utf8"));
  try {
    await waitFor(() => harness.capturePane().includes("Ask Codex"));
    const pane = await tmuxRunAsync(["list-panes", "-t", harness.tmuxSession, "-F", "#{pane_pid} #{pane_tty}"]);
    assert.equal(pane.status, 0);
    const [pid, tty] = pane.stdout.trim().split(/\s+/);
    assert.ok(tty.startsWith("/dev/"));
    if (process.argv[2] === "liveness") {
      setSyncServiceForTests({
        listManagedSessions: async () => [{ session_id: sessionId, tmux_session: harness.tmuxSession }],
        registerManagedSession: async () => ({}),
      } as unknown as SyncService);
      await reconcileSessionLiveness();
      setSyncServiceForTests(null);
    } else {
      cacheSessionProcess(sessionId, { pid: Number(pid), tty: "", sessionId }, harness.tmuxSession);
    }
    const cached = await getCachedSessionProcess(sessionId);
    assert.ok(cached);
    assert.equal(cached.tty, tty);
    const route = await resolveLiveTmuxTarget(undefined, sessionId, "codex");
    assert.equal(route.source, "process");
    assert.ok(route.tmuxTarget?.startsWith(`${harness.tmuxSession}:`));
    await injectViaTmux(route.tmuxTarget!, "continue", "codex");
    assert.deepEqual(state(), { active: true, interrupts: 0, queued: ["Existing worker report.", "continue"], delivered: [] });
    writeFileSync(finishPath, "ready");
    await waitFor(() => !state().active);
    assert.deepEqual(state().delivered, ["Existing worker report.", "continue"]);
    assert.equal(state().interrupts, 0);
    const headlessId = randomUUID();
    const headlessProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      assert.ok(headlessProcess.pid);
      cacheSessionProcess(headlessId, { pid: headlessProcess.pid, tty: "", sessionId: headlessId });
      const headless = await resolveLiveTmuxTarget(undefined, headlessId, "codex");
      assert.equal(headless.tmuxTarget, null);
      assert.equal(headless.proc?.tty, "");
    } finally {
      headlessProcess.kill();
    }
  } finally {
    setSyncServiceForTests(null);
    harness.tearDown();
    rmSync(cwd, { recursive: true, force: true });
  }
}

await verify();
console.log(`Verified ${process.argv[2]} terminal recovery and exactly-once delivery.`);
process.exit(0);
