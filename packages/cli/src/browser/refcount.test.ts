/**
 * Shared-fate ownership: `cast browser stop` must not take the browser out
 * from under other agents.
 *
 * The holder set is the tab-ownership map itself (tabsBySession), stamped
 * with when each session last ran a command. The transitions under test:
 *   1. Last holder stops → the browser really goes down.
 *   2. Another holder present → the caller only releases its own tabs.
 *   3. --force → teardown regardless, but the plan names who is affected.
 *   4. A holder gone quiet past the staleness window no longer pins Chrome.
 *   5. A holder whose tab was closed no longer counts.
 *   6. No identity + other holders → refused, never a silent teardown.
 *   7. Register-on-use: an acting command stamps the caller in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readState, setActiveTarget, writeState, type InstanceState } from "./instance.js";
import { decideStop, HOLDER_STALE_MS, liveHolders, planStop, releaseSession } from "./refcount.js";
import { planEngineStop } from "./engineStop.js";

const state = (
  tabsBySession: Record<string, string>,
  sessionSeenAt: Record<string, number> = {},
): InstanceState => ({
  pid: 1, port: 0, userDataDir: "/tmp/none", headless: true, sourceProfile: null, channel: "chrome",
  startedAt: 0, activeTargetId: null, tabsBySession, sessionSeenAt,
});

const NOW = 1_000_000_000;

describe("decideStop (engine-agnostic core)", () => {
  // The same contract the agent-browser adapter runs with holders taken from
  // `agent-browser session list`.
  test("last holder → teardown; others → release; --force → teardown naming them", () => {
    expect(decideStop({ others: [], me: "me" })).toEqual({ action: "teardown", others: [] });
    expect(decideStop({ others: ["me"], me: "me" })).toEqual({ action: "teardown", others: [] });
    expect(decideStop({ others: ["a", "b"], me: "me" })).toEqual({ action: "release", others: ["a", "b"] });
    expect(decideStop({ others: ["a"], me: "me", force: true })).toEqual({ action: "teardown", others: ["a"] });
  });

  test("no identity: refused while others hold, allowed when alone or forced", () => {
    expect(decideStop({ others: ["a"], me: null })).toEqual({ action: "refuse", others: ["a"] });
    expect(decideStop({ others: [], me: null })).toEqual({ action: "teardown", others: [] });
    expect(decideStop({ others: ["a"], me: null, force: true })).toEqual({ action: "teardown", others: ["a"] });
  });
});

describe("planStop", () => {
  test("the last holder tears the browser down", () => {
    const plan = planStop(state({ "session:me": "AAA" }, { "session:me": NOW }), "session:me", { now: NOW });
    expect(plan.action).toBe("teardown");
    expect(plan.others).toEqual([]);
  });

  test("with another holder present, only the caller's tab is released", () => {
    const s = state({ "session:me": "AAA", "session:other": "BBB" }, { "session:me": NOW, "session:other": NOW });
    const plan = planStop(s, "session:me", { now: NOW });
    expect(plan).toEqual({ action: "release", others: ["session:other"], myTabs: ["AAA"] });
  });

  test("--force tears down anyway and names who is affected", () => {
    const s = state({ "session:me": "AAA", "session:other": "BBB" }, { "session:me": NOW, "session:other": NOW });
    const plan = planStop(s, "session:me", { now: NOW, force: true });
    expect(plan.action).toBe("teardown");
    expect(plan.others).toEqual(["session:other"]);
  });

  test("a holder quiet past the staleness window no longer pins the browser", () => {
    const s = state(
      { "session:me": "AAA", "session:gone": "BBB" },
      { "session:me": NOW, "session:gone": NOW - HOLDER_STALE_MS - 1 },
    );
    expect(planStop(s, "session:me", { now: NOW }).action).toBe("teardown");
    // One millisecond inside the window still counts.
    const fresh = state(
      { "session:me": "AAA", "session:quiet": "BBB" },
      { "session:me": NOW, "session:quiet": NOW - HOLDER_STALE_MS },
    );
    expect(planStop(fresh, "session:me", { now: NOW }).action).toBe("release");
  });

  test("a holder whose tab was closed no longer counts", () => {
    const s = state({ "session:me": "AAA", "session:other": "BBB" }, { "session:me": NOW, "session:other": NOW });
    const plan = planStop(s, "session:me", { now: NOW, liveTargetIds: new Set(["AAA"]) });
    expect(plan.action).toBe("teardown");
  });

  test("the caller's own closed tab is not offered for release", () => {
    const s = state({ "session:me": "AAA", "session:other": "BBB" }, { "session:me": NOW, "session:other": NOW });
    const plan = planStop(s, "session:me", { now: NOW, liveTargetIds: new Set(["BBB"]) });
    expect(plan).toEqual({ action: "release", others: ["session:other"], myTabs: [] });
  });

  test("an unstamped legacy entry with a live tab still counts as a holder", () => {
    // Entries written before stamping existed carry no time. Erring towards
    // "still here" only delays a shutdown; erring the other way kills work.
    const s = state({ "session:me": "AAA", "session:legacy": "BBB" }, { "session:me": NOW });
    expect(planStop(s, "session:me", { now: NOW }).action).toBe("release");
  });

  test("a caller with no identity is refused while others hold tabs", () => {
    const s = state({ "session:other": "BBB" }, { "session:other": NOW });
    expect(planStop(s, null, { now: NOW })).toEqual({ action: "refuse", others: ["session:other"], myTabs: [] });
    // …but with nobody holding anything, a human can stop it as before.
    expect(planStop(state({}), null, { now: NOW }).action).toBe("teardown");
    // …and --force still works for them.
    expect(planStop(s, null, { now: NOW, force: true }).action).toBe("teardown");
  });

  test("liveHolders lists exactly the sessions that would be hit", () => {
    const s = state(
      { a: "AAA", b: "BBB", c: "CCC" },
      { a: NOW, b: NOW - HOLDER_STALE_MS - 1, c: NOW },
    );
    expect(liveHolders(s, new Set(["AAA", "BBB"]), NOW)).toEqual(["a"]);
    expect(liveHolders(s, undefined, NOW)).toEqual(["a", "c"]);
  });
});

describe("register on use / release", () => {
  let dir: string;
  const savedDir = process.env.CODECAST_DIR;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-refcount-"));
    process.env.CODECAST_DIR = dir;
    writeState(state({}));
  });
  afterEach(() => {
    if (savedDir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an acting command registers the caller as a holder with a stamp", () => {
    setActiveTarget(readState()!, "AAA", "session:me", NOW);
    const s = readState()!;
    expect(s.tabsBySession).toEqual({ "session:me": "AAA" });
    expect(s.sessionSeenAt).toEqual({ "session:me": NOW });
    expect(liveHolders(s, undefined, NOW)).toEqual(["session:me"]);
  });

  test("the stamp refreshes when it has aged, not on every command", () => {
    setActiveTarget(readState()!, "AAA", "session:me", NOW);
    setActiveTarget(readState()!, "AAA", "session:me", NOW + 10_000);
    expect(readState()!.sessionSeenAt!["session:me"]).toBe(NOW);
    setActiveTarget(readState()!, "AAA", "session:me", NOW + 61_000);
    expect(readState()!.sessionSeenAt!["session:me"]).toBe(NOW + 61_000);
  });

  test("a stale holder comes back to life by running a command", () => {
    setActiveTarget(readState()!, "AAA", "session:me", NOW);
    const later = NOW + HOLDER_STALE_MS + 5;
    expect(liveHolders(readState()!, undefined, later)).toEqual([]);
    setActiveTarget(readState()!, "AAA", "session:me", later);
    expect(liveHolders(readState()!, undefined, later)).toEqual(["session:me"]);
  });

  test("release forgets the caller's tab and stamp and clears a matching active tab", () => {
    setActiveTarget(readState()!, "AAA", "session:me", NOW);
    setActiveTarget(readState()!, "BBB", "session:other", NOW);
    expect(readState()!.activeTargetId).toBe("BBB");
    releaseSession(readState()!, "session:other");
    const s = readState()!;
    expect(s.tabsBySession).toEqual({ "session:me": "AAA" });
    expect(s.sessionSeenAt).toEqual({ "session:me": NOW });
    expect(s.activeTargetId).toBeNull();
    // The remaining holder is now the last one, so its stop is a teardown.
    expect(planStop(s, "session:me", { now: NOW }).action).toBe("teardown");
  });
});

describe("planEngineStop (agent-browser adapter)", () => {
  // Holders come from `agent-browser session list`; "default" is the unnamed
  // session a human at a shell drives, and it counts like any other.
  test("plain stop closes only this session and names who keeps theirs", () => {
    const r = planEngineStop({ sessions: ["default", "session-me", "session-a"], me: "session-me" });
    expect(r.plan.action).toBe("release");
    expect(r.closeArgs).toEqual([]);
    expect(r.warning).toBeNull();
    expect(r.summary).toContain("2 other session(s) keep theirs: default, session-a");
  });

  test("the last session's stop is a plain close with no warning", () => {
    const r = planEngineStop({ sessions: ["session-me"], me: "session-me" });
    expect(r.plan.action).toBe("teardown");
    expect(r.closeArgs).toEqual([]);
    expect(r.warning).toBeNull();
  });

  test("--force becomes close --all and warns with every session that dies", () => {
    const r = planEngineStop({ sessions: ["default", "session-me", "session-a"], me: "session-me", force: true });
    expect(r.closeArgs).toEqual(["--all"]);
    expect(r.warning).toContain("default, session-a");
    expect(r.summary).toContain("every browser session");
  });

  test("--force alone (no other sessions) needs no --all and no warning", () => {
    const r = planEngineStop({ sessions: ["session-me"], me: "session-me", force: true });
    expect(r.closeArgs).toEqual([]);
    expect(r.warning).toBeNull();
  });
});
