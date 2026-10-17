import { describe, expect, test } from "bun:test";
import { assignDestinations, buildOffloadPlan, loadShareOf, loadShift, movableShare, sliceForPercent, SPREAD_CEILING, type OffloadPlanInput } from "./resourceOffload";
import type { OffloadCandidate, OffloadPlan } from "../components/resources/types";
import type { ResourcePoint } from "@codecast/shared/contracts";
const point = (at: number): ResourcePoint => ({ at, cpuPercent: 95, memoryTotal: 1000, memoryAvailable: 500, memoryAvailableIsEstimate: true, pressure: "normal", load1: 20, logicalCpus: 8, processCount: 1 });
function input(): OffloadPlanInput {
  const source: OffloadPlanInput["source"] = { deviceId: "mac", name: "Mac", role: "local", platform: "darwin", online: true, receivedAt: 180000, history: Array.from({ length: 7 }, (_, i) => point(i * 30000)), snapshot: { version: 1, deviceId: "mac", platform: "darwin", sample: point(180000), processes: [{ pid: 1, ppid: 0, sessionId: "s", name: "node", kind: "tool", rss: 100, cpu: 10 }], groups: [], omittedProcessCount: 0, collectionDurationMs: 1, limitations: [] } };
  return { source, now: 180000, machines: [source, { deviceId: "linux", name: "Linux", role: "cloud_linux", platform: "linux", online: true, history: [] }], devices: [{ device_id: "mac", online: true, is_remote: false, platform: "darwin" }, { device_id: "linux", online: true, is_remote: true, platform: "linux" }], sessions: [{ sessionId: "s", conversationId: "c", title: "Build", state: "idle", deviceId: "mac" }], candidates: [{ _id: "c", short_id: null, title: "Build", owner_device_id: "mac", agent_type: "claude_code", project_path: null, worktree_name: null, worktree_branch: null, updated_at: 0, has_pending_messages: false, migration: null, cloud_placement: null, inbox_stashed_at: null, inbox_dismissed_at: null }] };
}
test("recommendations need fresh source evidence and retain unknown host capacity", () => {
  const args = input();
  const plan = buildOffloadPlan(args)!;
  expect(plan.candidates).toHaveLength(1);
  expect(plan.destinations[0].sample).toBeUndefined();
  expect(plan.candidates[0].perDestination.linux.readiness).toBe("preflight_required");
  expect(plan.candidates[0].relief).toEqual({ cpu: 10, rssLow: 0, rssHigh: 100 });
  args.source.receivedAt = -200000;
  expect(buildOffloadPlan(args)).toBeNull();
});
test("a reporting laptop whose device heartbeat lapsed still offers its sessions", () => {
  const args = input();
  args.source.online = false;
  args.devices[0].online = false;
  const plan = buildOffloadPlan(args)!;
  expect(plan.candidates[0].perDestination.linux.readiness).toBe("preflight_required");
});
test("pins, unsupported harnesses and shared ownership are not offered", () => {
  for (const reason of ["pin", "harness", "shared"]) {
    const args = input();
    if (reason === "pin") args.sessions[0].pinned = true;
    if (reason === "harness") args.candidates[0].agent_type = "codex";
    if (reason === "shared") args.source.snapshot!.processes[0].sharedSessionIds = ["s", "another"];
    const plan = buildOffloadPlan(args)!;
    expect(plan.candidates).toEqual([]);
    expect(plan.notOffered).toHaveLength(1);
  }
});
test("Apple-only tooling cannot be recommended to Linux", () => {
  const args = input();
  args.source.snapshot!.processes[0].name = "xcodebuild";
  const row = buildOffloadPlan(args)!.candidates[0];
  expect(row.perDestination.linux.readiness).toBe("blocked");
  expect(row.suggestedDestinationId).toBeUndefined();
  expect(row.requiresMac).toBeDefined();
});

test("loadShift spreads session CPU over the machine's cores and moves memory by resident size", () => {
  const sample = { ...point(0), cpuPercent: 80, logicalCpus: 8, memoryTotal: 1000, memoryAvailable: 100 };
  expect(loadShift(sample, { cpu: 400, rss: 300 }, -1)).toEqual({ before: { cpu: 80, memory: 90 }, after: { cpu: 30, memory: 60 } });
  expect(loadShift({ ...sample, cpuPercent: 10 }, { cpu: 400, rss: 300 }, 1).after).toEqual({ cpu: 60, memory: 120 });
  expect(loadShift({ ...sample, cpuPercent: undefined }, { cpu: 400, rss: 0 }, -1).after.cpu).toBeUndefined();
});

describe("assignDestinations", () => {
  const ok = { readiness: "preflight_required" as const, blockers: [], pending: [] };
  const cand = (id: string, rss: number, to = ["a", "b"]): OffloadCandidate => ({ sessionId: id, reason: "", confidence: "low", relief: { cpu: 0, rssHigh: rss }, stops: [], staysLocal: [], disruption: "idle", perDestination: Object.fromEntries(to.map((d) => [d, ok])) });
  const host = (deviceId: string, available: number, extra: Partial<OffloadPlan["destinations"][number]> = {}) => ({ deviceId, name: deviceId, role: "cloud_linux" as const, online: true, sample: { ...point(0), cpuPercent: 10, memoryTotal: 1000, memoryAvailable: available }, ...extra });
  const plan = (destinations: OffloadPlan["destinations"], candidates: OffloadCandidate[]) => ({ deviceId: "mac", sourceSample: point(0), incident: { level: "elevated", reason: "", since: 0 }, generatedAt: 0, destinations, candidates, notOffered: [] }) as unknown as OffloadPlan;

  test("auto fills the preferred host to the ceiling, then spills onto the next", () => {
    const cs = [cand("x", 300), cand("y", 300), cand("z", 300)];
    const got = assignDestinations(plan([host("a", 900), host("b", 900)], cs), cs, "auto");
    expect([...got.values()].sort()).toEqual(["a", "a", "b"]);
    expect(SPREAD_CEILING).toBe(80);
  });
  test("auto keeps a batch on one host when it fits, preferring the online, measured, cheaper one", () => {
    const cs = [cand("x", 100), cand("y", 100)];
    const got = assignDestinations(plan([host("b", 900, { costPerHour: 2 }), host("a", 900, { costPerHour: 1 })], cs), cs, "auto");
    expect([...got.values()]).toEqual(["a", "a"]);
    const asleep = assignDestinations(plan([host("a", 900, { online: false, asleep: true }), host("b", 900)], cs), cs, "auto");
    expect([...asleep.values()]).toEqual(["b", "b"]);
  });
  test("a session that fits nowhere goes where it pushes load least; blocked hosts are skipped", () => {
    const big = cand("x", 950);
    expect(assignDestinations(plan([host("a", 100), host("b", 500)], [big]), [big], "auto").get("x")).toBe("b");
    const onlyB = cand("y", 10, ["b"]);
    expect(assignDestinations(plan([host("a", 900), host("b", 900)], [onlyB]), [onlyB], "auto").get("y")).toBe("b");
  });
  test("a named host takes every session it can; the rest keep their own suggestion", () => {
    const cs = [cand("x", 10), { ...cand("y", 10, ["b"]), suggestedDestinationId: "b" }];
    const got = assignDestinations(plan([host("a", 900), host("b", 900)], cs), cs, "a");
    expect(Object.fromEntries(got)).toEqual({ x: "a", y: "b" });
  });
});

describe("sliceForPercent", () => {
  const ok = { readiness: "preflight_required" as const, blockers: [], pending: [] };
  // 8 cores at 50% = 400 CPU in use; 600 of 1000 memory in use.
  const sample = { ...point(0), cpuPercent: 50, logicalCpus: 8, memoryTotal: 1000, memoryAvailable: 400 };
  const cand = (id: string, cpu: number, rss: number, disruption: "idle" | "mid_turn" = "idle"): OffloadCandidate => ({ sessionId: id, reason: "", confidence: "low", relief: { cpu, rssHigh: rss }, stops: [], staysLocal: [], disruption, perDestination: { a: ok } });
  const cs = [cand("big", 200, 300), cand("mid", 80, 120), cand("small", 20, 30), cand("busy", 200, 300, "mid_turn")];

  test("a session's share is the mean of its CPU and memory shares", () => {
    expect(loadShareOf(cs[0], sample)).toBe(0.5);
    expect(loadShareOf(cs[2], sample)).toBe(0.05);
  });

  test("idle sessions go before working ones, biggest first, and the overshoot is trimmed", () => {
    expect(sliceForPercent(cs, sample, 0)).toEqual({ ids: [], share: 0 });
    expect(sliceForPercent(cs, sample, 40).ids).toEqual(["big"]);
    expect(sliceForPercent(cs, sample, 55).ids).toEqual(["big", "small"]);
    expect(sliceForPercent(cs, sample, 65).ids).toEqual(["big", "mid"]);
    expect(sliceForPercent(cs, sample, 90).ids).toEqual(["big", "busy"]);
    expect(sliceForPercent(cs.slice(0, 3), sample, 60).ids).toEqual(["big", "mid"]);
  });

  test("asking for more than can move takes everything and says how much that is", () => {
    const r = sliceForPercent(cs.slice(0, 3), sample, 100);
    expect(r.ids).toHaveLength(3);
    expect(r.share).toBeCloseTo(0.75);
    expect(movableShare(cs, sample)).toBe(1);
  });
});
