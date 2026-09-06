import { describe, expect, test } from "bun:test";
import { acknowledgedAt, isSessionUnread, sessionActivityAt, shouldAcknowledge } from "./sessionRead";

// The whole read model is this one comparison, so these cases ARE the spec.
describe("isSessionUnread", () => {
  test("a session that has not moved since the ack is read", () => {
    expect(isSessionUnread({ updatedAt: 1_000, mark: { acknowledged_at: 1_000 } })).toBe(false);
  });

  test("a session that moved after the ack is unread", () => {
    expect(isSessionUnread({ updatedAt: 2_000, mark: { acknowledged_at: 1_000 } })).toBe(true);
  });

  test("re-reporting the same state is free — only updated_at re-lights a card", () => {
    // The agent heartbeats, re-emits its status, streams tokens: none of that
    // bumps conversations.updated_at (managedSessions: "updated_at moves on
    // real conversation activity but NOT on idle heartbeats"), so the mark
    // still covers the row and nothing lights up.
    const mark = { acknowledged_at: 5_000 };
    for (let i = 0; i < 10; i++) {
      expect(isSessionUnread({ updatedAt: 5_000, mark })).toBe(false);
    }
    // A real new turn does bump it, and the card re-lights.
    expect(isSessionUnread({ updatedAt: 5_001, mark })).toBe(true);
  });

  test("the manual flag wins over an ack that would otherwise cover the row", () => {
    expect(isSessionUnread({
      updatedAt: 1_000,
      mark: { acknowledged_at: 9_000, manual_unread: true },
    })).toBe(true);
  });

  test("no mark falls back to this device's local last-opened record", () => {
    // Without the fallback the model's arrival would light every session a
    // long-time user has already read, on every client at once.
    expect(isSessionUnread({ updatedAt: 1_000, localViewedAt: 2_000 })).toBe(false);
    expect(isSessionUnread({ updatedAt: 3_000, localViewedAt: 2_000 })).toBe(true);
  });

  test("a server mark and a local record take the later of the two", () => {
    expect(acknowledgedAt({ updatedAt: 0, mark: { acknowledged_at: 5 }, localViewedAt: 9 })).toBe(9);
    expect(acknowledgedAt({ updatedAt: 0, mark: { acknowledged_at: 12 }, localViewedAt: 9 })).toBe(12);
  });

  test("a session never opened anywhere is unread", () => {
    expect(isSessionUnread({ updatedAt: 1_000 })).toBe(true);
  });

  test("a row with no activity stamp at all is not unread", () => {
    // Nothing to compare against is not evidence of something to read.
    expect(isSessionUnread({ updatedAt: 0 })).toBe(false);
  });
});

// ct-49533 gave every settle a per-turn identity and a flag saying whether a
// turn ended at all. Unread is a completion consumer, so it reads both.
describe("turn_completed_at is the stamp, when the row carries one", () => {
  test("a turn ending after the ack lights the card", () => {
    expect(isSessionUnread({
      updatedAt: 1_000, turnCompletedAt: 9_000, mark: { acknowledged_at: 5_000 },
    })).toBe(true);
  });

  test("the turn stamp wins over updated_at, in both directions", () => {
    // updated_at moved (a triage write, a metrics write) but no turn ended.
    expect(isSessionUnread({
      updatedAt: 9_000, turnCompletedAt: 4_000, mark: { acknowledged_at: 5_000 },
    })).toBe(false);
    // …and the reverse: a turn ended, whatever updated_at says.
    expect(isSessionUnread({
      updatedAt: 1_000, turnCompletedAt: 6_000, mark: { acknowledged_at: 5_000 },
    })).toBe(true);
  });

  test("a session the harness keeps alive re-lights per turn, not per status", () => {
    // Such a session settles as "waiting" and its STATUS then stops moving, so
    // the status cannot be the identity — the turn stamp is (ct-49533).
    const mark = { acknowledged_at: 5_000 };
    expect(isSessionUnread({ updatedAt: 1_000, turnCompletedAt: 5_000, mark })).toBe(false);
    expect(isSessionUnread({ updatedAt: 1_000, turnCompletedAt: 5_001, mark })).toBe(true);
  });
});

describe("a session boundary is not something to read", () => {
  test("a resume, clear or compact never lights a card on its own", () => {
    // The settle landed the pane at an idle prompt with no turn behind it.
    // On a row with no turn stamp, updated_at moved — and believing it would
    // light every session the user resumed.
    expect(isSessionUnread({
      updatedAt: 9_000, statusBoundary: true, mark: { acknowledged_at: 5_000 },
    })).toBe(false);
    expect(sessionActivityAt({ updatedAt: 9_000, statusBoundary: true })).toBe(0);
  });

  test("a boundary does not bury a real turn the viewer has not seen", () => {
    // The row is sitting on a boundary settle NOW, but a turn ended earlier
    // and was never acknowledged. That is still unread.
    expect(isSessionUnread({
      updatedAt: 9_000, turnCompletedAt: 7_000, statusBoundary: true,
      mark: { acknowledged_at: 5_000 },
    })).toBe(true);
  });

  test("the manual flag outranks a boundary", () => {
    expect(isSessionUnread({
      updatedAt: 9_000, statusBoundary: true,
      mark: { acknowledged_at: 9_999, manual_unread: true },
    })).toBe(true);
  });
});

describe("sessionActivityAt — one number for both sides of the comparison", () => {
  test("prefers the turn stamp, falls back to updated_at, else zero", () => {
    // The card compares against this and the ack writes this, so a client can
    // never acknowledge a number that leaves its own card lit.
    expect(sessionActivityAt({ updatedAt: 1_000, turnCompletedAt: 9_000 })).toBe(9_000);
    expect(sessionActivityAt({ updatedAt: 1_000 })).toBe(1_000);
    expect(sessionActivityAt({ updatedAt: 0 })).toBe(0);
  });

  test("a client ahead of the backend that supplies the facts still works", () => {
    // Neither field exists on rows from an undeployed backend; the coarser
    // watermark is the honest answer, not a crash and not a blank inbox.
    expect(sessionActivityAt({ updatedAt: 4_000, turnCompletedAt: null, statusBoundary: null }))
      .toBe(4_000);
  });
});

describe("shouldAcknowledge — the presence gate", () => {
  const here = { conversationId: "conv1", isActiveView: true, present: true, updatedAt: 1_000 };

  test("all four conditions together are the only way to write a mark", () => {
    expect(shouldAcknowledge(here)).toBe(true);
  });

  test("a session open behind another tab is not being read", () => {
    // The failure this prevents: acking on mere mount clears the dot on every
    // session the shell happens to hold, and an unread model that marks things
    // read by itself is worse than none.
    expect(shouldAcknowledge({ ...here, present: false })).toBe(false);
  });

  test("a session that is not the current view is not being read", () => {
    expect(shouldAcknowledge({ ...here, isActiveView: false })).toBe(false);
  });

  test("no session, or a session with no activity stamp, acknowledges nothing", () => {
    expect(shouldAcknowledge({ ...here, conversationId: null })).toBe(false);
    expect(shouldAcknowledge({ ...here, updatedAt: 0 })).toBe(false);
  });
});
