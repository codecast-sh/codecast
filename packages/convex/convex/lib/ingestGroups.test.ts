import { describe, expect, test } from "bun:test";
import { GROUP_RULES, type IngestItem } from "@codecast/shared/contracts/ingest";
import {
  HOUR_MS,
  addToBuckets,
  appendMetricPoint,
  applyOccurrence,
  bucketCount,
  foldOccurrences,
  hourStart,
  isOlderRelease,
  metricCrosses,
  openGroupsDelta,
  planItem,
  planMetric,
  pruneBuckets,
  trailingMean,
  utcDay,
  type GroupState,
  type Occurrence,
} from "./ingestGroups";

const NOW = Date.UTC(2026, 9, 3, 12, 30);
const HOUR = hourStart(NOW);

function group(over: Partial<GroupState> = {}): GroupState {
  return { kind: "error", status: "open", count: 1, first_seen: HOUR - 48 * HOUR_MS, last_seen: HOUR - HOUR_MS, buckets: [], ...over };
}

const occ = (over: Partial<Occurrence> = {}): Occurrence => ({ kind: "error", at: NOW, ...over });

/** n occurrences in the current hour, folded onto `state`. */
function burst(state: GroupState | null, n: number, over: Partial<Occurrence> = {}) {
  return foldOccurrences(state, Array.from({ length: n }, (_, i) => occ({ at: HOUR + i * 1000, ...over })), NOW);
}

describe("buckets", () => {
  test("add lands in the occurrence's hour and stays sorted", () => {
    let b = addToBuckets([], NOW, 1, NOW);
    b = addToBuckets(b, NOW - 2 * HOUR_MS, 3, NOW);
    b = addToBuckets(b, NOW + 1, 2, NOW);
    expect(b).toEqual([{ hour: HOUR - 2 * HOUR_MS, count: 3 }, { hour: HOUR, count: 3 }]);
  });

  test("the window keeps 72 hours and drops older ones", () => {
    const old = [{ hour: HOUR - 72 * HOUR_MS, count: 9 }, { hour: HOUR - 71 * HOUR_MS, count: 1 }];
    expect(pruneBuckets(old, NOW)).toEqual([{ hour: HOUR - 71 * HOUR_MS, count: 1 }]);
    expect(addToBuckets([], NOW - 80 * HOUR_MS, 1, NOW)).toEqual([]);
  });

  test("add does not mutate its input", () => {
    const input = [{ hour: HOUR, count: 1 }];
    addToBuckets(input, NOW, 1, NOW);
    expect(input[0].count).toBe(1);
  });

  test("the trailing mean covers the 24 hours before, empty hours as zero", () => {
    const b = [{ hour: HOUR - 25 * HOUR_MS, count: 100 }, { hour: HOUR - 24 * HOUR_MS, count: 24 }, { hour: HOUR - HOUR_MS, count: 24 }, { hour: HOUR, count: 999 }];
    expect(trailingMean(b, HOUR)).toBe(2);
    expect(bucketCount(b, HOUR)).toBe(999);
    expect(bucketCount(b, HOUR + HOUR_MS)).toBe(0);
  });

  test("utcDay", () => {
    expect(utcDay(NOW)).toBe("2026-10-03");
  });
});

describe("releases", () => {
  test("numeric order with prefixes and suffixes", () => {
    expect(isOlderRelease("1.2.3", "1.2.10")).toBe(true);
    expect(isOlderRelease("v2.0", "1.9.9")).toBe(false);
    expect(isOlderRelease("app@1.0.0+5", "app@1.0.1")).toBe(true);
    expect(isOlderRelease("1.2", "1.2.0")).toBe(false);
  });

  test("an unordered pair is never older", () => {
    expect(isOlderRelease("abc", "def")).toBe(false);
    expect(isOlderRelease("1.0", "main")).toBe(false);
  });
});

describe("new", () => {
  test("the first error, log or job of a fingerprint is a transition", () => {
    expect(applyOccurrence(null, occ(), NOW).transition).toBe("new");
    expect(applyOccurrence(null, occ({ kind: "log" }), NOW).transition).toBe("new");
    expect(applyOccurrence(null, occ({ kind: "job" }), NOW).transition).toBe("job_failed");
  });

  test("the new group carries counts, a bucket and the release", () => {
    const { next } = applyOccurrence(null, occ({ release: "1.0" }), NOW);
    expect(next).toMatchObject({ status: "open", count: 1, first_seen: NOW, last_seen: NOW, first_release: "1.0", last_release: "1.0", last_transition: "new", last_transition_at: NOW });
    expect(next.buckets).toEqual([{ hour: HOUR, count: 1 }]);
  });

  test("a repeat on an open group only counts", () => {
    const r = applyOccurrence(group(), occ(), NOW);
    expect(r.transition).toBeUndefined();
    expect(r.next.count).toBe(2);
    expect(r.next.last_seen).toBe(NOW);
  });

  test("a batch with many copies of a new error announces once", () => {
    const r = burst(null, 50);
    expect(r.transitions.map((t) => t.transition)).toEqual(["new"]);
    expect(r.next!.count).toBe(50);
  });
});

describe("regressed", () => {
  test("an occurrence on a resolved group reopens it", () => {
    const r = applyOccurrence(group({ status: "resolved", resolved_at: NOW - HOUR_MS }), occ(), NOW);
    expect(r.transition).toBe("regressed");
    expect(r.next).toMatchObject({ status: "open", regressed_at: NOW });
  });

  test("a release older than the fix is not a regression", () => {
    const r = applyOccurrence(group({ status: "resolved", resolved_in: "1.4.0" }), occ({ release: "1.3.9" }), NOW);
    expect(r.transition).toBeUndefined();
    expect(r.next.status).toBe("resolved");
    expect(r.next.count).toBe(2);
  });

  test("the fixed release or a newer one regresses", () => {
    expect(applyOccurrence(group({ status: "resolved", resolved_in: "1.4.0" }), occ({ release: "1.4.0" }), NOW).transition).toBe("regressed");
    expect(applyOccurrence(group({ status: "resolved", resolved_in: "1.4.0" }), occ({ release: "1.5.0" }), NOW).transition).toBe("regressed");
    expect(applyOccurrence(group({ status: "resolved", resolved_in: "1.4.0" }), occ(), NOW).transition).toBe("regressed");
  });

  test("ignored and muted groups count and never announce", () => {
    for (const status of ["ignored", "muted"] as const) {
      const r = burst(group({ status }), 100);
      expect(r.transitions).toEqual([]);
      expect(r.next!.count).toBe(101);
      expect(r.next!.status).toBe(status);
    }
  });

  test("a failing job on a resolved job group is a job failure", () => {
    expect(applyOccurrence(group({ kind: "job", status: "resolved" }), occ({ kind: "job" }), NOW).transition).toBe("job_failed");
  });
});

describe("spike", () => {
  test("20 in the hour against a quiet day spikes once", () => {
    const r = burst(group(), 25);
    expect(r.transitions.map((t) => t.transition)).toEqual(["spike"]);
    // The 20th occurrence is the one that crossed.
    expect(r.transitions[0].at).toBe(HOUR + 19 * 1000);
  });

  test("under 20 never spikes, whatever the factor", () => {
    expect(burst(group(), 19).transitions).toEqual([]);
  });

  test("the hour must reach 5 times the trailing mean", () => {
    // 10 an hour for 24 hours: the line is 50.
    const buckets = Array.from({ length: 24 }, (_, i) => ({ hour: HOUR - (i + 1) * HOUR_MS, count: 10 }));
    expect(burst(group({ buckets }), 49).transitions).toEqual([]);
    expect(burst(group({ buckets }), 50).transitions.map((t) => t.transition)).toEqual(["spike"]);
  });

  test("a spike within 6 hours of the last one is quiet", () => {
    const recent = group({ last_transition: "spike", last_transition_at: NOW - 5 * HOUR_MS });
    expect(burst(recent, 30).transitions).toEqual([]);
    const stale = group({ last_transition: "spike", last_transition_at: HOUR - GROUP_RULES.spike_cooldown_ms - 1 });
    expect(burst(stale, 30).transitions.map((t) => t.transition)).toEqual(["spike"]);
  });

  test("a group born this hour does not spike on top of new", () => {
    expect(burst(group({ first_seen: HOUR + 1 }), 40).transitions).toEqual([]);
  });

  test("a backfilled hour never spikes", () => {
    const past = Array.from({ length: 30 }, (_, i) => occ({ at: HOUR - 3 * HOUR_MS + i }));
    expect(foldOccurrences(group(), past, NOW).transitions).toEqual([]);
  });

  test("warning logs spike like errors", () => {
    expect(burst(group({ kind: "log" }), 20, { kind: "log" }).transitions.map((t) => t.transition)).toEqual(["spike"]);
  });
});

describe("checks", () => {
  test("a green first report is on record, quietly", () => {
    const r = applyOccurrence(null, occ({ kind: "check", ok: true }), NOW);
    expect(r.transition).toBeUndefined();
    expect(r.next).toMatchObject({ status: "resolved", count: 0, buckets: [], meta: { ok: true } });
  });

  test("a red first report fails", () => {
    const r = applyOccurrence(null, occ({ kind: "check", ok: false }), NOW);
    expect(r.transition).toBe("check_failed");
    expect(r.next).toMatchObject({ status: "open", count: 1, meta: { ok: false } });
  });

  test("a flip announces each way, staying put does not", () => {
    const green = group({ kind: "check", status: "resolved", count: 0, meta: { ok: true } });
    const fail = applyOccurrence(green, occ({ kind: "check", ok: false }), NOW);
    expect(fail.transition).toBe("check_failed");
    const still = applyOccurrence(fail.next, occ({ kind: "check", ok: false, at: NOW + 1 }), NOW + 1);
    expect(still.transition).toBeUndefined();
    expect(still.next.count).toBe(2);
    const back = applyOccurrence(still.next, occ({ kind: "check", ok: true, at: NOW + 2 }), NOW + 2);
    expect(back.transition).toBe("check_recovered");
    expect(back.next).toMatchObject({ status: "resolved", resolved_at: NOW + 2, count: 2, meta: { ok: true } });
    expect(applyOccurrence(back.next, occ({ kind: "check", ok: true, at: NOW + 3 }), NOW + 3).transition).toBeUndefined();
  });

  test("a red and a green in one batch are two transitions, in time order", () => {
    const green = group({ kind: "check", status: "resolved", count: 0, meta: { ok: true } });
    const r = foldOccurrences(green, [occ({ kind: "check", ok: true, at: NOW }), occ({ kind: "check", ok: false, at: NOW - 10 })], NOW);
    expect(r.transitions.map((t) => t.transition)).toEqual(["check_failed", "check_recovered"]);
  });

  test("a muted check tracks its state without announcing", () => {
    const r = applyOccurrence(group({ kind: "check", status: "muted", meta: { ok: true } }), occ({ kind: "check", ok: false }), NOW);
    expect(r.transition).toBeUndefined();
    expect(r.next.meta?.ok).toBe(false);
  });
});

describe("job bursts", () => {
  const job = (over: Partial<GroupState> = {}) => group({ kind: "job", last_transition: "job_failed", last_transition_at: NOW - 7 * HOUR_MS, ...over });

  test("3 failures in the hour announce once", () => {
    const r = burst(job(), 5, { kind: "job" });
    expect(r.transitions.map((t) => t.transition)).toEqual(["job_failed"]);
    expect(r.transitions[0].at).toBe(HOUR + 2000);
  });

  test("2 failures stay quiet", () => {
    expect(burst(job(), 2, { kind: "job" }).transitions).toEqual([]);
  });

  test("the 6 hour cooldown covers the new announcement too", () => {
    expect(burst(job({ last_transition_at: NOW - HOUR_MS }), 5, { kind: "job" }).transitions).toEqual([]);
  });

  test("a new job group fails once even in a burst", () => {
    expect(burst(null, 5, { kind: "job" }).transitions.map((t) => t.transition)).toEqual(["job_failed"]);
  });
});

describe("openGroupsDelta", () => {
  test("counts entries and exits of open", () => {
    expect(openGroupsDelta(undefined, "open")).toBe(1);
    expect(openGroupsDelta(undefined, "resolved")).toBe(0);
    expect(openGroupsDelta("open", "resolved")).toBe(-1);
    expect(openGroupsDelta("resolved", "open")).toBe(1);
    expect(openGroupsDelta("open", "open")).toBe(0);
  });
});

describe("planItem", () => {
  const env = { release: "1.2.0", environment: "prod" };

  test("an error groups by message and top frame and keeps its body for the sample", () => {
    const item: IngestItem = { type: "error", message: "User 42 not found\nmore", stack: "Error\n    at load (https://app.x/assets/main-abc12345.js:1:2)", tags: { a: "b" }, at: NOW };
    const plan = planItem(item, env);
    if (plan.type !== "group") throw new Error("expected a group");
    expect(plan.kind).toBe("error");
    expect(plan.fingerprint).toBe(`error:${plan.fp}`);
    expect(plan.title).toBe("User 42 not found");
    expect(plan.culprit).toBe("load@/assets/main.js");
    expect(plan.occurrence).toEqual({ kind: "error", at: NOW, release: "1.2.0" });
    expect(plan.sample).toMatchObject({ release: "1.2.0", environment: "prod", tags_json: '{"a":"b"}', level: "error" });
    const other = planItem({ ...item, message: "User 97 not found\nmore" }, env);
    expect(other.type === "group" && other.fp).toBe(plan.fp);
  });

  test("an explicit fingerprint wins", () => {
    const plan = planItem({ type: "error", message: "x", fingerprint: "mine", at: NOW }, {});
    expect(plan.type === "group" && plan.fingerprint).toBe("error:mine");
  });

  test("logs below warn are counted, not grouped", () => {
    expect(planItem({ type: "log", level: "info", message: "hi", at: NOW }, {})).toEqual({ type: "count" });
    expect(planItem({ type: "log", level: "warn", message: "hi", at: NOW }, {}).type).toBe("group");
  });

  test("jobs group by normalized name, checks by id under the invariant segment", () => {
    const job = planItem({ type: "job_failed", job: "Send Email", error: "boom", attempt: 2, at: NOW }, {});
    expect(job.type === "group" && job.fingerprint).toBe("job:send_email");
    expect(job.type === "group" && job.sample.context_json).toBe('{"attempt":2}');
    const check = planItem({ type: "check", id: "orders-balance", ok: false, title: "Orders balance", at: NOW }, {});
    expect(check.type === "group" && check.fingerprint).toBe("invariant:orders-balance");
    expect(check.type === "group" && check.occurrence.ok).toBe(false);
    expect(check.type === "group" && check.title).toBe("Orders balance");
  });

  test("a deploy takes the envelope's environment when it names none", () => {
    expect(planItem({ type: "deploy", version: "1.3.0", sha: "abc", at: NOW }, env)).toEqual({ type: "deploy", version: "1.3.0", sha: "abc", environment: "prod", at: NOW });
  });

  test("analytics events and replay manifests are counted only", () => {
    expect(planItem({ type: "event", name: "signup", at: NOW }, {})).toEqual({ type: "count" });
    expect(planItem({ type: "replay", replay_id: "r1", at: NOW }, {})).toEqual({ type: "count" });
  });
});

describe("watched metrics", () => {
  const watch = { short_id: "mw-3", name: "p95 latency", threshold: 800, direction: "above" as const };

  test("the line: above alerts past it, below under it, the line itself is ok", () => {
    expect(metricCrosses(801, 800, "above")).toBe(true);
    expect(metricCrosses(800, 800, "above")).toBe(false);
    expect(metricCrosses(9, 10, "below")).toBe(true);
    expect(metricCrosses(10, 10, "below")).toBe(false);
  });

  test("a value plans a metric occurrence keyed by the watch, carrying the value and its line", () => {
    const plan = planMetric({ ...watch, id: "w1" }, 950, NOW);
    expect(plan).toMatchObject({
      type: "group",
      kind: "metric",
      fp: "mw-3",
      fingerprint: "metric:mw-3",
      title: "p95 latency above 800",
      occurrence: { kind: "metric", at: NOW, ok: false },
      meta: { value: 950, threshold: 800, direction: "above", metric_watch_id: "w1" },
    });
  });

  test("a metric announces only when it flips: alert, stays, recovers", () => {
    const at = (i: number) => NOW - 10_000 + i;
    const occ = (value: number, i: number) => planMetric(watch, value, at(i)).occurrence;
    const { next, transitions } = foldOccurrences(null, [occ(500, 0), occ(900, 1), occ(950, 2), occ(700, 3), occ(990, 4)], NOW);
    expect(transitions.map((t) => t.transition)).toEqual(["metric_alert", "metric_recovered", "metric_alert"]);
    expect(next).toMatchObject({ status: "open", count: 3, meta: { ok: false } });
  });

  test("a first value across the line is an alert at once; a muted metric keeps counting silently", () => {
    expect(applyOccurrence(null, planMetric(watch, 900, NOW).occurrence, NOW).transition).toBe("metric_alert");
    const muted = applyOccurrence({ ...group({ kind: "metric", status: "muted" }), meta: { ok: true } }, planMetric(watch, 900, NOW).occurrence, NOW);
    expect(muted.transition).toBeUndefined();
    expect(muted.next.count).toBe(2);
  });

  test("points keep the newest metric_points, oldest first", () => {
    let points: { at: number; value: number }[] = [];
    for (let i = 0; i < GROUP_RULES.metric_points + 3; i++) points = appendMetricPoint(points, { at: i, value: i });
    expect(points).toHaveLength(GROUP_RULES.metric_points);
    expect(points[0].at).toBe(3);
  });
});
