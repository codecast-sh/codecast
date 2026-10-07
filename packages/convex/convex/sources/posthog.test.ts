import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { gzipSync, strFromU8, strToU8 } from "fflate";
import schema from "../schema";
import { makeFakeDb, schemaIndexes } from "../testDb";
import { PASSTHROUGH_MAX_BYTES } from "@codecast/shared/contracts/ingest";
import { VENDOR_CONVERTER_VERSION } from "@codecast/shared/contracts/replay";
import { fromRrweb } from "@codecast/shared/replay";
import { createSource } from "../ingest";
import { importedReplays } from "../replays";
import { encryptConnectionSecret, tokenConnectionRow } from "../tokenConnectors";
import {
  capRows,
  decompressPostHogEvent,
  fetchMetricValue,
  fetchRecordingEvents,
  hogqlScalar,
  importRecording,
  insightPath,
  insightScalar,
  listRecordings,
  parseSnapshotJsonl,
  posthogConn,
  posthogRequest,
  query,
  recordingRow,
  recordingsPath,
  snapshotReads,
  snapshotSources,
  SNAPSHOT_BLOBS_PER_READ,
  sourceForCaller,
} from "./posthog";

const h = (fn: any) => fn._handler;
const conn = { token: "phx_SECRET", host: "https://us.posthog.com", project_id: "77" };
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);

// ── Fixtures: a small PostHog recording ──

const T0 = 1_760_000_000_000;
const META = { type: 4, timestamp: T0, data: { href: "https://app.example.com/checkout", width: 1200, height: 800 } };
const FULL = {
  type: 2,
  timestamp: T0 + 10,
  data: {
    node: {
      id: 1,
      type: 0,
      childNodes: [
        {
          id: 2,
          type: 2,
          tagName: "html",
          childNodes: [
            { id: 3, type: 2, tagName: "head", childNodes: [{ id: 4, type: 2, tagName: "title", childNodes: [{ id: 5, type: 3, textContent: "Checkout" }] }] },
            { id: 6, type: 2, tagName: "body", childNodes: [{ id: 7, type: 2, tagName: "button", attributes: { id: "pay" }, childNodes: [{ id: 8, type: 3, textContent: "Pay now" }] }] },
          ],
        },
      ],
    },
    initialOffset: { top: 0, left: 0 },
  },
};
const CLICK = { type: 3, timestamp: T0 + 2_000, data: { source: 2, type: 2, id: 7, x: 10, y: 10 } };
const CONSOLE = { type: 6, timestamp: T0 + 2_100, data: { plugin: "rrweb/console@1", payload: { level: "error", payload: ['"Payment failed"'] } } };

/** posthog-js's compression: gzip bytes carried as a latin1 string. */
const packed = (value: unknown) => strFromU8(gzipSync(strToU8(JSON.stringify(value))), true);

describe("connection", () => {
  test("calls go to the connection's validated host; a source's project that is not a number is refused, never swapped for the connection's", () => {
    const cred = { token: "t", config: { host: "https://eu.posthog.com", project_id: "1" } };
    expect(posthogConn(cred, { project_id: "9" })).toEqual({ token: "t", host: "https://eu.posthog.com", project_id: "9" });
    expect(posthogConn(cred, {})).toMatchObject({ project_id: "1" });
    expect(posthogConn(cred, { project_id: "../9" })).toEqual({ error: 'PostHog project id must be a number, got "../9"' });
    expect(posthogConn(cred, { project_id: "abc" })).toHaveProperty("error");
    expect(posthogConn({ token: "t", config: {} })).toHaveProperty("error");
  });
});

describe("posthogRequest", () => {
  test("sends the bearer token, never follows a redirect, and keeps the token out of every error", async () => {
    let init: any;
    const ok = await posthogRequest(conn, "/query/", { method: "POST", body: { a: 1 }, maxBytes: 1000 }, async (_u, i) => ((init = i), json({ results: [] })));
    expect(ok.ok).toBe(true);
    expect(init.redirect).toBe("manual");
    expect(init.headers.Authorization).toBe("Bearer phx_SECRET");
    const answers = [
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      json({ detail: "Invalid personal API key." }, { status: 401 }),
      json({ type: "validation_error", detail: "Unknown table `evnts`" }, { status: 400 }),
      new Response("x".repeat(2000)),
    ];
    const errors: string[] = [];
    for (const res of answers) {
      const out = await posthogRequest(conn, "/query/", { maxBytes: 1000 }, async () => res);
      expect(out.ok).toBe(false);
      if (!out.ok) errors.push(out.error);
    }
    expect(errors[0]).toMatch(/redirected/);
    expect(errors[1]).toMatch(/refused the token \(401\): Invalid personal API key/);
    expect(errors[2]).toMatch(/400: Unknown table `evnts`/);
    expect(errors[3]).toMatch(/over 1000 bytes/);
    for (const e of errors) expect(e).not.toContain("phx_SECRET");
  });
});

describe("metric values", () => {
  test("a HogQL answer's first cell, numbers and numeric strings only", () => {
    expect(hogqlScalar({ columns: ["c"], results: [[42, "x"]] })).toBe(42);
    expect(hogqlScalar({ results: [["0.25"]] })).toBe(0.25);
    expect(hogqlScalar({ results: [[null]] })).toBeNull();
    expect(hogqlScalar({ results: [] })).toBeNull();
    expect(hogqlScalar({ results: [["n/a"]] })).toBeNull();
  });

  test("an insight's number: aggregated value, else the latest point, else a HogQL row", () => {
    expect(insightScalar({ result: [{ aggregated_value: 120, data: [1, 2] }] })).toBe(120);
    expect(insightScalar({ result: [{ data: [5, 8, 13], count: 26 }] })).toBe(13);
    expect(insightScalar({ results: [[7]] })).toBe(7);
    expect(insightScalar({ result: [] })).toBeNull();
    expect(insightScalar({})).toBeNull();
  });

  test("insight refs: a numeric id by path, a short id through the list filter, both fresh", () => {
    expect(insightPath("123")).toBe("/insights/123/?refresh=blocking");
    expect(insightPath("aBc12xYz")).toBe("/insights/?short_id=aBc12xYz&refresh=blocking");
  });

  test("fetchMetricValue reads a short-id insight from the list answer and says why when there is no number", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => (urls.push(url), json({ results: [{ id: 9, result: [{ data: [1, 4] }] }] }));
    expect(await fetchMetricValue(conn, { query_kind: "insight", query: "aBc12xYz" }, fetchImpl)).toEqual({ ok: true, value: 4 });
    expect(urls[0]).toBe("https://us.posthog.com/api/projects/77/insights/?short_id=aBc12xYz&refresh=blocking");
    const none = await fetchMetricValue(conn, { query_kind: "hogql", query: "select 1" }, async () => json({ results: [[null]] }));
    expect(none).toEqual({ ok: false, error: "The query returned no number in its first cell" });
    const missing = await fetchMetricValue(conn, { query_kind: "insight", query: "zzzzzzzz" }, async () => json({ results: [] }));
    expect(missing).toEqual({ ok: false, error: "PostHog has no insight zzzzzzzz" });
  });
});

describe("passthrough rows", () => {
  test("an answer under the cap passes whole", () => {
    expect(capRows({ columns: ["a"], types: ["Int"], results: [[1], [2]] })).toEqual({ columns: ["a"], types: ["Int"], results: [[1], [2]], rows: 2, truncated: false });
  });

  test("an answer over the cap keeps the longest prefix of whole rows that fits", () => {
    const results = Array.from({ length: 5000 }, (_, i) => [i, "x".repeat(100)]);
    const out = capRows({ columns: ["i", "pad"], results });
    expect(out.truncated).toBe(true);
    expect(out.rows).toBe(5000);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.length).toBeLessThan(5000);
    expect(new TextEncoder().encode(JSON.stringify({ columns: out.columns, types: out.types, results: out.results })).length).toBeLessThanOrEqual(PASSTHROUGH_MAX_BYTES);
    expect(out.results.at(-1)).toEqual([out.results.length - 1, "x".repeat(100)]);
  });
});

describe("recordings", () => {
  test("a list row maps PostHog's fields and refuses an id that could steer a path", () => {
    const row = recordingRow({
      id: "0192a-uuid",
      start_time: "2026-10-01T10:00:00Z",
      end_time: "2026-10-01T10:02:00Z",
      recording_duration: 120.4,
      distinct_id: "d1",
      person: { properties: { email: "a@example.com" } },
      start_url: "https://app.example.com/",
      click_count: 4,
      console_error_count: 1,
    });
    expect(row).toEqual({
      id: "0192a-uuid",
      started_at: Date.parse("2026-10-01T10:00:00Z"),
      ended_at: Date.parse("2026-10-01T10:02:00Z"),
      duration_ms: 120_400,
      distinct_id: "d1",
      email: "a@example.com",
      url: "https://app.example.com/",
      clicks: 4,
      errors: 1,
    });
    expect(recordingRow({ id: "r1", start_url: "https://app.example.com/magic?token=abc#x" })?.url).toBe("https://app.example.com/magic?token=#");
    expect(recordingRow({ id: "../../x" })).toBeNull();
    expect(recordingRow(null)).toBeNull();
  });

  test("list filters are clamped and checked before they reach a URL", () => {
    expect(recordingsPath({})).toBe("/session_recordings/?limit=20");
    expect(recordingsPath({ limit: 1000, date_from: "-7d", date_to: "2026-10-01", person_uuid: "p-1" })).toBe(
      "/session_recordings/?limit=100&date_from=-7d&date_to=2026-10-01&person_uuid=p-1",
    );
    expect(() => recordingsPath({ date_from: "-7d&limit=99999" })).toThrow(/PostHog date/);
    expect(() => recordingsPath({ person_uuid: "a/b" })).toThrow(/person id/);
  });

  test("snapshot sources prefer blob_v2, then blob, then realtime", () => {
    expect(snapshotSources({ sources: [{ source: "realtime" }, { source: "blob_v2", blob_key: "0" }, { source: "blob_v2", blob_key: 1 }] })).toEqual([
      { source: "blob_v2", blob_key: "0" },
      { source: "blob_v2", blob_key: "1" },
    ]);
    expect(snapshotSources({ sources: [{ source: "realtime" }] })).toEqual([{ source: "realtime" }]);
    expect(snapshotSources({})).toEqual([]);
  });

  test("JSONL: blob_v2 tuples, older window objects and bare events; a torn line is skipped", () => {
    const text = [
      JSON.stringify(["w1", META]),
      JSON.stringify({ window_id: "w1", data: [FULL, CLICK] }),
      '["w1", {"type": 3, "timest',
      JSON.stringify(CONSOLE),
      "",
    ].join("\n");
    expect(parseSnapshotJsonl(text).map((e) => e.timestamp)).toEqual([META.timestamp, FULL.timestamp, CLICK.timestamp, CONSOLE.timestamp]);
  });

  test("posthog-js compressed events inflate: a full snapshot whole, a mutation by field", () => {
    const full = decompressPostHogEvent({ ...FULL, cv: "2024-10", data: packed(FULL.data) });
    expect(full).toEqual(FULL as any);
    const adds = [{ parentId: 6, nextId: null, node: { id: 9, type: 2, tagName: "a", attributes: { href: "/x" }, childNodes: [] } }];
    const mutation = decompressPostHogEvent({ type: 3, timestamp: T0 + 5, cv: "2024-10", data: { source: 0, adds: packed(adds), texts: packed([]), attributes: packed([]), removes: packed([]) } });
    expect(mutation?.data).toEqual({ source: 0, adds, texts: [], attributes: [], removes: [] });
    // A field that does not inflate drops the event rather than feeding garbage on.
    expect(decompressPostHogEvent({ ...FULL, cv: "2024-10", data: "not gzip" })).toBeNull();
  });

  // A fake PostHog snapshots endpoint: blob_v2 only by an inclusive start and
  // end key, at most 20 apart, a bare blob_key refused, as PostHog answers.
  const blobServer = (blobs: string[][], urls: string[]) => async (url: string) => {
    urls.push(url);
    if (url.endsWith("/snapshots")) return json({ sources: blobs.map((_, i) => ({ source: "blob_v2", blob_key: String(i) })) });
    const q = new URL(url).searchParams;
    const start = q.get("start_blob_key");
    const end = q.get("end_blob_key");
    if (!start || !end) return json({ detail: "Must provide both start blob key and end blob key" }, { status: 400 });
    if (Number(end) - Number(start) > 20) return json({ detail: "Cannot request more than 20 blob keys at once" }, { status: 400 });
    return new Response(blobs.slice(Number(start), Number(end) + 1).flat().join("\n"));
  };
  const path = (range: string) => `https://us.posthog.com/api/projects/77/session_recordings/rec-1/snapshots?source=blob_v2&${range}`;

  test("a fetched recording converts to the semantic stream through fromRrweb", async () => {
    const urls: string[] = [];
    const blobs = [
      [JSON.stringify(["w", META]), JSON.stringify(["w", { ...FULL, cv: "2024-10", data: packed(FULL.data) }])],
      [JSON.stringify(["w", CLICK]), JSON.stringify(["w", CONSOLE])],
    ];
    const read = await fetchRecordingEvents(conn, "rec-1", blobServer(blobs, urls));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.truncated).toBe(false);
    // Both blobs in one call: PostHog's snapshot throttle counts calls.
    expect(urls.slice(1)).toEqual([path("start_blob_key=0&end_blob_key=1")]);
    const events = fromRrweb(read.events);
    expect(events.map((e) => e.type)).toEqual(["nav", "click", "console"]);
    expect(events[0]).toMatchObject({ url: "https://app.example.com/checkout", title: "Checkout" });
    expect(events[1]).toMatchObject({ label: "Pay now", t: 2_000 });
  });

  test("blob_v2 keys are read in consecutive runs of at most SNAPSHOT_BLOBS_PER_READ", () => {
    const keys = (...k: (string | number)[]) => k.map((b) => ({ source: "blob_v2", blob_key: String(b) }));
    expect(snapshotReads(keys(0, 1, 2))).toEqual([{ source: "blob_v2", blob_key: "0", end_blob_key: "2" }]);
    expect(snapshotReads(keys(0, 1, 3))).toEqual([
      { source: "blob_v2", blob_key: "0", end_blob_key: "1" },
      { source: "blob_v2", blob_key: "3" },
    ]);
    const many = snapshotReads(keys(...Array.from({ length: 45 }, (_, i) => i)));
    expect(many.map((r) => [r.blob_key, r.end_blob_key])).toEqual([["0", "19"], ["20", "39"], ["40", "44"]]);
    expect(SNAPSHOT_BLOBS_PER_READ).toBeLessThanOrEqual(20);
    expect(snapshotReads([{ source: "realtime" }])).toEqual([{ source: "realtime" }]);
  });

  test("a long recording reads 20 blobs a call, every event kept", async () => {
    const urls: string[] = [];
    const blobs = Array.from({ length: 25 }, (_, i) => [JSON.stringify(["w", { ...CLICK, timestamp: CLICK.timestamp + i }])]);
    const read = await fetchRecordingEvents(conn, "rec-1", blobServer(blobs, urls));
    expect(read.ok && read.events.length).toBe(25);
    expect(urls.slice(1)).toEqual([path("start_blob_key=0&end_blob_key=19"), path("start_blob_key=20&end_blob_key=24")]);
  });

  test("a range over the byte budget is read again blob by blob, keeping the blobs that fit", async () => {
    const urls: string[] = [];
    const big = (i: number) => [JSON.stringify(["w", { ...CLICK, timestamp: CLICK.timestamp + i, pad: "x".repeat(13 * 1024 * 1024) }])];
    const read = await fetchRecordingEvents(conn, "rec-1", blobServer([big(0), big(1)], urls));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.events.length).toBe(1);
    expect(read.truncated).toBe(true);
    expect(urls.slice(1)).toEqual([path("start_blob_key=0&end_blob_key=1"), path("start_blob_key=0&end_blob_key=0"), path("start_blob_key=1&end_blob_key=1")]);
  });
});

// ── The public actions, over the fake db ──

function world() {
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      projects: [],
      event_sources: [],
      app_installations: [],
      replays: [],
      conversations: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler: { runAfter: async () => {} } }) as any;
  return { db: db as any, as };
}

const TEAM = { workspace: "team" as const, team_id: "team_1" as any };
const KEY = "test-connection-secrets-key-at-least-32-bytes!!";

async function connected(w: ReturnType<typeof world>) {
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
  await h(createSource)(w.as("u1"), { ...TEAM, name: "product", provider: "posthog" });
}

/** An action ctx whose runQuery runs the real internal queries as `userId`, and whose runAction records. */
function actionCtx(w: ReturnType<typeof world>, userId: string, actions: Array<{ name: string; args: any }> = []) {
  const handlers: Record<string, any> = {
    "sources/posthog:sourceForCaller": sourceForCaller,
    "replays:importedReplays": importedReplays,
    "tokenConnectors:tokenConnectionRow": tokenConnectionRow,
  };
  return {
    runQuery: async (fn: any, args: any) => h(handlers[getFunctionName(fn)])(w.as(userId), args),
    runAction: async (fn: any, args: any) => {
      actions.push({ name: getFunctionName(fn), args });
      return { replay_id: "rp_row", short_id: "rp-1", chunks: 1 };
    },
  } as any;
}

describe("actions", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CONNECTION_SECRETS_KEY;
  });

  test("query passes rows through, capped, and refuses an empty query before any call", async () => {
    const w = world();
    await connected(w);
    globalThis.fetch = (async () => json({ columns: ["n"], types: ["UInt64"], results: [[1], [2]] })) as any;
    expect(await h(query)(actionCtx(w, "u1"), { ...TEAM, source: "product", query: "select 1" })).toEqual({ columns: ["n"], types: ["UInt64"], results: [[1], [2]], rows: 2, truncated: false });
    await expect(h(query)(actionCtx(w, "u1"), { ...TEAM, source: "product", query: "  " })).rejects.toThrow(/needs a query/);
  });

  test("a caller outside the workspace cannot reach the source, so nothing is called with its token", async () => {
    const w = world();
    await connected(w);
    globalThis.fetch = (async () => {
      throw new Error("must not fetch");
    }) as any;
    await expect(h(query)(actionCtx(w, "u2"), { workspace: "personal", source: "product", query: "select 1" })).rejects.toThrow(/not found/);
  });

  test("a non-PostHog source is refused", async () => {
    const w = world();
    await connected(w);
    await h(createSource)(w.as("u1"), { ...TEAM, name: "door", provider: "sdk" });
    await expect(h(query)(actionCtx(w, "u1"), { ...TEAM, source: "door", query: "select 1" })).rejects.toThrow(/sdk source, not PostHog/);
  });

  test("listRecordings names the recordings already imported", async () => {
    const w = world();
    await connected(w);
    const source = w.db._tables.event_sources[0];
    await w.db.insert("replays", { workspace: source.workspace, source_id: source._id, short_id: "rp-7", provider: "posthog", external_id: "r2", started_at: 1, counts: { clicks: 0, errors: 0, failed_requests: 0 }, group_ids: [], chunk_keys: [], imported_at: 5, converter_version: VENDOR_CONVERTER_VERSION, created_at: 1, updated_at: 1 });
    globalThis.fetch = (async () => json({ results: [{ id: "r1", start_time: "2026-10-01T00:00:00Z" }, { id: "r2" }, { id: "bad/id" }] })) as any;
    const out = await h(listRecordings)(actionCtx(w, "u1"), { ...TEAM, source: "product" });
    expect(out.recordings.map((r: any) => [r.id, r.replay, r.imported])).toEqual([
      ["r1", null, false],
      ["r2", "rp-7", true],
    ]);
  });

  test("importRecording imports the first time and serves our copy after", async () => {
    const w = world();
    await connected(w);
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/session_recordings/rec-1/")) return json({ id: "rec-1", start_time: "2026-10-01T10:00:00Z", distinct_id: "d1", person: { properties: { email: "a@example.com" } } });
      if (url.endsWith("/snapshots")) return json({ sources: [{ source: "blob_v2", blob_key: "0" }] });
      return new Response([META, FULL, CLICK].map((e) => JSON.stringify(["w", e])).join("\n"));
    }) as any;
    const actions: Array<{ name: string; args: any }> = [];
    const first = await h(importRecording)(actionCtx(w, "u1", actions), { ...TEAM, source: "product", recording: "rec-1" });
    expect(first).toEqual({ replay_id: "rp_row", short_id: "rp-1", imported: true, truncated: false });
    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe("replays:importExternal");
    expect(actions[0].args).toMatchObject({
      provider: "posthog",
      external_id: "rec-1",
      started_at: Date.parse("2026-10-01T10:00:00Z"),
      user: { id: "d1", email: "a@example.com" },
    });
    expect(actions[0].args.events.map((e: any) => e.type)).toEqual(["nav", "click"]);

    // importExternal stamps imported_at on the row; the second read is ours.
    const source = w.db._tables.event_sources[0];
    await w.db.insert("replays", { workspace: source.workspace, source_id: source._id, short_id: "rp-1", provider: "posthog", external_id: "rec-1", started_at: 1, counts: { clicks: 1, errors: 0, failed_requests: 0 }, group_ids: [], chunk_keys: ["k"], imported_at: 9, converter_version: VENDOR_CONVERTER_VERSION, created_at: 1, updated_at: 1 });
    urls.length = 0;
    const again = await h(importRecording)(actionCtx(w, "u1", actions), { ...TEAM, source: "product", recording: "rec-1" });
    expect(again).toMatchObject({ short_id: "rp-1", imported: false });
    expect(urls).toEqual([]);
    expect(actions).toHaveLength(1);
    await expect(h(importRecording)(actionCtx(w, "u1"), { ...TEAM, source: "product", recording: "../x" })).rejects.toThrow(/not a PostHog recording id/);
  });
});
