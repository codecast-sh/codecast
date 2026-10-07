import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { GROUP_RULES, METRIC_WATCH_LIMITS } from "@codecast/shared/contracts/ingest";
import { createSource, sourceConnectionLost } from "./ingest";
import { createWatch, getWatch, historyInputs, listWatches, loadHistory, pollDue, pollInputs, pollWatch, readHistory, recordHistory, recordPoint, removeWatch, updateWatch } from "./metrics";
import { bindHogqlNow, fetchMetricHistory, insightSeries, sourceForPoll } from "./sources/posthog";
import { historyInstants, mergeMetricHistory } from "./lib/ingestGroups";
import { encryptConnectionSecret, tokenConnectionRow } from "./tokenConnectors";

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
      metric_watches: [],
      app_installations: [],
      replays: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internalCtx: { db, scheduler } as any };
}

const TEAM = { workspace: "team" as const, team_id: "team_1" as any };

async function posthogSource(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  return (await h(createSource)(w.as("u1"), { ...TEAM, name: "product", provider: "posthog", ...extra })).source;
}

async function watch(w: ReturnType<typeof world>, over: Record<string, unknown> = {}) {
  await posthogSource(w);
  const out = await h(createWatch)(w.as("u1"), {
    ...TEAM,
    source: "product",
    name: "Signup rate",
    query_kind: "hogql",
    query: "select count() from events where event = 'signed_up'",
    threshold: 10,
    direction: "below",
    ...over,
  });
  return out.watch;
}

const point = (w: ReturnType<typeof world>, watchId: string, value: number, at = Date.now()) =>
  h(recordPoint)(w.internalCtx, { watch_id: watchId, at, value });

describe("watch CRUD", () => {
  test("create stamps the source's workspace, mints mw-N, clamps the interval and is due at once", async () => {
    const w = world();
    const before = Date.now();
    const row = await watch(w, { interval_ms: 1000 });
    expect(row).toMatchObject({ short_id: "mw-1", workspace: "team:team_1", team_id: "team_1", status: "active", state: "ok", points: [], last_value: null, source_name: "product" });
    expect(row.interval_ms).toBe(METRIC_WATCH_LIMITS.interval_min_ms);
    expect(row.next_check_at).toBeGreaterThanOrEqual(before);
  });

  test("a source that cannot answer the kind, a bad insight ref and a non-number line are refused", async () => {
    const w = world();
    await h(createSource)(w.as("u1"), { ...TEAM, name: "door", provider: "sdk" });
    await posthogSource(w);
    const base = { ...TEAM, name: "x", query: "1", threshold: 1, direction: "above" as const };
    await expect(h(createWatch)(w.as("u1"), { ...base, source: "door", query_kind: "hogql" })).rejects.toThrow(/sdk source cannot watch/);
    await expect(h(createWatch)(w.as("u1"), { ...base, source: "product", query_kind: "reader" })).rejects.toThrow(/cannot watch a reader/);
    await expect(h(createWatch)(w.as("u1"), { ...base, source: "product", query_kind: "insight", query: "../../admin" })).rejects.toThrow(/not a PostHog insight/);
    await expect(h(createWatch)(w.as("u1"), { ...base, source: "product", query_kind: "hogql", threshold: Number.NaN })).rejects.toThrow(/threshold/);
  });

  test("a watch is read and changed only by holders of its workspace", async () => {
    const w = world();
    const row = await watch(w);
    expect(await h(listWatches)(w.as("u1"), TEAM)).toHaveLength(1);
    expect(await h(listWatches)(w.as("u2"), { workspace: "personal" })).toEqual([]);
    await expect(h(getWatch)(w.as("u2"), { watch: row.short_id })).rejects.toThrow(/not found/);
    await expect(h(updateWatch)(w.as("u2"), { watch: row.short_id, threshold: 1 })).rejects.toThrow(/not found/);
    await expect(h(removeWatch)(w.as("u2"), { watch: row.short_id })).rejects.toThrow(/not found/);
  });

  test("pause leaves the poll index, resume is due at once and clears the error", async () => {
    const w = world();
    const row = await watch(w);
    await w.db.patch(row._id, { last_error: "boom" });
    const paused = (await h(updateWatch)(w.as("u1"), { watch: row.short_id, status: "paused" })).watch;
    expect(paused.next_check_at).toBeUndefined();
    const resumed = (await h(updateWatch)(w.as("u1"), { watch: row.short_id, status: "active" })).watch;
    expect(resumed.next_check_at).toBeDefined();
    expect(resumed.last_error).toBeUndefined();
  });

  test("remove deletes the watch and keeps its group", async () => {
    const w = world();
    const row = await watch(w);
    await point(w, row._id, 3);
    expect(await h(removeWatch)(w.as("u1"), { watch: row.short_id })).toEqual({ removed: "mw-1" });
    expect(w.db._tables.metric_watches).toHaveLength(0);
    expect(w.db._tables.event_groups).toHaveLength(1);
  });
});

describe("poll claiming", () => {
  test("claims due active watches once, a full interval ahead, one action each", async () => {
    const w = world();
    const a = await watch(w);
    const b = (await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: "b", query_kind: "insight", query: "42", threshold: 1, direction: "above" })).watch;
    await h(updateWatch)(w.as("u1"), { watch: b.short_id, status: "paused" });
    expect(await h(pollDue)(w.internalCtx, {})).toBe(1);
    expect(w.scheduled.filter((s) => s.name === "metrics:pollWatch").map((s) => s.args.watch_id)).toEqual([a._id]);
    expect(w.db._tables.metric_watches.find((r: any) => r._id === a._id).next_check_at).toBeGreaterThan(Date.now() + a.interval_ms - 5_000);
    // Not due again until the interval is up.
    expect(await h(pollDue)(w.internalCtx, {})).toBe(0);
  });

  test("a full page of due watches claims the next page at once", async () => {
    const w = world();
    await watch(w);
    for (let i = 0; i < 50; i++) await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: `w${i}`, query_kind: "insight", query: "42", threshold: 1, direction: "above" });
    expect(await h(pollDue)(w.internalCtx, {})).toBe(50);
    expect(w.scheduled.filter((s) => s.name === "metrics:pollDue")).toHaveLength(1);
    expect(await h(pollDue)(w.internalCtx, {})).toBe(1);
    expect(w.scheduled.filter((s) => s.name === "metrics:pollDue")).toHaveLength(1);
  });
});

describe("crossing the line", () => {
  test("a below watch alerts once when it drops under, counts while under, recovers once", async () => {
    const w = world();
    const row = await watch(w);
    // Triggers armed on both transitions, so each schedules its match (lib/triggerMatch).
    for (const event_type of ["metric_alert", "metric_recovered"]) await w.db.insert("agent_tasks", { status: "scheduled", event_filter: { event_type } });
    const kinds = () => w.db._tables.external_events.map((e: any) => e.kind);
    const source = () => w.db._tables.event_source_stats[0];

    await point(w, row._id, 25);
    let group = w.db._tables.event_groups[0];
    expect(group).toMatchObject({ kind: "metric", status: "resolved", count: 0, fingerprint: "metric:mw-1", title: "Signup rate below 10" });
    expect(group.meta).toMatchObject({ ok: true, value: 25, threshold: 10, direction: "below", metric_watch_id: row._id });
    expect(kinds()).toEqual([]);

    await point(w, row._id, 4);
    group = w.db._tables.event_groups[0];
    expect(group).toMatchObject({ status: "open", count: 1, last_transition: "metric_alert" });
    expect(group.meta.value).toBe(4);
    expect(kinds()).toEqual(["metric_alert"]);
    expect(w.db._tables.external_events[0].data).toMatchObject({ transition: "metric_alert", group_kind: "metric", value: 4, threshold: 10, source_name: "product" });
    expect(w.scheduled.filter((s) => s.name === "agentTasks:matchTaskTriggers").map((s) => s.args.event_type)).toEqual(["metric_alert"]);
    expect(source().groups_open).toBe(1);
    expect(w.db._tables.metric_watches[0]).toMatchObject({ state: "alert", group_id: group._id });

    await point(w, row._id, 2);
    expect(kinds()).toEqual(["metric_alert"]);
    // A quiet occurrence inside a minute is held on the group's tally (ingest.ts upsertGroup).
    const tally = (w.db._tables.event_group_tallies ?? [])[0];
    expect({ ...w.db._tables.event_groups[0], ...(tally ? JSON.parse(tally.fields_json) : {}) }.count).toBe(2);

    await point(w, row._id, 11);
    expect(kinds()).toEqual(["metric_alert", "metric_recovered"]);
    expect(w.db._tables.event_groups[0].status).toBe("resolved");
    expect(w.db._tables.metric_watches[0].state).toBe("ok");
    expect(source().groups_open).toBe(0);
    // Recovery is on the timeline and wakes what is armed on metric_recovered.
    expect(w.scheduled.filter((s) => s.name === "agentTasks:matchTaskTriggers").map((s) => s.args.event_type)).toEqual(["metric_alert", "metric_recovered"]);
    // Only failing reads are kept as samples.
    expect(w.db._tables.event_samples.map((s: any) => s.message)).toEqual(["Signup rate = 4 (alerts below 10)", "Signup rate = 2 (alerts below 10)"]);
  });

  test("an alert promotes as ux when the source promotes metric_alert", async () => {
    const w = world();
    await h(createSource)(w.as("u1"), { ...TEAM, name: "product", provider: "posthog", fingerprint_prefix: "union", promote: ["metric_alert"] });
    const row = (await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: "Errors", query_kind: "hogql", query: "select 1", threshold: 5, direction: "above" })).watch;
    await point(w, row._id, 9);
    const promote = w.scheduled.find((s) => s.name === "ingest:promote");
    expect(promote?.args).toMatchObject({ transition: "metric_alert", fingerprint: "union:metric:mw-1" });
  });

  test("the watch keeps the newest metric_points values, oldest first", async () => {
    const w = world();
    const row = await watch(w);
    const t0 = Date.now() - 100_000;
    for (let i = 0; i < GROUP_RULES.metric_points + 5; i++) await point(w, row._id, 20 + i, t0 + i);
    const points = w.db._tables.metric_watches[0].points;
    expect(points).toHaveLength(GROUP_RULES.metric_points);
    expect(points[0].value).toBe(25);
    expect(points.at(-1).value).toBe(20 + GROUP_RULES.metric_points + 4);
  });

  test("a failed read records the reason and moves nothing else", async () => {
    const w = world();
    const row = await watch(w);
    await point(w, row._id, 4);
    await h(recordPoint)(w.internalCtx, { watch_id: row._id, at: Date.now(), error: "PostHog answered 500" });
    const after = w.db._tables.metric_watches[0];
    expect(after).toMatchObject({ state: "alert", last_error: "PostHog answered 500" });
    expect(after.points).toHaveLength(1);
    expect(w.db._tables.external_events).toHaveLength(1);
  });

  test("a paused watch or source records nothing", async () => {
    const w = world();
    const row = await watch(w);
    await h(updateWatch)(w.as("u1"), { watch: row.short_id, status: "paused" });
    expect(await point(w, row._id, 1)).toBeNull();
    expect(w.db._tables.event_groups).toHaveLength(0);
  });
});

describe("pollWatch end to end", () => {
  const realFetch = globalThis.fetch;
  const KEY = "test-connection-secrets-key-at-least-32-bytes!!";
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CONNECTION_SECRETS_KEY;
  });

  test("reads the HogQL value through the team's PostHog connection and records the crossing", async () => {
    const w = world();
    process.env.CONNECTION_SECRETS_KEY = KEY;
    await w.db.insert("app_installations", {
      provider: "posthog",
      team_id: "team_1",
      connected_by: "u1",
      access_token_enc: await encryptConnectionSecret("phx_SECRET", KEY),
      config: { host: "https://us.posthog.com", project_id: "77" },
      granted_scopes: [],
      created_at: 1,
      updated_at: 1,
    });
    const row = await watch(w);
    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ columns: ["count()"], results: [[3]] }));
    }) as any;
    const handlers: Record<string, any> = {
      "metrics:pollInputs": pollInputs,
      "sources/posthog:sourceForPoll": sourceForPoll,
      "tokenConnectors:tokenConnectionRow": tokenConnectionRow,
      "metrics:recordPoint": recordPoint,
    };
    const route = async (fn: any, args: any) => h(handlers[getFunctionName(fn)])(w.internalCtx, args);
    const out = await h(pollWatch)({ runQuery: route, runMutation: route }, { watch_id: row._id });
    expect(out).toEqual({ value: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://us.posthog.com/api/projects/77/query/");
    expect(calls[0].init.headers.Authorization).toBe("Bearer phx_SECRET");
    expect(JSON.parse(calls[0].init.body)).toEqual({ query: { kind: "HogQLQuery", query: row.query } });
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["metric_alert"]);
  });

  test("without a connection the watch says how to connect, and nothing is fetched", async () => {
    const w = world();
    const row = await watch(w);
    globalThis.fetch = (async () => {
      throw new Error("must not fetch");
    }) as any;
    const handlers: Record<string, any> = { "metrics:pollInputs": pollInputs, "sources/posthog:sourceForPoll": sourceForPoll, "metrics:recordPoint": recordPoint, "ingest:sourceConnectionLost": sourceConnectionLost };
    const route = async (fn: any, args: any) => h(handlers[getFunctionName(fn)])(w.internalCtx, args);
    const out = await h(pollWatch)({ runQuery: route, runMutation: route }, { watch_id: row._id });
    expect(out.error).toMatch(/cast integrations connect posthog/);
    expect(w.db._tables.metric_watches[0].last_error).toMatch(/No PostHog connection/);
    // The source stops on it, so the next claim runs no poll at all.
    expect(w.db._tables.event_sources[0]).toMatchObject({ status: "error", last_error: expect.stringMatching(/No PostHog connection/) });
    w.db._tables.metric_watches[0].next_check_at = Date.now() - 1;
    w.scheduled.length = 0;
    expect(await h(pollDue)(w.internalCtx, {})).toBe(1);
    expect(w.scheduled.filter((s) => s.name === "metrics:pollWatch")).toHaveLength(0);
  });

  test("a token PostHog refuses stops the source, naming the refusal", async () => {
    const w = world();
    process.env.CONNECTION_SECRETS_KEY = KEY;
    await w.db.insert("app_installations", {
      provider: "posthog",
      team_id: "team_1",
      connected_by: "u1",
      access_token_enc: await encryptConnectionSecret("phx_REVOKED", KEY),
      config: { host: "https://us.posthog.com", project_id: "77" },
      granted_scopes: [],
      created_at: 1,
      updated_at: 1,
    });
    const row = await watch(w);
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "Invalid personal API key." }), { status: 401 })) as any;
    const handlers: Record<string, any> = {
      "metrics:pollInputs": pollInputs,
      "sources/posthog:sourceForPoll": sourceForPoll,
      "tokenConnectors:tokenConnectionRow": tokenConnectionRow,
      "metrics:recordPoint": recordPoint,
      "ingest:sourceConnectionLost": sourceConnectionLost,
    };
    const route = async (fn: any, args: any) => h(handlers[getFunctionName(fn)])(w.internalCtx, args);
    await h(pollWatch)({ runQuery: route, runMutation: route }, { watch_id: row._id });
    expect(w.db._tables.event_sources[0]).toMatchObject({ status: "error", last_error: expect.stringMatching(/PostHog refused the token \(401\)/) });
    // A poll that slips through after the stop does nothing.
    expect(await h(pollWatch)({ runQuery: route, runMutation: route }, { watch_id: row._id })).toBeNull();
  });

  test("a read that fails for another reason leaves the source polling", async () => {
    const w = world();
    process.env.CONNECTION_SECRETS_KEY = KEY;
    await w.db.insert("app_installations", {
      provider: "posthog",
      team_id: "team_1",
      connected_by: "u1",
      access_token_enc: await encryptConnectionSecret("phx_OK", KEY),
      config: { host: "https://us.posthog.com", project_id: "77" },
      granted_scopes: [],
      created_at: 1,
      updated_at: 1,
    });
    const row = await watch(w);
    globalThis.fetch = (async () => new Response("busy", { status: 503 })) as any;
    const handlers: Record<string, any> = {
      "metrics:pollInputs": pollInputs,
      "sources/posthog:sourceForPoll": sourceForPoll,
      "tokenConnectors:tokenConnectionRow": tokenConnectionRow,
      "metrics:recordPoint": recordPoint,
      "ingest:sourceConnectionLost": sourceConnectionLost,
    };
    const route = async (fn: any, args: any) => h(handlers[getFunctionName(fn)])(w.internalCtx, args);
    await h(pollWatch)({ runQuery: route, runMutation: route }, { watch_id: row._id });
    expect(w.db._tables.event_sources[0].status).toBe("active");
    expect(w.db._tables.metric_watches[0].last_error).toMatch(/503/);
  });
});

describe("history", () => {
  const realFetch = globalThis.fetch;
  const KEY = "test-connection-secrets-key-at-least-32-bytes!!";
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CONNECTION_SECRETS_KEY;
  });
  // The shape PostHog answers for a trends insight (read live 2026-10-06), cut to what is read.
  const trends = (data: number[], days: string[], extra: Record<string, unknown> = {}) => ({ id: 42, result: [{ data, days, labels: days, count: data.reduce((a, b) => a + b, 0), ...extra }] });

  test("an insight's first series becomes dated points; a total or a table has none", () => {
    expect(insightSeries(trends([1, 2, 3], ["2026-09-07", "2026-09-08", "2026-09-09"]))).toEqual([
      { at: Date.UTC(2026, 8, 7), value: 1 },
      { at: Date.UTC(2026, 8, 8), value: 2 },
      { at: Date.UTC(2026, 8, 9), value: 3 },
    ]);
    expect(insightSeries(trends([5], ["2026-09-07 13:00:00"]))).toEqual([{ at: Date.UTC(2026, 8, 7, 13), value: 5 }]);
    expect(insightSeries(trends([1, 2], ["2026-09-07", "2026-09-08"], { aggregated_value: 3 }))).toBeNull();
    expect(insightSeries({ result: [[4]] })).toBeNull();
    expect(insightSeries(trends([1, 2], ["2026-09-07"]))).toBeNull();
  });

  test("history goes under the polled points, never over them, cut to metric_points", () => {
    const polled = [{ at: 1000, value: 9 }];
    const history = [{ at: 10, value: 1 }, { at: 999, value: 2 }, { at: 1000, value: 7 }, { at: 2000, value: 8 }];
    expect(mergeMetricHistory(polled, history)).toEqual({ points: [{ at: 10, value: 1 }, { at: 999, value: 2 }, { at: 1000, value: 9 }], added: 2 });
    const long = Array.from({ length: 100 }, (_, i) => ({ at: i, value: i }));
    const merged = mergeMetricHistory([], long);
    expect(merged.points).toHaveLength(GROUP_RULES.metric_points);
    expect(merged.points[merged.points.length - 1].at).toBe(99);
    expect(merged.added).toBe(GROUP_RULES.metric_points);
    const full = Array.from({ length: GROUP_RULES.metric_points }, (_, i) => ({ at: 1000 + i, value: i }));
    expect(mergeMetricHistory(full, long).added).toBe(0);
  });

  test("a new watch reads its history at once and says it is reading", async () => {
    const w = world();
    const row = await watch(w, { query_kind: "insight", query: "42" });
    expect(row.history).toMatchObject({ added: 0, reading: true });
    expect(w.scheduled.filter((x) => x.name === "metrics:readHistory").map((x) => x.args.watch_id)).toEqual([row._id]);
  });

  test("load reads every watch in reach, HogQL ones too, one source's in turn; a paused source says why it has none", async () => {
    const w = world();
    const hog = await watch(w);
    const ins = (await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: "installs", query_kind: "insight", query: "42", threshold: 1, direction: "above" })).watch;
    await h(createSource)(w.as("u1"), { ...TEAM, name: "old", provider: "posthog" });
    const off = (await h(createWatch)(w.as("u1"), { ...TEAM, source: "old", name: "x", query_kind: "insight", query: "7", threshold: 1, direction: "above" })).watch;
    w.db._tables.event_sources.find((s: any) => s.name === "old").status = "paused";
    w.scheduled.length = 0;
    const out = await h(loadHistory)(w.as("u1"), { ...TEAM, days: 14 });
    expect(out.scheduled).toEqual([hog.short_id, ins.short_id]);
    expect(out.skipped).toEqual([{ watch: off.short_id, reason: "old is paused" }]);
    // Two watches on one source never ask PostHog at once: the first read starts the second.
    expect(w.scheduled.map((x) => x.args)).toEqual([{ watch_id: hog._id, days: 14, then: [ins._id] }]);
    expect(w.db._tables.metric_watches.find((r: any) => r._id === hog._id).history).toMatchObject({ reading: true });
    await expect(h(loadHistory)(w.as("u1"), { ...TEAM, days: 0 })).rejects.toThrow(/days/);
    // Another workspace's caller reaches nothing.
    await expect(h(loadHistory)(w.as("u2"), { watch: ins.short_id })).rejects.toThrow(/not found/);
  });

  test("reads the insight's series through the connection and puts it under the watch, with no transition", async () => {
    const w = world();
    process.env.CONNECTION_SECRETS_KEY = KEY;
    await w.db.insert("app_installations", {
      provider: "posthog",
      team_id: "team_1",
      connected_by: "u1",
      access_token_enc: await encryptConnectionSecret("phx_SECRET", KEY),
      config: { host: "https://us.posthog.com", project_id: "77" },
      granted_scopes: [],
      created_at: 1,
      updated_at: 1,
    });
    const row = await watch(w, { query_kind: "insight", query: "42", threshold: 2, direction: "above" });
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(trends([0, 5, 1], ["2026-09-07", "2026-09-08", "2026-09-09"])));
    }) as any;
    const handlers: Record<string, any> = {
      "metrics:historyInputs": historyInputs,
      "sources/posthog:sourceForPoll": sourceForPoll,
      "tokenConnectors:tokenConnectionRow": tokenConnectionRow,
      "metrics:recordHistory": recordHistory,
      "ingest:sourceConnectionLost": sourceConnectionLost,
    };
    const route = async (fn: any, args: any) => h(handlers[getFunctionName(fn)])(w.internalCtx, args);
    expect(await h(readHistory)({ runQuery: route, runMutation: route }, { watch_id: row._id })).toEqual({ added: 3 });
    expect(urls).toEqual(["https://us.posthog.com/api/projects/77/insights/42/?refresh=blocking"]);
    const stored = w.db._tables.metric_watches[0];
    expect(stored.points.map((p: any) => p.value)).toEqual([0, 5, 1]);
    expect(stored.history).toMatchObject({ added: 3 });
    expect(stored.history.reading).toBeUndefined();
    // A past crossing (5 > 2) is history, not news.
    expect(w.db._tables.external_events).toHaveLength(0);

    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "Invalid personal API key." }), { status: 401 })) as any;
    await h(readHistory)({ runQuery: route, runMutation: route }, { watch_id: row._id });
    expect(w.db._tables.metric_watches[0].history.note).toMatch(/401/);
    expect(w.db._tables.metric_watches[0].points).toHaveLength(3);
    expect(w.db._tables.event_sources[0]).toMatchObject({ status: "error" });
  });
});

describe("binding now() to a past instant", () => {
  const AT = Date.UTC(2026, 9, 6, 12);
  const T = "toDateTime('2026-10-06T12:00:00Z')";

  test("a lower bound gains the instant as its upper bound; an upper bound just moves", () => {
    expect(bindHogqlNow("select count() from events where event = 'x' and timestamp > now() - interval 1 day", AT)).toEqual({
      ok: true,
      query: `select count() from events where event = 'x' and (timestamp > ${T} - interval 1 day AND timestamp <= ${T})`,
      window_ms: 86_400_000,
    });
    const both = bindHogqlNow("select count() from events where timestamp >= now() - toIntervalHour(6) and timestamp < now()", AT);
    expect(both).toEqual({ ok: true, query: `select count() from events where (timestamp >= ${T} - toIntervalHour(6) AND timestamp <= ${T}) and timestamp < ${T}`, window_ms: 6 * 3600_000 });
    // An OR after the bound keeps its meaning: the bound is parenthesised.
    expect(bindHogqlNow("select 1 from events where timestamp > now() - interval 3 days or x = 1", AT)).toMatchObject({ ok: true, window_ms: 3 * 86_400_000 });
  });

  test("now() inside a string or a comment is not code", () => {
    const out = bindHogqlNow("select count() from events where event = 'now()' and timestamp > now() -- since now()", AT);
    expect(out).toEqual({ ok: true, query: `select count() from events where event = 'now()' and (timestamp > ${T} AND timestamp <= ${T}) -- since now()`, window_ms: null });
  });

  test("anything it cannot bind safely is refused, naming why", () => {
    const refused = (q: string) => {
      const out = bindHogqlNow(q, AT);
      return out.ok ? null : out.error;
    };
    expect(refused("select count() from events")).toMatch(/no now\(\)/);
    expect(refused("select count() from events where timestamp > today()")).toMatch(/today/);
    expect(refused("select count() from events where toDate(timestamp) = yesterday()")).toMatch(/yesterday/);
    expect(refused("select count() from events where timestamp > now('UTC')")).toMatch(/argument/);
    expect(refused("select now()")).toMatch(/compared straight/);
    expect(refused("select count() from events where timestamp > toStartOfDay(now())")).toMatch(/compared straight/);
    expect(refused("select count() from events where timestamp + interval 1 day > now()")).toMatch(/compared straight/);
    expect(refused("select count() from events where timestamp > now() - interval 1 day * 2")).toMatch(/compared straight/);
    expect(refused("select count() from events where event = 'x")).toMatch(/unclosed/);
  });
});

describe("history instants", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 9, 7, 9);

  test("a daily window reads one point a day back from the oldest point held, within days", () => {
    const oldest = NOW - 10 * 3600_000;
    const out = historyInstants({ now: NOW, oldest, interval_ms: 3600_000, days: 30 }, DAY);
    expect(out).toHaveLength(29);
    expect(out[out.length - 1]).toBe(oldest - DAY);
    expect(out[0]).toBe(oldest - 29 * DAY);
    expect(out).toEqual([...out].sort((a, b) => a - b));
  });

  test("a shorter window reads one per interval, capped at metric_points", () => {
    const out = historyInstants({ now: NOW, oldest: null, interval_ms: 3600_000, days: 30 }, 3600_000);
    expect(out).toHaveLength(GROUP_RULES.metric_points);
    expect(out[out.length - 1]).toBe(NOW - 3600_000);
  });

  test("a watch whose points already reach back far enough reads nothing", () => {
    expect(historyInstants({ now: NOW, oldest: NOW - 31 * DAY, interval_ms: 3600_000, days: 30 }, DAY)).toEqual([]);
  });
});

describe("HogQL history end to end", () => {
  const realFetch = globalThis.fetch;
  const KEY = "test-connection-secrets-key-at-least-32-bytes!!";
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CONNECTION_SECRETS_KEY;
  });

  async function connected() {
    const w = world();
    process.env.CONNECTION_SECRETS_KEY = KEY;
    await w.db.insert("app_installations", {
      provider: "posthog",
      team_id: "team_1",
      connected_by: "u1",
      access_token_enc: await encryptConnectionSecret("phx_SECRET", KEY),
      config: { host: "https://us.posthog.com", project_id: "77" },
      granted_scopes: [],
      created_at: 1,
      updated_at: 1,
    });
    const handlers: Record<string, any> = {
      "metrics:historyInputs": historyInputs,
      "sources/posthog:sourceForPoll": sourceForPoll,
      "tokenConnectors:tokenConnectionRow": tokenConnectionRow,
      "metrics:recordHistory": recordHistory,
      "ingest:sourceConnectionLost": sourceConnectionLost,
    };
    const route = async (fn: any, args: any) => h(handlers[getFunctionName(fn)])(w.internalCtx, args);
    return { w, actx: { runQuery: route, runMutation: route } };
  }

  test("reads the query at each past day through the poll's read, under the live point, with no alert and no state change", async () => {
    const { w, actx } = await connected();
    const row = await watch(w, { query: "select count() from events where event = 'signed_up' and timestamp > now() - interval 1 day", threshold: 10, direction: "below", interval_ms: 3600_000 });
    await point(w, row._id, 50);
    const bodies: string[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      expect(url).toBe("https://us.posthog.com/api/projects/77/query/");
      const q = JSON.parse(init.body).query.query as string;
      bodies.push(q);
      // Every value is under the line (below 10): history must not alert.
      return new Response(JSON.stringify({ results: [[bodies.length]] }));
    }) as any;
    const out = await h(readHistory)(actx, { watch_id: row._id, days: 5 });
    expect(out).toEqual({ added: 4 });
    expect(bodies).toHaveLength(4);
    for (const q of bodies) {
      expect(q).not.toContain("now()");
      expect(q).toMatch(/\(timestamp > toDateTime\('[^']+Z'\) - interval 1 day AND timestamp <= toDateTime\('[^']+Z'\)\)/);
    }
    const stored = w.db._tables.metric_watches[0];
    // Read newest first, stored oldest first, one day apart, then the live point.
    expect(stored.points.map((p: any) => p.value)).toEqual([4, 3, 2, 1, 50]);
    const gaps = stored.points.slice(0, 4).map((p: any, i: number) => stored.points[i + 1].at - p.at);
    expect(gaps.slice(0, 3)).toEqual([86_400_000, 86_400_000, 86_400_000]);
    expect(stored.state).toBe("ok");
    expect(stored.history).toMatchObject({ added: 4 });
    expect(w.db._tables.external_events).toHaveLength(0);
    expect(w.db._tables.event_groups.every((g: any) => g.last_transition !== "metric_alert")).toBe(true);
  });

  test("a rate limit partway keeps what it read and says why; a query it cannot bind reads nothing", async () => {
    const { w, actx } = await connected();
    const row = await watch(w, { query: "select count() from events where timestamp > now() - interval 1 day", interval_ms: 3600_000 });
    let n = 0;
    globalThis.fetch = (async () => (++n <= 2 ? new Response(JSON.stringify({ results: [[n]] })) : new Response(JSON.stringify({ detail: "slow down" }), { status: 400 }))) as any;
    const out = await h(readHistory)(actx, { watch_id: row._id, days: 10 });
    expect(out.added).toBe(2);
    expect(out.note).toMatch(/Stopped after 2 past values/);
    expect(w.db._tables.metric_watches[0].history).toMatchObject({ added: 2, note: expect.stringMatching(/Stopped after 2/) });
    expect(w.db._tables.event_sources[0].status).toBe("active");

    const plain = (await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: "all time", query_kind: "hogql", query: "select count() from events", threshold: 1, direction: "above" })).watch;
    let fetched = 0;
    globalThis.fetch = (async () => (fetched++, new Response("{}"))) as any;
    const none = await h(readHistory)(actx, { watch_id: plain._id });
    expect(none.note).toMatch(/no now\(\)/);
    expect(fetched).toBe(0);
    expect(w.db._tables.metric_watches.find((r: any) => r._id === plain._id).history.note).toMatch(/no now\(\)/);
  });
});

describe("history queue and busy retries", () => {
  test("a read starts the next watch of its source even when it fails", async () => {
    const w = world();
    const a = await watch(w);
    const b = (await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: "b", query_kind: "hogql", query: "q", threshold: 1, direction: "above" })).watch;
    const c = (await h(createWatch)(w.as("u1"), { ...TEAM, source: "product", name: "c", query_kind: "hogql", query: "q", threshold: 1, direction: "above" })).watch;
    w.scheduled.length = 0;
    const actx = { runQuery: async () => { throw new Error("boom"); }, runMutation: async () => null, scheduler: w.internalCtx.scheduler };
    await expect(h(readHistory)(actx, { watch_id: a._id, days: 7, then: [b._id, c._id] })).rejects.toThrow(/boom/);
    expect(w.scheduled).toEqual([{ name: "metrics:readHistory", args: { watch_id: b._id, days: 7, then: [c._id] } }]);
  });

  test("PostHog's busy answer and a rate limit are waited out, then the read goes on", async () => {
    const conn = { host: "https://us.posthog.com", project_id: "77", token: "phx" } as any;
    const answers = [503, 429, 200, 200];
    const waits: number[] = [];
    const fetchImpl = (async () => {
      const status = answers.shift() ?? 200;
      return status === 200 ? new Response(JSON.stringify({ results: [[7]] })) : new Response(JSON.stringify({ detail: "busy" }), { status });
    }) as any;
    const now = Date.UTC(2026, 9, 7);
    const out = await fetchMetricHistory(conn, { query_kind: "hogql", query: "select count() from events where timestamp > now() - interval 1 day" }, { now, oldest: null, interval_ms: 3600_000, days: 2 }, fetchImpl, async (ms) => void waits.push(ms));
    expect(out).toEqual({ ok: true, points: [{ at: now - 86_400_000, value: 7 }] });
    expect(waits).toHaveLength(2);
  });
});
