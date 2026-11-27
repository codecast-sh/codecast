import { describe, expect, test } from "bun:test";
import { closeHeldByAsk, isClosedRow, settleHideFields, viewerStallHideFields } from "./closedSession";
import { placeProjectableRow } from "./inboxPlacement";
import { inboxEpoch, type ProjectableInboxRow } from "./inboxProjection";

const EPOCH = inboxEpoch(1_800_000_000_000);
const CLOSED_AT = EPOCH - 60_000;

// The three shapes a Close leaves on a row.
const closedStopped = { inbox_closed_at: CLOSED_AT, inbox_dismissed_at: CLOSED_AT };
const closedHidden = { inbox_closed_at: CLOSED_AT, inbox_stashed_at: CLOSED_AT, inbox_stash_hidden: true };
const personStash = { inbox_closed_at: CLOSED_AT, inbox_stashed_at: CLOSED_AT + 5, inbox_stash_hidden: true };

function row(overrides: Record<string, any> = {}): ProjectableInboxRow {
  return { _id: "c1", status: "active", updated_at: EPOCH - 1000, message_count: 12, agent_status: "working", is_idle: false, ...overrides } as ProjectableInboxRow;
}

describe("a closed session that waits on a prompt stays in view (ct-102441)", () => {
  test("closeHeldByAsk: an open question or a permission prompt on a session with content", () => {
    expect(closeHeldByAsk({ awaitingInput: true, messageCount: 3 })).toBe(true);
    expect(closeHeldByAsk({ awaitingInput: false, agentStatus: "permission_blocked", messageCount: 3 })).toBe(true);
    expect(closeHeldByAsk({ awaitingInput: false, agentStatus: "idle", messageCount: 3 })).toBe(false);
    expect(closeHeldByAsk({ awaitingInput: false, agentStatus: "stopped", messageCount: 3 })).toBe(false);
    expect(closeHeldByAsk({ awaitingInput: true, messageCount: 0 })).toBe(false);
  });

  test("isClosedRow names both kinds of close, never a person's own stash over one", () => {
    expect(isClosedRow(closedStopped)).toBe(true);
    expect(isClosedRow(closedHidden)).toBe(true);
    expect(isClosedRow(personStash)).toBe(false);
    expect(isClosedRow({ ...closedStopped, inbox_killed_at: EPOCH })).toBe(false);
  });

  test("closed while a permission prompt stands (set aside): it files as a question, not under Stashed", () => {
    expect(placeProjectableRow(row({ ...closedHidden, awaiting_input: true }), true, EPOCH).bucket).toBe("questions");
    expect(placeProjectableRow(row({ ...closedHidden, agent_status: "permission_blocked" }), false, EPOCH).bucket).toBe("needs_input");
  });

  test("a team close (dismiss shape, the agent kept running) waiting on a prompt shows too", () => {
    expect(placeProjectableRow(row({ ...closedStopped, agent_status: "permission_blocked" }), false, EPOCH).bucket).toBe("needs_input");
  });

  test("once the ask is answered the close holds again", () => {
    expect(placeProjectableRow(row(closedHidden), false, EPOCH).bucket).toBe("stashed");
    expect(placeProjectableRow(row({ ...closedStopped, agent_status: "stopped", is_idle: true }), false, EPOCH).bucket).toBe("dismissed");
  });

  test("a stash or dismissal that is no close keeps hiding an ask, as before", () => {
    expect(placeProjectableRow(row({ ...personStash, awaiting_input: true }), true, EPOCH).bucket).toBe("stashed");
    expect(placeProjectableRow(row({ inbox_dismissed_at: CLOSED_AT, awaiting_input: true }), true, EPOCH).bucket).toBe("dismissed");
  });
});

describe("a closed session woken by a machine whose turn ends with no pin comes back (ct-102443)", () => {
  const back = { inbox_stashed_at: undefined, inbox_stash_hidden: undefined };

  test("an ordinary session comes back at the settle", () => {
    expect(settleHideFields(closedHidden, { returnsOnDone: true, asked: false })).toEqual(back);
  });

  test("a role's, anchor's or standing trigger's home waits for the classifier to say it asked", () => {
    expect(settleHideFields(closedHidden, { returnsOnDone: false, asked: false })).toBeNull();
    expect(settleHideFields(closedHidden, { returnsOnDone: false, asked: true })).toEqual(back);
  });

  test("only a close a machine woke: not an unwoken close, a person's stash, or a kill", () => {
    const opts = { returnsOnDone: true, asked: true };
    expect(settleHideFields(closedStopped, opts)).toBeNull();
    expect(settleHideFields(personStash, opts)).toBeNull();
    expect(settleHideFields({ ...closedHidden, inbox_killed_at: EPOCH }, opts)).toBeNull();
  });
});

describe("a stall brings a team session back for the person who hid it (ct-102442)", () => {
  const back = { inbox_dismissed_at: undefined, inbox_stashed_at: undefined, inbox_stash_hidden: undefined };

  test("every hide comes off, a close included (a teammate's close never stopped the agent)", () => {
    expect(viewerStallHideFields(closedStopped)).toEqual(back);
    expect(viewerStallHideFields(closedHidden)).toEqual(back);
    expect(viewerStallHideFields(personStash)).toEqual(back);
    expect(viewerStallHideFields({ inbox_dismissed_at: CLOSED_AT })).toEqual(back);
  });

  test("nothing to do when nothing hides it, or it was killed", () => {
    expect(viewerStallHideFields({})).toBeNull();
    expect(viewerStallHideFields({ ...closedStopped, inbox_killed_at: EPOCH })).toBeNull();
  });
});
