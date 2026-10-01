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

import type { CallRecordingKind } from "@codecast/shared/contracts";
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

/** A presigned URL for one request on one object. */
export function r2Presign(
  b: R2Bucket,
  method: "GET" | "HEAD" | "PUT" | "DELETE",
  key: string,
  expiresSeconds: number,
  now?: Date,
): Promise<string> {
  return presignUrl({
    method,
    endpoint: b.endpoint,
    path: `/${b.bucket}/${key.replace(/^\/+/, "")}`,
    region: "auto",
    service: "s3",
    accessKeyId: b.accessKeyId,
    secretAccessKey: b.secretAccessKey,
    expiresSeconds,
    now,
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
export const STABLE_URL_WINDOW_MS = 15 * 60 * 1000;

/** The signing moment and lifetime for a URL that stays byte-identical
 *  within `windowMs`, and lives at least `windowMs` after any use of it. */
export function stableSigningWindow(nowMs: number, windowMs = STABLE_URL_WINDOW_MS): { signedAt: Date; expiresSeconds: number; expiresAt: number } {
  const start = Math.floor(nowMs / windowMs) * windowMs;
  return { signedAt: new Date(start), expiresSeconds: Math.round((2 * windowMs) / 1000), expiresAt: start + 2 * windowMs };
}

/** A GET URL for a private object, stable within its window. `expiresAt` is
 *  when it stops working, for clients that must refresh before then. */
export async function r2StableGetUrl(b: R2Bucket, key: string, nowMs: number, windowMs = STABLE_URL_WINDOW_MS): Promise<{ url: string; expiresAt: number }> {
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
  const keys: string[] = [];
  let token: string | null = null;
  do {
    const params: Record<string, string> = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
    const url = await presignUrl({
      method: "GET",
      endpoint: b.endpoint,
      path: `/${b.bucket}`,
      region: "auto",
      service: "s3",
      accessKeyId: b.accessKeyId,
      secretAccessKey: b.secretAccessKey,
      expiresSeconds: 300,
      params,
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`R2 list of ${prefix} answered ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(xmlText(m[1]));
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
  return `${CALL_RECORDINGS_ROOT}${opts.transcriptId}/${opts.requestedAt}-`;
}

/** Where every call recording lives in its bucket: what tells an egress
 *  writing a call's files from anything else the LiveKit project runs. */
export const CALL_RECORDINGS_ROOT = "calls/";

/** The run prefix a file's key sits under, or null for a key outside the
 *  layout (never guessed: a prefix too short would delete other runs). */
export function callRecordingRunPrefixOfKey(key: string): string | null {
  const m = key.match(/^calls\/[^/]+\/\d+-/);
  return m ? m[0] : null;
}

/** Where a call recording's file goes in the recordings bucket: under its
 *  call, named by the press that started its run so a call's files list in
 *  run order and a run's files sit together. Both kinds are MP4: a screen is
 *  transcoded to H.264 at its own size (callRecordingRuns.screenEncoding says
 *  why), never copied as published. The row's r2_key is still rewritten to
 *  the name LiveKit reports, which is the one source of truth. */
export function callRecordingKey(opts: { transcriptId: string; kind: CallRecordingKind; requestedAt: number; trackSid?: string }): string {
  return `${callRecordingFileStem(opts)}.mp4`;
}

/** The live frame of a file while it records: one JPEG LiveKit overwrites
 *  every few seconds (callRecordingRuns.LIVE_FRAME_INTERVAL_S), beside the
 *  file and under the same run prefix. It is what "the screen right now"
 *  reads, since the MP4 only reaches the bucket when its egress ends. LiveKit
 *  adds the `.jpeg` to the prefix it is given. */
export function callRecordingLiveFramePrefix(opts: { transcriptId: string; kind: CallRecordingKind; requestedAt: number; trackSid?: string }): string {
  return `${callRecordingFileStem(opts)}-live`;
}
export const liveFrameKey = (prefix: string) => `${prefix}.jpeg`;

function callRecordingFileStem(opts: { transcriptId: string; kind: CallRecordingKind; requestedAt: number; trackSid?: string }): string {
  const base = callRecordingRunPrefix(opts);
  if (opts.kind === "composite") return `${base}composite`;
  return `${base}screen-${(opts.trackSid ?? "track").replace(/[^A-Za-z0-9_-]/g, "")}`;
}
