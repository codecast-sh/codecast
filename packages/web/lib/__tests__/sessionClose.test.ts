import { describe, expect, test } from "bun:test";
import { closeFactsOf, closeKindOf, closeSetsAside, closeTooltip, inFlightFactsOfRow, nestedInFlightOf, type CloseFacts } from "../sessionClose";

const NOW = 1_800_000_000_000;
const facts = (f: Partial<CloseFacts> = {}): CloseFacts => ({ inFlight: null, role: false, triggers: 0, waitingOnRun: false, ...f });

// One row per line of the brief's table: what Close does, and the words its tooltip says.
describe("what Close does to a session", () => {
  test("a session in flight is set aside and keeps running", () => {
    for (const inFlight of ["live", "awaiting", "queued", "workflow", "nested"] as const) {
      const f = facts({ inFlight, role: true, triggers: 2, waitingOnRun: true });
      expect(closeKindOf(f)).toBe("aside");
      expect(closeSetsAside(f)).toBe(true);
      expect(closeTooltip(f)).toBe("Close: hides it, lets it finish");
    }
  });

  test("a fresh /loop and a usage-limit park are set aside with their own words", () => {
    expect(closeSetsAside(facts({ inFlight: "loop" }))).toBe(true);
    expect(closeTooltip(facts({ inFlight: "loop" }))).toBe("Close: hides it, keeps its loop running");
    expect(closeSetsAside(facts({ inFlight: "limit" }))).toBe(true);
    expect(closeTooltip(facts({ inFlight: "limit" }))).toBe("Close: hides it, picks up when its limit resets");
  });

  test("a role's own session or one with armed triggers stops and keeps them", () => {
    expect(closeTooltip(facts({ triggers: 3 }))).toBe("Close: stops it, keeps its 3 triggers, comes back when one fires");
    expect(closeTooltip(facts({ triggers: 1 }))).toBe("Close: stops it, keeps its trigger, comes back when it fires");
    expect(closeTooltip(facts({ role: true }))).toBe("Close: stops it, comes back on its next message");
    expect(closeSetsAside(facts({ role: true, triggers: 2 }))).toBe(false);
  });

  test("a session waiting on a codecast flow run stops and comes back when the run reports", () => {
    expect(closeTooltip(facts({ waitingOnRun: true }))).toBe("Close: stops it, comes back when its run reports");
  });

  test("an ordinary finished session stops and leaves the list", () => {
    expect(closeKindOf(facts())).toBe("clears");
    expect(closeTooltip(facts())).toBe("Close: stops it, clears it from the list");
  });

  test("no tooltip names the old gestures", () => {
    for (const f of [facts({ inFlight: "live" }), facts({ inFlight: "loop" }), facts({ inFlight: "limit" }), facts({ role: true }), facts({ triggers: 2 }), facts({ waitingOnRun: true }), facts()]) {
      expect(closeTooltip(f)).not.toMatch(/kill|hibernat|stash/i);
    }
  });
});

describe("the facts of a row", () => {
  const settled = { message_count: 12, agent_status: "idle", updated_at: NOW - 60 * 60_000, last_heartbeat: NOW - 1000 };
  const reason = (row: Record<string, unknown>, pendingSend = false) => closeFactsOf(row as any, 0, NOW, pendingSend).inFlight;

  test("each in-flight fact, gathered from the row", () => {
    expect(reason(settled)).toBeNull();
    expect(reason({ ...settled, agent_status: "working", updated_at: NOW - 1000 })).toBe("live");
    expect(reason({ ...settled, awaiting_input: true })).toBe("awaiting");
    expect(inFlightFactsOfRow({ ...settled, has_pending: true }, NOW).queued).toBe(true);
    expect(reason({ ...settled, has_pending: true })).not.toBeNull();
    expect(reason(settled, true)).toBe("queued");
    expect(reason({ ...settled, workflow_run_id: "w1", workflow_run_status: "running", workflow_run_kind: "workflow" })).toBe("workflow");
    expect(reason({ ...settled, loop_state: { status: "armed", wakeup_at: NOW + 60_000, event_at: NOW - 1000 } })).toBe("loop");
    expect(reason({ ...settled, agent_type: "claude_code", pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000 })).toBe("limit");
  });

  test("a long-overdue /loop and an old usage-limit park hold nothing", () => {
    expect(reason({ ...settled, loop_state: { status: "armed", wakeup_at: NOW - 60 * 60_000, event_at: NOW - 2 * 60 * 60_000 } })).toBeNull();
    expect(reason({ ...settled, agent_type: "claude_code", pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 30 * 24 * 3_600_000 })).toBeNull();
  });

  test("a lead any member of whose nested group is in flight, by the same verdict, is set aside", () => {
    const loop = { status: "armed", wakeup_at: NOW + 60_000, event_at: NOW - 1000 };
    const child = (parent: string, extra: Record<string, unknown>) => ({ ...settled, parent_conversation_id: parent, ...extra });
    const rows = [
      child("busy", { agent_status: "working", updated_at: NOW - 1000 }),
      child("loop", { loop_state: loop }),
      child("limit", { agent_type: "claude_code", pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000 }),
      child("flow", { workflow_run_id: "w1", workflow_run_status: "running", workflow_run_kind: "workflow" }),
      child("queued", { has_pending: true }),
      child("asking", { awaiting_input: true }),
      child("idle", {}),
      { ...settled, agent_status: "working", updated_at: NOW - 1000, spawned_by_conversation_id: "team", agent_team_name: "crew", agent_name: "worker" },
      // A cast-spawn worker (spawned_by, no team) is not nested: it never comes down with its spawner.
      { ...settled, agent_status: "working", updated_at: NOW - 1000, spawned_by_conversation_id: "spawner" },
    ];
    for (const lead of ["busy", "loop", "limit", "flow", "queued", "asking", "team"]) expect([lead, nestedInFlightOf(rows as any, lead, NOW)]).toEqual([lead, true]);
    for (const lead of ["idle", "spawner"]) expect([lead, nestedInFlightOf(rows as any, lead, NOW)]).toEqual([lead, false]);
    const f = closeFactsOf(settled, 0, NOW, false, true);
    expect(f.inFlight).toBe("nested");
    expect(closeTooltip(f)).toBe("Close: hides it, lets it finish");
  });

  test("triggers count the roster and the row's own armed flag, never a /loop", () => {
    expect(closeFactsOf(settled, 2, NOW).triggers).toBe(2);
    expect(closeFactsOf({ ...settled, armed_trigger_kind: "standing" }, 0, NOW).triggers).toBe(1);
  });

  test("a codecast flow run is a wake it comes back on; a Workflow-tool run runs inside it", () => {
    const flow = { ...settled, workflow_run_id: "w1", workflow_run_status: "running" };
    expect(closeFactsOf(flow, 0, NOW).waitingOnRun).toBe(true);
    expect(closeFactsOf({ ...flow, workflow_run_kind: "workflow" }, 0, NOW).waitingOnRun).toBe(false);
    expect(closeFactsOf({ ...flow, workflow_run_status: "completed" }, 0, NOW).waitingOnRun).toBe(false);
    expect(closeFactsOf({ ...flow, is_workflow_sub: true }, 0, NOW).waitingOnRun).toBe(false);
  });

  test("inFlightFactsOfRow is the whole fact set, nothing more", () => {
    expect(Object.keys(inFlightFactsOfRow(settled, NOW)).sort()).toEqual(["awaitingInput", "inProcessRun", "limitParked", "loopFresh", "queued", "turnLive"]);
  });
});
