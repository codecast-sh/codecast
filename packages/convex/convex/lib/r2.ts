// Cloudflare R2 buckets this deployment writes to, and presigned URLs into
// them. R2 speaks S3 with region "auto", so signing is the shared SigV4
// presigner (awsSigV4.presignUrl); this module only knows which bucket is
// which and how a URL into it is minted.
//
// Two buckets, kept apart on purpose:
//   media            codecast-media, behind the public media.codecast.sh
//                    domain: published pages' video, addressed by content hash
//                    so a URL is only known to someone who has the page.
//   call recordings  codecast-call-recordings, with no public domain at all.
//                    A huddle's video is read only through a short-lived URL
//                    minted after the same access check the call page runs,
//                    and its credentials can touch nothing else.
//
// Retention differs on purpose. Replays are working material and expire by a
// bucket lifecycle rule. Call recordings get none: a recording is the meeting
// kept, and an age based rule would take a call away from the people it
// belongs to without anyone choosing that. A recording leaves the bucket when
// a person deletes its run (the presser or a team admin), or when its team is
// deleted (callRecordings.purgeTeamRecordings, TEAM_RECORDINGS_PURGE_GRACE_MS
// after the delete, so an operator's restoreTeam inside it stays whole). Account deletion leaves recordings
// alone for the same reason it leaves the call records: a call belongs to
// its team, not to whoever was in it.

import { fnv1a32, type CallRecordingKind } from "@codecast/shared/contracts";
import { presignUrl } from "./awsSigV4";

export type R2Bucket = {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

/** codecast-media, or null when media hosting is not configured. */
export function mediaBucketFromEnv(): (R2Bucket & { publicBase: string }) | null {
  const endpoint = process.env.R2_ENDPOINT, accessKeyId = process.env.R2_ACCESS_KEY_ID, secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, accessKeyId, secretAccessKey, bucket: process.env.R2_BUCKET || "codecast-media", publicBase: (process.env.MEDIA_PUBLIC_BASE || "https://media.codecast.sh").replace(/\/$/, "") };
}

/** The private call recordings bucket, or null when recording is not
 *  configured. Shares the account endpoint with media and nothing else: its
 *  own token, scoped to this bucket alone. */
export function callRecordingsBucketFromEnv(): R2Bucket | null {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.CALL_REC_R2_BUCKET;
  const accessKeyId = process.env.CALL_REC_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CALL_REC_R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, accessKeyId, secretAccessKey, bucket };
}

/** The private session replays bucket (codecast-replays, external-data.md
 *  X5), or null when replays are not configured. Like call recordings: the
 *  account endpoint, and a token scoped to this bucket alone. A lifecycle
 *  rule on the bucket expires every object after 30 days. */
export function replaysBucketFromEnv(): R2Bucket | null {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.REPLAYS_R2_BUCKET || "codecast-replays";
  const accessKeyId = process.env.REPLAYS_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.REPLAYS_R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, accessKeyId, secretAccessKey, bucket };
}

/** Where every replay chunk lives in its bucket. */
export const REPLAYS_ROOT = "replays/";

/** One chunk's key: content addressed under its source and recording, the
 *  sequence number zero padded so a recording's chunks list in order.
 *  `replay` is the source's own replay id, already reduced to safe path
 *  characters by safeReplayPathSegment. */
export function replayChunkKey(opts: { sourceId: string; replay: string; seq: number; sha256: string }): string {
  return `${REPLAYS_ROOT}${opts.sourceId}/${opts.replay}/${String(opts.seq).padStart(4, "0")}-${opts.sha256}.json.gz`;
}

/** A source's replay id as one path segment: anything outside [A-Za-z0-9_-]
 *  becomes "_", so an id can never climb out of its source's prefix. When
 *  that (or the length cap) changed the id, "~" and a hash of the raw id
 *  follow, so "a/b" and "a_b" stay two recordings; "~" never survives the
 *  replacement, so a suffixed segment cannot equal an untouched one. */
export function safeReplayPathSegment(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  if (safe === id && safe) return safe;
  return `${safe || "_"}~${fnv1a32(id).toString(16).padStart(8, "0")}`;
}

/** The sequence number and sha256 a chunk key names, or null for a key outside the layout. */
export function parseReplayChunkKey(key: string): { seq: number; sha256: string } | null {
  const m = key.match(/^replays\/[^/]+\/[^/]+\/(\d{4,})-([0-9a-f]{64})\.json\.gz$/);
  return m ? { seq: Number(m[1]), sha256: m[2] } : null;
}

/** A presigned URL for one request on one object, or on the bucket itself
 *  when `key` is empty (a listing), with any query `params` signed in. */
export function r2Presign(
  b: R2Bucket,
  method: "GET" | "HEAD" | "PUT" | "DELETE",
  key: string,
  expiresSeconds: number,
  now?: Date,
  params?: Record<string, string>,
  /** Headers the request must carry as signed (awsSigV4.presignUrl). */
  headers?: Record<string, string>,
): Promise<string> {
  const object = key.replace(/^\/+/, "");
  return presignUrl({
    method,
    endpoint: b.endpoint,
    path: object ? `/${b.bucket}/${object}` : `/${b.bucket}`,
    region: "auto",
    service: "s3",
    accessKeyId: b.accessKeyId,
    secretAccessKey: b.secretAccessKey,
    expiresSeconds,
    now,
    ...(params ? { params } : {}),
    ...(headers ? { headers } : {}),
  });
}

// A presigned URL is a function of the moment it was signed, so a query that
// signed with Date.now() would hand back a new URL on every run and re-push
// every subscriber each time anything else on the page changed (and the
// browser would refetch a video it already has, since the URL is its cache
// key). So reads sign at the start of a fixed window instead: every run inside
// one window produces the same bytes. A URL is good for two windows, so one
// handed out at the very end of its window still has a full window to live.
//
// That is also how late a revocation lands: a URL is a bearer link, the same
// for every reader in its window, so somebody removed from the team (or a
// share link turned off) can keep using one they already hold for up to two
// windows. Readers that do not need a stable URL (the CLI's frame grab, a
// share page's video redirect) sign fresh and short instead: r2FreshGetUrl.
// The window is the caller's (call recordings sign on the shared
// CALL_RECORDING_URL_WINDOW_MS, the one their pages refresh on), so the two
// never drift apart.

/** The signing moment and lifetime for a URL that stays byte-identical
 *  within `windowMs`, and lives at least `windowMs` after any use of it. */
export function stableSigningWindow(nowMs: number, windowMs: number): { signedAt: Date; expiresSeconds: number; expiresAt: number } {
  const start = Math.floor(nowMs / windowMs) * windowMs;
  return { signedAt: new Date(start), expiresSeconds: Math.round((2 * windowMs) / 1000), expiresAt: start + 2 * windowMs };
}

/** A GET URL for a private object, stable within its window. `expiresAt` is
 *  when it stops working, for clients that must refresh before then. */
export async function r2StableGetUrl(b: R2Bucket, key: string, nowMs: number, windowMs: number): Promise<{ url: string; expiresAt: number }> {
  const w = stableSigningWindow(nowMs, windowMs);
  return { url: await r2Presign(b, "GET", key, w.expiresSeconds, w.signedAt), expiresAt: w.expiresAt };
}

/** A GET URL signed now, for a reader that uses it at once and never needs
 *  the same bytes twice: one ffmpeg seek, one redirect. Short, so it is
 *  useless soon after the access check that minted it. */
export const FRESH_URL_SECONDS = 10 * 60;
export async function r2FreshGetUrl(b: R2Bucket, key: string, nowMs: number = Date.now()): Promise<{ url: string; expiresAt: number }> {
  return { url: await r2Presign(b, "GET", key, FRESH_URL_SECONDS, new Date(nowMs)), expiresAt: nowMs + FRESH_URL_SECONDS * 1000 };
}

/** Every key under `prefix` (S3 ListObjectsV2, followed page by page). A
 *  list is a GET on the bucket, which the recordings token's object read
 *  covers. Throws on a refused or unreadable answer: a caller deleting by
 *  prefix must know it did not see everything. */
export async function r2ListKeys(b: R2Bucket, prefix: string, maxKeys = 10_000): Promise<string[]> {
  return (await r2ListObjects(b, prefix, maxKeys)).map((o) => o.key);
}

/** r2ListKeys with each object's last write (ms; NaN when the listing did
 *  not say), for a sweep that must leave alone what was written moments ago. */
export async function r2ListObjects(b: R2Bucket, prefix: string, maxKeys = 10_000): Promise<Array<{ key: string; lastModified: number }>> {
  const keys: Array<{ key: string; lastModified: number }> = [];
  let token: string | null = null;
  do {
    const params: Record<string, string> = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
    const url = await r2Presign(b, "GET", "", 300, undefined, params);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`R2 list of ${prefix} answered ${res.status}`);
    const xml = await res.text();
    for (const c of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = c[1].match(/<Key>([^<]*)<\/Key>/);
      const modified = c[1].match(/<LastModified>([^<]*)<\/LastModified>/);
      if (key) keys.push({ key: xmlText(key[1]), lastModified: modified ? Date.parse(modified[1]) : NaN });
    }
    const next = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/) : null;
    token = next ? xmlText(next[1]) : null;
  } while (token && keys.length < maxKeys);
  return keys;
}

const xmlText = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Where one run of a call's recording lives: every file of one press, and
 *  anything LiveKit wrote for it, sits under this prefix. Deleting a run
 *  deletes the prefix, so nothing written under a name nobody recorded (a
 *  late upload, a partial file, a live frame) outlives it. The trailing dash
 *  keeps one press's prefix from matching another's longer timestamp. */
export function callRecordingRunPrefix(opts: { transcriptId: string; requestedAt: number }): string {
  return `${callRecordingCallPrefix(opts.transcriptId)}${opts.requestedAt}-`;
}

/** Where every call recording lives in its bucket: what tells an egress
 *  writing a call's files from anything else the LiveKit project runs. */
export const CALL_RECORDINGS_ROOT = "calls/";

/** How long a deleted team's recordings wait before they leave the bucket.
 *  deleteTeam is a tombstone an operator can lift (teams.restoreTeam); a
 *  restore inside this window brings the team back with its meetings, and
 *  after it the video is gone for good. Here rather than beside the sweep so
 *  teams.ts can schedule it without importing the recording module. */
export const TEAM_RECORDINGS_PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Everything a call ever wrote to the bucket: every run's files and live
 *  frames, and the manifests LiveKit leaves beside them. Removing a whole
 *  call (its team deleted) deletes this prefix. The trailing slash keeps one
 *  call's prefix from matching a longer id. */
export function callRecordingCallPrefix(transcriptId: string): string {
  return `${CALL_RECORDINGS_ROOT}${transcriptId}/`;
}

/** The run prefix a file's key sits under, or null for a key outside the
 *  layout (never guessed: a prefix too short would delete other runs). */
export function callRecordingRunPrefixOfKey(key: string): string | null {
  const m = key.match(/^calls\/[^/]+\/\d+-/);
  return m ? m[0] : null;
}

/** The manifest LiveKit writes beside every file an egress uploads: a JSON
 *  of the room, its participants and the file, named by the egress, in the
 *  file's own folder (`calls/<call>/EG_x.json`). It sits outside the run
 *  prefix, so a run's delete names it explicitly; null for a key outside the
 *  layout or a row LiveKit never gave an id. */
export function callRecordingManifestKey(fileKey: string, egressId: string | null | undefined): string | null {
  if (!egressId || !/^EG_[A-Za-z0-9]+$/.test(egressId)) return null;
  const m = fileKey.match(/^calls\/[^/]+\//);
  return m ? `${m[0]}${egressId}.json` : null;
}

/** One file of a run: its call, its kind, the press that started the run,
 *  and for a screen file the shared track it records. */
export type CallRecordingFileRef = { transcriptId: string; kind: CallRecordingKind; requestedAt: number; trackSid?: string };

/** Where a call recording's file goes in the recordings bucket: under its
 *  call, named by the press that started its run so a call's files list in
 *  run order and a run's files sit together. Both kinds are MP4: a screen is
 *  transcoded to H.264 at its own size (callRecordingRuns.screenEncoding says
 *  why), never copied as published. The row's r2_key is still rewritten to
 *  the name LiveKit reports, which is the one source of truth. */
export function callRecordingKey(opts: CallRecordingFileRef): string {
  return `${callRecordingFileStem(opts)}.mp4`;
}

/** The live frame of a file while it records: one JPEG LiveKit overwrites
 *  every few seconds (callRecordingRuns.LIVE_FRAME_INTERVAL_S), beside the
 *  file and under the same run prefix. It is what "the screen right now"
 *  reads, since the MP4 only reaches the bucket when its egress ends. LiveKit
 *  adds the `.jpeg` to the prefix it is given. */
export function callRecordingLiveFramePrefix(opts: CallRecordingFileRef): string {
  return `${callRecordingFileStem(opts)}-live`;
}
export const liveFrameKey = (prefix: string) => `${prefix}.jpeg`;

function callRecordingFileStem(opts: CallRecordingFileRef): string {
  const base = callRecordingRunPrefix(opts);
  if (opts.kind === "composite") return `${base}composite`;
  return `${base}screen-${(opts.trackSid ?? "track").replace(/[^A-Za-z0-9_-]/g, "")}`;
}
