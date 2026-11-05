import { describe, expect, test } from "bun:test";
import type { OpsGroup } from "./opsTypes";
import { DEFAULT_QUERY, escalation, filterIssues, stageFixLabel, statusCounts, type IssueCtx } from "./issuesModel";
import { attentionCounts, type AttentionItem } from "./opsHomeModel";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 4, 15, 37);
const hourAt = (back: number) => Math.floor((NOW - back * HOUR) / HOUR) * HOUR;
const g = (over: Partial<OpsGroup> = {}): OpsGroup =>
  ({ _id: over.short_id ?? "g1", short_id: "eg-1", source_id: "s1", kind: "error", title: "TypeError: x", status: "open", count: 3, first_seen: NOW - 2 * HOUR, last_seen: NOW - HOUR, buckets: [{ hour: hourAt(1), count: 3 }], ...over }) as OpsGroup;
const ctx: IssueCtx = { taskStatus: () => undefined };

describe("one number per filter", () => {
  test("Nobody on it narrows the lane counts too, so All open equals the rows it lists", () => {
    const rows = [g({ _id: "a", short_id: "eg-a" }), g({ _id: "b", short_id: "eg-b", fix_conversation_id: "conv" }), g({ _id: "c", short_id: "eg-c", first_seen: NOW - 10 * 24 * HOUR, last_seen: NOW - 5 * 24 * HOUR })];
    const q = { ...DEFAULT_QUERY, lane: "all" as const, nobody: true };
    const counts = statusCounts(rows, q, ctx, NOW);
    expect(counts.open).toBe(filterIssues(rows, q, ctx, NOW).length);
    expect(counts.open).toBe(2);
    expect(counts.attention).toBe(filterIssues(rows, { ...q, lane: "attention" }, ctx, NOW).length);
  });

  test("an Overview issue tile counts issues, so a folded row of two new issues is two, as the New lane lists them", () => {
    const base = { severity: 1, at: NOW, volume: 1, sourceId: "s1", taskId: null, task: null, sessionId: null } as const;
    const items = [
      { ...base, kind: "issue", key: "issue:a", state: "new", lanes: ["new", "new"], group: g() },
      { ...base, kind: "issue", key: "issue:b", state: "regressed", lanes: ["regressed"], group: g() },
      { ...base, kind: "watch", key: "watch:w", state: "alerting", also: ["regressed"], lanes: ["regressed"], watch: {} as never, group: g() },
    ] as unknown as AttentionItem[];
    const c = attentionCounts(items);
    expect(c.new).toBe(2);
    expect(c.regressed).toBe(2);
    expect(c.alerting).toBe(1);
  });
});

describe("a spike that settled", () => {
  // Three quiet days at 10 a day, then a spike to 300 in one hour, then the last three hours.
  const spiked = (perHourNow: number) =>
    g({
      first_seen: NOW - 80 * HOUR,
      buckets: [
        ...Array.from({ length: 48 }, (_, i) => ({ hour: hourAt(71 - i), count: i % 5 === 0 ? 2 : 0 })),
        { hour: hourAt(11), count: 300 },
        ...[2, 1, 0].map((h) => ({ hour: hourAt(h), count: perHourNow })),
      ],
    });

  test("passed only when the rate is back near its usual", () => {
    const back = escalation(spiked(0), NOW);
    expect(back.settled).toBe(true);
    expect(back.back).toBe(true);
  });

  test("under the spike line but still well over usual is still elevated, never passed", () => {
    const e = escalation(spiked(1), NOW);
    expect(e.baseline).toBeGreaterThan(0);
    expect(e.perHourNow * 24).toBeGreaterThan(1.5 * e.baseline);
    expect(e.settled).toBe(true);
    expect(e.back).toBe(false);
  });
});

describe("the Count sort", () => {
  test("ranks rows of one unit together, each by its own number", () => {
    const rows = [g({ _id: "m", kind: "metric", count: 388 }), g({ _id: "e1", count: 5 }), g({ _id: "j", kind: "job", count: 1 }), g({ _id: "e2", count: 2912 }), g({ _id: "c", kind: "check", count: 24 })];
    const out = filterIssues(rows, { ...DEFAULT_QUERY, lane: "all", sort: "events" }, ctx, NOW).map((r) => r._id);
    expect(out).toEqual(["e2", "e1", "j", "c", "m"]);
  });
});

describe("the fix press on a row", () => {
  test("a dropped task reads the Fix card's words; a task for another title starts a fix of its own", () => {
    expect(stageFixLabel(g({ title: "TypeError: x" }), "dropped", { title: "TypeError: x", short_id: "ct-57171" })).toBe("Reopen ct-57171 and fix");
    expect(stageFixLabel(g({ title: "TypeError: x" }), "dropped", { title: "Something else entirely", short_id: "ct-1" })).toBe("Start fix");
    expect(stageFixLabel(g(), "none", null)).toBe("Start fix");
  });
});

describe("rates side by side", () => {
  test("share one unit, so now and usually compare at a glance", async () => {
    const { rateUnit, rateWords } = await import("./issuesModel");
    const u = rateUnit(24, 22 * 24);
    expect(u).toBe("h");
    expect(rateWords(24, u)).toBe("1/h");
    expect(rateWords(22 * 24, u)).toBe("22/h");
    expect(rateWords(10, rateUnit(10, 5))).toBe("10/day");
  });
});
