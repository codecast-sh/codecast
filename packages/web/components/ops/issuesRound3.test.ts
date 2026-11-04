// The Issues surface's third pass: a spike that passed reads settled, the
// fix press reads the same everywhere, a metric part can be left out, an app
// check's sentence turns into figures, and a fix prompt names what it holds.
import { describe, expect, test } from "bun:test";
import { escalation, escalationWords, fixActionLabel, hogqlBreakdown, hogqlExclude, isEscalating, issueLane, metricFailure, projectZero, readingTemplate } from "./issuesModel";
import { seededWith } from "./issueFix";
import type { OpsGroup } from "./opsTypes";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 3, 12, 30);
const THIS_HOUR = Date.UTC(2026, 10, 3, 12);
const g = (over: Partial<OpsGroup> = {}): OpsGroup =>
  ({ _id: "g1", short_id: "eg-1", source_id: "s1", kind: "error", title: "TypeError: x", status: "open", count: 10, first_seen: NOW - 10 * 24 * HOUR, last_seen: NOW - HOUR, buckets: [], updated_at: NOW, ...over }) as OpsGroup;
/** `base` an hour for the 48 hours before the last day, then the last day's hours oldest first. */
const hours = (base: number, day: number[]) => [
  ...Array.from({ length: 48 }, (_, i) => ({ hour: THIS_HOUR - (71 - i) * HOUR, count: base })),
  ...day.map((count, i) => ({ hour: THIS_HOUR - (day.length - 1 - i) * HOUR, count })),
];

describe("a spike", () => {
  test("still running past the line is escalating, with the rate now", () => {
    const hot = g({ buckets: hours(2, [...Array(20).fill(10), 60, 70, 80, 90]) });
    const e = escalation(hot, NOW);
    expect(e.spiked && !e.settled).toBe(true);
    expect(isEscalating(hot, NOW)).toBe(true);
    expect(escalationWords(e)).toBe("500 in 24h · avg 21/h vs usual 2/h · now 80/h");
  });
  test("that fell back after a release has settled: never escalating, and its peak is kept", () => {
    const calmed = g({ buckets: hours(10, [10, 10, 10, 300, 250, 200, ...Array(18).fill(5)]) });
    const e = escalation(calmed, NOW);
    expect([e.spiked, e.settled, e.peak]).toEqual([true, true, 300]);
    expect(e.peakAt).toBe(THIS_HOUR - 20 * HOUR);
    expect(isEscalating(calmed, NOW)).toBe(false);
    // Still 120 a day after the spike: not escalating, but loud enough to read as firing.
    expect(issueLane(calmed, NOW)).toBe("firing");
  });
  test("the server's spike rule counts only while the rate holds", () => {
    const flagged = { last_transition: "spike", last_transition_at: NOW - 20 * HOUR } as Partial<OpsGroup>;
    expect(isEscalating(g({ ...flagged, buckets: hours(10, Array(24).fill(5)) }), NOW)).toBe(false);
    expect(isEscalating(g({ ...flagged, buckets: hours(10, [...Array(21).fill(5), 50, 50, 50]) }), NOW)).toBe(true);
  });
});

describe("the fix press", () => {
  test("names the task it works on, never one filed for another title", () => {
    expect(fixActionLabel("start", "ct-1", false)).toBe("Start fix on ct-1");
    expect(fixActionLabel("start", "ct-1", true)).toBe("Start fix");
    expect(fixActionLabel("refile", "ct-1", false)).toBe("Reopen ct-1 and fix");
    expect(fixActionLabel("refile", "ct-1", true)).toBe("Start fix");
    expect(fixActionLabel("followup", "ct-1", false)).toBe("Start follow-up fix on ct-1");
    expect(fixActionLabel("open", null, false)).toBe("Open fix session");
    expect(fixActionLabel(null, "ct-1", false)).toBeNull();
  });
});

describe("a metric's parts", () => {
  const q = "select count() from events where event = '$exception' and timestamp > now() - interval 1 day";
  test("one part left out keeps the filter and compares the part the way the breakdown keyed it, and still splits", () => {
    const out = hogqlExclude(q, "Error: ResizeObserver loop completed with undelivered notifications.")!;
    expect(out).toContain("(event = '$exception' and timestamp > now() - interval 1 day) and concat(");
    expect(out).toContain("!= 'Error: ResizeObserver loop completed with undelivered notifications.'");
    expect(hogqlBreakdown(out)).not.toBeNull();
    expect(hogqlExclude(q, "it's")).toContain("!= 'it\\'s'");
    expect(hogqlExclude("select avg(x) from events", "a")).toBeNull();
  });
  test("a fix prompt carries the reading and the biggest parts", () => {
    expect(metricFailure("111 above 15", [{ key: "Error: ResizeObserver loop", n: 111, share: 1 }])).toBe("111 above 15\n100% (111) Error: ResizeObserver loop");
  });
});

describe("an app check's readings", () => {
  const say = (credit: number, days: string, burn: number) => `OpenRouter credit $${credit}, ${days} days at $${burn}/day: past the 1-day / $250 level. Every call on the key stops at $0; a founder adds credit.`;
  const rows = [
    { id: "a", at: NOW, text: say(196, "3.0", 65) },
    { id: "b", at: NOW - 6 * HOUR, text: say(212, "3.3", 64) },
    { id: "c", at: NOW - 12 * HOUR, text: say(229, "3.5", 66) },
  ];
  test("one sentence with moving figures turns into named columns and the level it is held to", () => {
    const t = readingTemplate(rows)!;
    expect(t.cols.map((c) => c.label)).toEqual(["credit", "days", "per day"]);
    expect(t.values.get("a")).toEqual([196, 3, 65]);
    expect(t.line).toBe(250);
    expect(t.text).toBe(rows[0].text);
  });
  test("readings that do not share a shape, or never move, stay as words", () => {
    expect(readingTemplate([{ id: "a", text: "disk 90% full" }, { id: "b", text: "queue stuck for 3h" }])).toBeNull();
    expect(readingTemplate([{ id: "a", text: "past $250" }, { id: "b", text: "past $250" }])).toBeNull();
  });
  test("a falling figure reaches zero at the rate it fell since it last rose", () => {
    const z = projectZero([{ at: 0, v: 50 }, { at: HOUR, v: 100 }, { at: 2 * HOUR, v: 90 }, { at: 3 * HOUR, v: 80 }]);
    expect(z).toBe(11 * HOUR);
    expect(projectZero([{ at: 0, v: 10 }, { at: HOUR, v: 20 }])).toBeNull();
  });
});

describe("what a fix prompt holds", () => {
  test("named for the issue's kind", () => {
    expect(seededWith({ groupRefs: ["eg-71"], title: "E2E", url: "https://x", failure: "step 8" }, "check")).toBe("Title, run, failed step, log tail");
    expect(seededWith({ groupRefs: ["eg-299"], title: "Exceptions", failure: "111" }, "metric")).toBe("Title, reading, what it counted");
    expect(seededWith({ groupRefs: ["eg-118"], title: "TypeError", frame: "a.ts:1", release: "4c5" }, "error")).toBe("Title, stack frame, release");
  });
});

describe("an app check that lists fields", () => {
  const say = (undecided: number, adjudicated: number) => `1 stale, 3 no-response, 2 intro overdue, 6 over-matched, ${undecided} replied-but-undecided (informational), ${adjudicated} review-adjudicated (informational), 2 close-pending (informational)`;
  test("its columns are the fields that fail it, never the informational ones, and no field reads as a line", () => {
    const t = readingTemplate([{ id: "a", text: say(19, 10) }, { id: "b", text: say(18, 9) }])!;
    expect(t.cols.map((c) => c.label)).toEqual(["stale", "no-response", "intro overdue", "over-matched"]);
    expect(t.values.get("a")).toEqual([1, 3, 2, 6]);
    expect(t.line).toBeNull();
    expect(t.charted).toBe(0);
  });
});
