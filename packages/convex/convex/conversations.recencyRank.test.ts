import { describe, expect, test } from "bun:test";
import { recencyRankOf } from "./conversations";
import { PROMPT_CACHE_LIFETIME_MS } from "./wakeCost";

// `cast search` and `cast context` break ties below relevance with this rank,
// so an agent looking for a session to message sees the ones it can reach
// cheaply first. Messages into sessions whose prompt cache expired cost the
// whole context again and drew no replies (measured 2026-09-14).
const NOW = 1_800_000_000_000;
const conv = (o: Record<string, unknown>) => ({ updated_at: NOW - 60_000, status: "active", ...o });

describe("recencyRankOf", () => {
  test("a warm session ranks first", () => {
    expect(recencyRankOf(conv({}), NOW)).toBe(0);
  });

  test("an expired cache ranks next, judged by the last model call before updated_at", () => {
    expect(recencyRankOf(conv({ updated_at: NOW - PROMPT_CACHE_LIFETIME_MS - 1 }), NOW)).toBe(1);
    // A metadata patch bumped updated_at, but the cache was last written hours ago.
    expect(recencyRankOf(conv({ usage_totals: { updated_at: NOW - 3 * PROMPT_CACHE_LIFETIME_MS } }), NOW)).toBe(1);
  });

  test("killed or completed sessions rank last, however recent", () => {
    expect(recencyRankOf(conv({ inbox_killed_at: NOW - 1000 }), NOW)).toBe(2);
    expect(recencyRankOf(conv({ status: "completed" }), NOW)).toBe(2);
  });
});
