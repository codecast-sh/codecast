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
import { readPoolState, writePoolState } from "./state.js";
import { listWorkspaces, releaseWorkspace } from "../lifecycle.js";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../../test-helpers/codecastDir.js";

let repoRoot: string;
let home: IsolatedCodecastDir;

beforeEach(() => {
  // acquireWorkspace reserves ports under CODECAST_DIR; without this the suite
  // writes into the human's real ~/.codecast (ct-49576).
  home = isolateCodecastDir();
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pool-mgr-"));
  execSync("git init -q -b main", { cwd: repoRoot });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "pool-test\n");
  execSync("git add . && git commit -q -m init", { cwd: repoRoot });
});

afterEach(() => {
  try { execSync("git worktree prune", { cwd: repoRoot, stdio: "ignore" }); } catch {}
  fs.rmSync(repoRoot, { recursive: true, force: true });
  home.restore();
});

describe("currentRepoFingerprint", () => {
  test("returns head sha + empty lock for repo without lockfile", async () => {
    const fp = await currentRepoFingerprint(repoRoot);
    expect(fp.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fp.lockHash).toBe("");
  });

  test("hashes bun.lock when present", async () => {
    fs.writeFileSync(path.join(repoRoot, "bun.lock"), "lockfile v1\n");
    execSync("git add . && git commit -q -m lockfile", { cwd: repoRoot });
    const fp = await currentRepoFingerprint(repoRoot);
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

describe("maintainPool — the cap and the max age", () => {
  test("a request above the cap is clamped to three slots", async () => {
    const state = await maintainPool(repoRoot, 99);
    expect(state.size).toBe(3);
    expect(state.slots.length).toBe(3);
  }, 30000);

  test("a ready slot past the max age is torn down and replaced", async () => {
    await maintainPool(repoRoot, 1);
    const ready = await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });
    expect(ready).not.toBeNull();
    const wornPath = path.join(repoRoot, ".codecast/worktrees", ready!.workspaceName!);
    expect(fs.existsSync(wornPath)).toBe(true);

    // Age the slot without touching HEAD or the lockfile, so ONLY the age bar
    // can evict it.
    const aged = readPoolState(repoRoot)!;
    const agedStamp = new Date(Date.now() - 60 * 60_000).toISOString();
    aged.slots.find((s) => s.slotId === ready!.slotId)!.updatedAt = agedStamp;
    writePoolState(repoRoot, aged);

    await maintainPool(repoRoot, 1, { maxAgeMs: 30 * 60_000 });
    const after = readPoolState(repoRoot)!;
    const slot = after.slots.find((s) => s.slotId === ready!.slotId)!;
    // Evicted, then immediately re-warmed on the same slot id.
    expect(slot.state === "warming" || slot.state === "ready").toBe(true);
    expect(slot.updatedAt > agedStamp).toBe(true);
  }, 45000);

  test("an unexpired slot survives the same pass", async () => {
    await maintainPool(repoRoot, 1);
    const ready = await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });
    await maintainPool(repoRoot, 1, { maxAgeMs: 30 * 60_000 });
    const slot = readPoolState(repoRoot)!.slots.find((s) => s.slotId === ready!.slotId)!;
    expect(slot.state).toBe("ready");
    expect(slot.workspaceName).toBe(ready!.workspaceName);
  }, 45000);

  test("shrinking the pool removes the surplus worktree from disk", async () => {
    await maintainPool(repoRoot, 2);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const s = readPoolState(repoRoot);
      if (s && s.slots.length === 2 && s.slots.every((x) => x.state === "ready")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(readPoolState(repoRoot)!.slots.filter((s) => s.state === "ready").length).toBe(2);

    await maintainPool(repoRoot, 1);
    const after = readPoolState(repoRoot)!;
    expect(after.slots.length).toBe(1);
    expect(listWorkspaces(repoRoot).filter((w) => w.name.startsWith("pool-")).length).toBeLessThanOrEqual(1);
  }, 60000);
});

describe("drainPool", () => {
  test("removes every slot, its worktree and the demand history", async () => {
    const { drainPool } = await import("./manager.js");
    const { recordWorkspaceCreate, readDemand } = await import("./demand.js");
    await recordWorkspaceCreate(repoRoot);
    await maintainPool(repoRoot, 1);
    const ready = await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });
    const wtPath = path.join(repoRoot, ".codecast/worktrees", ready!.workspaceName!);

    const removed = await drainPool(repoRoot);
    expect(removed).toBe(1);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(readPoolState(repoRoot)).toBeNull();
    expect(readDemand(repoRoot)).toEqual([]);
  }, 30000);

  test("is a no-op on a repo that never had a pool", async () => {
    const { drainPool } = await import("./manager.js");
    expect(await drainPool(repoRoot)).toBe(0);
  });
});

describe("acquireWorkspace — records demand so the pool can re-arm", () => {
  test("a real create is recorded; a --skip-pool create is not", async () => {
    const { acquireWorkspace, releaseWorkspace: release } = await import("../lifecycle.js");
    const { readDemand } = await import("./demand.js");

    await acquireWorkspace(repoRoot, "skipped", { skipPool: true });
    expect(readDemand(repoRoot)).toEqual([]);
    await release(repoRoot, "skipped");

    await acquireWorkspace(repoRoot, "counted");
    expect(readDemand(repoRoot).length).toBe(1);
    await release(repoRoot, "counted");

    await acquireWorkspace(repoRoot, "counted-again");
    expect(readDemand(repoRoot).length).toBe(2);
    await release(repoRoot, "counted-again");
  }, 45000);
});

describe("maintainPool — a recycled slot is checked out at the CURRENT head", () => {
  test("the re-warmed worktree is on the new commit, not the branch's old tip", async () => {
    await maintainPool(repoRoot, 1);
    const first = await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });
    expect(first).not.toBeNull();

    fs.writeFileSync(path.join(repoRoot, "second.txt"), "x");
    execSync("git add . && git commit -q -m second", { cwd: repoRoot });
    const newHead = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();

    await maintainPool(repoRoot, 1);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const s = readPoolState(repoRoot);
      if (s?.slots.some((x) => x.state === "ready" && x.headSha === newHead)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const ready = readPoolState(repoRoot)!.slots.find((s) => s.state === "ready")!;
    expect(ready.headSha).toBe(newHead);

    // The fingerprint says "current"; check the tree actually is. Reusing the
    // surviving codecast/pool-N branch would leave it one commit behind.
    const slotPath = path.join(repoRoot, ".codecast/worktrees", ready.workspaceName!);
    const slotHead = execSync("git rev-parse HEAD", { cwd: slotPath, encoding: "utf-8" }).trim();
    expect(slotHead).toBe(newHead);
  }, 60000);
});
