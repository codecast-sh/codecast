import { describe, expect, test } from "bun:test";
import { closeFactsOf, closeKindOf, closeSetsAside, closeTooltip, nestedRunningOf, type CloseFacts } from "../sessionClose";

const NOW = 1_800_000_000_000;
const facts = (f: Partial<CloseFacts> = {}): CloseFacts => ({ running: false, role: false, triggers: 0, waitingOnRun: false, ...f });

// One row per line of the brief's table: what Close does, and the words its tooltip says.
describe("what Close does to a session", () => {
  test("a session running a turn is set aside and keeps running", () => {
    const f = facts({ running: true, role: true, triggers: 2, waitingOnRun: true });
    expect(closeKindOf(f)).toBe("aside");
    expect(closeSetsAside(f)).toBe(true);
    expect(closeTooltip(f)).toBe("Close: hides it, lets it finish");
  });

  test("a role's own session or one with armed triggers stops and keeps them", () => {
    expect(closeTooltip(facts({ triggers: 3 }))).toBe("Close: stops it, keeps its 3 triggers, comes back when one fires");
    expect(closeTooltip(facts({ triggers: 1 }))).toBe("Close: stops it, keeps its trigger, comes back when it fires");
    expect(closeTooltip(facts({ role: true }))).toBe("Close: stops it, comes back on its next message");
    expect(closeSetsAside(facts({ role: true, triggers: 2 }))).toBe(false);
  });

  test("a session waiting on a workflow run stops and comes back when the run reports", () => {
    expect(closeTooltip(facts({ waitingOnRun: true }))).toBe("Close: stops it, comes back when its run reports");
  });

  test("an ordinary finished session stops and leaves the list", () => {
    expect(closeKindOf(facts())).toBe("clears");
    expect(closeTooltip(facts())).toBe("Close: stops it, clears it from the list");
  });

  test("no tooltip names the old gestures", () => {
    for (const f of [facts({ running: true }), facts({ role: true }), facts({ triggers: 2 }), facts({ waitingOnRun: true }), facts()]) {
      expect(closeTooltip(f)).not.toMatch(/kill|hibernat|stash/i);
    }
  });
});

describe("the facts of a row", () => {
  const settled = { message_count: 12, agent_status: "idle", updated_at: NOW - 60 * 60_000, last_heartbeat: NOW - 1000 };

  test("a producing agent is running; a send in flight is too", () => {
    expect(closeFactsOf({ ...settled, agent_status: "working", updated_at: NOW - 1000 }, 0, NOW).running).toBe(true);
    expect(closeFactsOf(settled, 0, NOW).running).toBe(false);
    expect(closeFactsOf(settled, 0, NOW, true).running).toBe(true);
  });

  test("a lead whose subagent or teammate is mid-turn is running, so Close sets it aside", () => {
    const busy = { ...settled, agent_status: "working", updated_at: NOW - 1000 };
    const rows = [
      { ...busy, parent_conversation_id: "lead" },
      { ...settled, parent_conversation_id: "idle-lead" },
      { ...busy, spawned_by_conversation_id: "team-lead", agent_team_name: "crew", agent_name: "worker" },
      // A cast-spawn worker (spawned_by, no team) is not nested: it never comes down with its spawner.
      { ...busy, spawned_by_conversation_id: "spawner" },
    ];
    expect(nestedRunningOf(rows, "lead", NOW)).toBe(true);
    expect(nestedRunningOf(rows, "team-lead", NOW)).toBe(true);
    expect(nestedRunningOf(rows, "idle-lead", NOW)).toBe(false);
    expect(nestedRunningOf(rows, "spawner", NOW)).toBe(false);
    const f = closeFactsOf(settled, 0, NOW, false, nestedRunningOf(rows, "lead", NOW));
    expect(closeSetsAside(f)).toBe(true);
    expect(closeTooltip(f)).toBe("Close: hides it, lets it finish");
  });

  test("a role is a persistent anchor or a role's own session", () => {
    expect(closeFactsOf({ ...settled, persistent: true }, 0, NOW).role).toBe(true);
    expect(closeFactsOf({ ...settled, standing_role_id: "r1" }, 0, NOW).role).toBe(true);
    expect(closeFactsOf(settled, 0, NOW).role).toBe(false);
  });

  test("triggers count the roster, a /loop, and the row's own armed flag before the roster loads", () => {
    expect(closeFactsOf(settled, 2, NOW).triggers).toBe(2);
    expect(closeFactsOf({ ...settled, loop_state: { status: "armed" } }, 2, NOW).triggers).toBe(3);
    expect(closeFactsOf({ ...settled, armed_trigger_kind: "standing" }, 0, NOW).triggers).toBe(1);
  });

  test("a running workflow run the session started is a wake; a sub of one is not", () => {
    expect(closeFactsOf({ ...settled, workflow_run_id: "w1", workflow_run_status: "running" }, 0, NOW).waitingOnRun).toBe(true);
    expect(closeFactsOf({ ...settled, workflow_run_id: "w1", workflow_run_status: "completed" }, 0, NOW).waitingOnRun).toBe(false);
    expect(closeFactsOf({ ...settled, workflow_run_id: "w1", workflow_run_status: "running", is_workflow_sub: true }, 0, NOW).waitingOnRun).toBe(false);
  });
});
