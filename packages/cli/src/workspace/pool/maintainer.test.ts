import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startPoolMaintainer } from "./maintainer.js";
import { readPoolState } from "./state.js";

let repoRoot: string;
const handles: Array<{ stop: () => Promise<void> }> = [];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pool-maint-"));
  execSync("git init -q -b main", { cwd: repoRoot });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "test\n");
  execSync("git add . && git commit -q -m init", { cwd: repoRoot });
});

afterEach(async () => {
  for (const h of handles.splice(0)) {
    try { await h.stop(); } catch {}
  }
  try { execSync("git worktree prune", { cwd: repoRoot, stdio: "ignore" }); } catch {}
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("startPoolMaintainer", () => {
  test("first tick pre-warms the pool", async () => {
    const h = startPoolMaintainer({ repoRoot, size: 1, periodMs: 60000 });
    handles.push(h);
    // Wait for at least one ready slot.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const s = readPoolState(repoRoot);
      if (s?.slots.some((x) => x.state === "ready")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const state = readPoolState(repoRoot)!;
    expect(state.slots.some((s) => s.state === "ready")).toBe(true);
  }, 25000);

  test("tickNow() triggers a maintenance pass synchronously to completion", async () => {
    const h = startPoolMaintainer({ repoRoot, size: 1, periodMs: 60000, watch: false });
    handles.push(h);
    // tickNow returns when maintainPool completes (initial pass).
    await h.tickNow();
    const state = readPoolState(repoRoot)!;
    expect(state.size).toBe(1);
    // Slot was at least scheduled into warming.
    expect(state.slots[0]!.state === "warming" || state.slots[0]!.state === "ready").toBe(true);
  }, 15000);

  test("stop() is idempotent", async () => {
    const h = startPoolMaintainer({ repoRoot, size: 1, watch: false });
    handles.push(h);
    await h.stop();
    await h.stop(); // no throw
  });

  test("lockfile change triggers an additional tick", async () => {
    fs.writeFileSync(path.join(repoRoot, "bun.lock"), "v1\n");
    execSync("git add . && git commit -q -m lockfile", { cwd: repoRoot });

    const ticks: string[] = [];
    const h = startPoolMaintainer({
      repoRoot,
      size: 1,
      periodMs: 60000,
      log: (m) => { ticks.push(m); },
    });
    handles.push(h);
    // Wait for first ready slot.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const s = readPoolState(repoRoot);
      if (s?.slots.some((x) => x.state === "ready")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Now touch the lockfile to trigger fs.watch.
    fs.writeFileSync(path.join(repoRoot, "bun.lock"), "v2\n");
    // Give the watcher a moment.
    await new Promise((r) => setTimeout(r, 600));

    // Eventually the pool slot's lockHash should reflect the new content.
    const finalDeadline = Date.now() + 15000;
    while (Date.now() < finalDeadline) {
      const s = readPoolState(repoRoot);
      const ready = s?.slots.find((x) => x.state === "ready");
      if (ready && ready.lockHash) {
        // We don't compare exact hash; we just verify maintenance ran enough
        // to refresh fingerprint after the second lockfile content.
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // The "change detected" log line should have fired at least once.
    expect(ticks.some((m) => m.includes("change detected"))).toBe(true);
  }, 40000);
});
