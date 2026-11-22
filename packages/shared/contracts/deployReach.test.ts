import { describe, expect, test } from "bun:test";
import { deployHolds, deployReach, targetReach, type ReachChange, type ReachDeploy, type ReachState } from "./deployReach";

// How far a change has gone toward production (deploys.md DP16), read from a
// target's deploys. Synthetic data only.

const SHA = "604c31732fabcdef0123456789abcdef01234567";
const OTHER = "ffffffffff0000000000000000000000000000aa";
/** The change: on main at 1000, merged at 900. */
const ON_MAIN: ReachChange = { sha: SHA, main_at: 1000, merged_at: 900 };
/** A change main never ordered: only its merge time is known. */
const MERGED_ONLY: ReachChange = { sha: null, main_at: null, merged_at: 900 };

let n = 0;
const dp = (status: ReachDeploy["status"], over: Partial<ReachDeploy> = {}): ReachDeploy => ({
  short_id: `dp-${++n}`,
  status,
  sha: OTHER,
  created_at: 0,
  ...over,
});

type Row = { name: string; change: ReachChange; deploys: () => ReachDeploy[]; state: ReachState; deploy?: string | null; now?: string | null };

const ROWS: Row[] = [
    { name: "no deploys at all waits", change: ON_MAIN, deploys: () => [], state: "waiting", deploy: null, now: null },
    { name: "the live deploy is the change's commit, by a short prefix in another case", change: ON_MAIN, deploys: () => [dp("live", { sha: SHA.slice(0, 9).toUpperCase(), created_at: 10 })], state: "live", deploy: "dp-1" },
    { name: "a six-character prefix is not the same commit", change: ON_MAIN, deploys: () => [dp("live", { sha: SHA.slice(0, 6), created_at: 10 })], state: "waiting", now: "dp-1" },
    { name: "a live cut on main at the change's place holds it", change: ON_MAIN, deploys: () => [dp("live", { cut_at: 1000, created_at: 10 })], state: "live", deploy: "dp-1" },
    { name: "a live cut before the change's place waits", change: ON_MAIN, deploys: () => [dp("live", { cut_at: 999, created_at: 10 })], state: "waiting", deploy: null, now: "dp-1" },
    { name: "the change's place on main beats its merge time against a cut", change: ON_MAIN, deploys: () => [dp("live", { cut_at: 950, created_at: 10 })], state: "waiting", now: "dp-1" },
    { name: "with no place on main the merge time is held against a cut", change: MERGED_ONLY, deploys: () => [dp("live", { cut_at: 950, created_at: 10 })], state: "live", deploy: "dp-1" },
    {
      name: "the first live deploy that held it took it out; the live ones since kept it",
      change: ON_MAIN,
      deploys: () => [dp("live", { cut_at: 1500, created_at: 30 }), dp("live", { cut_at: 1200, created_at: 20 }), dp("live", { cut_at: 800, created_at: 10 })],
      state: "live",
      deploy: "dp-2",
    },
    { name: "with no cut, a deploy live at or after the merge holds it", change: MERGED_ONLY, deploys: () => [dp("live", { live_at: 900, created_at: 800 })], state: "live", deploy: "dp-1" },
    { name: "with no cut, a deploy live before the merge waits", change: MERGED_ONLY, deploys: () => [dp("live", { live_at: 899, created_at: 800 })], state: "waiting", now: "dp-1" },
    {
      name: "a running deploy cut after it, past a live one that is not, is going out",
      change: ON_MAIN,
      deploys: () => [dp("live", { cut_at: 800, created_at: 10 }), dp("running", { cut_at: 1200, created_at: 20, url: "https://ci/9" })],
      state: "going_out",
      deploy: "dp-2",
      now: "dp-1",
    },
    { name: "a requested deploy of the change's own commit that no machine has started is queued", change: ON_MAIN, deploys: () => [dp("requested", { sha: SHA, created_at: 20 })], state: "queued", deploy: "dp-1", now: null },
    { name: "an open deploy with no place on main says nothing yet", change: MERGED_ONLY, deploys: () => [dp("running", { created_at: 2000 })], state: "waiting", deploy: null },
    { name: "an open deploy with no sha says nothing yet", change: ON_MAIN, deploys: () => [dp("requested", { sha: null, created_at: 2000 })], state: "waiting" },
    {
      name: "an earlier live deploy held it and the live one now does not: rolled back",
      change: ON_MAIN,
      deploys: () => [dp("live", { cut_at: 1200, created_at: 10 }), dp("live", { cut_at: 800, created_at: 20 })],
      state: "rolled_back",
      deploy: "dp-1",
      now: "dp-2",
    },
    {
      name: "a deploy after the live one that held it and failed",
      change: ON_MAIN,
      deploys: () => [dp("live", { cut_at: 800, created_at: 10 }), dp("failed", { cut_at: 1200, created_at: 20, finished_at: 25 })],
      state: "failed",
      deploy: "dp-2",
      now: "dp-1",
    },
    { name: "a failed deploy with no live one at all", change: ON_MAIN, deploys: () => [dp("failed", { sha: SHA, created_at: 20 })], state: "failed", deploy: "dp-1", now: null },
    { name: "a failed deploy with no cut, created after the merge, held it by time", change: MERGED_ONLY, deploys: () => [dp("failed", { created_at: 950 })], state: "failed", deploy: "dp-1" },
    {
      name: "a failed deploy older than the live one does not count",
      change: ON_MAIN,
      deploys: () => [dp("failed", { cut_at: 1200, created_at: 5 }), dp("live", { cut_at: 800, created_at: 10 })],
      state: "waiting",
      now: "dp-2",
    },
    { name: "a failed deploy that did not hold it does not count", change: ON_MAIN, deploys: () => [dp("live", { cut_at: 800, created_at: 10 }), dp("failed", { cut_at: 900, created_at: 20 })], state: "waiting" },
    { name: "a cancelled deploy that held it does not count", change: ON_MAIN, deploys: () => [dp("cancelled", { sha: SHA, created_at: 20 })], state: "waiting", deploy: null },
    {
      name: "going out beats a failure behind it",
      change: ON_MAIN,
      deploys: () => [dp("live", { cut_at: 800, created_at: 10 }), dp("failed", { cut_at: 1200, created_at: 20 }), dp("running", { sha: SHA, created_at: 30 })],
      state: "going_out",
      deploy: "dp-3",
    },
];

describe("one target's reach", () => {
  for (const r of ROWS) {
    test(r.name, () => {
      n = 0;
      const deploys = r.deploys();
      // Order does not matter: the rule sorts by created_at itself.
      for (const list of [deploys, [...deploys].reverse()]) {
        const got = targetReach("web", list, r.change);
        expect(got.target).toBe("web");
        expect(got.state).toBe(r.state);
        if (r.deploy !== undefined) expect(got.deploy?.short_id ?? null).toBe(r.deploy);
        if (r.now !== undefined) expect(got.now?.short_id ?? null).toBe(r.now);
      }
    });
  }

  test("a deploy ref carries its status, sha, url, and when it went live, else finished, else was made", () => {
    const live = targetReach("web", [dp("live", { sha: SHA, created_at: 10, live_at: 15, finished_at: 16, url: "https://x/1" })], ON_MAIN);
    expect(live.deploy).toEqual({ short_id: expect.any(String), status: "live", sha: SHA, at: 15, url: "https://x/1" });
    const failed = targetReach("web", [dp("failed", { sha: SHA, created_at: 10, finished_at: 16 })], ON_MAIN);
    expect(failed.deploy).toMatchObject({ status: "failed", at: 16, url: null });
    const open = targetReach("web", [dp("running", { sha: SHA, created_at: 10 })], ON_MAIN);
    expect(open.deploy).toMatchObject({ status: "running", at: 10 });
  });

  test("deployHolds: same commit wins over a cut that would not hold it", () => {
    expect(deployHolds(dp("live", { sha: SHA, cut_at: 1 }), ON_MAIN)).toBe(true);
    expect(deployHolds(dp("live", { cut_at: 5000 }), { sha: SHA, main_at: null, merged_at: null })).toBe(false);
  });
});

// Moments after every fixture deploy: every target is still shipping, so all of them speak.
const NOW_ACTIVE = 5_000;

describe("the change's reach over its targets", () => {
  const LIVE = [dp("live", { sha: SHA, created_at: 10 })];
  const GOING = [dp("running", { sha: SHA, created_at: 10 })];
  const QUEUED = [dp("requested", { sha: SHA, created_at: 10 })];
  const WAITING: ReachDeploy[] = [];
  const ROLLED = [dp("live", { cut_at: 1200, created_at: 10 }), dp("live", { cut_at: 800, created_at: 20 })];
  const FAILED = [dp("failed", { sha: SHA, created_at: 10 })];
  const of = (...ds: ReachDeploy[][]) => deployReach(ON_MAIN, ds.map((deploys, i) => ({ target: `t${i}`, deploys })), NOW_ACTIVE)!.state;

  test("the state that most needs a reader's eye: failed, rolled back, waiting, queued, going out, live", () => {
    expect(of(LIVE, LIVE)).toBe("live");
    expect(of(GOING, QUEUED, LIVE)).toBe("queued");
    expect(of(QUEUED, WAITING)).toBe("waiting");
    expect(of(LIVE, GOING)).toBe("going_out");
    expect(of(GOING, WAITING, LIVE)).toBe("waiting");
    expect(of(WAITING, ROLLED, GOING)).toBe("rolled_back");
    expect(of(ROLLED, FAILED, WAITING, LIVE)).toBe("failed");
    expect(of(FAILED, LIVE)).toBe("failed");
  });

  test("each target is reported, with the change's sha; no targets is no reach", () => {
    const r = deployReach(ON_MAIN, [{ target: "web", deploys: LIVE }, { target: "api", deploys: WAITING }], NOW_ACTIVE)!;
    expect(r.sha).toBe(SHA);
    expect(r.targets.map((t) => [t.target, t.state])).toEqual([["web", "live"], ["api", "waiting"]]);
    expect(deployReach(ON_MAIN, [], NOW_ACTIVE)).toBeNull();
  });
});

describe("a dormant target keeps its row but does not set the change's state", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  test("a backend copy last shipped 15 days ago does not hold a change live on production at not live yet", () => {
    const production = [dp("live", { sha: SHA, created_at: now - DAY, live_at: now - DAY })];
    const operator = [dp("live", { sha: "1111111aaaa", cut_at: 1, created_at: now - 15 * DAY, live_at: now - 15 * DAY })];
    const r = deployReach(ON_MAIN, [{ target: "production", deploys: production }, { target: "aivery-operator", deploys: operator }], now)!;
    expect(r.state).toBe("live");
    expect(r.targets.map((t) => [t.target, t.state])).toEqual([["production", "live"], ["aivery-operator", "waiting"]]);
    expect(r.targets.map((t) => [t.target, !!t.dormant])).toEqual([["production", false], ["aivery-operator", true]]);
  });
  test("a target with a deploy open, or one in the week, still speaks; when all are dormant, all speak", () => {
    const production = [dp("live", { sha: SHA, created_at: now - DAY, live_at: now - DAY })];
    const recent = [dp("live", { sha: "1111111aaaa", cut_at: 1, created_at: now - 2 * DAY, live_at: now - 2 * DAY })];
    expect(deployReach(ON_MAIN, [{ target: "p", deploys: production }, { target: "app", deploys: recent }], now)!.state).toBe("waiting");
    const old = [dp("live", { sha: "1111111aaaa", cut_at: 1, created_at: now - 15 * DAY, live_at: now - 15 * DAY })];
    const queued = [...old, dp("requested", { sha: SHA, created_at: now - 20 * DAY })];
    expect(deployReach(ON_MAIN, [{ target: "p", deploys: production }, { target: "q", deploys: queued }], now)!.state).toBe("queued");
    expect(deployReach(ON_MAIN, [{ target: "only", deploys: old }], now)!.state).toBe("waiting");
  });
});
