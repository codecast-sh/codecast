import { describe, expect, test } from "bun:test";
import { GROUP_RULES } from "@codecast/shared/contracts/ingest";
import { HOUR_MS, applyMirror, hourStart, overlayBuckets, type GroupState, type MirrorSnapshot } from "./ingestGroups";

// The mirror rule (external-data.md X7): a vendor's whole group state folded
// into ours, with the same transition names and silences as occurrences.

const NOW = Date.UTC(2026, 9, 3, 12, 30);
const HOUR = hourStart(NOW);
const SINCE = NOW - 10 * HOUR_MS; // the mirror started ten hours ago

const snap = (over: Partial<MirrorSnapshot> = {}): MirrorSnapshot => ({
  kind: "error",
  status: "open",
  count: 5,
  first_seen: NOW - HOUR_MS,
  last_seen: NOW - 60_000,
  ...over,
});

const group = (over: Partial<GroupState> = {}): GroupState => ({
  kind: "error",
  status: "open",
  count: 5,
  first_seen: NOW - 48 * HOUR_MS,
  last_seen: NOW - 2 * HOUR_MS,
  buckets: [],
  ...over,
});

const names = (r: ReturnType<typeof applyMirror>) => r.transitions.map((t) => t.transition);

describe("first read", () => {
  test("an issue first seen after the mirror started is new", () => {
    const r = applyMirror(null, snap(), NOW, SINCE);
    expect(names(r)).toEqual(["new"]);
    expect(r.next).toMatchObject({ status: "open", count: 5, last_transition: "new" });
  });

  test("backfill (first seen before the mirror) is recorded without announcing", () => {
    const r = applyMirror(null, snap({ first_seen: SINCE - HOUR_MS }), NOW, SINCE);
    expect(names(r)).toEqual([]);
    expect(r.next.status).toBe("open");
  });

  test("a regression the vendor already reported at the first read is recorded, not announced, and not announced later", () => {
    const first = applyMirror(null, snap({ first_seen: SINCE - 50 * HOUR_MS, regressed: true }), NOW, SINCE);
    expect(names(first)).toEqual([]);
    expect(first.next.regressed_at).toBeDefined();
    const again = applyMirror(first.next, snap({ first_seen: SINCE - 50 * HOUR_MS, regressed: true, count: 6 }), NOW, SINCE);
    expect(names(again)).toEqual([]);
  });

  test("a resolved issue read first is resolved and quiet", () => {
    const r = applyMirror(null, snap({ status: "resolved", resolved_in: "1.2.0" }), NOW, SINCE);
    expect(names(r)).toEqual([]);
    expect(r.next).toMatchObject({ status: "resolved", resolved_in: "1.2.0", resolved_at: NOW });
  });
});

describe("counts", () => {
  test("vendor counts replace ours and never go down", () => {
    expect(applyMirror(group({ count: 5 }), snap({ count: 9 }), NOW, SINCE).next.count).toBe(9);
    expect(applyMirror(group({ count: 9 }), snap({ count: 5 }), NOW, SINCE).next.count).toBe(9);
  });

  test("without hourly stats the delta lands in the last-seen hour", () => {
    const r = applyMirror(group({ count: 5 }), snap({ count: 8 }), NOW, SINCE);
    expect(r.next.buckets).toEqual([{ hour: HOUR, count: 3 }]);
  });

  test("hourly stats lay over our hours", () => {
    const b = overlayBuckets([{ hour: HOUR - 30 * HOUR_MS, count: 4 }, { hour: HOUR - HOUR_MS, count: 1 }], [{ hour: HOUR - HOUR_MS, count: 7 }, { hour: HOUR, count: 2 }], NOW);
    expect(b).toEqual([{ hour: HOUR - 30 * HOUR_MS, count: 4 }, { hour: HOUR - HOUR_MS, count: 7 }, { hour: HOUR, count: 2 }]);
  });

  test("a spike in the vendor's current hour announces once, then cools down", () => {
    const hourly = [{ hour: HOUR - 5 * HOUR_MS, count: 1 }, { hour: HOUR, count: GROUP_RULES.spike_min_count }];
    const r = applyMirror(group(), snap({ count: 40, hourly }), NOW, SINCE);
    expect(names(r)).toEqual(["spike"]);
    const again = applyMirror(r.next, snap({ count: 60, hourly: [...hourly.slice(0, 1), { hour: HOUR, count: 40 }] }), NOW + 60_000, SINCE);
    expect(names(again)).toEqual([]);
  });
});

describe("status", () => {
  test("a resolve in the vendor resolves the group and announces resolved", () => {
    const r = applyMirror(group(), snap({ status: "resolved", resolved_in: "web@2.0.0" }), NOW, SINCE);
    expect(names(r)).toEqual(["resolved"]);
    expect(r.next).toMatchObject({ status: "resolved", resolved_at: NOW, resolved_in: "web@2.0.0" });
    expect(names(applyMirror(r.next, snap({ status: "resolved" }), NOW + 1, SINCE))).toEqual([]);
  });

  test("activity after a resolve regresses", () => {
    const resolved = group({ status: "resolved", resolved_at: NOW - HOUR_MS });
    const r = applyMirror(resolved, snap({ last_seen: NOW - 60_000 }), NOW, SINCE);
    expect(names(r)).toEqual(["regressed"]);
    expect(r.next).toMatchObject({ status: "open", regressed_at: NOW - 60_000 });
  });

  test("a group resolved here stays resolved while the vendor shows nothing newer", () => {
    const resolved = group({ status: "resolved", resolved_at: NOW - 60_000 });
    const r = applyMirror(resolved, snap({ last_seen: NOW - HOUR_MS }), NOW, SINCE);
    expect(names(r)).toEqual([]);
    expect(r.next.status).toBe("resolved");
  });

  test("the vendor's regressed flag regresses a resolved group even with an older last seen", () => {
    const resolved = group({ status: "resolved", resolved_at: NOW - 60_000 });
    expect(names(applyMirror(resolved, snap({ last_seen: NOW - HOUR_MS, regressed: true }), NOW, SINCE))).toEqual(["regressed"]);
  });

  test("a regression read while the group is open here is announced once", () => {
    const r = applyMirror(group(), snap({ regressed: true }), NOW, SINCE);
    expect(names(r)).toEqual(["regressed"]);
    expect(names(applyMirror(r.next, snap({ regressed: true, count: 7 }), NOW + 120_000, SINCE))).toEqual([]);
  });

  test("ignored follows the vendor both ways, quietly", () => {
    const ignored = applyMirror(group(), snap({ status: "ignored" }), NOW, SINCE);
    expect(names(ignored)).toEqual([]);
    expect(ignored.next.status).toBe("ignored");
    const reopened = applyMirror(ignored.next, snap(), NOW, SINCE);
    expect(names(reopened)).toEqual([]);
    expect(reopened.next.status).toBe("open");
  });

  test("a resolve of an ignored group is quiet", () => {
    expect(names(applyMirror(group({ status: "ignored" }), snap({ status: "resolved" }), NOW, SINCE))).toEqual([]);
  });

  test("a local mute sticks and silences everything", () => {
    const muted = group({ status: "muted" });
    for (const s of [snap({ status: "resolved" }), snap({ regressed: true }), snap({ status: "ignored" })]) {
      const r = applyMirror(muted, s, NOW, SINCE);
      expect(names(r)).toEqual([]);
      expect(r.next.status).toBe("muted");
    }
  });
});
