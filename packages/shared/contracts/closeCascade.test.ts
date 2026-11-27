import { describe, expect, test } from "bun:test";
import { adoptedByClose, cascadeTakesDownRow, closeAdoptionWindow, closeLeavesStanding, leadStillInClose, NESTED_GROUP_SCAN, goesDownWithLead, standsApartFromLead, stillHolds, type HoldFacts } from "./closeCascade";
import { IN_FLIGHT_FACT_KEYS } from "./closedSession";

// A Claude Code Task-tool subagent (session id "agent-…") runs inside its
// lead's process and a teammate is the lead's team: both go down with a close
// of the lead. A `cast spawn` worker has its own process and stays up.
const taskSub = { session_id: "agent-a009f4fcdcbf7ef81", is_subagent: true, parent_conversation_id: "lead" };
const spawned = { session_id: "ca19ce3d-0000-4000-8000-000000000001", is_subagent: true, parent_conversation_id: "lead" };
const teammate = { session_id: "5b1e0000-0000-4000-8000-000000000002", spawned_by_conversation_id: "lead", agent_team_name: "t", agent_name: "reviewer" };
const nothing = Object.fromEntries([...IN_FLIGHT_FACT_KEYS, "processAlive", "triggerArmed"].map((k) => [k, false])) as HoldFacts;

describe("goesDownWithLead", () => {
  test("a Task subagent, a teammate and a codex child go down; a spawned child and the team lead do not", () => {
    expect(goesDownWithLead(taskSub)).toBe(true);
    expect(goesDownWithLead(teammate)).toBe(true);
    // A codex child the daemon linked from the lead's transcript (stamped --print: a thread_spawn or a `codex exec`).
    expect(goesDownWithLead({ session_id: "019a0000-codex-thread", agent_type: "codex", parent_conversation_id: "lead", cli_flags: "--print" })).toBe(true);
    // A codex child /cli/spawn started under the lead with no spawner session (a flow station, `cast spawn --parent`): its own process.
    expect(goesDownWithLead({ session_id: "019a0000-codex-station", agent_type: "codex", parent_conversation_id: "lead", is_subagent: true } as any)).toBe(false);
    expect(goesDownWithLead({ session_id: "019a0000-codex-station", agent_type: "codex", parent_conversation_id: "lead", cli_flags: "--interactive" })).toBe(false);
    // A client row never carries cli_flags: the server's verdict rides as headless_launch.
    expect(goesDownWithLead({ session_id: "019a0000-codex-thread", agent_type: "codex", parent_conversation_id: "lead", headless_launch: true })).toBe(true);
    expect(goesDownWithLead({ session_id: "019a0000-codex-station", agent_type: "codex", parent_conversation_id: "lead", headless_launch: false })).toBe(false);
    // A named workflow agent id is not a Claude subagent transcript id.
    expect(goesDownWithLead({ session_id: "agent-averify-bugs-7-9-06a0cd0a0f0da259" })).toBe(false);
    expect(goesDownWithLead(spawned)).toBe(false);
    expect(goesDownWithLead({ ...teammate, agent_name: "team-lead" })).toBe(false);
    // A cast-spawned codex worker (spawn stamps spawned_by) has its own process.
    expect(goesDownWithLead({ session_id: "019a0000-codex-worker", agent_type: "codex", parent_conversation_id: "lead", spawned_by_conversation_id: "lead" })).toBe(false);
    // A codex session with no parent is nobody's child.
    expect(goesDownWithLead({ session_id: "019a0000-codex-top", agent_type: "codex" })).toBe(false);
    expect(goesDownWithLead({})).toBe(false);
  });
  // The stored fact decides over the session id: a child promoted to its own
  // process outlives its lead, and a teammate still goes down with it.
  test("runs_in_parent decides when the row holds it", () => {
    expect(goesDownWithLead({ ...taskSub, runs_in_parent: false })).toBe(false);
    expect(goesDownWithLead({ ...spawned, runs_in_parent: true })).toBe(true);
    expect(goesDownWithLead({ ...teammate, runs_in_parent: false })).toBe(true);
  });
});

describe("closeAdoptionWindow", () => {
  test("the newest NESTED_GROUP_SCAN parent-linked children of the lead, as the server reads them", () => {
    const rows = [
      ...Array.from({ length: NESTED_GROUP_SCAN + 5 }, (_, i) => ({ _id: `k${i}`, parent_conversation_id: "lead", _creationTime: 1000 + i })),
      { _id: "other", parent_conversation_id: "elsewhere", _creationTime: 9999 },
      { _id: "byStart", parent_conversation_id: "lead", started_at: 99_999 },
    ];
    const w = closeAdoptionWindow(rows, "lead");
    expect(w.size).toBe(NESTED_GROUP_SCAN);
    expect(w.has("byStart")).toBe(true);
    expect(w.has(`k${NESTED_GROUP_SCAN + 4}`)).toBe(true);
    expect(w.has("k0")).toBe(false);
    expect(w.has("other")).toBe(false);
  });
});

describe("leadStillInClose", () => {
  test("only while the lead is closed by that stamp, not back, set aside or killed", () => {
    expect(leadStillInClose({ inbox_dismissed_at: 5, inbox_closed_at: 5 }, 5)).toBe(true);
    expect(leadStillInClose({ inbox_closed_at: 5 }, 5)).toBe(false); // came back
    expect(leadStillInClose({ inbox_closed_at: 5, inbox_stashed_at: 5 } as any, 5)).toBe(false); // set aside
    expect(leadStillInClose({ inbox_dismissed_at: 5, inbox_closed_at: 5, inbox_killed_at: 6 }, 5)).toBe(false);
    expect(leadStillInClose({ inbox_dismissed_at: 7, inbox_closed_at: 7 }, 5)).toBe(false); // another close
  });
});

describe("adoptedByClose", () => {
  test("keys an adoption to the close that stamped it", () => {
    expect(adoptedByClose({ inbox_adopted_at: 5 }, 5)).toBe(true);
    expect(adoptedByClose({ inbox_adopted_at: 7 }, 5)).toBe(false);
    expect(adoptedByClose({}, 5)).toBe(false);
    expect(adoptedByClose({ inbox_adopted_at: 5 }, null)).toBe(false);
  });
});

describe("cascadeTakesDownRow", () => {
  const close = { close: true, forceKill: true, queued: false };
  test("a close takes down the Task subagent and the teammate, not the spawned child", () => {
    expect(cascadeTakesDownRow(taskSub, "inbox_dismissed_at", close)).toBe(true);
    expect(cascadeTakesDownRow(teammate, "inbox_dismissed_at", close)).toBe(true);
    expect(cascadeTakesDownRow(spawned, "inbox_dismissed_at", close)).toBe(false);
  });
  test("a close skips one already closed or killed", () => {
    expect(cascadeTakesDownRow({ ...taskSub, inbox_dismissed_at: 5, inbox_closed_at: 5 }, "inbox_dismissed_at", close)).toBe(false);
    expect(cascadeTakesDownRow({ ...taskSub, inbox_dismissed_at: 5, inbox_killed_at: 5 }, "inbox_dismissed_at", close)).toBe(false);
  });
  test("a kill takes the whole group", () => {
    for (const kid of [taskSub, spawned, teammate]) expect(cascadeTakesDownRow(kid, "inbox_dismissed_at", { forceKill: true, queued: false })).toBe(true);
  });
  test("a close that sets the lead aside stashes as a stash does: the teammate, not the nested rows", () => {
    expect(cascadeTakesDownRow(teammate, "inbox_stashed_at", { close: true, queued: false })).toBe(true);
    expect(cascadeTakesDownRow(spawned, "inbox_stashed_at", { close: true, queued: false })).toBe(false);
  });
});

describe("closeLeavesStanding", () => {
  test("only a nested child the close leaves up stands apart; one already hidden or adopted does not", () => {
    expect(standsApartFromLead(spawned)).toBe(true);
    expect(standsApartFromLead(taskSub)).toBe(false);
    expect(standsApartFromLead(teammate)).toBe(false);
    for (const k of ["inbox_dismissed_at", "inbox_stashed_at", "inbox_killed_at", "inbox_adopted_at"]) expect(standsApartFromLead({ ...spawned, [k]: 5 })).toBe(false);
  });
  test("it is adopted only while it still holds something", () => {
    expect(stillHolds(nothing)).toBe(false);
    expect(closeLeavesStanding(spawned, nothing)).toBe(false);
    for (const k of ["processAlive", "triggerArmed", "turnLive", "queued", "loopFresh", "awaitingInput", "limitParked", "fleetQueued", "openBackgroundWork", "inProcessRun"] as const) {
      expect([k, closeLeavesStanding(spawned, { ...nothing, [k]: true })]).toEqual([k, true]);
    }
    expect(closeLeavesStanding(taskSub, { ...nothing, processAlive: true })).toBe(false);
  });
});
