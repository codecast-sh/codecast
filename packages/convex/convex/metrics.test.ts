import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { GROUP_RULES, METRIC_WATCH_LIMITS } from "@codecast/shared/contracts/ingest";
import { createSource, sourceConnectionLost } from "./ingest";
import { createWatch, getWatch, listWatches, pollDue, pollInputs, pollWatch, recordPoint, removeWatch, updateWatch } from "./metrics";
import { sourceForPoll } from "./sources/posthog";
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
