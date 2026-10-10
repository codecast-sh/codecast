// The replay player's server half (external-data.md X5, "Playing a replay";
// contracts/replayPlayer.ts): DOM chunks stored beside the stream, the
// capability minted after an access check, and the manifest it opens.
import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { gunzipSync, strFromU8 } from "fflate";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { parseReplayDomChunkKey, replayDomChunkKey } from "./lib/r2";
import { mintReplayCap, openReplayCap, replayCapKey } from "./lib/replayCap";
import { chunkDomEvents, chunkObject, playerLink, playerManifestRow, playerTarget, recordReplayChunk, saveImported, saveSummary, storeReplayDom } from "./replays";
import { replayFrameAdmit, replayPlayerManifest, validateReplaySign } from "./replaysHttp";
import { bump } from "./ipRateLimit";
import { importVendorRecording } from "./sources/vendorReplay";
import { REPLAY_DOM_LIMITS, REPLAY_FRAME_LIMITS, REPLAY_PLAYER_ORIGIN, parseReplayPlayerUrl } from "@codecast/shared/contracts/replayPlayer";
import { REPLAY_LIMITS } from "@codecast/shared/contracts/replay";

const h = (fn: any) => fn._handler;
const NOW = Date.now();
const SHA = (c: string) => c.repeat(64);
const ENV = ["R2_ENDPOINT", "REPLAYS_R2_BUCKET", "REPLAYS_R2_ACCESS_KEY_ID", "REPLAYS_R2_SECRET_ACCESS_KEY"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
});

function withBucket() {
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.REPLAYS_R2_ACCESS_KEY_ID = "rk";
  process.env.REPLAYS_R2_SECRET_ACCESS_KEY = "rs";
}

function world(rows: Record<string, unknown>[] = []) {
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      event_sources: [{ _id: "src_row", workspace: "team:team_1", team_id: "team_1", name: "shop", provider: "sdk" }],
      replays: rows.map((over) => ({
        workspace: "team:team_1",
        team_id: "team_1",
        source_id: "src_row",
        provider: "posthog",
        external_id: "rec",
        started_at: 1_000,
        counts: { clicks: 0, errors: 0, failed_requests: 0 },
        group_ids: [],
        chunk_keys: [],
        created_at: 1,
        updated_at: 1,
        ...over,
      })),
      replay_timelines: [],
      ip_rate_limits: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db }) as any;
  return { db: db as any, as, internalCtx: { db, scheduler: { runAfter: async () => {} } } as any };
}

const domKey = (seq: number, sha = SHA("d")) => replayDomChunkKey({ sourceId: "src_row", replay: "rec", seq, sha256: sha });

describe("DOM chunks", () => {
  test("sit under the recording's dom/ prefix and parse back; a stream key is not one", () => {
    const k = domKey(3);
    expect(k).toBe(`replays/src_row/rec/dom/0003-${SHA("d")}.json.gz`);
    expect(parseReplayDomChunkKey(k)).toEqual({ seq: 3, sha256: SHA("d") });
    expect(parseReplayDomChunkKey(`replays/src_row/rec/0003-${SHA("d")}.json.gz`)).toBeNull();
  });

  test("the SDK signs them with kind dom, held to the DOM limits", () => {
    const ok = { replay_id: "r1", seq: 0, sha256: SHA("a"), size: REPLAY_LIMITS.chunk_max_bytes + 1, kind: "dom" };
    expect(validateReplaySign(ok)).toEqual(ok);
    expect(validateReplaySign({ ...ok, kind: "events" })).toContain("at most");
    expect(validateReplaySign({ ...ok, size: REPLAY_DOM_LIMITS.chunk_max_bytes + 1 })).toContain("DOM chunk is at most");
    expect(validateReplaySign({ ...ok, kind: "pixels" })).toContain("kind");
  });

  test("a signed DOM chunk is listed apart from the stream, one key per seq", async () => {
    const w = world();
    const source = w.db._tables.event_sources[0];
    await recordReplayChunk(w.internalCtx, source, "rec", 1, domKey(1), NOW, "dom");
    await recordReplayChunk(w.internalCtx, source, "rec", 0, domKey(0), NOW, "dom");
    await recordReplayChunk(w.internalCtx, source, "rec", 0, domKey(0, SHA("e")), NOW, "dom");
    const row = w.db._tables.replays[0];
    expect(row.chunk_keys).toEqual([]);
    expect(row.dom_chunk_keys).toEqual([domKey(0, SHA("e")), domKey(1)]);
    expect(await h(chunkObject)(w.internalCtx, { user_id: "u1", replay: row.short_id, seq: 1, kind: "dom" })).toBe(domKey(1));
    expect(await h(chunkObject)(w.internalCtx, { user_id: "u1", replay: row.short_id, seq: 1 })).toBeNull();
    expect(await h(chunkObject)(w.internalCtx, { user_id: "u2", replay: row.short_id, seq: 1, kind: "dom" })).toBeNull();
  });

  test("an import packs the capture into gzipped chunks and drops an event too heavy to keep", () => {
    const small = Array.from({ length: 50 }, (_, i) => ({ type: 3, timestamp: i, data: { source: 2, x: "y".repeat(10) } }));
    const { chunks, dropped } = chunkDomEvents(small);
    expect(chunks).toHaveLength(1);
    expect(dropped).toBe(0);
    expect(JSON.parse(strFromU8(gunzipSync(chunks[0])))).toEqual(small);
    // Incompressible text past the gzipped cap cannot be kept whole.
    let noise = "";
    for (let i = 0; noise.length < REPLAY_DOM_LIMITS.chunk_max_bytes * 1.5; i++) noise += Math.random().toString(36).slice(2);
    const heavy = chunkDomEvents([{ type: 2, timestamp: 0, data: { noise } }, { type: 3, timestamp: 1, data: {} }]);
    expect(heavy.dropped).toBe(1);
    expect(heavy.chunks).toHaveLength(1);
  });

  test("storeReplayDom uploads only what the bucket lacks and names the clock's epoch", async () => {
    withBucket();
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return new Response(null, { status: init?.method === "HEAD" ? 404 : 200 });
    }) as any;
    const events = [{ type: 4, timestamp: 5_000, data: { href: "https://shop.test/" } }, { type: 2, timestamp: 5_001, data: { node: {} } }];
    const out = await storeReplayDom({ endpoint: process.env.R2_ENDPOINT!, accessKeyId: "rk", secretAccessKey: "rs", bucket: "codecast-replays" }, { source_id: "src_row", external_id: "rec", events });
    expect(out.dom_chunk_keys).toHaveLength(1);
    expect(parseReplayDomChunkKey(out.dom_chunk_keys[0])?.seq).toBe(0);
    expect(out.dom_t0).toBe(5_000);
    expect(out.dom_bytes).toBeGreaterThan(0);
    expect(calls.map((c) => c.split(" ")[0])).toEqual(["HEAD", "PUT"]);
  });
});

describe("what an import records", () => {
  const summary = { provider: "posthog" as const, chunk_keys: ["k"], timeline_md: "t", counts: { clicks: 0, errors: 0, failed_requests: 0 }, duration_ms: 10 };

  test("the capture's keys and the replay clock's epoch (capture start plus the stream's first t)", async () => {
    const w = world([{ _id: "r1", short_id: "rp-1" }]);
    await h(saveImported)(w.internalCtx, { replay_id: "r1", ...summary, dom_chunk_keys: [domKey(0)], dom_bytes: 42, dom_t0: 5_000, first_t: 30 });
    expect(w.db._tables.replays[0]).toMatchObject({ dom_chunk_keys: [domKey(0)], dom_bytes: 42, dom_t0: 5_030 });
  });

  test("a re-import that kept no capture clears the old one", async () => {
    const w = world([{ _id: "r1", short_id: "rp-1", dom_chunk_keys: [domKey(0)], dom_bytes: 42 }]);
    await h(saveImported)(w.internalCtx, { replay_id: "r1", ...summary });
    expect(w.db._tables.replays[0]).toMatchObject({ dom_chunk_keys: [], dom_bytes: 0 });
  });

  test("our recorder's clock zero is its start plus the first event's t", async () => {
    const w = world([{ _id: "r1", short_id: "rp-1", provider: "sdk", chunk_keys: ["k"], started_at: 9_000 }]);
    await h(saveSummary)(w.internalCtx, { replay_id: "r1", chunk_keys: ["k"], timeline_md: "t", counts: summary.counts, duration_ms: 1, first_t: 120 });
    expect(w.db._tables.replays[0].dom_t0).toBe(9_120);
  });

  test("a vendor import stores the masked capture beside the stream", async () => {
    withBucket();
    globalThis.fetch = (async (_url: string, init?: RequestInit) => new Response(null, { status: init?.method === "HEAD" ? 404 : 200 })) as any;
    const actions: any[] = [];
    const ctx = {
      runQuery: async () => ({}),
      runAction: async (fn: any, args: any) => {
        actions.push({ name: getFunctionName(fn), args });
        return { replay_id: "r1", short_id: "rp-1", chunks: 1 };
      },
    };
    const rrweb = [
      { type: 4, timestamp: 1_000, data: { href: "https://shop.test/cart?token=abc", width: 800, height: 600 } },
      { type: 2, timestamp: 1_001, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: "input", attributes: { value: "secret" }, childNodes: [] }] } } },
      { type: 3, timestamp: 1_500, data: { source: 5, id: 2, text: "hunter2" } },
    ];
    await importVendorRecording(ctx as any, { source_id: "src_row" as any, provider: "posthog", external_id: "rec" }, async () => ({ events: rrweb, truncated: false }));
    const args = actions[0].args;
    expect(actions[0].name).toBe("replays:importExternal");
    expect(args.dom_chunk_keys).toHaveLength(1);
    expect(args.dom_t0).toBe(1_000);
    // The stream was read before the masking: the nav keeps its path.
    expect(args.events.find((e: any) => e.type === "nav")?.url).toContain("shop.test/cart");
    expect(JSON.stringify(rrweb)).not.toContain("hunter2");
    expect(JSON.stringify(rrweb)).not.toContain("secret");
    expect(JSON.stringify(rrweb)).not.toContain("abc");
  });

  test("a capture with no full snapshot is not kept: there is nothing to play", async () => {
    withBucket();
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as any;
    const actions: any[] = [];
    const ctx = { runQuery: async () => ({}), runAction: async (_fn: any, args: any) => (actions.push(args), { replay_id: "r1", short_id: "rp-1", chunks: 0 }) };
    await importVendorRecording(ctx as any, { source_id: "src_row" as any, provider: "sentry", external_id: "rec" }, async () => ({ events: [{ type: 4, timestamp: 1, data: { href: "https://x.test/" } }], truncated: true }));
    expect(actions[0].dom_chunk_keys).toBeUndefined();
  });
});

describe("the capability", () => {
  test("opens what it names until it lapses; a forged or foreign one opens nothing", async () => {
    const key = (await replayCapKey({ REPLAYS_R2_SECRET_ACCESS_KEY: "rs" }))!;
    const { cap, expires_at } = await mintReplayCap(key, { replay_id: "r1", user_id: "u1", now: NOW });
    expect(cap).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(await openReplayCap(key, cap, NOW)).toEqual({ v: 1, r: "r1", u: "u1", exp: expires_at });
    expect(await openReplayCap(key, cap, expires_at)).toBeNull();
    const other = (await replayCapKey({ REPLAYS_R2_SECRET_ACCESS_KEY: "other" }))!;
    expect(await openReplayCap(other, cap, NOW)).toBeNull();
    const [body, sig] = cap.split(".");
    const forged = btoa(atob(body.replace(/-/g, "+").replace(/_/g, "/")).replace('"r1"', '"r2"')).replace(/=+$/, "");
    expect(await openReplayCap(key, `${forged}.${sig}`, NOW)).toBeNull();
    expect(await openReplayCap(null, cap, NOW)).toBeNull();
    expect(await replayCapKey({})).toBeNull();
  });

  test("is minted only for a reader, and only when there is a capture to play", async () => {
    withBucket();
    const w = world([{ _id: "r1", short_id: "rp-1", dom_chunk_keys: [domKey(0)] }, { _id: "r2", short_id: "rp-2", external_id: "other" }]);
    const actionCtx = (userId: string) => ({ runQuery: async (_fn: any, args: any) => h(playerTarget)(w.as(userId), args) }) as any;
    const link = await h(playerLink)(actionCtx("u1"), { replay: "rp-1", t_ms: 83_000, mode: "frame" });
    expect(link).toMatchObject({ short_id: "rp-1", has_dom: true, frame_url: `${REPLAY_PLAYER_ORIGIN}/frame` });
    expect(parseReplayPlayerUrl(link.player_url)).toMatchObject({ cap: link.cap, t_ms: 83_000, mode: "frame" });
    const none = await h(playerLink)(actionCtx("u1"), { replay: "rp-2" });
    expect(none).toMatchObject({ has_dom: false, cap: null, player_url: null });
    await expect(h(playerLink)(actionCtx("u2"), { replay: "rp-1" })).rejects.toThrow();
  });

  test("the manifest re-checks the person it was minted for", async () => {
    const w = world([{ _id: "r1", short_id: "rp-1", url: "https://shop.test/", dom_chunk_keys: [domKey(0)], dom_t0: 777 }]);
    expect(await h(playerManifestRow)(w.internalCtx, { replay_id: "r1", user_id: "u1" })).toMatchObject({ dom_chunk_keys: [domKey(0)], t0: 777, replay: { short_id: "rp-1", url: "https://shop.test/" } });
    expect(await h(playerManifestRow)(w.internalCtx, { replay_id: "r1", user_id: "u2" })).toBeNull();
  });

  test("the route trades a live capability for signed DOM URLs and refuses anything else alike", async () => {
    withBucket();
    const w = world([{ _id: "r1", short_id: "rp-1", dom_chunk_keys: [domKey(0), domKey(1)] }]);
    const ctx = { runQuery: async (fn: any, args: any) => (expect(getFunctionName(fn)).toBe("replays:playerManifestRow"), h(playerManifestRow)(w.internalCtx, args)) };
    const { cap } = await mintReplayCap((await replayCapKey())!, { replay_id: "r1", user_id: "u1", now: Date.now() });
    const call = (c: string) => h(replayPlayerManifest)(ctx, new Request(`https://convex.codecast.sh/cli/replays/player?cap=${encodeURIComponent(c)}`));
    const ok = await call(cap);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await ok.json();
    expect(body.dom_urls).toHaveLength(2);
    expect(body.dom_urls[0]).toContain("/codecast-replays/replays/src_row/rec/dom/0000-");
    expect(body.dom_urls[0]).toContain("X-Amz-Signature=");
    expect((await call(`${cap.slice(0, -1)}${cap.endsWith("0") ? "1" : "0"}`)).status).toBe(404);
    expect((await call("nonsense")).status).toBe(404);
  });

  test("a frame request is admitted only on a live capability, and each capability buys a fixed number", async () => {
    withBucket();
    const w = world([{ _id: "r1", short_id: "rp-1", dom_chunk_keys: [domKey(0)] }]);
    const ctx = {
      runQuery: async (fn: any, args: any) => (expect(getFunctionName(fn)).toBe("replays:playerManifestRow"), h(playerManifestRow)(w.internalCtx, args)),
      runMutation: async (fn: any, args: any) => (expect(getFunctionName(fn)).toBe("ipRateLimit:bump"), h(bump)({ db: w.db }, args)),
    };
    const admit = (cap: string) => h(replayFrameAdmit)(ctx, new Request("https://convex.codecast.sh/cli/replays/frame-admit", { method: "POST", body: JSON.stringify({ cap }) }));
    const key = (await replayCapKey())!;
    const { cap } = await mintReplayCap(key, { replay_id: "r1", user_id: "u1", now: Date.now() });
    expect((await admit("nonsense")).status).toBe(404);
    const foreign = await mintReplayCap(key, { replay_id: "r1", user_id: "u2", now: Date.now() });
    expect((await admit(foreign.cap)).status).toBe(404);
    for (let i = 0; i < REPLAY_FRAME_LIMITS.requests_per_cap; i++) expect((await admit(cap)).status).toBe(204);
    const spent = await admit(cap);
    expect(spent.status).toBe(429);
    expect(Number(spent.headers.get("Retry-After"))).toBeGreaterThan(0);
    // A fresh capability for the same person has its own budget, up to the person's own.
    const fresh = await mintReplayCap(key, { replay_id: "r1", user_id: "u1", now: Date.now() + 1 });
    expect((await admit(fresh.cap)).status).toBe(204);
  });
});
