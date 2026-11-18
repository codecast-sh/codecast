import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { create, get as getGoal, update } from "./initiatives";
import { get, goalLevels, link, list, record, standings, workspaceStandings } from "./envs";

// Environment attempts and links (contracts/envs.ts, pl-1049 ct-96178).
// Pinned: the server re-reads the runner's JSON (held content refused), one
// repo per env key, a link carried in a result lands as the env's link, a
// goal's levels read the base attempt first, and nobody outside reads them.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const STRANGER = "u".repeat(31) + "s";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;

function fixtures() {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai", github_username: "me" },
      { _id: MATE, name: "Mate", email: "mate@x.ai", github_username: "mate" },
      { _id: STRANGER, name: "Stranger", email: "s@y.ai" },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    directory_team_mappings: [],
    counters: [],
    initiatives: [],
    initiative_updates: [],
    org_roles: [],
    org_role_history: [],
    anchors: [],
    conversations: [],
    session_owners: [],
    managed_sessions: [],
    tasks: [],
    plans: [],
    metric_watches: [],
    projects: [],
    env_attempts: [],
    env_links: [],
    env_attempt_cases: [],
  });
}

const ctxOf = (db: any, who: string | null = ME) => ({ db, auth: { getUserIdentity: async () => (who ? { subject: `${who}|session` } : null) } }) as any;
const run = (fn: any, db: any, args: Record<string, any>, who: string | null = ME) => fn._handler(ctxOf(db, who), args);
const inTeam = { workspace: "team" as const, team_id: TEAM };

let clock = 1_790_000_000_000;
// A ticking fake clock for this file only: bun runs every test file in one
// process, so the real clock goes back after each test.
const realNow = Date.now;
beforeEach(() => { Date.now = () => (clock += 1000); });
afterEach(() => { Date.now = realNow; });

const result = (over: Record<string, any> = {}) => ({
  env: "union/unit-smoke",
  env_version: "v1",
  rung: "L0",
  candidate: { label: "base", sha: "abc123" },
  split: "dev",
  cases: [{ id: "a", score: 1, draws: 1, pass: true }, { id: "b", score: 0, draws: 1, pass: false, note: "timed out" }],
  summary: { n: 2, mean: 0.5, ci95: [0, 1] },
  cost_usd: 0,
  started_at: "2026-11-17T10:00:00Z",
  finished_at: "2026-11-17T10:00:05Z",
  ...over,
});
const file = (db: any, over: Record<string, any> = {}, extra: Record<string, any> = {}, who = ME) =>
  run(record, db, { ...inTeam, env: "union/unit-smoke", level: "L0", title: "Unit smoke", repo: "github.com/acme/union", result: JSON.stringify(result(over)), ...extra }, who);

describe("envs: attempts", () => {
  test("a dev result is filed with its cases compact and read back whole", async () => {
    const db = fixtures();
    const out = await file(db);
    expect(out).toMatchObject({ short_id: "ea-1", workspace: WS });
    const row = await run(get, db, { id: "EA-1" });
    expect(row).toMatchObject({ env: "union/unit-smoke", level: "L0", n: 2, mean: 0.5, ci95: [0.0945, 0.9055], split: "dev", team_id: TEAM, title: "Unit smoke" });
    expect(row.cases).toEqual([{ id: "a", score: 1, draws: 1, pass: true }, { id: "b", score: 0, draws: 1, pass: false, note: "timed out" }]);
    expect(row.started_at).toBe(Date.parse("2026-11-17T10:00:00Z"));
    expect((await run(list, db, inTeam)).map((r: any) => r.short_id)).toEqual(["ea-1"]);
    expect((await run(list, db, inTeam))[0].cases).toBeUndefined();
  });

  test("the server refuses a held result that carries more than ids and scores, whatever the CLI did", async () => {
    const db = fixtures();
    const H = { split: "held", env_version: "9f3a2c1d" };
    const ha = "h:0123456789abcdef", hb = "h:fedcba9876543210";
    await expect(file(db, { ...H })).rejects.toThrow(/held-split case is its id and score only/);
    await expect(file(db, { ...H, cases: [{ id: ha, score: 1 }], summary: { n: 1, mean: 1 }, transcript: "the case text" })).rejects.toThrow(/field .*transcript.* may not carry/);
    await expect(file(db, { ...H, cases: [{ id: "Jane.Roe.wants.refund", score: 1 }, { id: hb, score: 0.5 }], summary: { n: 2, mean: 0.75 } })).rejects.toThrow(/h: and 16 hex/);
    const ok = await file(db, { ...H, cases: [{ id: ha, score: 1 }, { id: hb, score: 0.5 }], summary: { n: 2, mean: 0.75 } });
    expect((await run(get, db, { id: ok.short_id })).cases).toEqual([{ id: ha, score: 1 }, { id: hb, score: 0.5 }]);
  });

  test("a result for another env, level or a malformed one is refused", async () => {
    const db = fixtures();
    await expect(file(db, { env: "union/other" })).rejects.toThrow(/is for union\/other/);
    await expect(file(db, { rung: "L2" })).rejects.toThrow(/declared at L0/);
    await expect(run(record, db, { ...inTeam, env: "union/unit-smoke", level: "L0", result: "{not json" })).rejects.toThrow(/not JSON/);
    await expect(file(db, { summary: { n: 2, mean: 0.9 } })).rejects.toThrow(/not the mean/);
    expect(await run(list, db, inTeam)).toHaveLength(0);
  });

  test("a second repo declaring the same key is refused", async () => {
    const db = fixtures();
    await file(db);
    await expect(file(db, {}, { repo: "github.com/other/product" })).rejects.toThrow(/already recorded from github.com\/acme\/union/);
    await file(db, {}, { repo: "github.com/acme/union" });
    // A run that names no repo does not reset the guard (review M3); a fork of the same repo is the same repo.
    await file(db, {}, { repo: "" });
    await expect(file(db, {}, { repo: "github.com/other/product" })).rejects.toThrow(/already recorded/);
    await file(db, {}, { repo: "github.com/ashot/union" });
  });

  test("a link in the result becomes the env's link with the attempt as evidence; a hand link must point up", async () => {
    const db = fixtures();
    const out = await file(db, { link: { to: "L5:intros_a_week", measure: "pearson", value: 0.41, n: 12, measured_at: "2026-11-10T00:00:00Z" } });
    const row = await run(get, db, { id: out.short_id });
    expect(row.link).toMatchObject({ to: "L5:intros_a_week", measure: "pearson", value: 0.41, n: 12, evidence: out.short_id });
    await expect(run(link, db, { ...inTeam, env: "union/unit-smoke", level: "L2", to: "L1:union/gate", measure: "auc", value: 0.7, n: 40 })).rejects.toThrow(/not above L2/);
    await run(link, db, { ...inTeam, env: "union/unit-smoke", level: "L0", to: "L2:union/replay", measure: "rank", value: 0.6, n: 8, evidence: "doc:abc" });
    expect((await run(get, db, { id: out.short_id })).link).toMatchObject({ to: "L2:union/replay", evidence: "doc:abc" });
  });

  test("nobody outside the workspace reads an attempt", async () => {
    const db = fixtures();
    await file(db);
    await expect(run(get, db, { id: "ea-1" }, STRANGER)).rejects.toThrow(/not found/i);
    expect((await run(get, db, { id: "ea-1" }, MATE)).env).toBe("union/unit-smoke");
  });
});

describe("envs: a goal's levels", () => {
  test("a goal names its envs through update, ordered by level, logged like its metrics", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Intros a week" });
    await run(update, db, { id: "in-1", envs: [{ env: "union/replay", level: "L2" }, { env: "union/unit-smoke", level: "L0", note: "fast" }] });
    expect((await run(getGoal, db, { id: "in-1" })).envs).toEqual([{ env: "union/unit-smoke", level: "L0", note: "fast" }, { env: "union/replay", level: "L2" }]);
    await expect(run(update, db, { id: "in-1", envs: [{ env: "union/replay", level: "L2" }, { env: "union/replay", level: "L3" }] })).rejects.toThrow(/named twice/);
    await expect(run(update, db, { id: "in-1", envs: [{ env: "Not A Key", level: "L2" }] })).rejects.toThrow(/not an env key/);
    await run(update, db, { id: "in-1", envs: [] });
    expect((await run(getGoal, db, { id: "in-1" })).envs).toBeUndefined();
  });

  test("each level reads its latest base attempt (else the latest) and its link; an env removed from the repo still reads", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Intros a week" });
    await run(update, db, { id: "in-1", envs: [{ env: "union/unit-smoke", level: "L0" }, { env: "union/gone", level: "L1" }] });
    await file(db, {}, { goal: "in-1" });
    await file(db, { candidate: { label: "ct-9", sha: "def4567" }, cases: [{ id: "a", score: 1 }, { id: "b", score: 1 }], summary: { n: 2, mean: 1 } }, { goal: "in-1" });
    const out = await run(goalLevels, db, { goal: "in-1" });
    expect(out.goal.short_id).toBe("in-1");
    expect(out.levels[0]).toMatchObject({ env: "union/unit-smoke", level: "L0", title: "Unit smoke", attempt: { short_id: "ea-1", candidate: { label: "base" }, mean: 0.5 } });
    expect(out.levels[1]).toEqual({ env: "union/gone", level: "L1" });
    expect(await run(goalLevels, db, { goal: "in-1" }, STRANGER)).toBeNull();

    const feed = await run(workspaceStandings, db, inTeam, MATE);
    expect(feed.map((r: any) => r._id)).toEqual([`${WS}|union/unit-smoke`, `${WS}|union/gone`]);
    expect(feed[0]).toMatchObject({ workspace: WS, env: "union/unit-smoke", attempt: { short_id: "ea-1" } });
    expect(feed[0].level).toBeUndefined();
    expect(await run(standings, db, { ...inTeam, envs: [{ env: "union/unit-smoke", level: "L0" }] })).toHaveLength(1);
  });
});
