import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { checkRateLimit, rateLimitShardKey, rateLimitShards } from "./rateLimit";

const USER = "user-1" as any;

describe("checkRateLimit sharding", () => {
  test("low limits keep one exact counter row", () => {
    for (const limit of [3, 10, 60, 120]) expect(rateLimitShards(limit)).toBe(1);
  });

  test("high limits spread calls over several rows so parallel calls stop conflicting", async () => {
    expect(rateLimitShards(500)).toBe(7);
    const db = makeFakeDb({ rate_limits: [] });
    const ctx = { db } as any;
    for (let i = 0; i < 200; i++) await checkRateLimit(ctx, USER, "createConversation");
    const rows = (db as any)._tables.rate_limits;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r: any) => r.endpoint.startsWith("createConversation"))).toBe(true);
    expect(rows.reduce((n: number, r: any) => n + r.request_count, 0)).toBe(200);
  });

  test("a spent shard refuses and the bare endpoint name stays shard 0", async () => {
    expect(rateLimitShardKey("chat.send", 0)).toBe("chat.send");
    const db = makeFakeDb({
      rate_limits: Array.from({ length: rateLimitShards(500) }, (_, s) => ({
        _id: `rl-${s}`, user_id: USER, endpoint: rateLimitShardKey("createConversation", s),
        window_start: Date.now(), request_count: Math.ceil(500 / 7),
      })),
    });
    await expect(checkRateLimit({ db } as any, USER, "createConversation")).rejects.toThrow("Rate limit exceeded");
  });
});
