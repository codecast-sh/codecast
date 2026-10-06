import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { gzipSync, strToU8 } from "fflate";
import schema from "./schema";
import { armedTriggerRows, makeFakeDb, schemaIndexes } from "./testDb";
import { sha256Hex } from "./lib/hash";
import { HOUR_MS, hourStart } from "./lib/ingestGroups";
import { INGEST_LIMITS, isIngestKey } from "@codecast/shared/contracts/ingest";
import {
  OVERFLOW_FP,
  SOURCE_CAPS,
  applyBatch,
  createSource,
  dailyUpkeep,
  flushGroupTally,
  getGroup,
  purgeSourceRows,
  removeSource,
  getSource,
  listEvents,
  listGroups,
  listSources,
  linkSignal,
  promotionInputs,
  promotionSignal,
  rotateKey,
  setGroupStatus,
  sourceForKey,
  updateSource,
} from "./ingest";
import { listForTask, listForTeam } from "./externalEvents";
import { bumpWindow } from "./ipRateLimit";
import { applyTaskUpdate, insertTask, nextArmingAfterRun } from "./agentTasks";
import { admitIngestKey, decodeIngestBody, INGEST_PREFIXES, UNKNOWN_KEY_RATE, ingestErrorStatus, ingestKeyFrom, ingestServe, originAllowed } from "./ingestHttp";
import { backoffMs, classifyStatus, DEFAULT_CODECAST_INGEST_ENDPOINT } from "@platform/analytics/codecast";

const h = (fn: any) => fn._handler;

function world() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      projects: [],
      event_sources: [],
      event_groups: [],
      event_samples: [],
      external_events: [],
      agent_tasks: [],
      conversations: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internalCtx: { db, scheduler } as any };
}

/** A world with a trigger armed on every name an ingest transition fires. */
async function armedWorld() {
  const w = world();
  for (const row of armedTriggerRows("error_new", "error_regressed", "error_spike", "check_failed", "check_recovered", "job_failed", "metric_alert", "metric_recovered", "deploy")) {
    await w.db.insert("agent_tasks", row);
  }
  return w;
}

const TEAM = { workspace: "team" as const, team_id: "team_1" as any };

async function teamSource(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const out = await h(createSource)(w.as("u1"), { ...TEAM, name: " Union ", provider: "sdk", ...extra });
  return out as { source: any; ingest_key: string };
}

const NOW = Date.now();
const err = (message: string, over: Record<string, unknown> = {}) => ({ type: "error", message, at: NOW, ...over });
const batch = (w: ReturnType<typeof world>, sourceId: string, items: unknown[], extra: Record<string, unknown> = {}) =>
  h(applyBatch)(w.internalCtx, { source_id: sourceId, items_json: JSON.stringify(items), ...extra });
const names = (w: ReturnType<typeof world>) => w.scheduled.map((s) => s.name);
/** A group as a detail reader sees it: the row with its tally (occurrences held off the row) laid over. */
const live = (w: ReturnType<typeof world>, i = 0) => {
  const g = w.db._tables.event_groups[i];
  const t = (w.db._tables.event_group_tallies ?? []).find((x: any) => x.group_id === g._id);
  if (!t) return g;
  return { ...g, ...Object.fromEntries(Object.entries(JSON.parse(t.fields_json)).map(([k, value]) => [k, value ?? undefined])) };
};
/** A source's counters, which live on event_source_stats. */
const stats = (w: ReturnType<typeof world>, i = 0) => (w.db._tables.event_source_stats ?? []).find((x: any) => x.source_id === w.db._tables.event_sources[i]._id) ?? {};

describe("sources", () => {
  test("create returns the key once and stores only its hash", async () => {
    const w = world();
    const { source, ingest_key } = await teamSource(w);
    expect(isIngestKey(ingest_key)).toBe(true);
    const row = w.db._tables.event_sources[0];
    expect(row.ingest_key_hash).toBe(await sha256Hex(ingest_key));
    expect(row).toMatchObject({ workspace: "team:team_1", team_id: "team_1", owner_user_id: "u1", name: "union", status: "active", short_id: "src-1", promote: ["new", "regressed"] });
    expect(source.ingest_key_hash).toBeUndefined();
    expect(source.keyed).toBe(true);
    expect(JSON.stringify(await h(listSources)(w.as("u1"), TEAM))).not.toContain(row.ingest_key_hash);
  });

  test("no public source function returns the key hash", async () => {
    const w = world();
    await teamSource(w);
    const hash = w.db._tables.event_sources[0].ingest_key_hash;
    const outs = [
      await h(getSource)(w.as("u1"), { ...TEAM, source: "union" }),
      await h(updateSource)(w.as("u1"), { ...TEAM, source: "union", promote: ["new"] }),
      await h(listSources)(w.as("u1"), TEAM),
    ];
    const rotated = await h(rotateKey)(w.as("u1"), { ...TEAM, source: "union" });
    for (const out of [...outs, rotated]) expect(JSON.stringify(out)).not.toContain("ingest_key_hash");
    expect(JSON.stringify(outs)).not.toContain(hash);
  });

  test("a name is unique per workspace, whatever its spelling", async () => {
    const w = world();
    await teamSource(w);
    await expect(h(createSource)(w.as("u1"), { ...TEAM, name: "UNION", provider: "http" })).rejects.toThrow(/already exists/);
  });

  test("a connector source gets no key", async () => {
    const w = world();
    const out = await h(createSource)(w.as("u1"), { ...TEAM, name: "sentry", provider: "sentry" });
    expect(out.ingest_key).toBeUndefined();
    expect(w.db._tables.event_sources[0].ingest_key_hash).toBeUndefined();
  });

  test("rotate replaces the hash, so the old key stops resolving", async () => {
    const w = world();
    const { ingest_key } = await teamSource(w);
    const { ingest_key: next } = await h(rotateKey)(w.as("u1"), { ...TEAM, source: "union" });
    expect(next).not.toBe(ingest_key);
    expect(await h(sourceForKey)(w.internalCtx, { key_hash: await sha256Hex(ingest_key) })).toBeNull();
    expect(await h(sourceForKey)(w.internalCtx, { key_hash: await sha256Hex(next) })).toMatchObject({ status: "active" });
  });

  test("someone outside the workspace cannot see or change it", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await expect(h(rotateKey)(w.as("u2"), { workspace: "personal", source: source.short_id })).rejects.toThrow(/not found/);
    expect(await h(listSources)(w.as("u2"), { workspace: "personal" })).toEqual([]);
  });

  test("resume clears the reason a source stopped", async () => {
    const w = world();
    await teamSource(w);
    w.db._tables.event_sources[0].status = "paused";
    w.db._tables.event_sources[0].last_error = "filer left";
    const { source } = await h(updateSource)(w.as("u1"), { ...TEAM, source: "src-1", status: "active" });
    expect(source.status).toBe("active");
    expect(source.last_error).toBeUndefined();
  });
});

describe("applyBatch", () => {
  test("a new error makes a group, a sample, one timeline row, a trigger firing and a promotion", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    const res = await batch(w, source._id, [err("Boom 1"), err("Boom 2")], { release: "1.0.0", environment: "prod" });
    expect(res).toEqual({ accepted: 2, dropped: 0, transitions: 1, folded: 0 });

    const group = w.db._tables.event_groups[0];
    expect(group).toMatchObject({ workspace: "team:team_1", source_id: source._id, short_id: "eg-1", kind: "error", status: "open", count: 2, title: "Boom 2", first_release: "1.0.0" });
    expect(group.fingerprint.startsWith("error:")).toBe(true);
    expect(w.db._tables.event_samples).toHaveLength(2);

    const event = w.db._tables.external_events[0];
    expect(event).toMatchObject({ workspace: "team:team_1", team_id: "team_1", source_id: source._id, group_id: group._id, kind: "error_new", source: "sdk" });
    expect(event.repository).toBeUndefined();
    expect(event.data).toMatchObject({ transition: "new", group_short_id: "eg-1", source_name: "union", release: "1.0.0", environment: "prod" });

    const fire = w.scheduled.find((s) => s.name === "agentTasks:matchTaskTriggers")!;
    expect(fire.args).toMatchObject({ event_type: "error_new", team_id: "team_1", workspace: "team:team_1", source: "union", event_ref: { external_event_id: event._id, group_short_id: "eg-1" } });
    const promo = w.scheduled.find((s) => s.name === "ingest:promote")!;
    expect(promo.args).toMatchObject({ group_id: group._id, transition: "new", fingerprint: group.fingerprint });

    expect(stats(w)).toMatchObject({ events_today: 2, groups_open: 1 });
    // The counters stay off the source row, which every Ops query reads.
    expect(w.db._tables.event_sources[0].events_today).toBeUndefined();
    expect((await h(getSource)(w.as("u1"), { ...TEAM, source: "union" })).events_today).toBe(2);
  });

  test("a repeat only counts: no row, no firing", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    w.scheduled.length = 0;
    const res = await batch(w, source._id, [err("Boom", { at: NOW + 1 })]);
    expect(res.transitions).toBe(0);
    expect(live(w).count).toBe(2);
    expect(w.db._tables.external_events).toHaveLength(1);
    // A quiet repeat inside a minute holds its numbers on the tally, so the
    // issues list (the group rows) does not re-run; one flush writes them.
    expect(w.db._tables.event_groups[0].count).toBe(1);
    expect(names(w)).toEqual(["ingest:flushGroupTally"]);
    expect((await h(getGroup)(w.as("u1"), { group: "eg-1" })).group.count).toBe(2);
  });

  test("the fingerprint prefix reaches the signal, not the stored group", async () => {
    const w = world();
    const { source } = await teamSource(w, { fingerprint_prefix: "union", promote: ["check_failed"] });
    await batch(w, source._id, [{ type: "check", id: "orders-balance", ok: false }]);
    expect(w.db._tables.event_groups[0].fingerprint).toBe("invariant:orders-balance");
    expect(w.scheduled.find((s) => s.name === "ingest:promote")!.args.fingerprint).toBe("union:invariant:orders-balance");
  });

  test("a check flips red then green; a transition the source does not promote only fires", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    await batch(w, source._id, [{ type: "check", id: "c1", ok: true, at: NOW - 2000 }]);
    expect(w.db._tables.external_events).toHaveLength(0);
    await batch(w, source._id, [{ type: "check", id: "c1", ok: false, at: NOW - 1000 }]);
    await batch(w, source._id, [{ type: "check", id: "c1", ok: true, at: NOW }]);
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["check_failed", "check_recovered"]);
    expect(names(w).filter((n) => n === "agentTasks:matchTaskTriggers")).toHaveLength(2);
    expect(names(w)).not.toContain("ingest:promote");
    expect(w.db._tables.event_groups[0]).toMatchObject({ status: "resolved", meta: { ok: true } });
    // A green report keeps no sample.
    expect(w.db._tables.event_samples).toHaveLength(1);
    expect(stats(w).groups_open).toBe(0);
  });

  test("samples stay at 20 per group", async () => {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < 6; i++) {
      await batch(w, source._id, Array.from({ length: 10 }, (_, j) => err("Boom", { at: NOW - 100_000 + i * 100 + j })));
    }
    expect(w.db._tables.event_samples).toHaveLength(20);
    expect(live(w).count).toBe(60);
    expect(live(w).sample_count).toBe(20);
  });

  test("a resolved error that comes back regresses and promotes", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 10 })]);
    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved", resolved_in: "1.0.0" });
    expect(stats(w).groups_open).toBe(0);
    w.scheduled.length = 0;
    await batch(w, source._id, [err("Boom")], { release: "0.9.0" });
    expect(w.db._tables.external_events).toHaveLength(1);
    await batch(w, source._id, [err("Boom", { at: NOW + 1 })], { release: "1.0.1" });
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["error_new", "error_regressed"]);
    expect(w.scheduled.find((s) => s.name === "ingest:promote")!.args.transition).toBe("regressed");
  });

  test("a regression after a second resolve announces even when the occurrence reuses an earlier regression's at", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 10 })]);
    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved" });
    await batch(w, source._id, [err("Boom", { at: NOW })]);
    await new Promise((r) => setTimeout(r, 2));
    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved", resolved_in: "1.1.0" });
    w.scheduled.length = 0;
    // A retried batch: the same `at` as the first regression.
    await batch(w, source._id, [err("Boom", { at: NOW })], { release: "1.1.0" });
    expect(w.db._tables.event_groups[0].status).toBe("open");
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["error_new", "error_regressed", "error_regressed"]);
    expect(names(w)).toContain("agentTasks:matchTaskTriggers");
    expect(w.scheduled.find((s) => s.name === "ingest:promote")!.args.transition).toBe("regressed");
  });

  test("a spike announces against a quiet day", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 30 * HOUR_MS })]);
    const hour = hourStart(NOW);
    await batch(w, source._id, Array.from({ length: 25 }, (_, i) => err("Boom", { at: hour + i })));
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["error_new", "error_spike"]);
  });

  test("a deploy is one marker however often it is reported", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    const deploy = { type: "deploy", version: "1.2.0", sha: "abc", at: NOW };
    await batch(w, source._id, [deploy], { environment: "prod" });
    await batch(w, source._id, [deploy], { environment: "prod" });
    expect(w.db._tables.external_events).toHaveLength(1);
    expect(w.db._tables.external_events[0]).toMatchObject({ kind: "deploy", title: "Deployed 1.2.0 to prod", sha: "abc" });
    expect(w.scheduled.find((s) => s.name === "agentTasks:matchTaskTriggers")!.args).toMatchObject({ event_type: "deploy", source: "union" });
  });

  test("events, info logs and replays are accepted without a group", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const res = await batch(w, source._id, [{ type: "event", name: "signup", at: NOW }, { type: "log", level: "info", message: "hi", at: NOW }, { type: "replay", replay_id: "r", at: NOW }]);
    expect(res).toEqual({ accepted: 3, dropped: 0, transitions: 0, folded: 0 });
    expect(w.db._tables.event_groups).toHaveLength(0);
    // An analytics event is counted per name and hour on the source, and its payload is not kept.
    await batch(w, source._id, [{ type: "event", name: "signup", at: NOW, props: { plan: "plan-zeta" } }, { type: "event", name: "checkout", at: NOW }]);
    const names = stats(w).event_names;
    expect(names.map((e: any) => [e.name, e.buckets.reduce((n: number, b: any) => n + b.count, 0)])).toEqual([["signup", 2], ["checkout", 1]]);
    expect(JSON.stringify(w.db._tables.event_source_stats)).not.toContain("plan-zeta");
  });

  test("a paused source takes nothing", async () => {
    const w = world();
    const { source } = await teamSource(w);
    w.db._tables.event_sources[0].status = "paused";
    expect(await batch(w, source._id, [err("Boom")])).toEqual({ accepted: 0, dropped: 1, transitions: 0, folded: 0 });
    expect(w.db._tables.event_groups).toHaveLength(0);
  });

  test("the team feed leaves the transitions out; the ingestion timeline has them", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    expect(await h(listForTeam)(w.as("u1"), { team_id: "team_1" })).toEqual([]);
    expect(await h(listEvents)(w.as("u1"), TEAM)).toHaveLength(1);
    expect(await h(listEvents)(w.as("u1"), { ...TEAM, source: "union" })).toHaveLength(1);
  });
});

describe("readers", () => {
  test("groups and their samples are the workspace's only", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom"), { type: "job_failed", job: "Send", error: "x", at: NOW }]);
    expect((await h(listGroups)(w.as("u1"), TEAM)).map((g: any) => g.kind).sort()).toEqual(["error", "job"]);
    expect((await h(listGroups)(w.as("u1"), { ...TEAM, kind: "job" })).map((g: any) => g.short_id)).toEqual(["eg-2"]);
    const shown = await h(getGroup)(w.as("u1"), { group: "eg-1" });
    expect(shown.samples).toHaveLength(1);
    expect(shown.source).toMatchObject({ name: "union", short_id: "src-1" });
    expect(await h(listGroups)(w.as("u2"), { workspace: "personal" })).toEqual([]);
    await expect(h(getGroup)(w.as("u2"), { group: "eg-1" })).rejects.toThrow(/not found/);
    await expect(h(setGroupStatus)(w.as("u2"), { group: "eg-1", status: "ignored" })).rejects.toThrow(/not found/);
  });
});

describe("promotion", () => {
  const source = { provider: "sdk" as const, name: "union", workspace: "team:team_1", team_id: "team_1" as any, project_id: "p1" as any };
  const group = { short_id: "eg-4", kind: "error" as const, title: "Boom", culprit: "load@/a.js", count: 3, first_seen: 1, last_seen: 2, last_release: "1.0" };

  test("files in the source's workspace and project, by the kind map", () => {
    expect(promotionSignal(source, group, "new", "union:error:abc")).toMatchObject({
      source: "sdk:union",
      kind: "bug",
      fingerprint: "union:error:abc",
      title: "Boom",
      subject: "eg-4",
      observed_at: 2,
      workspace: "team",
      team_id: "team_1",
      project: "p1",
    });
    expect(promotionSignal(source, group, "spike", "f")!.kind).toBe("regression");
    expect(promotionSignal({ ...source, workspace: "user:u1", team_id: undefined, project_id: undefined }, group, "regressed", "f")).toMatchObject({ workspace: "personal" });
    expect(promotionSignal(source, group, "resolved", "f")).toBeNull();
  });

  test("the promoting transition and every later one land on the cause task's timeline", async () => {
    const w = world();
    w.db._tables.tasks = [{ _id: "t1", short_id: "ct-1", title: "Boom", user_id: "u1", team_id: "team_1", workspace: "team:team_1", status: "open", created_at: NOW, updated_at: NOW }];
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 10 })]);
    const promo = w.scheduled.find((s) => s.name === "ingest:promote")!;
    const first = w.db._tables.external_events[0];
    expect(promo.args.external_event_id).toBe(first._id);
    // What ingest.promote writes back once signals.ingestAs names the cause.
    await h(linkSignal)(w.internalCtx, { group_id: promo.args.group_id, task_id: "t1", external_event_id: promo.args.external_event_id });
    await h(linkSignal)(w.internalCtx, { group_id: promo.args.group_id, task_id: "t1", external_event_id: promo.args.external_event_id });
    expect(w.db._tables.external_events[0]).toMatchObject({ task_id: "t1", task_ids: ["t1"] });

    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved" });
    await batch(w, source._id, [err("Boom")], { release: "2.0.0" });
    const regressed = w.db._tables.external_events[1];
    expect(regressed).toMatchObject({ kind: "error_regressed", task_id: "t1", task_ids: ["t1"] });

    const timeline = await h(listForTask)(w.as("u1"), { task_id: "t1" });
    expect(timeline.map((e: any) => e.kind)).toEqual(["error_regressed", "error_new"]);
  });

  test("a promotion never stamps a row of another group", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom"), { type: "job_failed", job: "Send", error: "x", at: NOW }]);
    const [a, b] = w.db._tables.event_groups;
    const jobEvent = w.db._tables.external_events.find((e: any) => e.group_id === b._id);
    await h(linkSignal)(w.internalCtx, { group_id: a._id, task_id: "t1", external_event_id: jobEvent._id });
    expect(jobEvent.task_id).toBeUndefined();
    expect(w.db._tables.event_groups[0].signal_task_id).toBe("t1");
  });

  test("a filer who left the team cannot file", async () => {
    const w = world();
    const { source: created } = await teamSource(w);
    await batch(w, created._id, [err("Boom")]);
    const groupId = w.db._tables.event_groups[0]._id;
    expect((await h(promotionInputs)(w.internalCtx, { group_id: groupId }))!.filer_may_file).toBe(true);
    w.db._tables.team_memberships.length = 0;
    expect((await h(promotionInputs)(w.internalCtx, { group_id: groupId }))!.filer_may_file).toBe(false);
  });
});

describe("what one source can cost (review fixes)", () => {
  test("a deploy reported again (a retried batch, an SDK reporting at boot) fires its triggers once", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    const deploy = { type: "deploy", version: "1.2.0", sha: "abc", at: NOW };
    expect((await batch(w, source._id, [deploy])).transitions).toBe(1);
    expect((await batch(w, source._id, [deploy])).transitions).toBe(0);
    expect(names(w).filter((n) => n === "agentTasks:matchTaskTriggers")).toHaveLength(1);
  });

  test("new fingerprints past the hourly cap fold into one overflow group per kind", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => err(`Distinct ${from + i}`, { fingerprint: `fp-${from + i}` }));
    await batch(w, source._id, many(0, SOURCE_CAPS.new_groups_per_hour - 2));
    const res = await batch(w, source._id, many(1000, 10));
    expect(res.folded).toBe(8);
    const groups = w.db._tables.event_groups;
    expect(groups).toHaveLength(SOURCE_CAPS.new_groups_per_hour + 1);
    const overflow = groups.find((g: any) => g.fingerprint.endsWith(OVERFLOW_FP))!;
    expect(live(w, groups.indexOf(overflow)).count).toBe(8);
    // Later batches past the cap keep landing there, not in new rows.
    await batch(w, source._id, many(2000, 5));
    expect(w.db._tables.event_groups).toHaveLength(SOURCE_CAPS.new_groups_per_hour + 1);
  });

  test("promotions past the hourly cap stay on the timeline without filing a signal", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    for (let i = 0; i < SOURCE_CAPS.promotions_per_hour + 3; i++) await batch(w, source._id, [err(`E${i}`, { fingerprint: `p${i}` })]);
    expect(names(w).filter((n) => n === "ingest:promote")).toHaveLength(SOURCE_CAPS.promotions_per_hour);
    expect(names(w).filter((n) => n === "agentTasks:matchTaskTriggers")).toHaveLength(SOURCE_CAPS.promotions_per_hour + 3);
  });

  test("a deploy's sha joins the release's errors to the commit and the session that wrote it", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const sha = "a".repeat(40);
    w.db._tables.conversations.push({ _id: "c1", user_id: "u1", short_id: "jx1abcd" });
    (w.db._tables.commits ??= []).push({ _id: "k1", sha, message: "Fix the thing\n\nbody", author_name: "Ann", timestamp: NOW, conversation_id: "c1" });
    await batch(w, source._id, [{ type: "deploy", version: "2.0.0", sha, at: NOW }], { environment: "prod" });
    await batch(w, source._id, [err("Boom")], { release: "2.0.0", environment: "prod" });
    expect(w.db._tables.event_groups[0].last_sha).toBe(sha);
    const { commit } = await h(getGroup)(w.as("u1"), { group: "eg-1" });
    expect(commit).toMatchObject({ sha, message: "Fix the thing", session: "jx1abcd" });
    // A release with no deploy sha on record names another build: the join clears.
    await batch(w, source._id, [err("Boom", { at: NOW + 1 })], { release: "2.0.1", environment: "prod" });
    expect(live(w).last_sha).toBeUndefined();
  });

  test("a held tally flushes onto the row, and a write after the minute goes to the row directly", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    await batch(w, source._id, [err("Boom", { at: NOW + 1 })]);
    await h(flushGroupTally)(w.internalCtx, { group_id: w.db._tables.event_groups[0]._id });
    expect(w.db._tables.event_groups[0].count).toBe(2);
    expect(w.db._tables.event_group_tallies).toHaveLength(0);
    w.db._tables.event_groups[0].updated_at = NOW - 120_000;
    await batch(w, source._id, [err("Boom", { at: NOW + 2 })]);
    expect(w.db._tables.event_groups[0].count).toBe(3);
  });

  test("a group written before sample_count is counted once, then trimmed by the count", async () => {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < 4; i++) await batch(w, source._id, Array.from({ length: 5 }, (_, j) => err("Boom", { at: NOW - 1000 + i * 10 + j })));
    w.db._tables.event_groups[0].updated_at = 0;
    delete w.db._tables.event_groups[0].sample_count;
    (w.db._tables.event_group_tallies ?? []).length = 0;
    await batch(w, source._id, [err("Boom", { at: NOW })]);
    expect(w.db._tables.event_samples).toHaveLength(20);
    expect(w.db._tables.event_groups[0].sample_count).toBe(20);
  });

  test("removing a source purges its rows a bounded page at a time, watches and replays included", async () => {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < 45; i++) await batch(w, source._id, Array.from({ length: 5 }, (_, j) => err(`E${i}`, { fingerprint: `g${i}`, at: NOW - j })));
    (w.db._tables.metric_watches ??= []).push({ _id: "mw1", source_id: source._id, workspace: "team:team_1" });
    (w.db._tables.replays ??= []).push({ _id: "rp1", source_id: source._id, workspace: "team:team_1", started_at: NOW });
    (w.db._tables.replay_timelines ??= []).push({ _id: "rt1", replay_id: "rp1", timeline_md: "x", updated_at: NOW });
    await h(removeSource)(w.as("u1"), { ...TEAM, source: "union" });
    let runs = 0;
    while (w.scheduled.some((x) => x.name === "ingest:purgeSourceRows") && runs < 20) {
      w.scheduled.length = 0;
      await h(purgeSourceRows)(w.internalCtx, { source_id: source._id });
      runs++;
    }
    expect(runs).toBeGreaterThan(1);
    for (const table of ["event_groups", "event_samples", "metric_watches", "replays", "replay_timelines", "event_source_stats"]) {
      expect((w.db._tables[table] ?? []).length).toBe(0);
    }
  });

  test("a workspace holds one app connector, since it reads through the workspace's one app connection", async () => {
    const w = world();
    await h(createSource)(w.as("u1"), { ...TEAM, name: "union", provider: "app" });
    await expect(h(createSource)(w.as("u1"), { ...TEAM, name: "billing", provider: "app" })).rejects.toThrow(/already has an app connector/);
  });

  test("the daily prune reads only groups whose buckets can still change", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Recent", { at: NOW - 80 * HOUR_MS }), err("Old", { fingerprint: "old", at: NOW - 30 * 24 * HOUR_MS })]);
    const before = w.db._tables.event_groups.map((g: any) => ({ ...g }));
    await h(dailyUpkeep)(w.internalCtx, {});
    const old = w.db._tables.event_groups.find((g: any) => g.title === "Old");
    expect(old).toEqual(before.find((g: any) => g.title === "Old"));
  });
});

describe("the door's admission", () => {
  const req = (origin?: string) => new Request("https://x/cli/ingest/k", { method: "POST", headers: origin ? { origin } : {} });
  const ctxWith = (source: any, limited: boolean) => ({
    runQuery: async () => source,
    runMutation: async () => (limited ? { ok: false, retry_after_ms: 30_000 } : { ok: true }),
  });
  const rate = { prefix: "ingest", max: 1, window_ms: 60_000 };
  const key = "cc_ing_" + "a".repeat(32);

  test("unknown key 401, refused origin 403, paused 503, limited 429 a browser can read", async () => {
    const source = { _id: "s1", status: "active", allowed_origins: ["https://app.union.dev"] };
    expect(((await admitIngestKey(ctxWith(null, false), req(), key, rate)) as Response).status).toBe(401);
    expect(((await admitIngestKey(ctxWith(source, false), req("https://evil.example"), key, rate)) as Response).status).toBe(403);
    expect(((await admitIngestKey(ctxWith({ ...source, status: "paused" }, false), req("https://app.union.dev"), key, rate)) as Response).status).toBe(503);
    const limited = (await admitIngestKey(ctxWith(source, true), req("https://app.union.dev"), key, rate)) as Response;
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Access-Control-Allow-Origin")).toBe("https://app.union.dev");
    expect(limited.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    expect(limited.headers.get("Retry-After")).toBe("30");
    const ok = await admitIngestKey(ctxWith(source, false), req("https://app.union.dev"), key, rate);
    expect(ok).toMatchObject({ source: { _id: "s1" }, cors: { "Access-Control-Allow-Origin": "https://app.union.dev" } });
  });
});

describe("guessing keys at the door", () => {
  test("an address runs out of unknown keys, and then even a right one earns nothing until the window passes", async () => {
    const w = world();
    (w.db._tables.ip_rate_limits ??= []);
    const { ingest_key } = await teamSource(w);
    const ctx = {
      runQuery: async (_fn: any, args: any) => h(sourceForKey)(w.internalCtx, args),
      runMutation: async (_fn: any, args: any) => bumpWindow(w.db, args.key, args.max, args.window_ms),
    };
    const from = (ip: string) => new Request("https://x/cli/ingest/k", { method: "POST", headers: { "x-forwarded-for": ip } });
    const rate = { prefix: "ingest", max: 100, window_ms: 60_000 };
    const wrong = (i: number) => "cc_ing_" + String(i).padStart(32, "x");
    for (let i = 0; i < UNKNOWN_KEY_RATE.max; i++) {
      expect(((await admitIngestKey(ctx, from("1.2.3.4"), wrong(i), rate)) as Response).status).toBe(401);
    }
    const spent = (await admitIngestKey(ctx, from("1.2.3.4"), wrong(999), rate)) as Response;
    expect(spent.status).toBe(429);
    expect(Number(spent.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The right key from the spent address is refused before it is looked up.
    expect(((await admitIngestKey(ctx, from("1.2.3.4"), ingest_key, rate)) as Response).status).toBe(429);
    // Another address, and a known key, are untouched.
    expect(await admitIngestKey(ctx, from("5.6.7.8"), ingest_key, rate)).toMatchObject({ source: { status: "active" } });
    expect(((await admitIngestKey(ctx, from("5.6.7.8"), wrong(1), rate)) as Response).status).toBe(401);
    // A known key spends nothing from the window.
    const row = w.db._tables.ip_rate_limits.find((r: any) => r.key === `${UNKNOWN_KEY_RATE.name}:5.6.7.8`);
    expect(row.count).toBe(1);
  });
});

describe("trigger payload", () => {
  test("an event trigger spends its pending events when it re-arms", () => {
    expect(nextArmingAfterRun({ schedule_type: "event" } as any, NOW)).toHaveProperty("pending_events", undefined);
    expect("pending_events" in nextArmingAfterRun({ schedule_type: "event" } as any, NOW)).toBe(true);
  });
});

describe("trigger source filters", () => {
  // A trigger with no project_path fires in its owner's personal workspace
  // (agentTasks triggerWorkspaceKey), so the source lives there.
  const personalSource = (w: ReturnType<typeof world>) => h(createSource)(w.as("u1"), { workspace: "personal", name: " Union ", provider: "sdk" });
  const armed = (w: ReturnType<typeof world>, source: string) =>
    insertTask(w.internalCtx, "u1" as any, { title: "t", prompt: "p", schedule_type: "event", event_filter: { event_type: "error_new", source } });

  test("a name or src-N is stored as the source's canonical name", async () => {
    const w = world();
    await personalSource(w);
    await armed(w, "src-1");
    await armed(w, " UNION ");
    expect(w.db._tables.agent_tasks.map((t: any) => t.event_filter.source)).toEqual(["union", "union"]);
  });

  test("an unknown source is refused at save, naming the known ones, on create and on edit", async () => {
    const w = world();
    await personalSource(w);
    await expect(armed(w, "unoin")).rejects.toThrow(/No source "unoin".*union \(src-1\)/);
    expect(w.db._tables.agent_tasks).toHaveLength(0);
    await armed(w, "union");
    const task = w.db._tables.agent_tasks[0];
    await expect(
      applyTaskUpdate(w.internalCtx, task, { schedule_type: "event", event_filter: { event_type: "error_new", source: "src-9" } }, { userId: "u1" as any, source: "cli" }),
    ).rejects.toThrow(/No source "src-9"/);
  });

  test("a blank source is dropped and no source is not checked", async () => {
    const w = world();
    await armed(w, "  ");
    expect(w.db._tables.agent_tasks[0].event_filter).toEqual({ event_type: "error_new" });
  });
});

describe("the door", () => {
  test("the key comes from the path on either prefix, else the bearer header", () => {
    expect(ingestKeyFrom("/cli/ingest/cc_ing_abc", null)).toBe("cc_ing_abc");
    expect(ingestKeyFrom("/api/ingest/cc_ing_abc/extra", null)).toBe("cc_ing_abc");
    expect(ingestKeyFrom("/cli/ingest/", "Bearer cc_ing_xyz")).toBe("cc_ing_xyz");
    expect(ingestKeyFrom("/cli/ingest/", null)).toBeNull();
  });

  test("origins: no list allows any, a list allows only its members", () => {
    expect(originAllowed(null, "https://evil.example")).toBe(true);
    expect(originAllowed(["https://app.union.dev/"], "https://app.union.dev")).toBe(true);
    expect(originAllowed(["https://app.union.dev"], "https://evil.example")).toBe(false);
    expect(originAllowed(["https://app.union.dev"], null)).toBe(true);
  });

  test("bodies: plain, gzip, a gzip bomb, junk", () => {
    const body = JSON.stringify({ items: [] });
    expect(decodeIngestBody(strToU8(body), null)).toEqual({ text: body });
    expect(decodeIngestBody(gzipSync(strToU8(body)), "gzip")).toEqual({ text: body });
    const bomb = gzipSync(new Uint8Array(INGEST_LIMITS.max_bytes + 10));
    expect(bomb.byteLength).toBeLessThan(INGEST_LIMITS.max_bytes);
    expect(decodeIngestBody(bomb, "gzip")).toMatchObject({ status: 413 });
    expect(decodeIngestBody(new Uint8Array(INGEST_LIMITS.max_bytes + 1), null)).toMatchObject({ status: 413 });
    expect(decodeIngestBody(strToU8("not gzip"), "gzip")).toMatchObject({ status: 400 });
    expect(decodeIngestBody(strToU8(body), "br")).toMatchObject({ status: 400 });
  });

  test("a paused source asks the SDK to back off, not to stop, so resuming brings it back", async () => {
    const w = world();
    const { ingest_key } = await teamSource(w);
    w.db._tables.event_sources[0].config = { ...w.db._tables.event_sources[0].config, allowed_origins: ["https://app.union.dev"] };
    const serve = (origin: string) =>
      h(ingestServe)(
        { runQuery: async (_fn: any, args: any) => h(sourceForKey)(w.internalCtx, args) },
        new Request(`https://convex.codecast.sh/cli/ingest/${ingest_key}`, { method: "POST", headers: { origin }, body: "{}" }),
      ) as Promise<Response>;
    w.db._tables.event_sources[0].status = "paused";
    const paused = await serve("https://app.union.dev");
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("60");
    expect(paused.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    expect(classifyStatus(paused.status)).toBe("retry");
    expect(backoffMs(0, paused.headers.get("Retry-After"))).toBe(60_000);
    // A refused origin never gets better by retrying, so it still stops the SDK.
    const refused = await serve("https://evil.example");
    expect(refused.status).toBe(403);
    expect(classifyStatus(refused.status)).toBe("stop");
  });

  test("the SDK's default endpoint lands on one of the door's prefixes", () => {
    expect(INGEST_PREFIXES).toContain(new URL(DEFAULT_CODECAST_INGEST_ENDPOINT).pathname + "/");
  });

  test("errors map like the CLI routes", () => {
    expect(ingestErrorStatus({ data: { code: "FORBIDDEN" } })).toBe(403);
    expect(ingestErrorStatus({ data: { code: "RATE_LIMITED" } })).toBe(429);
    expect(ingestErrorStatus(new Error("boom"))).toBe(500);
  });
});
