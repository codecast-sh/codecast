import { afterEach, describe, expect, test } from "bun:test";
import { parseReplayChunkKey, replayChunkKey, replaysBucketFromEnv, safeReplayPathSegment } from "./r2";

const ENV = ["R2_ENDPOINT", "REPLAYS_R2_BUCKET", "REPLAYS_R2_ACCESS_KEY_ID", "REPLAYS_R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const SHA = "a".repeat(64);

describe("replays bucket", () => {
  test("needs its own key; the media key never stands in for it", () => {
    for (const k of ENV) delete process.env[k];
    process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.R2_ACCESS_KEY_ID = "media";
    process.env.R2_SECRET_ACCESS_KEY = "media-secret";
    expect(replaysBucketFromEnv()).toBeNull();
    process.env.REPLAYS_R2_ACCESS_KEY_ID = "rk";
    process.env.REPLAYS_R2_SECRET_ACCESS_KEY = "rs";
    expect(replaysBucketFromEnv()).toEqual({ endpoint: "https://acct.r2.cloudflarestorage.com", accessKeyId: "rk", secretAccessKey: "rs", bucket: "codecast-replays" });
    process.env.REPLAYS_R2_BUCKET = "codecast-replays-dev";
    expect(replaysBucketFromEnv()?.bucket).toBe("codecast-replays-dev");
  });
});

describe("chunk keys", () => {
  test("content addressed under source and recording, in sequence order", () => {
    const key = replayChunkKey({ sourceId: "src1", replay: "r_9", seq: 3, sha256: SHA });
    expect(key).toBe(`replays/src1/r_9/0003-${SHA}.json.gz`);
    expect(parseReplayChunkKey(key)).toEqual({ seq: 3, sha256: SHA });
    expect(parseReplayChunkKey("calls/x/1-composite.mp4")).toBeNull();
  });

  test("a replay id cannot climb out of its source's prefix", () => {
    const climbed = safeReplayPathSegment("../../other-source/x");
    expect(climbed).toMatch(/^______other-source_x~[0-9a-f]{8}$/);
    expect(climbed).not.toContain("/");
    expect(safeReplayPathSegment("")).toMatch(/^_~[0-9a-f]{8}$/);
    expect(safeReplayPathSegment("ok-ID_1")).toBe("ok-ID_1");
    const key = replayChunkKey({ sourceId: "src1", replay: climbed, seq: 0, sha256: SHA });
    expect(parseReplayChunkKey(key)).toEqual({ seq: 0, sha256: SHA });
  });

  test("ids that sanitize alike stay distinct segments", () => {
    const ids = ["a/b", "a_b", "a.b", "a b", "x".repeat(200), "x".repeat(201)];
    const segments = ids.map(safeReplayPathSegment);
    expect(new Set(segments).size).toBe(ids.length);
    expect(segments[1]).toBe("a_b");
    for (const seg of segments) expect(seg).toMatch(/^[A-Za-z0-9_-]+(~[0-9a-f]{8})?$/);
    expect(safeReplayPathSegment("a/b")).toBe(safeReplayPathSegment("a/b"));
  });
});
