import { expect, test } from "bun:test";
import { buildOffloadPlan, type OffloadPlanInput } from "./resourceOffload";
import type { ResourcePoint } from "@codecast/shared/contracts";
const point = (at: number): ResourcePoint => ({ at, cpuPercent: 95, memoryTotal: 1000, memoryAvailable: 500, memoryAvailableIsEstimate: true, pressure: "normal", load1: 20, logicalCpus: 8, processCount: 1 });
function input(): OffloadPlanInput {
  const source: OffloadPlanInput["source"] = { deviceId: "mac", name: "Mac", role: "local", platform: "darwin", online: true, receivedAt: 60000, history: [point(0), point(30000), point(60000)], snapshot: { version: 1, deviceId: "mac", platform: "darwin", sample: point(60000), processes: [{ pid: 1, ppid: 0, sessionId: "s", name: "node", kind: "tool", rss: 100, cpu: 10 }], groups: [], omittedProcessCount: 0, collectionDurationMs: 1, limitations: [] } };
  return { source, now: 60000, machines: [source, { deviceId: "linux", name: "Linux", role: "cloud_linux", platform: "linux", online: true, history: [] }], devices: [{ device_id: "mac", online: true, is_remote: false, platform: "darwin" }, { device_id: "linux", online: true, is_remote: true, platform: "linux" }], sessions: [{ sessionId: "s", conversationId: "c", title: "Build", state: "idle", deviceId: "mac" }], candidates: [{ _id: "c", short_id: null, title: "Build", owner_device_id: "mac", agent_type: "claude_code", project_path: null, worktree_name: null, worktree_branch: null, updated_at: 0, has_pending_messages: false, migration: null, cloud_placement: null, inbox_stashed_at: null, inbox_dismissed_at: null }] };
}
test("recommendations need fresh source evidence and retain unknown host capacity", () => {
  const args = input();
  const plan = buildOffloadPlan(args)!;
  expect(plan.candidates).toHaveLength(1);
  expect(plan.destinations[0].headroom).toBeUndefined();
  expect(plan.candidates[0].perDestination.linux.readiness).toBe("preflight_required");
  expect(plan.candidates[0].relief).toEqual({ cpu: 10, rssLow: 0, rssHigh: 100 });
  args.source.receivedAt = -200000;
  expect(buildOffloadPlan(args)).toBeNull();
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
