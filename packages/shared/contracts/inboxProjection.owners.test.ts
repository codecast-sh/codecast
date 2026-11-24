import { describe, expect, test } from "bun:test";
import {
  agentAnswersRow,
  agentOwnerOfRow,
  endedEscalationPatch,
  inboxEpoch,
  inWorkingSet,
  isUnderRole,
  isInboxMember,
  personWorkState,
  rideLeadPlacements,
  rollupParentIdOf,
  shouldShowInInbox,
  type InboxBucket,
  type ProjectableInboxRow,
} from "./inboxProjection";
import { placeProjectableRow, projectInbox } from "./inboxPlacement";
import { waitAudience, type SessionOwnerFacts } from "./sessionOwners";

// The owners model (team feature session_owners) is carried by the row: the
// server stamps owners_model only where the model applies. Every case runs the
// same row with the stamp (flag on) and without it (flag off).

const EPOCH = inboxEpoch(1_800_000_000_000);
const HOUR = 60 * 60 * 1000;

// A settled turn with content: needs_input on its own facts.
function waiting(id: string, overrides: Partial<ProjectableInboxRow> & Record<string, any> = {}): ProjectableInboxRow {
  return {
    _id: id,
    status: "active",
    updated_at: EPOCH - HOUR,
    message_count: 4,
    title: `Session ${id}`,
    agent_status: "idle",
    agent_status_updated_at: EPOCH - HOUR,
    is_idle: true,
    ...overrides,
  };
}

// Under the model; `mine` stamps owned_by_me, the viewer's own claim.
const on = (row: ProjectableInboxRow, mine = true): ProjectableInboxRow => ({ ...row, owners_model: true, owned_by_me: mine });

describe("agent owners answer: a wait files as working, With <owner>", () => {
  test("a role owner: flag on files working and keeps the raw work state; flag off is today's needs_input", () => {
    const row = waiting("s", { org_role_id: "role1" });
    expect(placeProjectableRow(row, false, EPOCH)).toEqual({ bucket: "needs_input", work_state: "needs_input" });
    const placed = placeProjectableRow(on(row), false, EPOCH);
    expect(placed).toEqual({ bucket: "working", work_state: "needs_input" });
    expect(personWorkState(on(row), placed)).toBe("working");
    expect(personWorkState(row, placeProjectableRow(row, false, EPOCH))).toBe("needs_input");
    expect(agentOwnerOfRow(on(row))).toEqual({ kind: "role", id: "role1" });
    expect(agentOwnerOfRow(row)).toBeNull();
  });

  test("a parent session owner answers the same way; the role comes first when both own it", () => {
    const child = waiting("c", { owner_session_id: "p" });
    expect(placeProjectableRow(on(child), false, EPOCH).bucket).toBe("working");
    expect(agentOwnerOfRow(on(child))).toEqual({ kind: "session", id: "p" });
    expect(agentOwnerOfRow(on({ ...child, org_role_id: "r" }))).toEqual({ kind: "role", id: "r" });
    // Flag off: no owner_session_id is stamped, and nothing answers.
    expect(placeProjectableRow(child, false, EPOCH).bucket).toBe("needs_input");
  });

  test("with no agent owner a wait is the person's under the flag too", () => {
    expect(placeProjectableRow(on(waiting("s")), false, EPOCH)).toEqual({ bucket: "needs_input", work_state: "needs_input" });
  });

  test("a wait that reached its people (unreachable or passed up) is Needs You until the next message", () => {
    // The stamp names the message count it covers: no clock is compared.
    const row = on(waiting("s", { org_role_id: "r", wait_up_at: EPOCH + 9 * HOUR, wait_up_count: 4 }));
    expect(agentAnswersRow(row)).toBe(false);
    expect(placeProjectableRow(row, false, EPOCH).bucket).toBe("needs_input");
    // The next message expires it however the clocks disagree: the agent answers again.
    expect(agentAnswersRow({ ...row, message_count: 5 })).toBe(true);
  });

  test("the person's figures read working in every section an agent-answered wait sits in, unless the person filed it", () => {
    const hand = on(waiting("s", { org_role_id: "r" }));
    for (const bucket of ["working", "pinned", "stashed", "snoozed", "dismissed"] as const) {
      expect(personWorkState(hand, { bucket, work_state: "needs_input" })).toBe("working");
    }
    expect(personWorkState(hand, { bucket: "questions", work_state: "needs_input" })).toBe("needs_input");
    expect(personWorkState({ ...hand, user_rest: "needs_input" }, { bucket: "needs_input", work_state: "needs_input" })).toBe("needs_input");
    expect(personWorkState({ ...hand, inbox_rest: "needs_input", inbox_rest_at: EPOCH } as any, { bucket: "needs_input", work_state: "needs_input" })).toBe("needs_input");
    expect(personWorkState(waiting("off", { org_role_id: "r" }), { bucket: "pinned", work_state: "needs_input" })).toBe("needs_input");
  });

  test("an escalated wait lists the person it reached while it stands, an owner or not", () => {
    const row = on(waiting("s", { org_role_id: "r", wait_up_count: 4, wait_up_person: "lead" }), false);
    expect(isInboxMember(row, "lead")).toBe(true);
    expect(isInboxMember({ ...row, message_count: 5 }, "lead")).toBe(false);
    expect(isInboxMember(waiting("off", { wait_up_count: 4, wait_up_person: "lead" }), "lead")).toBe(false);
  });

  test("the escalated seat is the wait's person's alone, while it stands, inside 30 days", () => {
    const row = on(waiting("s", { org_role_id: "r", inbox_dismissed_at: EPOCH - 40 * 24 * HOUR, wait_up_at: EPOCH - HOUR, wait_up_count: 4, wait_up_person: "lead" }), false);
    expect(inWorkingSet(row, EPOCH, "lead")).toEqual(["escalated"]);
    // Read off the wait itself: another viewer, a handed-on wait and an ended one hold no seat.
    expect(inWorkingSet(row, EPOCH, "me")).toEqual([]);
    expect(inWorkingSet({ ...row, wait_up_person: "admin" }, EPOCH, "lead")).toEqual([]);
    expect(inWorkingSet({ ...row, message_count: 5 }, EPOCH, "lead")).toEqual([]);
    // The server's by_wait_up_person range reads 30 days back.
    expect(inWorkingSet({ ...row, wait_up_at: EPOCH - 31 * 24 * HOUR }, EPOCH, "lead")).toEqual([]);
  });

  test("the person's own filing and pin come first", () => {
    const row = on(waiting("s", { org_role_id: "r" }));
    expect(placeProjectableRow({ ...row, inbox_rest: "needs_input", inbox_rest_at: EPOCH }, false, EPOCH).bucket).toBe("needs_input");
    expect(placeProjectableRow({ ...row, inbox_pinned_at: EPOCH - 2 * HOUR }, false, EPOCH).bucket).toBe("pinned");
  });

  test("an ask that reached the viewer (asking) still files under questions", () => {
    const row = on(waiting("s", { org_role_id: "r" }));
    expect(placeProjectableRow(row, true, EPOCH).bucket).toBe("questions");
  });

  test("working, done and dormant are unchanged under an agent owner", () => {
    const working = on(waiting("s", { org_role_id: "r", agent_status: "working", is_idle: false }));
    expect(placeProjectableRow(working, false, EPOCH)).toEqual({ bucket: "working", work_state: "working" });
    const done = on(waiting("d", { org_role_id: "r", agent_status: "done" }));
    expect(placeProjectableRow(done, false, EPOCH).bucket).toBe("done");
  });
});

describe("membership: only owned rows, nested ones included, nothing rides", () => {
  test("the viewer's owner row (owned_by_me) or their being the implicit starter makes it theirs; off the model nothing does", () => {
    expect(isInboxMember({ owners_model: true, owned_by_me: true }, "me")).toBe(true);
    expect(isInboxMember({ owners_model: true, implicit_owner: "me" }, "me")).toBe(true);
    expect(isInboxMember({ owners_model: true, implicit_owner: "a" }, "me")).toBe(false);
    expect(isInboxMember({ owners_model: true }, "me")).toBe(false);
    expect(isInboxMember({ owned_by_me: true }, "me")).toBe(false);
  });

  test("a nested row the viewer owns is a member under the flag; off it, it rides its parent", () => {
    const sub = waiting("c", { is_subagent: true, parent_conversation_id: "p", inbox_adopted_at: null });
    expect(shouldShowInInbox(sub)).toBe(false);
    expect(inWorkingSet(sub, EPOCH, "me")).toEqual([]);
    expect(shouldShowInInbox(on(sub))).toBe(true);
    // A subagent holds no recent seat (the server's recent index is top-level
    // only). The nested window seats one the viewer runs, released and owns
    // through the implicit starter; an owner row adds the owned window.
    const released = { ...on(sub, false), user_id: "me", implicit_owner: "me", parent_released_at: EPOCH - HOUR };
    expect(inWorkingSet(released, EPOCH, "me")).toEqual(["nested"]);
    expect(inWorkingSet({ ...released, owned_by_me: true }, EPOCH, "me")).toEqual(["nested", "owned"]);
    expect(inWorkingSet(on(sub), EPOCH, "me")).toEqual(["owned"]);
    // Never another viewer's, never one run elsewhere, and never a child whose
    // parent died without a release (its wait escalates instead).
    expect(inWorkingSet(released, EPOCH, "you")).toEqual([]);
    expect(inWorkingSet({ ...released, user_id: "bot" }, EPOCH, "me")).toEqual([]);
    expect(inWorkingSet({ ...released, parent_released_at: null }, EPOCH, "me")).toEqual([]);
    // An orphan (parent pointer, no message, not a subagent) is read by the
    // recent index like any top-level row.
    const orphan = waiting("o", { parent_conversation_id: "p" });
    expect(inWorkingSet(orphan, EPOCH, "me")).toEqual([]);
    expect(inWorkingSet(on(orphan, false), EPOCH, "me")).toEqual(["recent"]);
  });

  test("no role riding, teammate riding or child rollup under the flag", () => {
    const hand = { _id: "h", org_role_id: "r" };
    expect(isUnderRole(hand)).toBe(true);
    expect(isUnderRole(on(hand as any))).toBe(false);
    const mate = { _id: "m", agent_team_name: "t", agent_name: "w", spawned_by_conversation_id: "lead" };
    expect(rollupParentIdOf(mate)).toBe("lead");
    expect(rollupParentIdOf(on(mate as any))).toBeNull();
    const sub = { _id: "c", is_subagent: true, parent_conversation_id: "p" };
    expect(rollupParentIdOf(sub)).toBe("p");
    expect(rollupParentIdOf(on(sub as any))).toBeNull();
  });

  test("the projection: flag off a hand rides its role's standing session; flag on it stands alone", () => {
    const lead = waiting("lead", { standing_role_id: "r", anchor_id: "a", agent_status: "working", is_idle: false });
    const hand = waiting("hand", { org_role_id: "r" });
    const off = projectInbox([lead, hand], EPOCH);
    expect(off.placements.get("hand")!.bucket).toBe(off.placements.get("lead")!.bucket);
    const onProj = projectInbox([on(lead), on(hand)], EPOCH);
    expect(onProj.placements.get("hand")!.bucket).toBe("working");
    expect(onProj.placements.get("hand")!.work_state).toBe("needs_input");
    // The lead's standing session keeps its own anchor rule.
    expect(onProj.placements.get("lead")!.bucket).toBe("hidden");
  });

  test("rideLeadPlacements leaves a child_live standing session hidden under the flag", () => {
    const rows: Record<string, any> = { lead: { standing_role_id: "r", child_live: true } };
    const placements = new Map<string, { bucket: InboxBucket; work_state: "working" }>([["lead", { bucket: "hidden", work_state: "working" }]]);
    rideLeadPlacements(placements, (id) => rows[id]);
    expect(placements.get("lead")!.bucket).toBe("working");
    const onRows: Record<string, any> = { lead: { ...rows.lead, owners_model: true } };
    const onPlacements = new Map<string, { bucket: InboxBucket; work_state: "working" }>([["lead", { bucket: "hidden", work_state: "working" }]]);
    rideLeadPlacements(onPlacements, (id) => onRows[id]);
    expect(onPlacements.get("lead")!.bucket).toBe("hidden");
  });
});

describe("waitAudience: who a wait reaches past its agent (shared sessionOwners)", () => {
  const facts = (over: Partial<SessionOwnerFacts> = {}): SessionOwnerFacts => ({ rows: [], starter: null, ...over });
  test("a reachable agent hears it; otherwise people, the implicit starter, the human starter, then the fallback", () => {
    expect(waitAudience(facts({ org_role_id: "r", starter: "ann" }), { agentReachable: true, fallbackPerson: "lead" })).toEqual({ agent: { kind: "role", id: "r" }, people: [], person: null });
    expect(waitAudience(facts({ org_role_id: "r", rows: [{ user_id: "bo", added_at: 1 }] }), { agentReachable: false, fallbackPerson: "lead" }).people).toEqual(["bo"]);
    expect(waitAudience(facts({ starter: "ann" }), { agentReachable: false, fallbackPerson: "lead" })).toEqual({ agent: null, people: ["ann"], person: null });
    expect(waitAudience(facts({ parent_conversation_id: "p", starter: "ann" }), { agentReachable: false, fallbackPerson: "lead" })).toEqual({ agent: null, people: ["ann"], person: "ann" });
    // A bot run with no agent, no owners and no human starter: the fallback.
    expect(waitAudience(facts(), { agentReachable: false, fallbackPerson: "admin" })).toEqual({ agent: null, people: ["admin"], person: "admin" });
    expect(waitAudience(facts({ org_role_id: "r", role_started: true, starter: "ann" }), { agentReachable: false, fallbackPerson: "lead" }).people).toEqual(["lead"]);
  });
  test("never an excluded account: a bot owner row or a leaver is skipped down the chain", () => {
    const withBot = facts({ rows: [{ user_id: "bot", added_at: 1 }], parent_conversation_id: "p", starter: "ann" });
    expect(waitAudience(withBot, { agentReachable: false, fallbackPerson: null, exclude: ["bot"] })).toEqual({ agent: null, people: ["ann"], person: "ann" });
    expect(waitAudience(facts({ org_role_id: "r", role_started: true }), { agentReachable: false, fallbackPerson: "lead", exclude: ["lead"] }).people).toEqual([]);
  });
});

describe("endedEscalationPatch: the next message ends an escalation", () => {
  test("clears the stamps once the count moves past it, and nothing before", () => {
    expect(endedEscalationPatch({ wait_up_count: 4 }, 5)).toEqual({ wait_up_at: undefined, wait_up_count: undefined, wait_up_person: undefined });
    expect(endedEscalationPatch({ wait_up_count: 4 }, 4)).toEqual({});
    expect(endedEscalationPatch({}, 9)).toEqual({});
  });
});
