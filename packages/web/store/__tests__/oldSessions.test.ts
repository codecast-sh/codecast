import { describe, expect, it } from "bun:test";
import {
  computeInboxMembership,
  partitionWorkingSet,
  renderInboxEpoch,
  type InboxSession,
} from "../inboxStore";
import { inboxEpoch, INBOX_WINDOW_CAPS } from "@codecast/shared/contracts";

// The "show old sessions" toggle over the REPLICA model (sync-convergence
// C4/C5). Membership is no longer a per-device memory of the last payload
// (liveInboxIds + exemptions + a no-filter fallback) — it is the shared
// working-set selection (selectWorkingSet, caps included) evaluated over the
// replica's own rows, the same computation the server scan runs. "Old" is the
// FOLD: a member past a deterministic 12h activity gap, hidden behind the
// toggle. Show-old selects shown + folded INSIDE the computation and can never
// bypass the selection — the bug class this replaced was every device counting
// its whole never-prune cache whenever the synced toggle was on.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const EPOCH = inboxEpoch(NOW);

const cid = (n: number) => `j${String(n).padStart(31, "0")}`;

function sess(overrides: Partial<InboxSession> & { _id: string }): InboxSession {
  return {
    _id: overrides._id,
    session_id: `sess-${overrides._id.slice(0, 4)}`,
    title: "s",
    agent_type: "claude_code",
    updated_at: NOW,
    message_count: 1,
    is_idle: true,
    has_pending: false,
    ...overrides,
  } as InboxSession;
}

const RECENT = cid(1);
const AGED = cid(2);

describe("computeInboxMembership — the shared selection over the replica", () => {
  it("a row with activity inside the 30-day window is a member; an aged-out row is not", () => {
    const m = computeInboxMembership(
      {
        [RECENT]: sess({ _id: RECENT }),
        [AGED]: sess({ _id: AGED, updated_at: NOW - 40 * DAY }),
      },
      EPOCH,
    );
    expect(m.members.has(RECENT)).toBe(true);
    expect(m.members.has(AGED)).toBe(false);
  });

  it("membership is DATA, not payload memory: a cold cache selects correctly with no live payload ever seen", () => {
    // The old gate read liveInboxIds; empty set = show everything. Now the same
    // rows produce the same set on a cold boot, a stalled subscription, or a
    // fresh payload — the selection reads only row fields and the epoch.
    const rows = {
      [RECENT]: sess({ _id: RECENT }),
      [AGED]: sess({ _id: AGED, updated_at: NOW - 40 * DAY }),
    };
    const m = computeInboxMembership(rows, EPOCH);
    expect([...m.members]).toEqual([RECENT]);
  });

  it("stubs and child rows are never their own members (overlay and structure, not membership)", () => {
    const m = computeInboxMembership(
      {
        "local-stub-123": sess({ _id: "local-stub-123" }),
        [AGED]: sess({ _id: AGED, parent_conversation_id: RECENT, is_subagent: true }),
        [cid(9)]: sess({ _id: cid(9), parent_conversation_id: RECENT }), // orphan: parent pointer, no parent message
      },
      EPOCH,
    );
    expect(m.members.size).toBe(0);
  });

  it("a plan handoff (parent pointer + parent message, not a subagent) IS its own member — the server stamps it", () => {
    // createConversation writes exactly this shape for the daemon's plan
    // handoff (parent_message_uuid "plan-handoff"); the server's scan treats
    // it as a first-class member (shouldShowInInbox keeps it, groupPoolChildren
    // excludes it from the child pool), so the replica must select it too or
    // the compare reports it missing at every epoch.
    const handoff = cid(5);
    const m = computeInboxMembership(
      { [handoff]: sess({ _id: handoff, parent_conversation_id: RECENT, parent_message_uuid: "plan-handoff" }) },
      EPOCH,
    );
    expect(m.members.has(handoff)).toBe(true);
  });

  it("killed rows are out unless pinned (shouldShowInInbox, shared with the server scan)", () => {
    const killed = cid(3);
    const killedPinned = cid(4);
    const m = computeInboxMembership(
      {
        [killed]: sess({ _id: killed, inbox_killed_at: NOW }),
        [killedPinned]: sess({ _id: killedPinned, inbox_killed_at: NOW, is_pinned: true, inbox_pinned_at: NOW }),
      },
      EPOCH,
    );
    expect(m.members.has(killed)).toBe(false);
    expect(m.members.has(killedPinned)).toBe(true);
  });

  it("dismissed and stashed rows hold seats through their own 30-day windows, keyed on the gesture stamp", () => {
    const dismissed = cid(5);
    const stashed = cid(6);
    const staleDismiss = cid(7);
    const m = computeInboxMembership(
      {
        // Ancient activity, fresh gesture: still a member (the dismissed window
        // keys on inbox_dismissed_at, not updated_at).
        [dismissed]: sess({ _id: dismissed, updated_at: NOW - 40 * DAY, status: "completed", inbox_dismissed_at: NOW - DAY }),
        [stashed]: sess({ _id: stashed, updated_at: NOW - 40 * DAY, status: "completed", inbox_stashed_at: NOW - DAY }),
        // Gesture older than the window: out.
        [staleDismiss]: sess({ _id: staleDismiss, updated_at: NOW - 40 * DAY, status: "completed", inbox_dismissed_at: NOW - 40 * DAY }),
      },
      EPOCH,
    );
    expect(m.members.has(dismissed)).toBe(true);
    expect(m.members.has(stashed)).toBe(true);
    expect(m.members.has(staleDismiss)).toBe(false);
  });

  it("a pinned row holds its seat at any age", () => {
    const pinnedOld = cid(8);
    const m = computeInboxMembership(
      { [pinnedOld]: sess({ _id: pinnedOld, updated_at: NOW - 90 * DAY, inbox_pinned_at: NOW - 90 * DAY, is_pinned: true }) },
      EPOCH,
    );
    expect(m.members.has(pinnedOld)).toBe(true);
  });

  it("an overflowing window names itself in truncated (caps are part of the shared selection)", () => {
    const rows: Record<string, InboxSession> = {};
    for (let i = 0; i < INBOX_WINDOW_CAPS.recent + 5; i++) {
      const id = cid(100 + i);
      rows[id] = sess({ _id: id, updated_at: NOW - i });
    }
    const m = computeInboxMembership(rows, EPOCH);
    expect(m.truncated).toContain("recent");
    expect(m.members.size).toBe(INBOX_WINDOW_CAPS.recent);
  });

  it("the fold: members past a 12h activity gap; deliberate windows exempt", () => {
    const fresh = cid(20);
    const edge = cid(21);
    const folded = cid(22);
    const oldPin = cid(23);
    const m = computeInboxMembership(
      {
        [fresh]: sess({ _id: fresh, updated_at: NOW }),
        [edge]: sess({ _id: edge, updated_at: NOW - 13 * HOUR }),
        [folded]: sess({ _id: folded, updated_at: NOW - 14 * HOUR }),
        // Same age as the folded row, but pinned — a deliberate window, exempt.
        [oldPin]: sess({ _id: oldPin, updated_at: NOW - 14 * HOUR, is_pinned: true, inbox_pinned_at: NOW - 14 * HOUR }),
      },
      EPOCH,
    );
    expect(m.belowFold.has(fresh)).toBe(false);
    expect(m.belowFold.has(edge)).toBe(false); // at the cut, not under it
    expect(m.belowFold.has(folded)).toBe(true);
    expect(m.belowFold.has(oldPin)).toBe(false);
  });
});

describe("partitionWorkingSet — show-old inside the computation, overlays as pass-throughs", () => {
  const membershipOf = (rows: Record<string, InboxSession>) => computeInboxMembership(rows, EPOCH);

  it("GATE INVERSION: a nonmember is dropped even with show-old ON (the toggle is not a bypass)", () => {
    const rows = {
      [RECENT]: sess({ _id: RECENT }),
      [AGED]: sess({ _id: AGED, updated_at: NOW - 40 * DAY }),
    };
    const r = partitionWorkingSet(rows, membershipOf(rows), { showOld: true });
    expect(Object.keys(r.visibleSessions)).toEqual([RECENT]);
    expect(r.oldCount).toBe(0);
  });

  it("show-old off hides folded members and counts them; on reveals them, count unchanged", () => {
    const fresh = cid(30);
    const edge = cid(31);
    const folded = cid(32);
    const rows = {
      [fresh]: sess({ _id: fresh, updated_at: NOW }),
      [edge]: sess({ _id: edge, updated_at: NOW - 13 * HOUR }),
      [folded]: sess({ _id: folded, updated_at: NOW - 14 * HOUR }),
    };
    const off = partitionWorkingSet(rows, membershipOf(rows), { showOld: false });
    expect(Object.keys(off.visibleSessions).sort()).toEqual([fresh, edge].sort());
    expect(off.oldCount).toBe(1);
    const on = partitionWorkingSet(rows, membershipOf(rows), { showOld: true });
    expect(Object.keys(on.visibleSessions).sort()).toEqual([fresh, edge, folded].sort());
    expect(on.oldCount).toBe(1);
  });

  it("declared overlays pass through: create stub, child rows, the focused session, kept drafts", () => {
    const focusedOld = cid(40);
    const draftOld = cid(41);
    const child = cid(42);
    const rows = {
      [RECENT]: sess({ _id: RECENT }),
      "local-stub-9": sess({ _id: "local-stub-9" }),                       // create_stub
      [child]: sess({ _id: child, parent_conversation_id: RECENT, parent_message_uuid: "u" }), // rides its parent
      [focusedOld]: sess({ _id: focusedOld, updated_at: NOW - 40 * DAY }), // focused
      [draftOld]: sess({ _id: draftOld, updated_at: NOW - 40 * DAY, _hasDraft: true }), // draft_blank
    };
    const r = partitionWorkingSet(rows, membershipOf(rows), { showOld: false, focusedId: focusedOld });
    expect(Object.keys(r.visibleSessions).sort()).toEqual(
      [RECENT, "local-stub-9", child, focusedOld, draftOld].sort(),
    );
    // Pass-throughs are rendering-only: none of them are members, none count old.
    expect(r.oldCount).toBe(0);
  });

  it("returns the original map ref when nothing was dropped, so downstream memos hold", () => {
    const rows = { [RECENT]: sess({ _id: RECENT }) };
    const r = partitionWorkingSet(rows, membershipOf(rows), { showOld: false });
    expect(r.visibleSessions).toBe(rows);
  });
});

describe("renderInboxEpoch — the replica's clock (C2)", () => {
  it("the latest payload epoch advanced by the local minute; whichever is ahead wins", () => {
    const localEpoch = inboxEpoch(NOW);
    // Payload behind the device clock: the local minute rules.
    expect(renderInboxEpoch({ mine: { epoch: localEpoch - 5 * 60_000 } }, NOW)).toBe(localEpoch);
    // Payload ahead (device clock skewed back): the payload rules — the view
    // never rolls backwards to a slow local clock.
    expect(renderInboxEpoch({ mine: { epoch: localEpoch + 5 * 60_000 } }, NOW)).toBe(localEpoch + 5 * 60_000);
    // No payload yet: the local minute.
    expect(renderInboxEpoch(undefined, NOW)).toBe(localEpoch);
    expect(renderInboxEpoch({}, NOW)).toBe(localEpoch);
  });
});
