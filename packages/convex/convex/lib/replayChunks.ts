// Replay chunks in R2 (replays.ts): reading a recording's gzipped event
// chunks back with their limits held, packing a stream or a DOM capture into
// content addressed chunks and storing them, and signing chunk URLs for the
// routes. Pure helpers over the bucket; the rows stay in replays.ts.
import { Gunzip, gzipSync, strToU8, strFromU8 } from "fflate";
import { sha256Hex } from "./hash";
import { readBodyCapped } from "./tokenHttp";
import { parseReplayChunkKey, r2FreshGetUrl, r2Presign, replayDomChunkKey, replaysBucketFromEnv, safeReplayPathSegment, type R2Bucket } from "./r2";
import { REPLAY_LIMITS, type ReplayEvent } from "@codecast/shared/contracts/replay";
import { foldRepeatNavs, parseReplayEvents, sortReplayEvents, type RrwebEvent } from "@codecast/shared/replay";
import { REPLAY_DOM_LIMITS, type ReplayDomChunkMeta, type ReplayPlayerManifest } from "@codecast/shared/contracts/replayPlayer";

/**
 * The most a chunk may expand to when gunzipped. A real chunk is at most
 * chunk_max_events events, about 1 MB of JSON; the cap leaves room for that
 * while keeping the decoded string well inside an action's memory.
 */
export const REPLAY_CHUNK_MAX_INFLATED_BYTES = 8 * 1024 * 1024;

/** The chunk spans a row keeps, when they still match its keys one for one; else null (the player then reads the capture whole). */
export function domChunkMeta(row: { dom_chunk_keys?: string[]; dom_chunk_meta?: ReplayDomChunkMeta[] }): ReplayDomChunkMeta[] | null {
  const keys = row.dom_chunk_keys ?? [];
  return keys.length > 0 && row.dom_chunk_meta?.length === keys.length ? row.dom_chunk_meta : null;
}

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}


/** Input fed to the inflater per step. Deflate expands at most ~1032x, so one step yields about 1 MB at worst. */
const GUNZIP_STEP_BYTES = 1024;

/**
 * Gunzip that gives up past `max` output bytes (null), so a small gzip bomb
 * cannot exhaust the action's memory. The ISIZE trailer is not trusted: it
 * is written by the uploader and wraps at 4 GB.
 */
export function gunzipCapped(bytes: Uint8Array, max: number): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let total = 0;
  let over = false;
  const inflater = new Gunzip((chunk) => {
    if (over) return;
    total += chunk.length;
    if (total > max) {
      over = true;
      return;
    }
    parts.push(chunk);
  });
  try {
    for (let i = 0; i < bytes.length && !over; i += GUNZIP_STEP_BYTES) {
      inflater.push(bytes.subarray(i, i + GUNZIP_STEP_BYTES), i + GUNZIP_STEP_BYTES >= bytes.length);
    }
  } catch {
    return null;
  }
  return over ? null : concatBytes(parts, total);
}

/**
 * Every event in a recording's chunks, in time order. A chunk that is
 * missing (an upload that never finished), oversized, inflates past the cap,
 * or does not hash to the sha its key names is skipped and counted: the
 * presigned PUT cannot enforce any of that, so this is where the limits and
 * content addressing are held to.
 *
 * `serverWritten` is for a recording this backend stored itself (a vendor
 * import): chunks put before putChunk stopped marking them gzip come back
 * inflated by fetch, so their bytes cannot hash to the key, and plain JSON is
 * taken as is. An uploader's chunk is always held to its hash.
 */
export async function readReplayChunks(bucket: R2Bucket, keys: readonly string[], opts: { serverWritten?: boolean } = {}): Promise<{ events: ReplayEvent[]; skipped: number }> {
  const events: ReplayEvent[] = [];
  let skipped = 0;
  for (const key of keys) {
    const res = await fetch(await r2Presign(bucket, "GET", key, REPLAY_LIMITS.signed_url_ttl_s));
    const bytes = res.ok ? await readBodyCapped(res, REPLAY_LIMITS.chunk_max_bytes) : null;
    if (!res.ok) await res.body?.cancel().catch(() => {});
    const want = parseReplayChunkKey(key)?.sha256;
    const inflatedByFetch = !!bytes && opts.serverWritten === true && !isGzip(bytes);
    if (!bytes || (want && !inflatedByFetch && (await sha256Hex(bytes)) !== want)) {
      skipped++;
      continue;
    }
    const json = isGzip(bytes) ? gunzipCapped(bytes, REPLAY_CHUNK_MAX_INFLATED_BYTES) : bytes;
    if (!json) {
      skipped++;
      continue;
    }
    try {
      events.push(...parseReplayEvents(JSON.parse(strFromU8(json))));
    } catch {
      skipped++;
    }
  }
  return { events: foldRepeatNavs(sortReplayEvents(events)), skipped };
}

/** The newest rrweb timestamp in one stored DOM chunk, or null when it cannot be read. */
export async function lastCaptureTimestamp(bucket: R2Bucket, key: string): Promise<number | null> {
  const span = await readDomChunkSpan(bucket, key);
  return span && span.last > 0 ? span.last : null;
}

/** One stored DOM chunk's rrweb events and JSON size, read back from R2; null when it cannot be read. */
export async function readDomChunkEvents(bucket: R2Bucket, key: string): Promise<{ events: any[]; raw: number } | null> {
  const res = await fetch(await r2Presign(bucket, "GET", key, REPLAY_LIMITS.signed_url_ttl_s));
  const bytes = res.ok ? await readBodyCapped(res, REPLAY_DOM_LIMITS.chunk_max_bytes) : null;
  if (!res.ok) await res.body?.cancel().catch(() => {});
  if (!bytes) return null;
  const json = isGzip(bytes) ? gunzipCapped(bytes, REPLAY_DOM_LIMITS.chunk_max_inflated_bytes) : bytes;
  if (!json) return null;
  try {
    const events = JSON.parse(strFromU8(json));
    return { events: Array.isArray(events) ? events : [], raw: json.length };
  } catch {
    return null;
  }
}

/** One stored DOM chunk's span (spanOf), read back from R2; null when it cannot be read. */
export async function readDomChunkSpan(bucket: R2Bucket, key: string): Promise<ReplayDomChunkMeta | null> {
  const chunk = await readDomChunkEvents(bucket, key);
  if (!chunk) return null;
  const marks = chunk.events.map((e: any) => ({ t: typeof e?.timestamp === "number" ? e.timestamp : NaN, full: e?.type === 2 }));
  return spanOf(marks, chunk.raw);
}

/** Split a stream into chunks of at most chunk_max_events events and chunk_max_bytes gzipped. */
export function chunkReplayEvents(events: readonly ReplayEvent[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  const pack = (slice: readonly ReplayEvent[]) => {
    const gz = gzipSync(strToU8(JSON.stringify(slice)));
    if (gz.length <= REPLAY_LIMITS.chunk_max_bytes || slice.length <= 1) {
      if (gz.length <= REPLAY_LIMITS.chunk_max_bytes) out.push(gz);
      return;
    }
    const half = Math.ceil(slice.length / 2);
    pack(slice.slice(0, half));
    pack(slice.slice(half));
  };
  for (let i = 0; i < events.length; i += REPLAY_LIMITS.chunk_max_events) pack(events.slice(i, i + REPLAY_LIMITS.chunk_max_events));
  return out.slice(0, REPLAY_LIMITS.max_chunks_per_replay);
}

/** PUT one chunk unless an object with its key (and so its content) is already there. Moment bodies use it too (moments.ts). */
export async function putChunk(bucket: R2Bucket, key: string, body: Uint8Array): Promise<void> {
  const head = await fetch(await r2Presign(bucket, "HEAD", key, REPLAY_LIMITS.signed_url_ttl_s), { method: "HEAD" });
  if (head.ok) return;
  const res = await fetch(await r2Presign(bucket, "PUT", key, REPLAY_LIMITS.signed_url_ttl_s), {
    method: "PUT",
    body: body as unknown as BodyInit,
    // No Content-Encoding, as the SDK uploads (platform analytics replay.ts):
    // the object is these exact bytes and its key names their sha256. Marked
    // gzip, every fetch hands it back inflated and the hash no longer matches.
    // Every reader unzips gzip bytes itself.
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`R2 put of ${key} answered ${res.status}`);
}

/**
 * A DOM capture as gzipped chunks, produced one at a time: events packed
 * until their JSON passes chunk_target_raw_bytes, each event serialized once.
 * A chunk that gzips past chunk_max_bytes is halved; a single event past it
 * (a page too heavy to keep) comes out as "dropped". The import runs in the
 * default runtime's 64 MiB beside the parsed recording, so a caller that
 * uploads each chunk as it comes holds one chunk's text and bytes at a time.
 */
export function* domChunkStream(events: readonly RrwebEvent[]): Generator<{ gz: Uint8Array; meta: ReplayDomChunkMeta } | "dropped"> {
  type Part = { json: string; t: number; full: boolean };
  function* pack(parts: Part[]): Generator<{ gz: Uint8Array; meta: ReplayDomChunkMeta } | "dropped"> {
    if (!parts.length) return;
    const text = `[${parts.map((p) => p.json).join(",")}]`;
    const gz = gzipSync(strToU8(text));
    if (gz.length <= REPLAY_DOM_LIMITS.chunk_max_bytes) {
      yield { gz, meta: spanOf(parts, text.length) };
      return;
    }
    if (parts.length === 1) {
      yield "dropped";
      return;
    }
    const half = Math.ceil(parts.length / 2);
    yield* pack(parts.slice(0, half));
    yield* pack(parts.slice(half));
  }
  let parts: Part[] = [];
  let raw = 0;
  for (const event of events) {
    const json = JSON.stringify(event);
    parts.push({ json, t: typeof event.timestamp === "number" ? event.timestamp : 0, full: event.type === 2 });
    raw += json.length + 1;
    if (raw >= REPLAY_DOM_LIMITS.chunk_target_raw_bytes) {
      yield* pack(parts);
      parts = [];
      raw = 0;
    }
  }
  yield* pack(parts);
}

/** One chunk's span: its first and last timestamps, its first full snapshot's, and its JSON size. */
export function spanOf(events: readonly { t: number; full: boolean }[], raw: number): ReplayDomChunkMeta {
  let first = Infinity;
  let last = -Infinity;
  let full: number | undefined;
  for (const e of events) {
    if (!Number.isFinite(e.t) || e.t <= 0) continue;
    if (e.t < first) first = e.t;
    if (e.t > last) last = e.t;
    if (e.full && (full === undefined || e.t < full)) full = e.t;
  }
  if (first === Infinity) first = last = 0;
  return { first, last, ...(full !== undefined ? { full } : {}), raw };
}

/** Every chunk of a capture at once (domChunkStream), held to max_chunks_per_replay; chunks past it count as dropped. */
export function chunkDomEvents(events: readonly RrwebEvent[]): { chunks: Uint8Array[]; dropped: number } {
  const chunks: Uint8Array[] = [];
  let dropped = 0;
  for (const c of domChunkStream(events)) {
    if (c === "dropped" || chunks.length >= REPLAY_DOM_LIMITS.max_chunks_per_replay) dropped++;
    else chunks.push(c.gz);
  }
  return { chunks, dropped };
}

/**
 * Store a recording's DOM capture (already masked, prepareDomCapture) beside
 * its stream: content addressed under the recording's `dom/` prefix, so a
 * re-import uploads only what changed. Each chunk is uploaded as it is
 * packed, and packing stops at max_chunks_per_replay (the rest of a capture
 * that long is not kept). Answers what saveImported records.
 */
export async function storeReplayDom(
  bucket: R2Bucket,
  /** first_seq: where a later part of a long recording continues the numbering (sources/replayRest.ts). */
  input: { source_id: string; external_id: string; events: readonly RrwebEvent[]; first_seq?: number },
): Promise<{ dom_chunk_keys: string[]; dom_chunk_meta: ReplayDomChunkMeta[]; dom_bytes: number; dom_t0: number; dropped: number }> {
  const replay = safeReplayPathSegment(input.external_id);
  const first = input.first_seq ?? 0;
  const keys: string[] = [];
  const meta: ReplayDomChunkMeta[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const chunk of domChunkStream(input.events)) {
    if (chunk === "dropped") {
      dropped++;
      continue;
    }
    if (first + keys.length >= REPLAY_DOM_LIMITS.max_chunks_per_replay) {
      dropped++;
      break;
    }
    const key = replayDomChunkKey({ sourceId: input.source_id, replay, seq: first + keys.length, sha256: await sha256Hex(chunk.gz) });
    await putChunk(bucket, key, chunk.gz);
    keys.push(key);
    meta.push(chunk.meta);
    bytes += chunk.gz.length;
  }
  return { dom_chunk_keys: keys, dom_chunk_meta: meta, dom_bytes: bytes, dom_t0: input.events[0]?.timestamp ?? 0, dropped };
}

/** The route's answer: chunk URLs signed now and short, keys removed. */
export async function signReplayChunks<T extends { chunk_keys: string[] }>(res: T, now: number = Date.now()) {
  const bucket = replaysBucketFromEnv();
  const { chunk_keys, ...rest } = res;
  const chunk_urls: string[] = [];
  if (bucket) for (const key of chunk_keys) chunk_urls.push((await r2FreshGetUrl(bucket, key, now)).url);
  return { ...rest, chunk_urls, server_now: now };
}

/** The manifest the player reads, with the DOM keys swapped for URLs signed now. */
export async function signPlayerManifest(
  row: { dom_chunk_keys: string[]; replay: ReplayPlayerManifest["replay"]; t0: number },
  expiresAt: number,
  bucket: R2Bucket,
  now: number = Date.now(),
): Promise<ReplayPlayerManifest> {
  const dom_urls: string[] = [];
  for (const key of row.dom_chunk_keys) dom_urls.push((await r2FreshGetUrl(bucket, key, now)).url);
  return { replay: row.replay, t0: row.t0, dom_urls, expires_at: expiresAt };
}

