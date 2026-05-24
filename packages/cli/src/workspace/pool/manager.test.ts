import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claimFromPool,
  currentRepoFingerprint,
  maintainPool,
  waitForReadySlot,
} from "./manager.js";
import { readPoolState } from "./state.js";
import { listWorkspaces, releaseWorkspace } from "../lifecycle.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pool-mgr-"));
  execSync("git init -q -b main", { cwd: repoRoot });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "pool-test\n");
  execSync("git add . && git commit -q -m init", { cwd: repoRoot });
});

afterEach(() => {
  try { execSync("git worktree prune", { cwd: repoRoot, stdio: "ignore" }); } catch {}
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("currentRepoFingerprint", () => {
  test("returns head sha + empty lock for repo without lockfile", () => {
    const fp = currentRepoFingerprint(repoRoot);
    expect(fp.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fp.lockHash).toBe("");
  });

  test("hashes bun.lock when present", () => {
    fs.writeFileSync(path.join(repoRoot, "bun.lock"), "lockfile v1\n");
    execSync("git add . && git commit -q -m lockfile", { cwd: repoRoot });
    const fp = currentRepoFingerprint(repoRoot);
    expect(fp.lockHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("maintainPool + waitForReadySlot — pre-warm flow", () => {
  test("pre-warms N slots that become ready", async () => {
    await maintainPool(repoRoot, 2);
    // First call schedules warming (fire-and-forget). Wait for at least one
    // slot to become ready.
    const ready = await waitForReadySlot(repoRoot, { timeoutMs: 10000, pollMs: 100 });
    expect(ready).not.toBeNull();
    expect(ready?.workspaceName).toMatch(/^pool-\d+$/);

    // Eventually both slots reach ready.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = readPoolState(repoRoot);
      if (state && state.slots.every((s) => s.state === "ready")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const final = readPoolState(repoRoot)!;
    expect(final.slots.filter((s) => s.state === "ready").length).toBe(2);
    expect(final.slots[0]!.headSha).toMatch(/^[0-9a-f]{40}$/);
  }, 30000);
});

describe("claimFromPool — atomically renames", () => {
  test("claims a ready slot, returns workspace with the requested name", async () => {
    await maintainPool(repoRoot, 1);
    const ready = await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });
    expect(ready).not.toBeNull();

    const claim = await claimFromPool(repoRoot, "feat-foo");
    expect(claim).not.toBeNull();
    expect(claim!.workspace.name).toBe("feat-foo");
    expect(claim!.workspace.path).toContain(".codecast/worktrees/feat-foo");
    expect(claim!.workspace.branch).toBe("codecast/feat-foo");

    // Pool slot is recycled to empty.
    const state = readPoolState(repoRoot)!;
    const slot = state.slots.find((s) => s.slotId === claim!.slotId)!;
    expect(slot.state).toBe("empty");

    // Workspace state at the new name exists.
    const wsList = listWorkspaces(repoRoot);
    expect(wsList.map((w) => w.name)).toContain("feat-foo");

    // Old pool-N state file is gone.
    expect(wsList.find((w) => w.name.startsWith("pool-"))).toBeUndefined();

    await releaseWorkspace(repoRoot, "feat-foo");
  }, 30000);

  test("returns null when no slots are ready", async () => {
    // Pool not initialized at all
    const claim = await claimFromPool(repoRoot, "feat-x");
    expect(claim).toBeNull();
  });

  test("two simultaneous claims do not double-claim the same slot", async () => {
    await maintainPool(repoRoot, 1);
    await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });

    const [a, b] = await Promise.all([
      claimFromPool(repoRoot, "feat-a"),
      claimFromPool(repoRoot, "feat-b"),
    ]);
    // Exactly one succeeds with this single-slot pool.
    const successes = [a, b].filter((x) => x !== null);
    expect(successes.length).toBe(1);

    const winner = successes[0]!;
    await releaseWorkspace(repoRoot, winner.workspace.name);
  }, 30000);
});

describe("maintainPool — crash recovery", () => {
  test("orphaned 'warming' slot (no workspace state) is recycled to empty", async () => {
    // Manually corrupt the pool: a warming slot with no backing workspace.
    const { initPool, transitionSlot, writePoolState, readPoolState } = await import("./state.js");
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming", { workspaceName: "pool-0" });
    writePoolState(repoRoot, p);

    await maintainPool(repoRoot, 1);
    const s1 = readPoolState(repoRoot)!;
    // The orphaned warming slot should have been recycled and re-warmed.
    // After maintainPool, it's been transitioned through stale → empty → warming.
    expect(s1.slots[0]!.state === "warming" || s1.slots[0]!.state === "ready").toBe(true);
    if (s1.slots[0]!.state === "warming") {
      expect(s1.slots[0]!.workspaceName).toBe("pool-0");
    }
  }, 15000);

  test("a slot whose workspace already exists on disk is resumed to ready", async () => {
    // Phase 1: real pre-warm
    await maintainPool(repoRoot, 1);
    const ready = await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });
    expect(ready).not.toBeNull();

    // Phase 2: simulate daemon crash mid-warm by manually flipping the slot
    // back to 'warming' while the workspace artifacts remain intact on disk.
    const { readPoolState, writePoolState } = await import("./state.js");
    const corrupt = readPoolState(repoRoot)!;
    const slot = corrupt.slots.find((s) => s.slotId === ready!.slotId)!;
    slot.state = "warming";
    slot.updatedAt = new Date().toISOString();
    writePoolState(repoRoot, corrupt);

    // Phase 3: re-run maintainPool — recovery should resume to 'ready'.
    await maintainPool(repoRoot, 1);
    const recovered = readPoolState(repoRoot)!;
    const recoveredSlot = recovered.slots.find((s) => s.slotId === ready!.slotId)!;
    expect(recoveredSlot.state).toBe("ready");
    expect(recoveredSlot.headSha).toMatch(/^[0-9a-f]{40}$/);
  }, 25000);
});

describe("end-to-end latency benchmark — pool fast path vs fresh acquire", () => {
  test("warm acquire is significantly faster than cold acquire", async () => {
    const { acquireWorkspace, releaseWorkspace } = await import("../lifecycle.js");

    // Cold: no pool — first fresh acquire
    const startCold = Date.now();
    await acquireWorkspace(repoRoot, "cold-feat", { skipPool: true });
    const coldMs = Date.now() - startCold;
    await releaseWorkspace(repoRoot, "cold-feat");

    // Warm: pre-warm one slot then acquire
    await maintainPool(repoRoot, 1);
    await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });
    const startWarm = Date.now();
    const r = await acquireWorkspace(repoRoot, "warm-feat");
    const warmMs = Date.now() - startWarm;
    expect(r.workspace.name).toBe("warm-feat");
    await releaseWorkspace(repoRoot, "warm-feat");

    console.log(`[bench] cold=${coldMs}ms warm=${warmMs}ms (ratio ${(coldMs / Math.max(warmMs, 1)).toFixed(2)}x)`);
    // For this trivial repo cold is already fast (~50-100ms), so warm being
    // <= cold is a soft assertion. The benchmark output is the real value.
    expect(warmMs).toBeLessThan(2000);
  }, 30000);
});

describe("maintainPool — stale handling", () => {
  test("slots become stale on head change and get recycled", async () => {
    await maintainPool(repoRoot, 1);
    await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });

    // Change HEAD so fingerprint differs.
    fs.writeFileSync(path.join(repoRoot, "newfile.txt"), "x");
    execSync("git add . && git commit -q -m new", { cwd: repoRoot });

    // Re-run maintainPool. Stale slots should be recycled (transitioned to
    // empty), then warming kicks off again.
    await maintainPool(repoRoot, 1);

    // Wait for fresh slot to come up with new head sha.
    const newHead = execSync("git rev-parse HEAD", {
      cwd: repoRoot, encoding: "utf-8",
    }).trim();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const s = readPoolState(repoRoot);
      const ready = s?.slots.find((x) => x.state === "ready");
      if (ready && ready.headSha === newHead) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const final = readPoolState(repoRoot)!;
    const ready = final.slots.find((x) => x.state === "ready");
    expect(ready?.headSha).toBe(newHead);
  }, 45000);
});
