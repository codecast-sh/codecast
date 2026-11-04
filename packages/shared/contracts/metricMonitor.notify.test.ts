import { describe, expect, test } from "bun:test";
import { DELIVERIES_KEPT, alertLine, appendDeliveries, normalizeNotify, notifyProblem, renotifyDue } from "./metricMonitor";

describe("alert notify", () => {
  test("one stored shape: ids unique and sorted, empty parts dropped, nothing when it reaches no one", () => {
    expect(normalizeNotify({ users: ["b", "a", "b"], channel: "" }, "me")).toEqual({ users: ["a", "b"], by: "me" });
    expect(normalizeNotify({ users: [], roles: [], fix: false, renotify_ms: 3600_000, recovery: true }, "me")).toBeUndefined();
    expect(normalizeNotify(null, "me")).toBeUndefined();
  });

  test("renotify and recovery only stand beside someone to tell; a fix alone keeps neither", () => {
    expect(normalizeNotify({ fix: true, renotify_ms: 3600_000, recovery: true }, "me")).toEqual({ fix: true, by: "me" });
    expect(normalizeNotify({ channel: "c1", renotify_ms: 3600_000, recovery: true }, "me")).toEqual({ channel: "c1", renotify_ms: 3600_000, recovery: true, by: "me" });
  });

  test("limits", () => {
    expect(notifyProblem({ users: Array.from({ length: 11 }, (_, i) => `u${i}`) })).toMatch(/at most 10 people/);
    expect(notifyProblem({ renotify_ms: 60_000 })).toMatch(/30 minutes/);
    expect(notifyProblem({ renotify_ms: 0 })).toBeNull();
  });

  test("renotify is due once the interval has passed since it was last said", () => {
    expect(renotifyDue({ renotify_ms: 1000 }, 0, 999)).toBe(false);
    expect(renotifyDue({ renotify_ms: 1000 }, 0, 1000)).toBe(true);
    expect(renotifyDue({}, 0, 10_000)).toBe(false);
    expect(renotifyDue({ renotify_ms: 1000 }, undefined, 10_000)).toBe(false);
  });

  test("the deliveries keep the newest", () => {
    const many = Array.from({ length: DELIVERIES_KEPT + 3 }, (_, i) => ({ at: i, kind: "crossed" as const, to: "@a", ok: true }));
    const kept = appendDeliveries([], many);
    expect(kept).toHaveLength(DELIVERIES_KEPT);
    expect(kept[0].at).toBe(3);
  });

  test("one line says what happened, with the value against the line", () => {
    const w = { short_id: "mw-8", name: "Exceptions", threshold: 15, direction: "above" as const };
    expect(alertLine(w, { kind: "crossed", value: 109.4, now: 0 })).toBe("mw-8 Exceptions crossed its line: 109, line > 15");
    expect(alertLine(w, { kind: "still", value: 20, since: 0, now: 3 * 3600_000 })).toBe("mw-8 Exceptions still alerting after 3h: 20, line > 15");
    expect(alertLine({ ...w, unit: "$" }, { kind: "recovered", value: 9.5, since: 0, now: 2 * 86400_000 })).toBe("mw-8 Exceptions recovered: $9.5, line > $15, after 2d");
    expect(alertLine(w, { kind: "crossed", value: null, now: 0, noData: true })).toBe("mw-8 Exceptions stopped answering, line > 15");
  });
});
