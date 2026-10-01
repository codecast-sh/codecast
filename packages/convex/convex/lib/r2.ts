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
