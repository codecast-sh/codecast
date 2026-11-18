import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { create, update } from "./initiatives";
import { list, record, standings, workspaceStandings, get } from "./envs";
import { log, open, page, put } from "./envCases";
import { heldCaseId } from "@codecast/shared/contracts/envs";
import { caseSetVersion, parseCaseSet } from "@codecast/shared/contracts/envCases";

// Env case sets (envCases.ts, pl-1049 ct-96179). Pinned for held: a set goes
// live only when its last chunk lands; its cases leave only through a fetch,
// to the fetch's caller, before it expires; every fetch is a log row counted
// on the env's standing; no read path (standing, log, attempts) carries a
// case; and a session that uploaded the set cannot run it while a goal climbs
// the env. Pinned for dev: any member fetches it, with none of held's rules,
// and dev and held sets of one env never stand in for each other.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const STRANGER = "u".repeat(31) + "s";
const TEAM = "teams_acme" as any;
const ENV = "union/second-side-replay";
const SECRET = "SECRET-PITCH-TEXT";

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
    env_heldout: [],
    env_heldout_cases: [],
    env_heldout_reads: [],
  });
}

const ctxOf = (db: any, who: string | null = ME) => ({ db, auth: { getUserIdentity: async () => (who ? { subject: `${who}|session` } : null) } }) as any;
const run = (fn: any, db: any, args: Record<string, any>, who: string | null = ME) => fn._handler(ctxOf(db, who), args);
const inTeam = { workspace: "team" as const, team_id: TEAM };

let clock = 1_790_000_000_000;
const realNow = Date.now;
beforeEach(() => { Date.now = () => (clock += 1000); });
afterEach(() => { Date.now = realNow; });

const cases = [0, 1, 2].map((i) => ({ id: `case-${i}`, payload: JSON.stringify({ pitch: `${SECRET} ${i}`, outcome: i % 2 ? "yes" : "no" }) }));
async function upload(db: any, extra: Record<string, any> = {}, who = ME) {
  const version = await caseSetVersion({ meta: JSON.stringify({ seed: "abc" }), cases });
  const base = { ...inTeam, env: ENV, version, size: cases.length, label: "frozen", meta: JSON.stringify({ seed: "abc" }), ...extra };
  const first = await run(put, db, { ...base, cases: cases.slice(0, 2) }, who);
  expect(first.live).toBe(false);
  const done = await run(put, db, { ...base, set: first.set, cases: cases.slice(2) }, who);
  expect(done.live).toBe(true);
  return { version, set: done.set };
}
const noSecret = (x: unknown) => expect(JSON.stringify(x)).not.toContain(SECRET);

describe("held sets", () => {
  test("a set goes live on its last chunk; until then nothing can be fetched", async () => {
    const db = fixtures();
    const version = await caseSetVersion({ cases });
    const first = await run(put, db, { ...inTeam, env: ENV, version, size: 3, cases: cases.slice(0, 1) });
    await expect(run(open, db, { ...inTeam, env: ENV })).rejects.toThrow(/no held set/);
    await expect(run(put, db, { ...inTeam, env: ENV, version, size: 3, set: first.set, cases: cases.slice(1) }, MATE)).rejects.toThrow(/not open/);
    await expect(run(put, db, { ...inTeam, env: ENV, version, size: 3, set: first.set, cases: [...cases, ...cases] })).rejects.toThrow(/past its 3/);
    const done = await run(put, db, { ...inTeam, env: ENV, version, size: 3, set: first.set, cases: cases.slice(1) });
    expect(done).toMatchObject({ live: true, written: 3 });
  });

  test("a fetch is logged, and its pages go only to its caller before it expires", async () => {
    const db = fixtures();
    const { version } = await upload(db);
    const o = await run(open, db, { ...inTeam, env: ENV, session_id: "jx-run", task_id: "ct-5" }, MATE);
    expect(o).toMatchObject({ version, size: 3, label: "frozen", meta: JSON.stringify({ seed: "abc" }) });
    const p = await run(page, db, { read: o.read, from: 0 }, MATE);
    expect(p.cases.map((c: any) => c.id)).toEqual(["case-0", "case-1", "case-2"]);
    expect(p.next).toBeNull();
    await expect(run(page, db, { read: o.read, from: 0 }, ME)).rejects.toThrow(/No open case-set fetch/);
    await expect(run(page, db, { read: o.read, from: 0 }, STRANGER)).rejects.toThrow(/No open case-set fetch/);
    clock += 2 * 3600_000;
    await expect(run(page, db, { read: o.read, from: 0 }, MATE)).rejects.toThrow(/No open case-set fetch/);
    const l = await run(log, db, { ...inTeam, env: ENV });
    expect(l.reads.map((r: any) => [r.kind, r.by, r.session_id, r.task_id])).toEqual([["run", "mate", "jx-run", "ct-5"], ["put", "me", undefined, undefined]]);
    expect(l.held).toMatchObject({ size: 3, version, reads: 1 });
    noSecret(l);
  });

  test("an upload's own row cannot open pages", async () => {
    const db = fixtures();
    await upload(db);
    const putRow = db._tables.env_heldout_reads.find((r: any) => r.kind === "put");
    await expect(run(page, db, { read: putRow._id, from: 0 })).rejects.toThrow(/No open case-set fetch/);
  });

  test("nobody outside the workspace opens or reads the log", async () => {
    const db = fixtures();
    await upload(db);
    await expect(run(open, db, { ...inTeam, env: ENV }, STRANGER)).rejects.toThrow();
    await expect(run(log, db, { ...inTeam, env: ENV }, STRANGER)).rejects.toThrow();
  });

  test("standing, attempts and the log carry counts and hashes, never a case", async () => {
    const db = fixtures();
    const { version } = await upload(db);
    const o = await run(open, db, { ...inTeam, env: ENV });
    const hashed = await Promise.all(cases.map((c) => heldCaseId(ENV, c.id)));
    const result = {
      env: ENV, env_version: "abcdef12", level: "L2", candidate: { label: "base" }, split: "held",
      cases: hashed.map((id, i) => ({ id, score: i / 2 })), summary: { n: 3, mean: 0.5 },
      started_at: "2026-11-17T10:00:00Z", finished_at: "2026-11-17T10:00:05Z",
    };
    // A held attempt is filed only against its own fetch, once.
    await expect(run(record, db, { ...inTeam, env: ENV, level: "L2", result: JSON.stringify(result) })).rejects.toThrow(/filed by the run that fetched/);
    await expect(run(record, db, { ...inTeam, env: ENV, level: "L2", result: JSON.stringify(result), cases_read: o.read }, MATE)).rejects.toThrow(/filed by the run that fetched/);
    const filed = await run(record, db, { ...inTeam, env: ENV, level: "L2", result: JSON.stringify(result), cases_read: o.read });
    await expect(run(record, db, { ...inTeam, env: ENV, level: "L2", result: JSON.stringify(result), cases_read: o.read })).rejects.toThrow(/filed by the run that fetched/);
    expect(db._tables.env_attempts[0].cases_version).toBe(version);
    expect((await run(log, db, { ...inTeam, env: ENV })).reads[0]).toMatchObject({ kind: "run", attempt: filed.short_id });
    const s = await run(standings, db, { ...inTeam, envs: [{ env: ENV, level: "L2" }] });
    expect(s[0].held).toMatchObject({ size: 3, version, reads: 1, unfiled: 0, last_attempt: { short_id: filed.short_id, n: 3 } });
    for (const out of [s, await run(workspaceStandings, db, inTeam), await run(list, db, { ...inTeam, env: ENV }), await run(get, db, { id: filed.short_id }), await run(log, db, { ...inTeam, env: ENV })]) {
      noSecret(out);
      for (const c of cases) expect(JSON.stringify(out)).not.toContain(c.id);
    }
  });

  test("a new upload replaces the live set; fetches count per set", async () => {
    const db = fixtures();
    await upload(db);
    await run(open, db, { ...inTeam, env: ENV });
    const next = [{ id: "case-9", payload: JSON.stringify({ pitch: "x" }) }];
    const version = await caseSetVersion({ cases: next });
    await expect(run(put, db, { ...inTeam, env: ENV, version, size: 1, cases: next })).rejects.toThrow(/--replace/);
    await run(put, db, { ...inTeam, env: ENV, version, size: 1, cases: next, replace: true });
    const l = await run(log, db, { ...inTeam, env: ENV });
    expect(l.held).toMatchObject({ version, size: 1, reads: 0 });
    const o = await run(open, db, { ...inTeam, env: ENV });
    expect((await run(page, db, { read: o.read, from: 0 })).cases.map((c: any) => c.id)).toEqual(["case-9"]);
  });

  test("the uploading session cannot run the set once a goal climbs the env, with or without --task", async () => {
    const db = fixtures();
    await upload(db, { session_id: "jx-uploader" });
    // No goal names the env yet: the uploader may check its own upload.
    await run(open, db, { ...inTeam, env: ENV, session_id: "jx-uploader" });
    await run(create, db, { ...inTeam, title: "Matched to opted in" });
    await run(update, db, { id: "in-1", envs: [{ env: ENV, level: "L2" }] });
    await expect(run(open, db, { ...inTeam, env: ENV, session_id: "jx-uploader" })).rejects.toThrow(/uploaded union\/second-side-replay's held set/);
    await expect(run(open, db, { ...inTeam, env: ENV, session_id: "jx-uploader", task_id: "ct-8" })).rejects.toThrow(/uploaded/);
    await run(open, db, { ...inTeam, env: ENV, session_id: "jx-climber" });
  });

  test("a session on a task that climbs the env cannot upload its held set", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Matched to opted in" });
    await run(update, db, { id: "in-1", envs: [{ env: ENV, level: "L2" }] });
    db._tables.tasks.push({ _id: "t1", short_id: "ct-7", title: "climb", goal_ref: "in-1 matched_to_opted_in", workspace: `team:${TEAM}` });
    const version = await caseSetVersion({ cases });
    await expect(run(put, db, { ...inTeam, env: ENV, version, size: 3, cases, task_id: "ct-7" })).rejects.toThrow(/chosen by the climber/);
    expect((await run(put, db, { ...inTeam, env: ENV, version, size: 3, cases })).live).toBe(true);
  });

  test("a fetch that ends with no attempt shows as unfiled", async () => {
    const db = fixtures();
    await upload(db);
    await run(open, db, { ...inTeam, env: ENV, ttl_s: 60 });
    expect((await run(log, db, { ...inTeam, env: ENV })).held).toMatchObject({ reads: 1, unfiled: 0 });
    clock += 120_000;
    expect((await run(log, db, { ...inTeam, env: ENV })).held).toMatchObject({ reads: 1, unfiled: 1 });
  });
});

describe("dev sets", () => {
  const devCases = [0, 1].map((i) => ({ id: `dev-${i}`, payload: JSON.stringify({ pitch: `dev ${i}`, outcome: "yes" }) }));
  async function uploadDev(db: any, extra: Record<string, any> = {}, who = ME) {
    const version = await caseSetVersion({ meta: JSON.stringify({ seed: "abc" }), cases: devCases });
    const out = await run(put, db, { ...inTeam, env: ENV, split: "dev", version, size: 2, meta: JSON.stringify({ seed: "abc" }), cases: devCases, ...extra }, who);
    expect(out).toMatchObject({ live: true, split: "dev" });
    return version;
  }

  test("any member fetches a dev set, the uploader included, while a goal climbs the env", async () => {
    const db = fixtures();
    await run(create, db, { ...inTeam, title: "Matched to opted in" });
    await run(update, db, { id: "in-1", envs: [{ env: ENV, level: "L2" }] });
    const version = await uploadDev(db, { session_id: "jx-uploader" });
    for (const [who, session] of [[ME, "jx-uploader"], [MATE, "jx-other"]] as const) {
      const o = await run(open, db, { ...inTeam, env: ENV, split: "dev", session_id: session }, who);
      expect(o).toMatchObject({ split: "dev", version, size: 2, meta: JSON.stringify({ seed: "abc" }) });
      expect((await run(page, db, { read: o.read, from: 0 }, who)).cases.map((c: any) => c.id)).toEqual(["dev-0", "dev-1"]);
    }
    await expect(run(open, db, { ...inTeam, env: ENV, split: "dev" }, STRANGER)).rejects.toThrow();
  });

  test("dev and held are separate sets: one never answers for the other", async () => {
    const db = fixtures();
    await uploadDev(db);
    await expect(run(open, db, { ...inTeam, env: ENV, split: "held" })).rejects.toThrow(/no held set/);
    const { version: heldVersion } = await upload(db);
    const devOpen = await run(open, db, { ...inTeam, env: ENV, split: "dev" });
    expect((await run(page, db, { read: devOpen.read, from: 0 })).cases.map((c: any) => c.id)).toEqual(["dev-0", "dev-1"]);
    const heldOpen = await run(open, db, { ...inTeam, env: ENV });
    expect(heldOpen.version).toBe(heldVersion);
    // Each split keeps its own live set and replace rule.
    await expect(uploadDev(db)).rejects.toThrow(/live dev set/);
    const l = await run(log, db, { ...inTeam, env: ENV });
    expect(l.dev).toMatchObject({ size: 2, reads: 1, unfiled: 0 });
    expect(l.held).toMatchObject({ size: 3, reads: 1 });
    expect(l.reads.map((r: any) => `${r.kind}:${r.split}`)).toEqual(["run:held", "run:dev", "put:held", "put:dev"]);
  });

  test("a dev attempt takes its set version from its fetch, may run without one, and no fetch crosses splits", async () => {
    const db = fixtures();
    const devVersion = await uploadDev(db);
    await upload(db);
    const result = (split: string, ids: string[]) => ({
      env: ENV, env_version: "abcdef12", level: "L2", candidate: { label: "base" }, split,
      cases: ids.map((id) => ({ id, score: 0.5 })), summary: { n: ids.length, mean: 0.5 },
      started_at: "2026-11-17T10:00:00Z", finished_at: "2026-11-17T10:00:05Z",
    });
    const file = (split: string, ids: string[], extra: Record<string, any> = {}) => run(record, db, { ...inTeam, env: ENV, level: "L2", result: JSON.stringify(result(split, ids)), ...extra });
    // Dev on local cases: no fetch, no version.
    const local = await file("dev", ["dev-0"]);
    expect(db._tables.env_attempts.find((a: any) => a.short_id === local.short_id).cases_version).toBeUndefined();
    const devFetch = await run(open, db, { ...inTeam, env: ENV, split: "dev" });
    const heldFetch = await run(open, db, { ...inTeam, env: ENV });
    const hashed = await heldCaseId(ENV, "case-0");
    await expect(file("held", [hashed], { cases_read: devFetch.read })).rejects.toThrow(/filed by the run that fetched the held set/);
    await expect(file("dev", ["dev-0"], { cases_read: heldFetch.read })).rejects.toThrow(/does not belong to this dev run/);
    const filed = await file("dev", ["dev-0", "dev-1"], { cases_read: devFetch.read });
    expect(db._tables.env_attempts.find((a: any) => a.short_id === filed.short_id).cases_version).toBe(devVersion);
    const s = await run(standings, db, { ...inTeam, envs: [{ env: ENV, level: "L2" }] });
    expect(s[0].dev).toMatchObject({ version: devVersion, last_attempt: { short_id: filed.short_id } });
    expect(s[0].held.last_attempt).toBeUndefined();
  });

  test("no number of dev uploads, dev fetches or dev attempts hides the held set or its counts", async () => {
    const db = fixtures();
    const { version } = await upload(db);
    const heldFetch = await run(open, db, { ...inTeam, env: ENV, ttl_s: 60 });
    const ws = `team:${TEAM}`;
    for (let i = 0; i < 150; i++) {
      db._tables.env_heldout.push({ _id: `dv${i}`, workspace: ws, env: ENV, split: "dev", version: "1111111111111111", size: 2, written: i % 2, ...(i % 2 ? {} : { committed_at: clock + i }), by_user: ME, created_at: clock + i });
    }
    for (let i = 0; i < 1100; i++) db._tables.env_heldout_reads.push({ _id: `dr${i}`, workspace: ws, env: ENV, set_id: "dv0", split: "dev", version: "1111111111111111", kind: "run", by_user: ME, at: clock + i, expires_at: clock + i });
    for (let i = 0; i < 250; i++) db._tables.env_attempts.push({ _id: `da${i}`, workspace: ws, short_id: `ea-x${i}`, env: ENV, env_version: "v", level: "L2", candidate: { label: "base" }, split: "dev", n: 1, mean: 1, started_at: 1, finished_at: clock + 5000 + i, by_user: ME, created_at: 1 });
    clock += 3_600_000;
    expect((await run(open, db, { ...inTeam, env: ENV })).version).toBe(version);
    const l = await run(log, db, { ...inTeam, env: ENV });
    expect(l.held).toMatchObject({ version, reads: 2, unfiled: 1 });
    // A second held upload still needs --replace.
    const v2 = await caseSetVersion({ cases: cases.slice(0, 1) });
    await expect(run(put, db, { ...inTeam, env: ENV, version: v2, size: 1, cases: cases.slice(0, 1) })).rejects.toThrow(/--replace/);
    void heldFetch;
  });

  test("an expired held fetch cannot file an attempt", async () => {
    const db = fixtures();
    await upload(db);
    const o = await run(open, db, { ...inTeam, env: ENV, ttl_s: 60 });
    clock += 120_000;
    const result = { env: ENV, env_version: "abcdef12", level: "L2", candidate: { label: "base" }, split: "held", cases: [{ id: await heldCaseId(ENV, "case-0"), score: 1 }], summary: { n: 1, mean: 1 }, started_at: "2026-11-17T10:00:00Z", finished_at: "2026-11-17T10:00:05Z" };
    await expect(run(record, db, { ...inTeam, env: ENV, level: "L2", result: JSON.stringify(result), cases_read: o.read })).rejects.toThrow(/filed by the run that fetched/);
  });

  test("a dev fetch that files nothing is not counted as unfiled", async () => {
    const db = fixtures();
    await uploadDev(db);
    await run(open, db, { ...inTeam, env: ENV, split: "dev", ttl_s: 60 });
    clock += 120_000;
    expect((await run(log, db, { ...inTeam, env: ENV })).dev).toMatchObject({ reads: 1, unfiled: 0 });
  });
});

describe("sets uploaded before dev sets", () => {
  test("a row with no split is the held set, and the older held_read still files a held attempt", async () => {
    const db = fixtures();
    const ws = `team:${TEAM}`;
    db._tables.env_heldout.push({ _id: "old1", workspace: ws, team_id: TEAM, env: ENV, version: "0123456789abcdef", size: 1, written: 1, committed_at: 5, by_user: ME, created_at: 5 });
    db._tables.env_heldout_cases.push({ _id: "oc1", set_id: "old1", workspace: ws, idx: 0, case_id: "case-0", payload: JSON.stringify({ pitch: SECRET }) });
    db._tables.env_heldout_reads.push({ _id: "op1", workspace: ws, env: ENV, set_id: "old1", version: "0123456789abcdef", kind: "put", by_user: ME, session_id: "jx-old", at: 5 });
    await expect(run(open, db, { ...inTeam, env: ENV, split: "dev" })).rejects.toThrow(/no dev set/);
    const o = await run(open, db, { ...inTeam, env: ENV });
    expect(o).toMatchObject({ split: "held", version: "0123456789abcdef", size: 1 });
    expect((await run(page, db, { read: o.read, from: 0 })).cases.map((c: any) => c.id)).toEqual(["case-0"]);
    const result = { env: ENV, env_version: "abcdef12", level: "L2", candidate: { label: "base" }, split: "held", cases: [{ id: await heldCaseId(ENV, "case-0"), score: 1 }], summary: { n: 1, mean: 1 }, started_at: "2026-11-17T10:00:00Z", finished_at: "2026-11-17T10:00:05Z" };
    await run(record, db, { ...inTeam, env: ENV, level: "L2", result: JSON.stringify(result), held_read: o.read });
    const l = await run(log, db, { ...inTeam, env: ENV });
    expect(l.held).toMatchObject({ version: "0123456789abcdef", reads: 1, unfiled: 0 });
    expect(l.reads.map((r: any) => `${r.kind}:${r.split}`)).toEqual(["run:held", "put:held"]);
    // The old upload's session is still the uploader: refused once a goal climbs the env.
    await run(create, db, { ...inTeam, title: "Matched to opted in" });
    await run(update, db, { id: "in-1", envs: [{ env: ENV, level: "L2" }] });
    await expect(run(open, db, { ...inTeam, env: ENV, session_id: "jx-old" })).rejects.toThrow(/uploaded/);
  });
});

describe("replacing a set's meta only", () => {
  test("keep_cases makes a new version with the same cases, logged as an upload, and only on purpose", async () => {
    const db = fixtures();
    const { version } = await upload(db);
    const meta = JSON.stringify({ seed: "abc", calibration: { platt: { a: 1, b: 0 } } });
    await expect(run(put, db, { ...inTeam, env: ENV, keep_cases: true, meta, cases: [] })).rejects.toThrow(/--replace/);
    await expect(run(put, db, { ...inTeam, env: ENV, split: "dev", keep_cases: true, replace: true, meta, cases: [] })).rejects.toThrow(/no live dev set/);
    const out = await run(put, db, { ...inTeam, env: ENV, keep_cases: true, replace: true, meta, cases: [], session_id: "jx-cal" });
    expect(out).toMatchObject({ live: true, size: 3, split: "held" });
    expect(out.version).not.toBe(version);
    const o = await run(open, db, { ...inTeam, env: ENV }, MATE);
    expect(o).toMatchObject({ version: out.version, meta });
    expect((await run(page, db, { read: o.read, from: 0 }, MATE)).cases.map((c: any) => c.id)).toEqual(["case-0", "case-1", "case-2"]);
    const l = await run(log, db, { ...inTeam, env: ENV });
    expect(l.reads.map((r: any) => `${r.kind}:${r.version === out.version ? "new" : "old"}`)).toEqual(["run:new", "put:new", "put:old"]);
    // A session on a task climbing the env may not change what grades its held set.
    await run(create, db, { ...inTeam, title: "Matched to opted in" });
    await run(update, db, { id: "in-1", envs: [{ env: ENV, level: "L2" }] });
    db._tables.tasks.push({ _id: "t1", short_id: "ct-7", title: "climb", goal_ref: "in-1", workspace: `team:${TEAM}` });
    await expect(run(put, db, { ...inTeam, env: ENV, keep_cases: true, replace: true, meta: "{}", cases: [], task_id: "ct-7" })).rejects.toThrow(/may not change what grades/);
  });
});

describe("case set files", () => {
  test("parse refuses unknown fields, repeated ids and empty sets; the version ignores order", async () => {
    expect(parseCaseSet({ cases: [] })).toMatchObject({ ok: false });
    expect(parseCaseSet({ cases: [{ id: "a", payload: 1 }], extra: 1 })).toMatchObject({ ok: false });
    expect(parseCaseSet({ cases: [{ id: "a", payload: 1 }, { id: "a", payload: 2 }] })).toMatchObject({ ok: false });
    expect(parseCaseSet({ cases: [{ id: "a" }] })).toMatchObject({ ok: false });
    const a = parseCaseSet({ meta: { seed: "s" }, cases: [{ id: "a", payload: { x: 1 } }, { id: "b", payload: 2 }] });
    const b = parseCaseSet({ meta: { seed: "s" }, cases: [{ id: "b", payload: 2 }, { id: "a", payload: { x: 1 } }] });
    if (!a.ok || !b.ok) throw new Error("parse");
    expect(await caseSetVersion(a.set)).toBe(await caseSetVersion(b.set));
    expect(await caseSetVersion(a.set)).toMatch(/^[0-9a-f]{16}$/);
  });
});
