import { afterEach, describe, expect, test } from "bun:test";
import { patchReplay } from "./lib/replayIndex";
import { getFunctionName } from "convex/server";
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { sha256Hex } from "./lib/hash";
import { replayChunkKey } from "./lib/r2";
import { applyBatch, createSource } from "./ingest";
import {
  chunkObject,
  cliGet,
  get,
  webGetReplay,
  linkReplayToGroup,
  list,
  browse,
  saveShape,
  recordReplayChunk,
  REPLAY_GROUP_LINKS_MAX,
  saveImported,
  saveCaptureLength,
  saveSummary,
  upsertReplayManifest,
  CHUNK_LANDING_MS,
  REPLAYS_NEW_PER_HOUR,
  shouldQueueAssembly,
} from "./replays";
import { chunkReplayEvents, gunzipCapped, putChunk, readReplayChunks, REPLAY_CHUNK_MAX_INFLATED_BYTES, signReplayChunks } from "./lib/replayChunks";
import { withCaptureLength } from "./lib/replayImport";
import { REPLAY_BROWSE_SCAN_MAX, REPLAY_GROUP_SCAN_MAX, writeReplayTimeline } from "./lib/replayReads";
import { readBodyCapped } from "./lib/tokenHttp";
import { handleReplaySign, replaySignKey, validateReplaySign } from "./replaysHttp";
import { classifyStatus } from "@platform/analytics/codecast";
import { REPLAY_LIMITS, type ReplayEvent } from "@codecast/shared/contracts/replay";

const h = (fn: any) => fn._handler;
const NOW = Date.now();

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
      replays: [],
      replay_timelines: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internalCtx: { db, scheduler } as any };
}

async function teamSource(w: ReturnType<typeof world>) {
  const out = await h(createSource)(w.as("u1"), { workspace: "team", team_id: "team_1", name: "shop", provider: "sdk" });
  return { source: w.db._tables.event_sources[0], key: out.ingest_key as string };
}

const SHA = (c: string) => c.repeat(64);
const key = (source: any, seq: number, sha = SHA("a")) => replayChunkKey({ sourceId: String(source._id), replay: "r1", seq, sha256: sha });
const replayItem = (over: Record<string, unknown> = {}) => ({ type: "replay" as const, replay_id: "r1", at: NOW, ...over });

describe("the manifest row", () => {
  test("whichever arrives first opens the stub; the others fill it in", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), NOW);
    await upsertReplayManifest(w.internalCtx, source, replayItem({ url: "https://shop.test/cart", started_at: NOW - 60_000, duration_ms: 60_000, counts: { clicks: 3 } }), NOW);
    expect(w.db._tables.replays).toHaveLength(1);
    expect(w.db._tables.replays[0]).toMatchObject({
      workspace: "team:team_1",
      team_id: "team_1",
      short_id: "rp-1",
      provider: "sdk",
      external_id: "r1",
      url: "https://shop.test/cart",
      started_at: NOW - 60_000,
      duration_ms: 60_000,
      counts: { clicks: 3, errors: 0, failed_requests: 0 },
      chunk_keys: [key(source, 0)],
    });
  });

  test("a manifest update schedules assembly only once chunks exist", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await upsertReplayManifest(w.internalCtx, source, replayItem(), NOW);
    expect(w.scheduled.map((s) => s.name)).not.toContain("replays:assemble");
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), NOW);
    await upsertReplayManifest(w.internalCtx, source, replayItem(), NOW);
    expect(w.scheduled.filter((s) => s.name === "replays:assemble")).toHaveLength(1);
  });

  test("a re-sent manifest queues one assembly, none once the timeline is current, and another for a new chunk", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const assemblies = () => w.scheduled.filter((s) => s.name === "replays:assemble").length;
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), NOW);
    for (let i = 0; i < 20; i++) await upsertReplayManifest(w.internalCtx, source, replayItem(), NOW + i);
    expect(assemblies()).toBe(1);
    const row = w.db._tables.replays[0];
    await w.db.patch(row._id, { timeline_at: NOW + 100 });
    await upsertReplayManifest(w.internalCtx, source, replayItem(), NOW + 200);
    expect(assemblies()).toBe(1);
    await recordReplayChunk(w.internalCtx, source, "r1", 1, key(source, 1), NOW + 300);
    await w.db.patch(row._id, { chunks_at: NOW + 300 });
    await upsertReplayManifest(w.internalCtx, source, replayItem(), NOW + 400);
    expect(assemblies()).toBe(2);
    await upsertReplayManifest(w.internalCtx, source, replayItem(), NOW + 500);
    expect(assemblies()).toBe(2);
    // A queued assembly that never reported back stops blocking after ten minutes.
    await upsertReplayManifest(w.internalCtx, source, replayItem(), NOW + 400 + 10 * 60_000);
    expect(assemblies()).toBe(3);
  });

  test("a chunk re-signed with new content keeps its key unless the caller vouches the held one never landed; keys stay in order; past the cap is refused", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await recordReplayChunk(w.internalCtx, source, "r1", 2, key(source, 2), NOW);
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), NOW);
    expect(await recordReplayChunk(w.internalCtx, source, "r1", 2, key(source, 2, SHA("b")), NOW)).toMatchObject({ ok: true, held: key(source, 2) });
    expect(await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), NOW)).not.toHaveProperty("held");
    expect(w.db._tables.replays[0].chunk_keys).toEqual([key(source, 0), key(source, 2)]);
    // Vouching for a key other than the one held changes nothing.
    expect(await recordReplayChunk(w.internalCtx, source, "r1", 2, key(source, 2, SHA("b")), NOW, "events", key(source, 2, SHA("z")))).toMatchObject({ held: key(source, 2) });
    expect(await recordReplayChunk(w.internalCtx, source, "r1", 2, key(source, 2, SHA("b")), NOW, "events", key(source, 2))).not.toHaveProperty("held");
    expect(w.db._tables.replays[0].chunk_keys).toEqual([key(source, 0), key(source, 2, SHA("b"))]);
    expect(await recordReplayChunk(w.internalCtx, source, "r1", REPLAY_LIMITS.max_chunks_per_replay, "k", NOW)).toMatchObject({ ok: false });
  });

  test("group links are deduplicated and capped", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await linkReplayToGroup(w.internalCtx, source, "r1", "g1" as any, NOW);
    await linkReplayToGroup(w.internalCtx, source, "r1", "g1" as any, NOW);
    expect(w.db._tables.replays[0].group_ids).toEqual(["g1"]);
    for (let i = 0; i < REPLAY_GROUP_LINKS_MAX + 5; i++) await linkReplayToGroup(w.internalCtx, source, "r1", `x${i}` as any, NOW);
    expect(w.db._tables.replays[0].group_ids).toHaveLength(REPLAY_GROUP_LINKS_MAX);
  });
});

describe("through the ingest batch", () => {
  test("an error carrying replay_id links its group and the sample names the replay row; a replay item upserts the manifest", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await h(applyBatch)(w.internalCtx, {
      source_id: source._id,
      items_json: JSON.stringify([
        { type: "error", message: "Boom", at: NOW, replay_id: "r1" },
        { type: "error", message: "Boom", at: NOW + 1, replay_id: "r2" },
        replayItem({ url: "https://shop.test/" }),
      ]),
    });
    const group = w.db._tables.event_groups[0];
    const replays = w.db._tables.replays;
    expect(replays.map((r: any) => r.external_id).sort()).toEqual(["r1", "r2"]);
    for (const r of replays) expect(r.group_ids).toEqual([group._id]);
    expect(replays.find((r: any) => r.external_id === "r1").url).toBe("https://shop.test/");
    const samples = w.db._tables.event_samples;
    expect(samples.map((s: any) => s.replay_id).filter(Boolean).sort()).toEqual(replays.map((r: any) => r._id).sort());
  });
});

describe("reads", () => {
  async function seeded() {
    const w = world();
    const { source } = await teamSource(w);
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), NOW);
    const id = w.db._tables.replays[0]._id;
    await writeReplayTimeline(w.internalCtx, id, "replay rp-1 · 1 event", NOW);
    await w.db.patch(id, { timeline_at: NOW });
    return { w, source, id };
  }

  test("a workspace member lists and reads; the list never carries the timeline or chunk keys", async () => {
    const { w } = await seeded();
    const rows = await h(list)(w.as("u1"), { workspace: "team", team_id: "team_1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ short_id: "rp-1", source_name: "shop", chunks: 1, has_timeline: true });
    expect(JSON.stringify(rows)).not.toContain("replays/");
    expect(JSON.stringify(rows)).not.toContain("timeline_md");
    const one = await h(get)(w.as("u1"), { replay: "rp-1" });
    expect(one.timeline_md).toBe("replay rp-1 · 1 event");
    expect(JSON.stringify(one)).not.toContain("replays/");
  });

  test("someone outside the workspace sees nothing, the same as a missing replay", async () => {
    const { w } = await seeded();
    expect(await h(get)(w.as("u2"), { replay: "rp-1" })).toBeNull();
    expect(await h(get)(w.as("u2"), { replay: "rp-404" })).toBeNull();
    expect(await h(chunkObject)(w.internalCtx, { user_id: "u2", replay: "rp-1", seq: 0 })).toBeNull();
  });

  // A pill's read: the list row by rp-N, and null (never an error) for a
  // replay the reader's workspace does not hold.
  test("a reference reads the list row, and nothing outside the workspace", async () => {
    const { w } = await seeded();
    const row = await h(webGetReplay)(w.as("u1"), { ref: "rp-1" });
    expect(row).toMatchObject({ short_id: "rp-1", source_name: "shop", chunks: 1, dom_chunks: 0 });
    expect(JSON.stringify(row)).not.toContain("timeline_md");
    expect(JSON.stringify(row)).not.toContain("replays/");
    expect(await h(webGetReplay)(w.as("u2"), { ref: "rp-1" })).toBeNull();
    expect(await h(webGetReplay)(w.as("u1"), { ref: "rp-404" })).toBeNull();
  });

  test("the chunk route resolves the key after the access check", async () => {
    const { w, source } = await seeded();
    expect(await h(chunkObject)(w.internalCtx, { user_id: "u1", replay: "rp-1", seq: 0 })).toBe(key(source, 0));
    expect(await h(chunkObject)(w.internalCtx, { user_id: "u1", replay: "rp-1", seq: 1 })).toBeNull();
    expect(await h(chunkObject)(w.internalCtx, { replay: "rp-1", seq: 0 })).toBeNull();
  });

  test("the CLI answer swaps keys for signed URLs", async () => {
    process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.REPLAYS_R2_ACCESS_KEY_ID = "rk";
    process.env.REPLAYS_R2_SECRET_ACCESS_KEY = "rs";
    const signed = await signReplayChunks({ short_id: "rp-1", chunk_keys: ["replays/s/r1/0000-x.json.gz"] }, NOW);
    expect(signed).not.toHaveProperty("chunk_keys");
    expect(signed.chunk_urls[0]).toContain("/codecast-replays/replays/s/r1/0000-x.json.gz?");
    expect(signed.chunk_urls[0]).toContain("X-Amz-Signature=");
  });

  test("an assembly that raced a new chunk does not claim it", async () => {
    const { w, source, id } = await seeded();
    await recordReplayChunk(w.internalCtx, source, "r1", 1, key(source, 1), NOW + 1);
    await w.db.patch(id, { assemble_at: NOW });
    await h(saveSummary)(w.internalCtx, { replay_id: id, chunk_keys: [key(source, 0)], timeline_md: "stale", counts: { clicks: 0, errors: 0, failed_requests: 0 }, duration_ms: 0 });
    expect(w.db._tables.replay_timelines.map((t: any) => t.timeline_md)).toEqual(["replay rp-1 · 1 event"]);
    // It stands down, so the manifest naming the new chunk queues the next assembly.
    expect(w.db._tables.replays[0].assemble_at).toBeUndefined();
    await upsertReplayManifest(w.internalCtx, source, replayItem(), NOW + 1);
    expect(w.scheduled.filter((s) => s.name === "replays:assemble")).toHaveLength(1);
  });

  test("the timeline lives in its own table: a list over many large timelines reads none of them", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const big = "x".repeat(REPLAY_LIMITS.timeline_md_max_chars);
    for (let i = 0; i < 40; i++) {
      await recordReplayChunk(w.internalCtx, source, `r${i}`, 0, key(source, 0), NOW + i);
      const row = w.db._tables.replays[i];
      await h(saveSummary)(w.internalCtx, { replay_id: row._id, chunk_keys: row.chunk_keys, timeline_md: big, counts: { clicks: 0, errors: 0, failed_requests: 0 }, duration_ms: 0 });
    }
    for (const row of w.db._tables.replays) expect(row).not.toHaveProperty("timeline_md");
    expect(w.db._tables.replay_timelines).toHaveLength(40);
    const rows = await h(list)(w.as("u1"), { workspace: "team", team_id: "team_1", source: "shop", limit: 200 });
    expect(rows).toHaveLength(40);
    expect(rows.every((r: any) => r.has_timeline)).toBe(true);
    expect(JSON.stringify(rows).length).toBeLessThan(40 * 1024);
    const one = await h(get)(w.as("u1"), { replay: rows[0].short_id });
    expect(one.timeline_md).toBe(big);
  });

  test("an import writes its timeline once, replacing the earlier one", async () => {
    const { w, id } = await seeded();
    await h(saveImported)(w.internalCtx, { replay_id: id, provider: "posthog", chunk_keys: [], timeline_md: "imported", counts: { clicks: 0, errors: 0, failed_requests: 0 }, duration_ms: 0 });
    expect(w.db._tables.replay_timelines.map((t: any) => t.timeline_md)).toEqual(["imported"]);
  });

  test("an import keeps how far its copy reaches beside the vendor's longer length, and a capture read only ever extends it", async () => {
    const { w, id } = await seeded();
    // rp-5132: PostHog says 1:45:49; the read stopped at the size cap 14:28.5 in.
    await h(saveImported)(w.internalCtx, { replay_id: id, provider: "posthog", chunk_keys: [], timeline_md: "imported", counts: { clicks: 0, errors: 0, failed_requests: 0 }, duration_ms: 868_500, vendor_length_ms: 6_349_000, dom_chunk_keys: ["k1"], dom_bytes: 1, dom_t0: 0 });
    const row = () => w.db._tables.replays.find((r: any) => r._id === id);
    expect(row().duration_ms).toBe(6_349_000);
    expect(row().captured_ms).toBe(868_500);
    // The capture's own end runs a little past the last event: the reach grows, the length stays.
    await h(saveCaptureLength)(w.internalCtx, { replay_id: id, last_key: "k1", duration_ms: 870_000 });
    expect(row().captured_ms).toBe(870_000);
    expect(row().duration_ms).toBe(6_349_000);
    // A shorter read never shrinks it, and a stale key writes nothing.
    await h(saveCaptureLength)(w.internalCtx, { replay_id: id, last_key: "k1", duration_ms: 600_000 });
    await h(saveCaptureLength)(w.internalCtx, { replay_id: id, last_key: "old", duration_ms: 9_000_000 });
    expect(row().captured_ms).toBe(870_000);
    expect(row().duration_ms).toBe(6_349_000);
  });

  test("a read that left nothing of the vendor's recording reaches its whole length; a later part of an older chain saves nothing", async () => {
    const { w, id } = await seeded();
    const base = { replay_id: id, provider: "posthog" as const, chunk_keys: [], timeline_md: "imported", counts: { clicks: 0, errors: 0, failed_requests: 0 } };
    const row = () => w.db._tables.replays.find((r: any) => r._id === id);
    // rp-5132 read whole: its events stop at 1:04:59, PostHog's length runs on through an idle tab.
    await h(saveImported)(w.internalCtx, { ...base, duration_ms: 3_899_384, vendor_length_ms: 6_349_000, whole: true });
    expect(row().captured_ms).toBe(6_349_000);
    // A chain's part saves only while the row carries that chain.
    const chain = { gen: 7, next_blob: 120, blobs: 253, carry_key: "c", updated_at: 1 };
    await h(saveImported)(w.internalCtx, { ...base, duration_ms: 868_500, vendor_length_ms: 6_349_000, import_rest: chain });
    expect(row().import_rest.gen).toBe(7);
    expect(await h(saveImported)(w.internalCtx, { ...base, timeline_md: "stale", duration_ms: 2_000_000, expect_gen: 6 })).toEqual({ saved: false });
    expect(row().captured_ms).toBe(868_500);
    expect(await h(saveImported)(w.internalCtx, { ...base, duration_ms: 2_000_000, expect_gen: 7 })).toEqual({ saved: true });
    // The last part clears the chain.
    expect(row().import_rest).toBeUndefined();
  });

  test("a fresh read of a recording that kept growing never shrinks the copy already held (rp-5212, rp-5200)", async () => {
    const { w, id } = await seeded();
    const base = { replay_id: id, provider: "posthog" as const, chunk_keys: [], timeline_md: "imported", counts: { clicks: 0, errors: 0, failed_requests: 0 } };
    const row = () => w.db._tables.replays.find((r: any) => r._id === id);
    // rp-5200 held 1:13:03 in 34 chunks, read on by its chain.
    const held = Array.from({ length: 34 }, (_, i) => `k${i}`);
    await h(saveImported)(w.internalCtx, { ...base, counts: { clicks: 107, errors: 4, failed_requests: 11 }, duration_ms: 4_383_000, vendor_length_ms: 11_400_000, dom_chunk_keys: held, dom_bytes: 1, dom_t0: 0, read_to: { next_blob: 160, blobs: 428, carry_key: "c", at: 1 } });
    // PostHog's length grew, and a read from the start came back with its first 14:26.
    expect(await h(saveImported)(w.internalCtx, { ...base, counts: { clicks: 3, errors: 0, failed_requests: 0 }, duration_ms: 866_000, vendor_length_ms: 12_000_000, dom_chunk_keys: ["s0", "s1", "s2"], dom_bytes: 1, dom_t0: 0 })).toEqual({ saved: false });
    expect(row().captured_ms).toBe(4_383_000);
    expect(row().dom_chunk_keys).toHaveLength(34);
    expect(row().counts.clicks).toBe(107);
    expect(row().read_to.next_blob).toBe(160);
    // The row's own chain still appends past it.
    await h(saveImported)(w.internalCtx, { ...base, duration_ms: 4_383_000, dom_chunk_keys: held, dom_bytes: 1, import_rest: { gen: 9, next_blob: 160, blobs: 428, carry_key: "c", updated_at: 1 } });
    expect(await h(saveImported)(w.internalCtx, { ...base, duration_ms: 5_000_000, dom_chunk_keys: [...held, "k34"], dom_bytes: 1, expect_gen: 9 })).toEqual({ saved: true });
    expect(row().dom_chunk_keys).toHaveLength(35);
    // A copy by an older converter is what a refresh replaces, shorter or not.
    row().converter_version = 1;
    expect(await h(saveImported)(w.internalCtx, { ...base, duration_ms: 866_000, dom_chunk_keys: ["s0"], dom_bytes: 1 })).toEqual({ saved: true });
  });

  test("a source filter reads that source's index; a group filter looks through a bounded window", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await h(createSource)(w.as("u1"), { workspace: "team", team_id: "team_1", name: "admin", provider: "sdk" });
    const other = w.db._tables.event_sources[1];
    await recordReplayChunk(w.internalCtx, source, "s1", 0, key(source, 0), NOW);
    await recordReplayChunk(w.internalCtx, other, "o1", 0, key(other, 0), NOW + 1);
    await linkReplayToGroup(w.internalCtx, other, "o1", "g1" as any, NOW);
    expect((await h(list)(w.as("u1"), { workspace: "team", team_id: "team_1", source: "shop" })).map((r: any) => r.external_id)).toEqual(["s1"]);
    expect((await h(list)(w.as("u1"), { workspace: "team", team_id: "team_1", group_id: "g1" })).map((r: any) => r.external_id)).toEqual(["o1"]);
    expect(await h(list)(w.as("u1"), { workspace: "team", team_id: "team_1", source: "shop", group_id: "g1" })).toEqual([]);
    expect(REPLAY_GROUP_SCAN_MAX).toBeLessThanOrEqual(500);
  });
});

const ENV = ["R2_ENDPOINT", "REPLAYS_R2_BUCKET", "REPLAYS_R2_ACCESS_KEY_ID", "REPLAYS_R2_SECRET_ACCESS_KEY"];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const bucket = { endpoint: "https://acct.r2.cloudflarestorage.com", accessKeyId: "k", secretAccessKey: "s", bucket: "codecast-replays" };
const ev = (n: number): ReplayEvent[] => Array.from({ length: n }, (_, i) => ({ type: "click" as const, t: i, label: `b${i}`, selector: "button" }));

describe("chunks", () => {
  test("split by the event cap, gzipped, each under the byte cap", () => {
    const chunks = chunkReplayEvents(ev(REPLAY_LIMITS.chunk_max_events + 10));
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(strFromU8(gunzipSync(chunks[1])))).toHaveLength(10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(REPLAY_LIMITS.chunk_max_bytes);
  });

  test("assembly reads gzipped and plain chunks, and skips missing, oversized and tampered ones", async () => {
    const a = gzipSync(strToU8(JSON.stringify(ev(2))));
    const b = strToU8(JSON.stringify({ events: [{ type: "error", t: 5, message: "Boom" }] }));
    const tampered = gzipSync(strToU8(JSON.stringify(ev(1))));
    const objects: Record<string, Uint8Array> = {
      [`replays/s/r/0000-${await sha256Hex(a)}.json.gz`]: a,
      [`replays/s/r/0001-${await sha256Hex(b)}.json.gz`]: b,
      [`replays/s/r/0002-${SHA("c")}.json.gz`]: tampered,
    };
    globalThis.fetch = (async (url: string) => {
      const path = decodeURIComponent(new URL(url).pathname).replace("/codecast-replays/", "");
      const body = objects[path];
      return body ? new Response(body) : new Response("no", { status: 404 });
    }) as any;
    const keys = [...Object.keys(objects), `replays/s/r/0003-${SHA("d")}.json.gz`];
    const { events, skipped } = await readReplayChunks(bucket, keys);
    expect(events.map((e) => e.type)).toEqual(["click", "click", "error"]);
    expect(skipped).toBe(2);
  });
});

describe("chunks this backend stored", () => {
  test("putChunk stores the gzip bytes as they are, unmarked, so a read hashes to the key", async () => {
    const sent: Array<{ method: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (_url: string, init: any = {}) => {
      sent.push({ method: init.method ?? "GET", headers: init.headers ?? {} });
      return init.method === "HEAD" ? new Response(null, { status: 404 }) : new Response("ok");
    }) as any;
    await putChunk(bucket, "replays/s/r/0000-x.json.gz", gzipSync(strToU8("[]")));
    const put = sent.find((r) => r.method === "PUT")!;
    expect(put.headers["Content-Encoding"]).toBeUndefined();
  });

  test("a vendor chunk stored marked gzip comes back inflated and is still read; an uploader's is held to its hash", async () => {
    const gz = gzipSync(strToU8(JSON.stringify(ev(3))));
    const key = `replays/s/r/0000-${await sha256Hex(gz)}.json.gz`;
    // What fetch hands back for an object stored with Content-Encoding gzip.
    globalThis.fetch = (async () => new Response(strToU8(JSON.stringify(ev(3))), { headers: { "content-encoding": "gzip" } })) as any;
    expect((await readReplayChunks(bucket, [key], { serverWritten: true })).events).toHaveLength(3);
    expect(await readReplayChunks(bucket, [key])).toEqual({ events: [], skipped: 1 });
  });
});

describe("untrusted chunk bytes", () => {
  test("a declared length past the cap is refused before the body is read", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
    const res = new Response(body, { headers: { "content-length": String(REPLAY_LIMITS.chunk_max_bytes + 1) } });
    expect(await readBodyCapped(res, REPLAY_LIMITS.chunk_max_bytes)).toBeNull();
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test("a body with no or a lying length stops at the cap while streaming", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { sent += 64 * 1024; c.enqueue(new Uint8Array(64 * 1024)); } });
    expect(await readBodyCapped(new Response(body), 1024 * 1024)).toBeNull();
    expect(sent).toBeLessThan(2 * 1024 * 1024);
    expect(await readBodyCapped(new Response(new Uint8Array(10)), 1024)).toHaveLength(10);
  });

  test("a gzip bomb inflates no further than the cap", () => {
    const bomb = gzipSync(new Uint8Array(REPLAY_CHUNK_MAX_INFLATED_BYTES * 4));
    expect(bomb.length).toBeLessThan(REPLAY_LIMITS.chunk_max_bytes);
    expect(gunzipCapped(bomb, REPLAY_CHUNK_MAX_INFLATED_BYTES)).toBeNull();
    const ok = gzipSync(strToU8(JSON.stringify(ev(100))));
    expect(JSON.parse(strFromU8(gunzipCapped(ok, REPLAY_CHUNK_MAX_INFLATED_BYTES)!))).toHaveLength(100);
    expect(gunzipCapped(strToU8("not gzip at all"), 1024)).toBeNull();
  });

  test("assembly skips a correctly addressed bomb", async () => {
    const bomb = gzipSync(strToU8("[" + " ".repeat(REPLAY_CHUNK_MAX_INFLATED_BYTES + 10) + "]"));
    const bombKey = `replays/s/r/0000-${await sha256Hex(bomb)}.json.gz`;
    globalThis.fetch = (async () => new Response(bomb)) as any;
    expect(await readReplayChunks(bucket, [bombKey])).toEqual({ events: [], skipped: 1 });
  });
});

describe("the sign route", () => {
  test("reads both path spellings", () => {
    expect(replaySignKey("/cli/ingest/replay-sign/cc_ing_x")).toBe("cc_ing_x");
    expect(replaySignKey("/api/ingest/cc_ing_x/replay-sign")).toBe("cc_ing_x");
    expect(replaySignKey("/cli/ingest/cc_ing_x")).toBeNull();
  });

  test("validates the chunk it is asked to sign", () => {
    const ok = { replay_id: "r1", seq: 0, sha256: SHA("a"), size: 100 };
    expect(validateReplaySign(ok)).toEqual({ ...ok, kind: "events" });
    expect(validateReplaySign({ ...ok, size: REPLAY_LIMITS.chunk_max_bytes + 1 })).toContain("at most");
    expect(validateReplaySign({ ...ok, sha256: "ABC" })).toContain("sha256");
    expect(validateReplaySign({ ...ok, seq: REPLAY_LIMITS.max_chunks_per_replay })).toContain("seq");
    expect(validateReplaySign(null)).toContain("object");
  });

  function httpCtx(w: ReturnType<typeof world>) {
    // runQuery/runMutation route to the real handlers over the same db.
    return {
      runQuery: async (fn: any, args: any) => {
        const name = getFunctionName(fn);
        if (name === "ingest:sourceForKey") return h((await import("./ingest")).sourceForKey)(w.internalCtx, args);
        throw new Error(`unexpected query ${name}`);
      },
      runMutation: async (fn: any, args: any) => {
        const name = getFunctionName(fn);
        if (name === "replays:recordChunk") return h((await import("./replays")).recordChunk)(w.internalCtx, args);
        if (name === "ipRateLimit:bump") return { ok: true };
        throw new Error(`unexpected mutation ${name}`);
      },
    };
  }
  const post = (body: unknown) => new Request("https://x/cli/ingest/replay-sign/k", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  test("signs a PUT for a new chunk, records its key, and skips one already uploaded", async () => {
    process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.REPLAYS_R2_ACCESS_KEY_ID = "rk";
    process.env.REPLAYS_R2_SECRET_ACCESS_KEY = "rs";
    const w = world();
    const { source, key: ingestKey } = await teamSource(w);
    let exists = false;
    globalThis.fetch = (async () => new Response(null, { status: exists ? 200 : 404 })) as any;
    const body = { replay_id: "r1", seq: 0, sha256: SHA("e"), size: 1000 };
    const res = await handleReplaySign(httpCtx(w), post(body), ingestKey);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.key).toBe(replayChunkKey({ sourceId: String(source._id), replay: "r1", seq: 0, sha256: SHA("e") }));
    expect(out.upload_url).toContain("X-Amz-Signature=");
    // The declared size is signed as the PUT's content-length, so the bucket refuses any other body size.
    expect(new URL(out.upload_url).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    expect(w.db._tables.replays[0].chunk_keys).toEqual([out.key]);
    exists = true;
    const again = await (await handleReplaySign(httpCtx(w), post(body), ingestKey)).json();
    expect(again).toEqual({ key: out.key, upload_url: null, exists: true });
  });

  test("a landed chunk is never replaced; a sequence whose upload never landed is re-signed", async () => {
    process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.REPLAYS_R2_ACCESS_KEY_ID = "rk";
    process.env.REPLAYS_R2_SECRET_ACCESS_KEY = "rs";
    const w = world();
    const { source, key: ingestKey } = await teamSource(w);
    const landed = new Set<string>();
    globalThis.fetch = (async (url: string) => new Response(null, { status: [...landed].some((k) => url.includes(k)) ? 200 : 404 })) as any;
    const sign = async (sha: string) => (await handleReplaySign(httpCtx(w), post({ replay_id: "r1", seq: 0, sha256: sha, size: 10 }), ingestKey)).json();
    const first = await sign(SHA("a"));
    expect(first.upload_url).toContain("X-Amz-Signature=");
    // The SDK's PUT failed, so it re-signs seq 0 with a grown batch: allowed, the new key replaces the unlanded one.
    const retry = await sign(SHA("b"));
    expect(retry.upload_url).toContain("X-Amz-Signature=");
    expect(w.db._tables.replays[0].chunk_keys).toEqual([retry.key]);
    landed.add(retry.key);
    // Once landed, other content for seq 0 gets the landed key back as already uploaded, and nothing changes.
    const forged = await sign(SHA("f"));
    expect(forged).toEqual({ key: retry.key, upload_url: null, exists: true });
    expect(w.db._tables.replays[0].chunk_keys).toEqual([retry.key]);
    // A retry with identical content still succeeds.
    expect(await sign(SHA("b"))).toEqual({ key: retry.key, upload_url: null, exists: true });
  });

  test("an unknown key is a 401, a bad body a 400, a paused source a retryable 503", async () => {
    process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.REPLAYS_R2_ACCESS_KEY_ID = "rk";
    process.env.REPLAYS_R2_SECRET_ACCESS_KEY = "rs";
    const w = world();
    const { source, key: ingestKey } = await teamSource(w);
    expect((await handleReplaySign(httpCtx(w), post({}), "cc_ing_" + "x".repeat(32))).status).toBe(401);
    expect((await handleReplaySign(httpCtx(w), post({ replay_id: "r1" }), ingestKey)).status).toBe(400);
    await w.db.patch(source._id, { status: "paused" });
    const paused = await handleReplaySign(httpCtx(w), post({}), ingestKey);
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("60");
    expect(classifyStatus(paused.status)).toBe("retry");
  });

  test("a failure inside the route answers a retryable 500 a browser can read, not a bare error", async () => {
    process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.REPLAYS_R2_ACCESS_KEY_ID = "rk";
    process.env.REPLAYS_R2_SECRET_ACCESS_KEY = "rs";
    const w = world();
    const { key: ingestKey } = await teamSource(w);
    const ok = httpCtx(w);
    const broken = { ...ok, runMutation: async (fn: any, args: any) => (getFunctionName(fn) === "replays:recordChunk" ? Promise.reject(new Error("boom")) : ok.runMutation(fn, args)) };
    const res = await handleReplaySign(broken, post({ replay_id: "r1", seq: 0, sha256: SHA("e"), size: 10 }), ingestKey);
    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("review fixes", () => {
  test("a source opens at most REPLAYS_NEW_PER_HOUR recordings an hour; known ones still take chunks", async () => {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < REPLAYS_NEW_PER_HOUR; i++) expect((await recordReplayChunk(w.internalCtx, source, `r${i}`, 0, key(source, 0), NOW)).ok).toBe(true);
    const over = await recordReplayChunk(w.internalCtx, source, "one-too-many", 0, key(source, 0), NOW);
    expect(over.ok).toBe(false);
    expect(w.db._tables.replays).toHaveLength(REPLAYS_NEW_PER_HOUR);
    expect((await recordReplayChunk(w.internalCtx, source, "r0", 1, key(source, 1), NOW)).ok).toBe(true);
    expect(await linkReplayToGroup(w.internalCtx, source, "another", "g1" as any, NOW)).toBeNull();
  });

  test("an assembly that missed a chunk still landing leaves the timeline stale, so the chunk's own manifest queues another", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), Date.now());
    const row = () => w.db._tables.replays[0];
    await h(saveSummary)(w.internalCtx, { replay_id: row()._id, chunk_keys: row().chunk_keys, timeline_md: "partial", counts: { clicks: 0, errors: 0, failed_requests: 0 }, duration_ms: 0, skipped: 1 });
    expect(row().timeline_at).toBeLessThan(row().chunks_at);
    expect(shouldQueueAssembly(row(), Date.now())).toBe(true);
    // Long after the sign the chunk is given up on: the timeline is current.
    await w.db.patch(row()._id, { chunks_at: Date.now() - CHUNK_LANDING_MS - 1 });
    await h(saveSummary)(w.internalCtx, { replay_id: row()._id, chunk_keys: row().chunk_keys, timeline_md: "final", counts: { clicks: 0, errors: 0, failed_requests: 0 }, duration_ms: 0, skipped: 1 });
    expect(shouldQueueAssembly(row(), Date.now())).toBe(false);
  });

  test("the list takes a source by name, src-N or id, and refuses one it does not know", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await recordReplayChunk(w.internalCtx, source, "s1", 0, key(source, 0), NOW);
    const scope = { workspace: "team", team_id: "team_1" };
    for (const ref of ["shop", source.short_id, String(source._id)]) {
      expect((await h(list)(w.as("u1"), { ...scope, source: ref })).map((r: any) => r.external_id)).toEqual(["s1"]);
    }
    await expect(h(list)(w.as("u1"), { ...scope, source: "nope" })).rejects.toThrow(/Source nope not found/);
  });
});

describe("cliGet", () => {
  test("refuses a bad token", async () => {
    const w = world();
    await expect(h(cliGet)(w.internalCtx, { api_token: "nope", replay: "rp-1" })).rejects.toThrow();
  });
});

describe("browse", () => {
  async function many(n: number, at: (i: number) => Record<string, unknown> = () => ({})) {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < n; i++) {
      await upsertReplayManifest(w.internalCtx, source, replayItem({ replay_id: `r${i}`, started_at: NOW - i * 60_000 }), NOW);
      // Through the writer every real write uses (lib/replayIndex.ts patchReplay): the index fields and the person tallies follow.
      await patchReplay(w.internalCtx, w.db._tables.replays[i], { started_at: NOW - i * 60_000, ...at(i) });
    }
    return { w, source };
  }
  const scope = { workspace: "team", team_id: "team_1" };

  test("a page of the newest, with the true total past it", async () => {
    const { w } = await many(30);
    const res = await h(browse)(w.as("u1"), { ...scope, limit: 10 });
    expect(res.rows).toHaveLength(10);
    expect(res.total).toBe(30);
    expect(res.capped).toBe(false);
    expect(res.rows[0].short_id).toBe("rp-1");
    expect(JSON.stringify(res)).not.toContain("replays/");
  });

  test("filters, search and sort run over every recording, not one page", async () => {
    const { w } = await many(40, (i) => ({
      duration_ms: i === 39 ? null : i * 1_000,
      counts: { clicks: i, errors: i % 10 === 0 ? 1 : 0, failed_requests: 0 },
      user: i < 3 ? { email: "ada@example.com" } : { id: `anon-${i}` },
      url: i === 35 ? "https://shop.example.com/refund" : "https://shop.example.com/",
    }));
    const errs = await h(browse)(w.as("u1"), { ...scope, has: ["errors"], limit: 2 });
    expect(errs.total).toBe(4);
    expect(errs.rows.map((r: any) => r.short_id)).toEqual(["rp-1", "rp-11"]);
    const found = await h(browse)(w.as("u1"), { ...scope, q: "REFUND", limit: 5 });
    expect(found.rows.map((r: any) => r.short_id)).toEqual(["rp-36"]);
    const longest = await h(browse)(w.as("u1"), { ...scope, sort: "longest", limit: 40 });
    expect(longest.rows[0].short_id).toBe("rp-39");
    expect(longest.rows[39].short_id).toBe("rp-40");
    const ada = await h(browse)(w.as("u1"), { ...scope, person: "ada@example.com", people: true, limit: 5 });
    expect(ada.total).toBe(3);
    expect(ada.people.map((p: any) => [p.key, p.sessions])).toEqual([["ada@example.com", 3]]);
    const recent = await h(browse)(w.as("u1"), { ...scope, since: NOW - 5 * 60_000 });
    expect(recent.total).toBe(6);
  });

  test("one person and the partly imported are read by their own index: exact, with when the oldest started", async () => {
    const { w } = await many(12, (i) => ({
      user: i % 3 === 0 ? { email: "Ada@Example.com" } : { id: `anon-${i}` },
      ...(i < 5 ? { captured_ms: 60_000, duration_ms: 3_600_000 } : { duration_ms: 60_000 }),
    }));
    const ada = await h(browse)(w.as("u1"), { ...scope, person: "ada@example.com" });
    expect([ada.total, ada.capped]).toEqual([4, false]);
    expect(ada.oldest_at).toBe(NOW - 9 * 60_000);
    const partial = await h(browse)(w.as("u1"), { ...scope, has: ["partial"] });
    expect(partial.rows.map((r: any) => r.short_id)).toEqual(["rp-1", "rp-2", "rp-3", "rp-4", "rp-5"]);
    // A row whose flag was never stamped is not in the cut index: the backfill is what puts it there.
    await w.db.patch(w.db._tables.replays[0]._id, { rest_cut: undefined });
    expect((await h(browse)(w.as("u1"), { ...scope, has: ["partial"] })).total).toBe(4);
  });

  test("an exact rp-N is read by its index: found past every other filter, counted exactly", async () => {
    const { w } = await many(8, (i) => ({ counts: { clicks: 0, errors: 0, failed_requests: 0 }, facts: { at: NOW, active_ms: i === 6 ? 1_000 : 60_000 } }));
    const res = await h(browse)(w.as("u1"), { ...scope, q: " RP-7 ", has: ["errors"], active_min_ms: 5_000, since: NOW - 60_000, limit: 5 });
    expect(res.rows.map((r: any) => r.short_id)).toEqual(["rp-7"]);
    expect(res.total).toBe(1);
    expect(res.capped).toBe(false);
    const none = await h(browse)(w.as("u1"), { ...scope, q: "rp-999" });
    expect([none.total, none.capped]).toEqual([0, false]);
  });

  test("the active-time floor says how many it leaves out; an issue-linked short one is kept and not counted", async () => {
    const { w } = await many(6, (i) => ({ facts: { at: NOW, active_ms: i < 3 ? 1_000 : 60_000 }, ...(i === 0 ? { group_ids: ["g1"] } : {}) }));
    const res = await h(browse)(w.as("u1"), { ...scope, active_min_ms: 5_000 });
    expect([res.total, res.below_active]).toEqual([4, 2]);
    const any = await h(browse)(w.as("u1"), { ...scope });
    expect([any.total, any.below_active]).toEqual([6, 0]);
  });

  test("people page, sort by failures, leave out the anonymous; rage says what it could not test", async () => {
    const { w } = await many(12, (i) => ({
      counts: { clicks: 0, errors: i === 5 ? 3 : 0, failed_requests: 0 },
      user: i < 2 ? { email: "ada@example.com" } : { id: `anon-${i}` },
      shape: i < 4 ? { v: 1, active_ms: 0, pages: 1, rage_clicks: i === 0 ? 1 : 0, strip: "0", marks: [] } : undefined,
    }));
    const all = await h(browse)(w.as("u1"), { ...scope, people: true, people_sort: "failures", people_limit: 3 });
    expect(all.people_total).toBe(11);
    expect(all.people).toHaveLength(3);
    expect(all.people[0].key).toBe("anon-5");
    expect(all.people_anonymous).toBe(10);
    const known = await h(browse)(w.as("u1"), { ...scope, people: true, identified: true });
    expect(known.people.map((p: any) => p.key)).toEqual(["ada@example.com"]);
    const rage = await h(browse)(w.as("u1"), { ...scope, has: ["rage"] });
    expect(rage.total).toBe(1);
    expect(rage.rage_unchecked).toBe(8);
  });

  test("the vendor's facts filter by environment, count the pickers' options, and answer rage for unread rows", async () => {
    const { w } = await many(6, (i) => ({
      facts: i < 5 ? { at: NOW, browser: i < 3 ? "Chrome" : "Safari", os: i === 0 ? "Windows" : "Mac OS X", country: "US", rage_clicks: i === 4 ? 2 : 0 } : undefined,
    }));
    const chrome = await h(browse)(w.as("u1"), { ...scope, browser: "Chrome" });
    expect(chrome.total).toBe(3);
    // A picker's options count what every other filter keeps, its own aside.
    expect(chrome.facets.browser).toEqual([["Chrome", 3], ["Safari", 2]]);
    expect(chrome.facets.os).toEqual([["Mac OS X", 2], ["Windows", 1]]);
    const rage = await h(browse)(w.as("u1"), { ...scope, has: ["rage"] });
    expect(rage.total).toBe(1);
    expect(rage.rage_unchecked).toBe(1);
  });

  test("an imported length runs to the end of its capture, never shorter than its events", () => {
    expect(withCaptureLength({ duration_ms: 0, first_t: 2_000 }, 302_000).duration_ms).toBe(300_000);
    expect(withCaptureLength({ duration_ms: 900_000, first_t: 0 }, 300_000).duration_ms).toBe(900_000);
    expect(withCaptureLength({ duration_ms: 5, first_t: 0 }, undefined).duration_ms).toBe(5);
  });

  test("someone outside the workspace browses nothing", async () => {
    const { w } = await many(3);
    const res = await h(browse)(w.as("u2"), { workspace: "personal" });
    expect(res.total).toBe(0);
  });

  test("the scan is bounded, and says so", () => {
    expect(REPLAY_BROWSE_SCAN_MAX).toBeGreaterThanOrEqual(1000);
  });

  test("a shape lands once, only on the chunks it was read from", async () => {
    const { w, source } = await many(1);
    const row = w.db._tables.replays[0];
    await recordReplayChunk(w.internalCtx, source, "r0", 0, key(source, 0), NOW);
    const shape = { v: 1, active_ms: 5, pages: 1, rage_clicks: 0, strip: "9", marks: [] };
    await h(saveShape)(w.internalCtx, { replay_id: row._id, chunk_keys: ["stale"], shape });
    expect(w.db._tables.replays[0].shape).toBeUndefined();
    await h(saveShape)(w.internalCtx, { replay_id: row._id, chunk_keys: w.db._tables.replays[0].chunk_keys, shape });
    expect(w.db._tables.replays[0].shape).toEqual(shape);
    const res = await h(browse)(w.as("u1"), scope);
    expect(res.rows[0].shape).toEqual(shape);
  });
});

describe("a recording as a moment", () => {
  const assemble = (w: ReturnType<typeof world>, row: any, over: Record<string, unknown> = {}) =>
    h(saveSummary)(w.internalCtx, { replay_id: row._id, chunk_keys: row.chunk_keys, timeline_md: "t", counts: { clicks: 5, errors: 0, failed_requests: 0 }, duration_ms: 60_000, ...over });

  test("a complete assembly opens a replay moment once the source publishes a replay extractor", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), NOW);
    const row = () => w.db._tables.replays[0];
    await assemble(w, row());
    expect(w.db._tables.moments ?? []).toHaveLength(0);
    await w.db.insert("moment_extractors", { source_id: source._id, kind: "replay", quiet_ms: 1_800_000 });
    await assemble(w, row());
    await assemble(w, row());
    const moments = w.db._tables.moments;
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ kind: "replay", subject: row().short_id, status: "waiting", events: 2 });
  });

  test("a recording nobody worked in opens nothing", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await w.db.insert("moment_extractors", { source_id: source._id, kind: "replay", quiet_ms: 1_800_000 });
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), NOW);
    await assemble(w, w.db._tables.replays[0], { counts: { clicks: 1, errors: 1, failed_requests: 0 } });
    await assemble(w, w.db._tables.replays[0], { duration_ms: 8_000 });
    expect(w.db._tables.moments ?? []).toHaveLength(0);
  });

  test("an assembly still waiting on a chunk opens nothing", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await w.db.insert("moment_extractors", { source_id: source._id, kind: "replay", quiet_ms: 1_800_000 });
    await recordReplayChunk(w.internalCtx, source, "r1", 0, key(source, 0), Date.now());
    await assemble(w, w.db._tables.replays[0], { skipped: 1 });
    expect(w.db._tables.moments ?? []).toHaveLength(0);
  });
});
