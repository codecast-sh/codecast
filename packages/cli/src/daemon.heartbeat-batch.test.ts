import { describe, expect, test } from "bun:test";
import { heartbeatHealthCheckBucket } from "./daemon.js";

// The batched heartbeat flush sends the whole fleet's liveness in one
// transaction per tick (collapsing N inbox invalidations into 1), but the
// per-session health check (a local tmux scrape) must NOT all run on the same
// tick — that would trade the network burst for a tmux/process burst. The flush
// shards sessions into HEALTH_CHECK_EVERY_N_HEARTBEATS buckets by this function
// and runs one bucket per tick, so each session is checked every N ticks and the
// scrapes are spread evenly. These tests pin that behavior.
describe("heartbeatHealthCheckBucket", () => {
  test("is deterministic and always in [0, mod)", () => {
    for (const id of ["abc", "019e6a38-abb5-7df0", "", "z".repeat(64)]) {
      const a = heartbeatHealthCheckBucket(id, 3);
      const b = heartbeatHealthCheckBucket(id, 3);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(3);
    }
  });

  test("spreads a realistic fleet roughly evenly across buckets", () => {
    // UUID-shaped ids like real session ids.
    const ids = Array.from({ length: 300 }, (_, i) =>
      `0${i.toString(16).padStart(7, "0")}-abb5-7df0-8b70-${i.toString(16).padStart(12, "0")}`,
    );
    const mod = 3;
    const counts = [0, 0, 0];
    for (const id of ids) counts[heartbeatHealthCheckBucket(id, mod)]++;
    // No bucket should hold more than ~half the fleet — i.e. the load is shared,
    // not lumped onto one tick. (Even split is 100 each; allow generous slack.)
    for (const c of counts) {
      expect(c).toBeGreaterThan(ids.length / mod / 2); // > ~50
      expect(c).toBeLessThan((ids.length / mod) * 2); // < ~200
    }
    expect(counts[0] + counts[1] + counts[2]).toBe(ids.length);
  });
});
