import { describe, expect, test } from "bun:test";
import { factsQueries, needsFacts, parseFacts, posthogWebUrl, RECHECK_EVERY_MS, RECHECK_MS } from "./replayFacts";

describe("replay facts", () => {
  test("asks a row never asked, and a row asked while it may still have been recording", () => {
    const now = 10 * RECHECK_MS;
    expect(needsFacts({ started_at: now - 1000 }, now)).toBe(true);
    expect(needsFacts({ started_at: now - RECHECK_MS * 2, facts: { at: now - RECHECK_MS * 2 + 60_000 } }, now)).toBe(true);
    expect(needsFacts({ started_at: now - 60_000, facts: { at: now - RECHECK_EVERY_MS / 2 } }, now)).toBe(false);
    expect(needsFacts({ started_at: now - RECHECK_MS * 3, facts: { at: now - RECHECK_MS } }, now)).toBe(false);
    // A tab left open for hours: asked six hours in while it still ran, so asked again; once its end is well before the ask, done.
    const start = now - 9 * 3600_000;
    expect(needsFacts({ started_at: start, facts: { at: start + 6 * 3600_000, length_ms: 6 * 3600_000 - 60_000 } }, now)).toBe(true);
    expect(needsFacts({ started_at: start, facts: { at: start + 6 * 3600_000, length_ms: 6 * 3600_000 - 60_000 } }, start + 6 * 3600_000 + 60_000)).toBe(false);
    expect(needsFacts({ started_at: start, facts: { at: now - RECHECK_EVERY_MS, length_ms: 2 * 3600_000 } }, now)).toBe(false);
  });

  test("queries interpolate only session ids", () => {
    const q = factsQueries(["01a1a405-0911-74b1-9622-c4038542f161", "x'); DROP"], Date.UTC(2026, 9, 1));
    expect(q.lengths).toContain("'01a1a405-0911-74b1-9622-c4038542f161'");
    expect(q.lengths).not.toContain("DROP");
    expect(q.env).toContain("toDateTime('2026-10-01T00:00:00Z')");
  });

  test("parses both answers, and every asked id gets an entry", () => {
    const facts = parseFacts(
      ["a", "b", "c"],
      [["a", 2605, 156938, 31, 0], ["zzz", 1, 1, 1, 1]],
      [["a", "Opera", "Windows", "Desktop", "us", "www.google.com", 2], ["b", "Chrome", "Mac OS X", "Desktop", "US", "$direct", 0]],
      5,
    );
    expect(facts.get("a")).toEqual({ at: 5, length_ms: 2_605_000, active_ms: 156938, clicks: 31, console_errors: 0, browser: "Opera", os: "Windows", device: "Desktop", country: "US", referrer: "www.google.com", rage_clicks: 2 });
    expect(facts.get("b")).toEqual({ at: 5, browser: "Chrome", os: "Mac OS X", device: "Desktop", country: "US", rage_clicks: 0 });
    expect(facts.get("c")).toEqual({ at: 5 });
    expect(facts.has("zzz")).toBe(false);
  });

  test("the vendor's web address", () => {
    expect(posthogWebUrl({ host: "https://us.posthog.com/", project_id: "123" })).toBe("https://us.posthog.com/project/123");
  });
});
