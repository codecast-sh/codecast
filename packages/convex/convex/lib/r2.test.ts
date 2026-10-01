import { afterEach, describe, expect, test } from "bun:test";
import { callRecordingsBucketFromEnv, mediaBucketFromEnv, r2Presign, r2StableGetUrl, stableSigningWindow, STABLE_URL_WINDOW_MS } from "./r2";

const bucket = { endpoint: "https://acct.r2.cloudflarestorage.com", accessKeyId: "k", secretAccessKey: "s", bucket: "codecast-call-recordings" };
const ENV = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "MEDIA_PUBLIC_BASE", "CALL_REC_R2_BUCKET", "CALL_REC_R2_ACCESS_KEY_ID", "CALL_REC_R2_SECRET_ACCESS_KEY"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buckets from env", () => {
  test("the recordings bucket needs its own token, never the media one", () => {
    for (const k of ENV) delete process.env[k];
    process.env.R2_ENDPOINT = bucket.endpoint;
    process.env.R2_ACCESS_KEY_ID = "media-key";
    process.env.R2_SECRET_ACCESS_KEY = "media-secret";
    expect(callRecordingsBucketFromEnv()).toBeNull();
    process.env.CALL_REC_R2_BUCKET = "codecast-call-recordings";
    process.env.CALL_REC_R2_ACCESS_KEY_ID = "rec-key";
    process.env.CALL_REC_R2_SECRET_ACCESS_KEY = "rec-secret";
    expect(callRecordingsBucketFromEnv()).toEqual({ endpoint: bucket.endpoint, accessKeyId: "rec-key", secretAccessKey: "rec-secret", bucket: "codecast-call-recordings" });
    expect(mediaBucketFromEnv()).toEqual({ endpoint: bucket.endpoint, accessKeyId: "media-key", secretAccessKey: "media-secret", bucket: "codecast-media", publicBase: "https://media.codecast.sh" });
  });
});

describe("presigned URLs", () => {
  test("address the object inside its bucket", async () => {
    const url = await r2Presign(bucket, "GET", "/calls/t1/c1.mp4", 60, new Date("2026-10-02T00:00:00Z"));
    expect(url.startsWith("https://acct.r2.cloudflarestorage.com/codecast-call-recordings/calls/t1/c1.mp4?")).toBe(true);
    expect(url).toContain("X-Amz-Expires=60");
  });

  test("a read URL is the same bytes all through its window, and new in the next", async () => {
    const t0 = Date.parse("2026-10-02T10:00:00Z");
    const a = await r2StableGetUrl(bucket, "calls/t1/c1.mp4", t0 + 1_000);
    const b = await r2StableGetUrl(bucket, "calls/t1/c1.mp4", t0 + STABLE_URL_WINDOW_MS - 1);
    const c = await r2StableGetUrl(bucket, "calls/t1/c1.mp4", t0 + STABLE_URL_WINDOW_MS);
    expect(a).toEqual(b);
    expect(c.url).not.toBe(a.url);
  });

  test("a URL handed out at the end of its window still lives a full window", () => {
    const now = 10 * STABLE_URL_WINDOW_MS - 1;
    const w = stableSigningWindow(now);
    expect(w.signedAt.getTime()).toBe(9 * STABLE_URL_WINDOW_MS);
    expect(w.expiresAt - now).toBeGreaterThanOrEqual(STABLE_URL_WINDOW_MS);
    expect(w.expiresSeconds * 1000).toBe(2 * STABLE_URL_WINDOW_MS);
  });
});
