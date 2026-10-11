import { describe, expect, test } from "bun:test";
import { PRESENCE, heartbeatPatch, isHere, isTyping, presenceCutoff } from "./presence";
import { takeFromWindow } from "./rateLimit";

const NOW = 1_000_000_000;

describe("presence cutoff", () => {
  test("a row is here strictly inside the stale window", () => {
    expect(presenceCutoff(NOW)).toBe(NOW - PRESENCE.staleMs);
    expect(isHere({ last_seen: NOW }, NOW)).toBe(true);
    expect(isHere({ last_seen: NOW - PRESENCE.staleMs + 1 }, NOW)).toBe(true);
    expect(isHere({ last_seen: NOW - PRESENCE.staleMs }, NOW)).toBe(false);
  });

  test("an idle beat writes only every other time, and a row renewed then survives a missed beat", () => {
    expect(PRESENCE.heartbeatMs).toBeLessThan(PRESENCE.seenWriteMs);
    expect(PRESENCE.seenWriteMs + PRESENCE.heartbeatMs).toBeLessThan(PRESENCE.staleMs);
    const beats = Array.from({ length: 8 }, (_, i) => i * PRESENCE.heartbeatMs);
    let row = { last_seen: 0, viewing_version: null as number | null };
    let writes = 0;
    for (const at of beats.slice(1)) {
      const patch = heartbeatPatch(row, null, at);
      if (patch) (row = patch), writes++;
      expect(isHere(row, at + PRESENCE.heartbeatMs * 2 - 1)).toBe(true);
    }
    expect(writes).toBe(Math.floor((beats.length - 1) / 2));
  });

  test("typing holds until its deadline", () => {
    expect(isTyping({ until: NOW + 1 }, NOW)).toBe(true);
    expect(isTyping({ until: NOW }, NOW)).toBe(false);
    expect(isTyping({ until: 0 }, NOW)).toBe(false);
  });
});

describe("heartbeat writes", () => {
  test("a fresh row with the same view writes nothing", () => {
    expect(heartbeatPatch({ last_seen: NOW - 1_000, viewing_version: null }, null, NOW)).toBeNull();
  });

  test("a row past the write interval is renewed", () => {
    expect(heartbeatPatch({ last_seen: NOW - PRESENCE.seenWriteMs, viewing_version: 3 }, 3, NOW)).toEqual({
      last_seen: NOW,
      viewing_version: 3,
    });
  });

  test("changing the viewed version writes at once", () => {
    expect(heartbeatPatch({ last_seen: NOW - 1, viewing_version: null }, 12, NOW)).toEqual({ last_seen: NOW, viewing_version: 12 });
    expect(heartbeatPatch({ last_seen: NOW - 1, viewing_version: 12 }, null, NOW)).toEqual({ last_seen: NOW, viewing_version: null });
  });
});

describe("rate windows", () => {
  const rule = { max: 2, windowMs: 1_000 };

  test("allows max hits per window, then refuses with the wait", () => {
    const a = takeFromWindow(null, rule, NOW);
    const b = takeFromWindow(a.next, rule, NOW + 100);
    const c = takeFromWindow(b.next, rule, NOW + 400);
    expect([a.allowed, b.allowed, c.allowed]).toEqual([true, true, false]);
    expect(c.retryAfterMs).toBe(600);
    expect(c.next).toEqual(b.next);
  });

  test("a new window opens once the old one has passed", () => {
    const full = { window_start: NOW, count: 2 };
    expect(takeFromWindow(full, rule, NOW + 1_000)).toEqual({ allowed: true, next: { window_start: NOW + 1_000, count: 1 }, retryAfterMs: 0 });
  });
});
