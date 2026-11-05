import { describe, expect, test } from "bun:test";
import { DELIVERIES_KEPT } from "@codecast/shared/contracts/metricMonitor";
import { deliveriesByRow, lastUsedRoutes, notifySummary, notifyTargets, routedSilently, rowKey } from "./alertRoutingModel";

describe("alert routing on the web", () => {
  test("each delivery sits under its transition; a repeat under the crossing before it; inferred rows get none", () => {
    const rows = [
      { at: 1000, kind: "crossed" as const, value: 20 },
      { at: 5000, kind: "recovered" as const, value: 3 },
      { at: 1000, kind: "crossed" as const, value: 20, inferred: true },
    ];
    const out = deliveriesByRow(rows, [
      { at: 1010, kind: "crossed", to: "@ada", ok: true },
      { at: 3000, kind: "still", to: "@ada", ok: true },
      { at: 5005, kind: "recovered", to: "#ops", ok: true },
      { at: 90_000, kind: "crossed", to: "@ada", ok: true },
    ], 100);
    expect(out.get(rowKey(rows[0]))?.map((d) => d.kind)).toEqual(["crossed", "still"]);
    expect(out.get(rowKey(rows[1]))?.map((d) => d.to)).toEqual(["#ops"]);
    expect([...out.values()].flat()).toHaveLength(3);
  });

  test("targets are named from the roster and channels, the unknown as removed, and summed up in a few words", () => {
    const options = [
      { key: "u1", label: "Ada", info: { name: "Ada" }, you: true },
      { key: "r1", label: "Growth", info: { kind: "role", name: "Growth", handle: "growth" } as any, you: false },
    ];
    const n = { users: ["u1", "u9"], roles: ["r1"], channel: "c1", renotify_ms: 3600_000, recovery: true, fix: true, by: "u1" };
    const targets = notifyTargets(n, options as any, [{ _id: "c1", name: "ops" }]);
    expect(targets.map((t) => t.label)).toEqual(["Ada", "removed person", "@growth", "#ops"]);
    expect(notifySummary(n, targets)).toBe("Ada removed person @growth #ops · every 1h · recovery · fix starts");
    expect(notifySummary(undefined, [])).toBeNull();
  });
});

describe("an announced transition routing said nothing about", () => {
  const notify = { users: ["u1"], by: "me" };
  const crossed = { at: 1_000, kind: "crossed" as const, value: 5 };
  test("routed now, no delivery for it: no routes then", () => {
    expect(routedSilently(crossed, { notify, deliveries: [] })).toBe(true);
    expect(routedSilently(crossed, { notify: undefined, deliveries: [] })).toBe(false);
    expect(routedSilently({ ...crossed, inferred: true }, { notify, deliveries: [] })).toBe(false);
  });
  test("a recovery counts only when recovery is told", () => {
    const rec = { at: 2_000, kind: "recovered" as const, value: 1 };
    expect(routedSilently(rec, { notify, deliveries: [] })).toBe(false);
    expect(routedSilently(rec, { notify: { ...notify, recovery: true }, deliveries: [] })).toBe(true);
  });
  test("a full ring that no longer reaches back says nothing", () => {
    const deliveries = Array.from({ length: DELIVERIES_KEPT }, (_, i) => ({ at: 5_000 + i, kind: "crossed" as const, to: "@a", ok: true }));
    expect(routedSilently(crossed, { notify, deliveries })).toBe(false);
    expect(routedSilently({ ...crossed, at: 9_000 }, { notify, deliveries })).toBe(true);
  });
});

describe("a new watch's first routes", () => {
  const w = (workspace: string, updated_at: number, notify?: any) => ({ workspace, updated_at, notify });
  test("the workspace's most recently changed routed watch, people, roles and channel only", () => {
    const watches = [
      w("team:a", 10, { users: ["u1"], channel: "c1", by: "u1" }),
      w("team:a", 30, { roles: ["oncall"], channel: "c2", fix: true, renotify_ms: 3600_000, recovery: true, by: "u2" }),
      w("team:a", 50),
      w("team:b", 90, { users: ["u9"], by: "u9" }),
    ];
    expect(lastUsedRoutes(watches as any, "team:a", "me")).toEqual({ roles: ["oncall"], channel: "c2" });
  });
  test("nothing routed here: the person making it", () => {
    expect(lastUsedRoutes([w("team:b", 1, { users: ["u9"], by: "u9" })] as any, "team:a", "me")).toEqual({ users: ["me"] });
    expect(lastUsedRoutes([], "team:a", undefined)).toEqual({});
  });
});
