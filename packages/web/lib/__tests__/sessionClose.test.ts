import { describe, expect, test } from "bun:test";
import { IN_FLIGHT_FACT_KEYS } from "@codecast/shared/contracts";
import { closeFactsOf, closeKindOf, closeSetsAside, closeTakesDownOf, closeTooltip, inFlightFactsOfRow, nestedInFlightOf, type CloseFacts } from "../sessionClose";

const NOW = 1_800_000_000_000;
// A role never comes back on done (closeReturnsOnDone), so the facts follow unless a test says otherwise.
const facts = (f: Partial<CloseFacts> = {}): CloseFacts => ({ inFlight: null, role: false, returnsOnDone: !f.role, triggers: 0, waitingOnRun: false, takesDown: 0, ...f });

// One row per line of the brief's table: what Close does, and the words its tooltip says.
describe("what Close does to a session", () => {
  test("a session in flight is set aside and keeps running", () => {
    for (const inFlight of ["live", "queued", "workflow", "nested"] as const) {
      const f = facts({ inFlight, role: true, triggers: 2, waitingOnRun: true });
      expect(closeKindOf(f)).toBe("aside");
      expect(closeSetsAside(f)).toBe(true);
      expect(closeTooltip(f)).toBe("Close: hides it, back when it needs you");
      expect(closeTooltip(facts({ inFlight }))).toBe("Close: hides it, back when it reports done or needs you");
    }
  });

  test("a session waiting on a permission prompt or poll is set aside, and its tooltip says it still waits on you", () => {
    const f = facts({ inFlight: "awaiting", triggers: 2 });
    expect(closeKindOf(f)).toBe("awaiting");
    expect(closeSetsAside(f)).toBe(true);
    expect(closeTooltip(f)).toBe("Close: hides it; it still waits on you");
    const prompted = { message_count: 12, agent_status: "working", updated_at: NOW - 1000, last_heartbeat: NOW - 500, awaiting_input: true };
    expect(closeTooltip(closeFactsOf(prompted as any, 0, NOW))).toBe("Close: hides it; it still waits on you");
  });

  test("a fresh /loop and a usage-limit park are set aside with their own words", () => {
    expect(closeSetsAside(facts({ inFlight: "loop" }))).toBe(true);
    expect(closeTooltip(facts({ inFlight: "loop" }))).toBe("Close: hides it, keeps its loop, back when it reports done or needs you");
    expect(closeSetsAside(facts({ inFlight: "limit" }))).toBe(true);
    expect(closeTooltip(facts({ inFlight: "limit" }))).toBe("Close: hides it, still parked on its limit");
    expect(closeTooltip(facts({ inFlight: "background" }))).toBe("Close: hides it, keeps its background work, back when it reports done or needs you");
  });

  test("a role's own session or one with armed triggers stops and keeps them", () => {
    expect(closeTooltip(facts({ triggers: 3 }))).toBe("Close: stops it, runs its 3 triggers out of sight, back when it reports done or needs you");
    expect(closeTooltip(facts({ triggers: 1 }))).toBe("Close: stops it, runs its trigger out of sight, back when it reports done or needs you");
    expect(closeTooltip(facts({ role: true }))).toBe("Close: stops it, back when it needs you");
    expect(closeSetsAside(facts({ role: true, triggers: 2 }))).toBe(false);
  });

  test("a role, or a session a standing trigger wakes, comes back only when it asks", () => {
    expect(closeTooltip(facts({ role: true, triggers: 4 }))).toBe("Close: stops it, runs its 4 triggers out of sight, back when it needs you");
    expect(closeTooltip(facts({ returnsOnDone: false, triggers: 1 }))).toBe("Close: stops it, runs its trigger out of sight, back when it needs you");
    const settled = { message_count: 12, agent_status: "idle", updated_at: NOW - 60 * 60_000, last_heartbeat: NOW - 1000 };
    expect(closeFactsOf({ ...settled, armed_trigger_kind: "standing" } as any, 1, NOW).returnsOnDone).toBe(false);
    expect(closeFactsOf({ ...settled, standing_role_id: "r1" } as any, 0, NOW).returnsOnDone).toBe(false);
    expect(closeFactsOf({ ...settled, persistent: true } as any, 0, NOW).returnsOnDone).toBe(false);
    // A one-off trigger is an ordinary session's: it comes back when a run finishes.
    const once = closeFactsOf({ ...settled, armed_trigger_kind: "once" } as any, 1, NOW);
    expect(once.returnsOnDone).toBe(true);
    expect(closeTooltip(once)).toBe("Close: stops it, runs its trigger out of sight, back when it reports done or needs you");
  });

  test("a session waiting on a codecast flow run stops and comes back when the run finishes", () => {
    expect(closeTooltip(facts({ waitingOnRun: true }))).toBe("Close: stops it, its run goes on, back when it reports done or needs you");
  });

  test("an ordinary finished session stops and leaves the list", () => {
    expect(closeKindOf(facts())).toBe("clears");
    expect(closeTooltip(facts())).toBe("Close: stops it, back when it reports done or needs you");
  });

  test("a stop that takes the agents under it down names them, with the count", () => {
    expect(closeTooltip(facts({ takesDown: 4 }))).toBe("Close: stops it and the 4 agents under it, back when it reports done or needs you");
    expect(closeTooltip(facts({ takesDown: 1 }))).toBe("Close: stops it and the agent under it, back when it reports done or needs you");
    expect(closeTooltip(facts({ takesDown: 2, triggers: 3 }))).toBe("Close: stops it and the 2 agents under it, runs its 3 triggers out of sight, back when it reports done or needs you");
    expect(closeTooltip(facts({ takesDown: 2, role: true }))).toBe("Close: stops it and the 2 agents under it, back when it needs you");
    expect(closeTooltip(facts({ takesDown: 2, waitingOnRun: true }))).toBe("Close: stops it and the 2 agents under it, its run goes on, back when it reports done or needs you");
    // A close set aside stops nothing, so it names nothing.
    expect(closeTooltip(facts({ takesDown: 2, inFlight: "live" }))).toBe("Close: hides it, back when it reports done or needs you");
  });

  test("no tooltip names the old gestures", () => {
    for (const f of [facts({ inFlight: "live" }), facts({ inFlight: "awaiting" }), facts({ inFlight: "loop" }), facts({ inFlight: "limit" }), facts({ role: true }), facts({ triggers: 2 }), facts({ waitingOnRun: true }), facts()]) {
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

  test("a lead any Task subagent or teammate of which is in flight, by the same verdict, is set aside", () => {
    const loop = { status: "armed", wakeup_at: NOW + 60_000, event_at: NOW - 1000 };
    const child = (parent: string, extra: Record<string, unknown>) => ({ ...settled, session_id: `agent-a0a0a0${Buffer.from(parent).toString("hex")}`, is_subagent: true, parent_conversation_id: parent, ...extra });
    const rows = [
      child("busy", { agent_status: "working", updated_at: NOW - 1000 }),
      child("loop", { loop_state: loop }),
      child("limit", { agent_type: "claude_code", pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000 }),
      child("flow", { workflow_run_id: "w1", workflow_run_status: "running", workflow_run_kind: "workflow" }),
      child("queued", { has_pending: true }),
      child("asking", { awaiting_input: true }),
      child("idle", {}),
      // A teammate goes down with its lead, so mid-turn it holds the close.
      // Children with a process of their own stay up, so mid-turn they hold
      // nothing: a nested `cast spawn` worker, a spawned_by-only worker.
      { ...settled, session_id: "uuid-team", agent_status: "working", updated_at: NOW - 1000, spawned_by_conversation_id: "team", agent_team_name: "crew", agent_name: "worker" },
      { ...settled, session_id: "ca19ce3d-worker", agent_status: "working", updated_at: NOW - 1000, is_subagent: true, parent_conversation_id: "worker" },
      { ...settled, session_id: "uuid-spawner", agent_status: "working", updated_at: NOW - 1000, spawned_by_conversation_id: "spawner" },
    ];
    for (const lead of ["busy", "loop", "limit", "flow", "queued", "asking", "team"]) expect([lead, nestedInFlightOf(rows as any, lead, NOW)]).toEqual([lead, true]);
    for (const lead of ["idle", "spawner", "worker"]) expect([lead, nestedInFlightOf(rows as any, lead, NOW)]).toEqual([lead, false]);
    const f = closeFactsOf(settled, 0, NOW, false, true);
    expect(f.inFlight).toBe("nested");
    expect(closeTooltip(f)).toBe("Close: hides it, back when it reports done or needs you");
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

  test("inFlightFactsOfRow fills the whole shared fact set, nothing more", () => {
    expect(Object.keys(inFlightFactsOfRow(settled, NOW)).sort()).toEqual([...IN_FLIGHT_FACT_KEYS].sort());
  });

  test("a worker waiting in its fleet's queue is a wake: Close sets it aside, but not its lead, whose close leaves it up", () => {
    const q = { ...settled, session_id: "ca19ce3d-q", message_count: 0, subagent_slot: "queued" };
    expect(closeFactsOf(q, 0, NOW).inFlight).toBe("fleet");
    expect(closeSetsAside(closeFactsOf(q, 0, NOW))).toBe(true);
    expect(nestedInFlightOf([{ ...q, is_subagent: true, parent_conversation_id: "lead" }] as any, "lead", NOW)).toBe(false);
    expect(closeFactsOf({ ...settled, subagent_slot: "running" }, 0, NOW).inFlight).toBeNull();
  });

  test("open background work its daemon still vouches for is a wake: Close sets it aside", () => {
    const bg = { ...settled, agent_status: "waiting", open_tasks: [{ id: "b1", kind: "background", command: "bun run build" }], open_tasks_at: NOW - 30_000 };
    const f = closeFactsOf(bg, 0, NOW);
    expect(f.inFlight).toBe("background");
    expect(closeTooltip(f)).toBe("Close: hides it, keeps its background work, back when it reports done or needs you");
    // A report its daemon no longer heartbeats for vouches for nothing.
    expect(closeFactsOf({ ...bg, last_heartbeat: NOW - 3_600_000 }, 0, NOW).inFlight).toBeNull();
    expect(nestedInFlightOf([{ ...bg, session_id: "agent-a0a0a06267", parent_conversation_id: "lead" }] as any, "lead", NOW)).toBe(true);
  });

  test("a close takes down the lead's Task subagents and teammates not already closed or killed, and the tooltip counts them", () => {
    const kid = (sid: string, extra: Record<string, unknown> = {}) => ({ ...settled, _id: sid, session_id: sid, is_subagent: true, parent_conversation_id: "lead", ...extra });
    const rows = [
      kid("agent-a0a0a031"), kid("agent-a0a0a032"), kid("agent-a0a0a033"),
      kid("agent-a0a0a0636c6f736564", { inbox_dismissed_at: 5, inbox_closed_at: 5 }),
      kid("agent-a0a0a06b696c6c6564", { inbox_dismissed_at: 5, inbox_killed_at: 5 }),
      kid("ca19ce3d-spawned"),
      { ...settled, _id: "uuid-mate", session_id: "uuid-mate", spawned_by_conversation_id: "lead", agent_team_name: "crew", agent_name: "reviewer" },
    ];
    expect(closeTakesDownOf(rows as any, "lead").map((r: any) => r.session_id)).toEqual(["agent-a0a0a031", "agent-a0a0a032", "agent-a0a0a033", "uuid-mate"]);
    const f = closeFactsOf(settled, 0, NOW, false, nestedInFlightOf(rows as any, "lead", NOW), closeTakesDownOf(rows as any, "lead").length);
    expect(closeTooltip(f)).toBe("Close: stops it and the 4 agents under it, back when it reports done or needs you");
  });
});
