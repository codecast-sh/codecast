import { describe, expect, test } from "bun:test";
import { tallyInboxRows, placeConversationRow, ownAsk } from "./conversations";

// The `cast sessions` tally. This logic has been wrong twice — a killed row
// double-counted under a comment denying it, then `-a` zeroing the retirement
// figures while still listing those rows — and both times adversarial review
// caught it because nothing here was tested. These pin the contract so either
// regression fails a test instead of shipping.
//
// The contract: the three retirement figures are TALLIES, not a partition of
// the work-state buckets. Counting is unconditional; only the COLLAPSE depends
// on -a, and a killed row never collapses.

const labelByConv = new Map<string, string>();

function session(overrides: Record<string, any> = {}) {
  return {
    _id: "conversations_1",
    session_id: "sess-1",
    title: "Ship the thing",
    project_path: "/proj",
    updated_at: Date.now(),
    message_count: 5,
    agent_type: "claude",
    agent_status: undefined,
    is_idle: true,
    awaiting_input: false,
    has_pending: false,
    is_unresponsive: false,
    is_pinned: false,
    is_connected: false,
    is_subagent: false,
    ...overrides,
  };
}

// The tally never classifies: computeInboxSessions stamps every row through
// the shared placeInboxRow (via placeConversationRow) before the tally sees
// it. The test rows go through the same stamp.
function stamped(s: any) {
  const placement = placeConversationRow({ ...s, has_pending_messages: s.has_pending }, s, ownAsk(s), s.last_user_message);
  return { ...s, ...placement, asking: ownAsk(s) };
}

const tally = (s: any[], showAll = false) =>
  tallyInboxRows(s.map(stamped), { showAll, stateFilter: null, labelByConv });

// Which work-state bucket a listed row lands in depends on liveness signals
// that are beside the point for a tally test; what matters is that it lands in
// exactly one. (Killed is the exception — classifyWorkState forces it to idle,
// and that IS load-bearing, so those tests assert `idle` directly.)
const workStateTotal = (c: any) => c.needs_input + c.working + c.idle;

describe("tallyInboxRows — retirement figures are tallies, not a partition", () => {
  test("an ordinary row: counted in total and its work state, no retirement figure", () => {
    const { counts, rows } = tally([session()]);
    expect(counts.total).toBe(1);
    expect(workStateTotal(counts)).toBe(1);
    expect(counts.killed + counts.dismissed + counts.stashed).toBe(0);
    expect(rows).toHaveLength(1);
  });

  // The F1 regression. A killed row is an OVERLAY: it lands in `killed` AND in
  // total/work_state/pinned. Re-adding a `continue` after the tally breaks this.
  test("a killed row is listed AND counted in total, idle, pinned and killed", () => {
    const { counts, rows } = tally([session({ inbox_killed_at: 111, is_pinned: true })]);
    expect(counts.killed).toBe(1);
    expect(counts.total).toBe(1);
    expect(counts.idle).toBe(1); // classifyWorkState collapses killed → idle
    expect(counts.pinned).toBe(1);
    expect(rows).toHaveLength(1); // renders through — never collapsed
  });

  test("a killed row renders through under -a as well", () => {
    const { counts, rows } = tally([session({ inbox_killed_at: 111 })], true);
    expect(counts.killed).toBe(1);
    expect(rows).toHaveLength(1);
  });

  test("dismissed without -a: counted, collapsed out of the listing and totals", () => {
    const { counts, rows } = tally([session({ inbox_dismissed_at: 111 })]);
    expect(counts.dismissed).toBe(1);
    expect(counts.total).toBe(0);
    expect(workStateTotal(counts)).toBe(0);
    expect(rows).toHaveLength(0);
  });

  test("stashed without -a: counted, collapsed out of the listing and totals", () => {
    const { counts, rows } = tally([session({ inbox_stashed_at: 111 })]);
    expect(counts.stashed).toBe(1);
    expect(counts.total).toBe(0);
    expect(rows).toHaveLength(0);
  });

  // The F4 regression. Re-gating the tally on !showAll zeroes these while the
  // rows are listed — which gutted `stashed`, whose whole purpose is telling you
  // how many agents are still running.
  test("dismissed WITH -a: still counted, and now also listed and in totals", () => {
    const { counts, rows } = tally([session({ inbox_dismissed_at: 111 })], true);
    expect(counts.dismissed).toBe(1); // NOT zeroed by -a
    expect(counts.total).toBe(1);
    expect(workStateTotal(counts)).toBe(1);
    expect(rows).toHaveLength(1);
  });

  test("stashed WITH -a: still counted, and now also listed and in totals", () => {
    const { counts, rows } = tally([session({ inbox_stashed_at: 111 })], true);
    expect(counts.stashed).toBe(1); // NOT zeroed by -a
    expect(counts.total).toBe(1);
    expect(rows).toHaveLength(1);
  });

  // Precedence at the tally, not just in the classifier: cast kill writes both
  // stamps, and the row must be reported once, as killed.
  test("a row with both kill and dismiss stamps counts once, as killed", () => {
    const { counts } = tally([session({ inbox_killed_at: 111, inbox_dismissed_at: 111 })]);
    expect(counts.killed).toBe(1);
    expect(counts.dismissed).toBe(0);
  });

  test("subagent rows are excluded from every figure", () => {
    const { counts, rows } = tally([session({ is_subagent: true })]);
    expect(counts.total).toBe(0);
    expect(rows).toHaveLength(0);
  });

  // `cast sessions <id>` names a row on purpose. A subagent (cast spawn
  // --subagent, a Task-tool helper) is hidden from the top-level monitor, but an
  // explicitly requested id must still answer — it is the wait signal an
  // orchestrator watches for its worker. Other subagents stay hidden.
  test("an explicitly requested subagent row is listed; unrequested ones stay hidden", () => {
    const { counts, rows } = tallyInboxRows(
      [
        session({ _id: "conversations_sub", session_id: "sess-sub", is_subagent: true }),
        session({ _id: "conversations_other", session_id: "sess-other", is_subagent: true }),
      ].map(stamped),
      { showAll: false, stateFilter: null, labelByConv, requestedIds: new Set(["conversations_sub"]) },
    );
    expect(rows.map((r) => r.id)).toEqual(["conversations_sub"]);
    expect(counts.total).toBe(1);
  });

  // The inbox emits a subagent through two paths (top-level recency scan and
  // the parent's child enumeration); the web dedups by _id, so must this.
  test("a requested subagent emitted twice lists and counts once", () => {
    const sub = session({ _id: "conversations_sub", session_id: "sess-sub", is_subagent: true });
    const { counts, rows } = tallyInboxRows([sub, { ...sub }].map(stamped), {
      showAll: false, stateFilter: null, labelByConv, requestedIds: new Set(["conversations_sub"]),
    });
    expect(rows).toHaveLength(1);
    expect(counts.total).toBe(1);
  });

  // The same class as F1/F4, one figure over: pinned/live tally RENDERED rows
  // (they sit after the collapse), so a collapsed dismissed+pinned row must not
  // inflate `pinned` — that would claim a pinned card the inbox doesn't show.
  // Moving `counts.pinned++` above the collapse breaks this.
  test("a collapsed dismissed+pinned row is not counted as pinned", () => {
    const { counts } = tally([session({ inbox_dismissed_at: 111, is_pinned: true })]);
    expect(counts.dismissed).toBe(1);
    expect(counts.pinned).toBe(0);
  });

  // stateFilter narrows the LISTING only — counts stay whole-fleet, or the
  // summary line would change meaning with every --state flag.
  test("stateFilter=pinned narrows rows to pinned without touching counts", () => {
    const { counts, rows } = tallyInboxRows(
      [session({ _id: "a", is_pinned: true }), session({ _id: "b" })].map(stamped),
      { showAll: false, stateFilter: "pinned", labelByConv },
    );
    expect(counts.total).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_pinned).toBe(true);
  });

  test("a work-state filter keeps only matching rows, counts untouched", () => {
    // killed is forced idle by classifyWorkState; a quiet row WITH messages is
    // needs_input (settled-with-content routes to the user), so these two rows
    // land in different buckets by construction.
    const { counts, rows } = tallyInboxRows(
      [session({ _id: "a", inbox_killed_at: 111, is_pinned: true }), session({ _id: "b" })].map(stamped),
      { showAll: false, stateFilter: "idle", labelByConv },
    );
    expect(counts.total).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_killed).toBe(true);
  });

  test("labelByConv stamps the row label; absent entries read null", () => {
    const labels = new Map([["conversations_a", "fleet"]]);
    const { rows } = tallyInboxRows(
      [session({ _id: "conversations_a" }), session({ _id: "conversations_b" })].map(stamped),
      { showAll: false, stateFilter: null, labelByConv: labels },
    );
    expect(rows.find((r) => r.id === "conversations_a")!.label).toBe("fleet");
    expect(rows.find((r) => r.id === "conversations_b")!.label).toBe(null);
  });

  // The whole point of splitting stashed from dismissed.
  test("a mixed fleet reports each retirement state separately", () => {
    const { counts } = tally([
      session({ _id: "a" }),
      session({ _id: "b", inbox_stashed_at: 111 }),
      session({ _id: "c", inbox_dismissed_at: 111 }),
      session({ _id: "d", inbox_killed_at: 111 }),
    ]);
    expect(counts.stashed).toBe(1);
    expect(counts.dismissed).toBe(1);
    expect(counts.killed).toBe(1);
    // Listed: the ordinary row and the killed one; the other two collapsed.
    expect(counts.total).toBe(2);
  });
});
