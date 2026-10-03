// sim/history.ts on a scratch home: sessions, runs.jsonl, pruning.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRun, closeSession, openSession, pruneSessions, readRuns, readSession, sessionProvenance, sessionStamp, sessionsDir, treePatchPath, treesDir } from "./history";

const homes: string[] = [];
const scratchHome = () => {
  const home = mkdtempSync(join(tmpdir(), "sim-history-"));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const tree = { gitHead: "a".repeat(40), dirty: true };
const run = (passed: boolean) => ({ scenario: "s", mode: "interleave" as const, seed: 1, passed, deliveries: 3, ms: 5 });

// A finished session `minutesAgo` old, with the given runs and a tree patch.
function session(home: string, minutesAgo: number, runs: boolean[], patch: string | null = null, exit = 0) {
  const at = new Date(Date.UTC(2026, 9, 3, 12) - minutesAgo * 60_000);
  const { dir, session } = openSession(["x"], tree, { home, at });
  for (const passed of runs) appendRun(dir, run(passed));
  if (patch) {
    mkdirSync(treesDir(home), { recursive: true });
    writeFileSync(treePatchPath(patch, home), "z");
  }
  closeSession(dir, session, exit, patch, at);
  return session.id;
}

describe("sessions", () => {
  test("open, append and close round-trip through session.json and runs.jsonl", () => {
    const home = scratchHome();
    const at = new Date("2026-10-03T22:00:10.299Z");
    const { dir, session: open } = openSession(["memberRemovedMidTurn", "--seed", "4"], tree, { home, at });
    expect(open.id).toBe(sessionStamp(at));
    expect(open.id.startsWith("2026-10-03T22-00-10-299Z-")).toBe(true);
    expect(readSession(dir)).toMatchObject({ argv: ["memberRemovedMidTurn", "--seed", "4"], gitHead: tree.gitHead, dirty: true, finishedAt: null, exit: null });
    appendRun(dir, run(true));
    appendRun(dir, { ...run(false), dir: "s-interleave-1" });
    closeSession(dir, open, 1, "f".repeat(64), new Date("2026-10-03T22:01:00Z"));
    expect(readSession(dir)).toMatchObject({ treePatch: "f".repeat(64), finishedAt: "2026-10-03T22:01:00.000Z", exit: 1 });
    expect(readRuns(dir)).toEqual([run(true), { ...run(false), dir: "s-interleave-1" }]);
    expect(sessionProvenance({ SIM_SESSION: dir })).toEqual({ gitHead: tree.gitHead, dirty: true });
    expect(sessionProvenance({})).toEqual({});
  });

  test("pruning keeps the newest, and any older session that failed; trees go with the sessions that named them", () => {
    const home = scratchHome();
    const newest = [session(home, 1, [true], "1".repeat(64)), session(home, 2, [true])];
    const oldPass = session(home, 10, [true, true], "2".repeat(64));
    const oldFail = session(home, 11, [true, false], "3".repeat(64));
    const oldCrash = session(home, 12, [], null, 1);
    const removed = pruneSessions(home, 2, Date.UTC(2026, 9, 3, 12));
    expect(removed).toEqual([oldPass]);
    expect(readdirSync(sessionsDir(home)).sort()).toEqual([...newest, oldFail, oldCrash].sort());
    expect(readdirSync(treesDir(home)).sort()).toEqual([`${"1".repeat(64)}.patch.gz`, `${"3".repeat(64)}.patch.gz`]);
  });

  test("an unfinished session is left alone for a day, then pruned like any other", () => {
    const home = scratchHome();
    const keep = session(home, 0, [true]);
    const { dir } = openSession(["x"], tree, { home, at: new Date(Date.UTC(2026, 9, 3, 11)) });
    expect(pruneSessions(home, 1, Date.UTC(2026, 9, 3, 12))).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(pruneSessions(home, 1, Date.UTC(2026, 9, 4, 12))).toHaveLength(1);
    expect(readdirSync(sessionsDir(home))).toEqual([keep]);
  });
});
