import { afterEach, describe, expect, test } from "bun:test";
import {
  callRecordingKey,
  callRecordingLiveFramePrefix,
  callRecordingRunPrefix,
  callRecordingRunPrefixOfKey,
  callRecordingManifestKey,
  callRecordingsBucketFromEnv,
  FRESH_URL_SECONDS,
  liveFrameKey,
  mediaBucketFromEnv,
  r2FreshGetUrl,
  r2ListKeys,
  r2Presign,
  r2StableGetUrl,
  stableSigningWindow,
  STABLE_URL_WINDOW_MS,
} from "./r2";

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

describe("callRecordingKey", () => {
  test("a call's files sit under it, named by the press that started their run, all MP4", () => {
    expect(callRecordingKey({ transcriptId: "t1", kind: "composite", requestedAt: 1727000000000 })).toBe("calls/t1/1727000000000-composite.mp4");
    expect(callRecordingKey({ transcriptId: "t1", kind: "screen", requestedAt: 1727000000000, trackSid: "TR_ab/../c" })).toBe("calls/t1/1727000000000-screen-TR_abc.mp4");
  });
});

describe("a run's prefix", () => {
  test("every file of one press, its live frames included, sits under it, and no other press does", () => {
    const run = { transcriptId: "t1", requestedAt: 1727000000000 };
    const prefix = callRecordingRunPrefix(run);
    expect(prefix).toBe("calls/t1/1727000000000-");
    expect(callRecordingKey({ ...run, kind: "composite" }).startsWith(prefix)).toBe(true);
    expect(liveFrameKey(callRecordingLiveFramePrefix({ ...run, kind: "screen", trackSid: "TR_x" }))).toBe("calls/t1/1727000000000-screen-TR_x-live.jpeg");
    // A press a millisecond later has a longer number at the same place.
    expect(callRecordingKey({ transcriptId: "t1", requestedAt: 17270000000001, kind: "composite" }).startsWith(prefix)).toBe(false);
    expect(callRecordingRunPrefixOfKey("calls/t1/1727000000000-screen-TR_x.mp4")).toBe(prefix);
    // Never guessed for a key outside the layout.
    expect(callRecordingRunPrefixOfKey("calls/t1/composite.mp4")).toBeNull();
    expect(callRecordingRunPrefixOfKey("elsewhere/t1/1-x.mp4")).toBeNull();
  });
});

describe("fresh URLs and listing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a fresh URL is signed now, for ten minutes", async () => {
    const now = Date.parse("2026-10-02T10:07:13Z");
    const { url, expiresAt } = await r2FreshGetUrl(bucket, "calls/t1/c.mp4", now);
    expect(new URL(url).searchParams.get("X-Amz-Date")).toBe("20261002T100713Z");
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe(String(FRESH_URL_SECONDS));
    expect(expiresAt).toBe(now + FRESH_URL_SECONDS * 1000);
  });

  test("a prefix is listed page by page, with the list parameters signed", async () => {
    const seen: URL[] = [];
    globalThis.fetch = (async (input: any) => {
      const u = new URL(String(input));
      seen.push(u);
      const page2 = u.searchParams.get("continuation-token") === "tok&2";
      const xml = page2
        ? "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>calls/t1/1-live.jpeg</Key></Contents></ListBucketResult>"
        : "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>calls/t1/1-composite.mp4</Key></Contents><Contents><Key>calls/t1/1-a&amp;b.mp4</Key></Contents><NextContinuationToken>tok&amp;2</NextContinuationToken></ListBucketResult>";
      return new Response(xml, { status: 200 });
    }) as any;
    expect(await r2ListKeys(bucket, "calls/t1/1-")).toEqual(["calls/t1/1-composite.mp4", "calls/t1/1-a&b.mp4", "calls/t1/1-live.jpeg"]);
    expect(seen).toHaveLength(2);
    expect(seen[0].pathname).toBe("/codecast-call-recordings");
    expect(seen[0].searchParams.get("list-type")).toBe("2");
    expect(seen[0].searchParams.get("prefix")).toBe("calls/t1/1-");
    expect(seen[0].searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a refused list throws: a delete by prefix must know it saw everything", async () => {
    globalThis.fetch = (async () => new Response("denied", { status: 403 })) as any;
    await expect(r2ListKeys(bucket, "calls/t1/1-")).rejects.toThrow(/403/);
  });
});

describe("callRecordingManifestKey", () => {
  test("names LiveKit's manifest in the file's folder, and nothing for an unknown shape", () => {
    expect(callRecordingManifestKey("calls/t1/1727000000000-composite.mp4", "EG_abc123")).toBe("calls/t1/EG_abc123.json");
    expect(callRecordingManifestKey("calls/t1/1727000000000-composite.mp4", null)).toBeNull();
    expect(callRecordingManifestKey("calls/t1/1727000000000-composite.mp4", "../x")).toBeNull();
    expect(callRecordingManifestKey("elsewhere/f.mp4", "EG_abc")).toBeNull();
  });
});
