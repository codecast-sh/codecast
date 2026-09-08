import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deletePoolState,
  initPool,
  markStaleByAge,
  markStaleByHead,
  POOL_DIR,
  POOL_MAX_AGE_MS,
  resizePool,
  PoolTransitionError,
  readPoolState,
  transitionSlot,
  writePoolState,
} from "./state.js";

let repoRoot: string;
beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pool-state-"));
});
afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("initPool", () => {
  test("creates N empty slots with stable ids", () => {
    const p = initPool(3);
    expect(p.size).toBe(3);
    expect(p.slots.map((s) => s.slotId)).toEqual(["pool-0", "pool-1", "pool-2"]);
    expect(p.slots.every((s) => s.state === "empty")).toBe(true);
  });
});

describe("read/write/delete persistence", () => {
  test("roundtrip", () => {
    const p = initPool(2);
    writePoolState(repoRoot, p);
    const r = readPoolState(repoRoot);
    expect(r?.size).toBe(2);
    expect(r?.slots).toHaveLength(2);
  });

  test("write is atomic — no .tmp left behind", () => {
    writePoolState(repoRoot, initPool(1));
    const dir = path.join(repoRoot, POOL_DIR);
    const files = fs.readdirSync(dir);
    expect(files).toEqual(["state.json"]);
  });

  test("missing file → null", () => {
    expect(readPoolState(repoRoot)).toBeNull();
  });

  test("malformed file → null", () => {
    fs.mkdirSync(path.join(repoRoot, POOL_DIR), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, POOL_DIR, "state.json"), "{ not json");
    expect(readPoolState(repoRoot)).toBeNull();
  });

  test("delete wipes pool dir", () => {
    writePoolState(repoRoot, initPool(1));
    expect(readPoolState(repoRoot)).toBeTruthy();
    deletePoolState(repoRoot);
    expect(readPoolState(repoRoot)).toBeNull();
  });
});

describe("transitionSlot — legal moves", () => {
  test("empty → warming", () => {
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming", { workspaceName: "pool-0" });
    expect(p.slots[0]!.state).toBe("warming");
    expect(p.slots[0]!.workspaceName).toBe("pool-0");
  });

  test("warming → ready (with head/lock)", () => {
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming", { workspaceName: "pool-0" });
    transitionSlot(p, "pool-0", "ready", { headSha: "abc", lockHash: "def" });
    expect(p.slots[0]!.state).toBe("ready");
    expect(p.slots[0]!.headSha).toBe("abc");
  });

  test("ready → claimed", () => {
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming");
    transitionSlot(p, "pool-0", "ready");
    transitionSlot(p, "pool-0", "claimed");
    expect(p.slots[0]!.state).toBe("claimed");
  });

  test("claimed → empty (post-release recycle)", () => {
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming", { workspaceName: "pool-0", headSha: "x" });
    transitionSlot(p, "pool-0", "ready");
    transitionSlot(p, "pool-0", "claimed");
    transitionSlot(p, "pool-0", "empty");
    expect(p.slots[0]!.state).toBe("empty");
    // empty must wipe metadata
    expect(p.slots[0]!.workspaceName).toBeUndefined();
    expect(p.slots[0]!.headSha).toBeUndefined();
  });

  test("ready → stale", () => {
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming");
    transitionSlot(p, "pool-0", "ready");
    transitionSlot(p, "pool-0", "stale");
    expect(p.slots[0]!.state).toBe("stale");
  });
});

describe("transitionSlot — illegal moves", () => {
  test("empty → claimed throws", () => {
    const p = initPool(1);
    expect(() => transitionSlot(p, "pool-0", "claimed")).toThrow(PoolTransitionError);
  });
  test("ready → empty throws (must go through claimed or stale)", () => {
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming");
    transitionSlot(p, "pool-0", "ready");
    expect(() => transitionSlot(p, "pool-0", "empty")).toThrow(PoolTransitionError);
  });
  test("missing slot id throws", () => {
    const p = initPool(1);
    expect(() => transitionSlot(p, "bogus", "warming")).toThrow(/not found/);
  });
});

describe("markStaleByHead", () => {
  test("ready slots with mismatched headSha become stale", () => {
    const p = initPool(2);
    transitionSlot(p, "pool-0", "warming");
    transitionSlot(p, "pool-0", "ready", { headSha: "old", lockHash: "L" });
    transitionSlot(p, "pool-1", "warming");
    transitionSlot(p, "pool-1", "ready", { headSha: "new", lockHash: "L" });

    markStaleByHead(p, "new", "L");
    expect(p.slots[0]!.state).toBe("stale");
    expect(p.slots[1]!.state).toBe("ready");
  });

  test("ready slots with mismatched lockHash become stale", () => {
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming");
    transitionSlot(p, "pool-0", "ready", { headSha: "X", lockHash: "oldlock" });

    markStaleByHead(p, "X", "newlock");
    expect(p.slots[0]!.state).toBe("stale");
  });

  test("warming slots also become stale on mismatch", () => {
    const p = initPool(1);
    transitionSlot(p, "pool-0", "warming", { headSha: "old", lockHash: "L" });
    markStaleByHead(p, "new", "L");
    expect(p.slots[0]!.state).toBe("stale");
  });

  test("empty/claimed/stale slots are untouched", () => {
    const p = initPool(3);
    transitionSlot(p, "pool-1", "warming");
    transitionSlot(p, "pool-1", "ready", { headSha: "old", lockHash: "L" });
    transitionSlot(p, "pool-1", "claimed");
    transitionSlot(p, "pool-2", "warming");
    transitionSlot(p, "pool-2", "ready", { headSha: "old", lockHash: "L" });
    transitionSlot(p, "pool-2", "stale");

    markStaleByHead(p, "new", "L");
    expect(p.slots[0]!.state).toBe("empty");
    expect(p.slots[1]!.state).toBe("claimed");
    expect(p.slots[2]!.state).toBe("stale");
  });
});

describe("markStaleByAge — a tree that only LOOKS current", () => {
  test("a ready slot past the max age goes stale even with a matching fingerprint", () => {
    const state = initPool(1);
    transitionSlot(state, "pool-0", "warming", { workspaceName: "pool-0" });
    transitionSlot(state, "pool-0", "ready", { headSha: "abc", lockHash: "def" });
    const born = Date.parse(state.slots[0]!.updatedAt);

    markStaleByAge(state, POOL_MAX_AGE_MS, born + POOL_MAX_AGE_MS - 1);
    expect(state.slots[0]!.state).toBe("ready");

    markStaleByAge(state, POOL_MAX_AGE_MS, born + POOL_MAX_AGE_MS + 1);
    expect(state.slots[0]!.state).toBe("stale");
  });

  test("a warming slot is left alone: its age is the build still running", () => {
    const state = initPool(1);
    transitionSlot(state, "pool-0", "warming", { workspaceName: "pool-0" });
    const born = Date.parse(state.slots[0]!.updatedAt);
    markStaleByAge(state, POOL_MAX_AGE_MS, born + POOL_MAX_AGE_MS * 10);
    expect(state.slots[0]!.state).toBe("warming");
  });
});

describe("resizePool — never forgets a slot that holds a worktree", () => {
  test("growing appends empty slots with fresh ids", () => {
    const state = initPool(1);
    resizePool(state, 3);
    expect(state.size).toBe(3);
    expect(state.slots.map((s) => s.slotId)).toEqual(["pool-0", "pool-1", "pool-2"]);
    expect(state.slots.every((s) => s.state === "empty")).toBe(true);
  });

  test("shrinking marks a surplus ready slot stale so it gets torn down", () => {
    const state = initPool(2);
    for (const id of ["pool-0", "pool-1"]) {
      transitionSlot(state, id, "warming", { workspaceName: id });
      transitionSlot(state, id, "ready", { headSha: "abc" });
    }
    resizePool(state, 1);
    // The tree is still named, so maintainPool can remove it.
    expect(state.slots.find((s) => s.slotId === "pool-1")!.state).toBe("stale");
    expect(state.slots.find((s) => s.slotId === "pool-1")!.workspaceName).toBe("pool-1");
    expect(state.slots.find((s) => s.slotId === "pool-0")!.state).toBe("ready");
  });

  test("shrinking to zero drops empty slots outright", () => {
    const state = initPool(3);
    resizePool(state, 0);
    expect(state.slots).toEqual([]);
  });

  test("a claimed slot survives a shrink: it is already out of the pool", () => {
    const state = initPool(1);
    transitionSlot(state, "pool-0", "warming", { workspaceName: "pool-0" });
    transitionSlot(state, "pool-0", "ready", {});
    transitionSlot(state, "pool-0", "claimed");
    resizePool(state, 0);
    expect(state.slots[0]!.state).toBe("claimed");
  });
});
