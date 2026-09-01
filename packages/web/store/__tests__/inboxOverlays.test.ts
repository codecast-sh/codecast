import { describe, expect, it } from "bun:test";
import {
  BLOCKED_REVIVE_TTL_MS,
  DECLARED_INBOX_OVERLAYS,
  HIDDEN_OVERRIDE_SETTLE_MS,
  anyOverlayActive,
  collectInboxOverlayDeps,
  collectTriagePendingIds,
  freshReviveRequestIds,
  isOverlayAffected,
  overlaysAffecting,
  type InboxOverlayDeps,
  type InboxOverlayState,
} from "../inboxOverlays";

// The declared overlays (sync-convergence C5): the ONLY local adjustments a
// replica may make over the shared projection, each named and bounded. The
// digest compare drops overlay-affected ids from its diff (isOverlayAffected),
// so this enumeration is load-bearing for the convergence proof — an overlay
// missing here would surface as permanent drift, an extra one would blind the
// compare.

const CID = "a".repeat(32);
const NOW = 1_756_600_000_000;

const emptyDeps = (over: Partial<InboxOverlayDeps> = {}): InboxOverlayDeps => ({
  now: NOW,
  focusedId: null,
  pendingCreateIds: new Set(),
  triagePendingIds: new Set(),
  pendingSendIds: new Set(),
  reviveIds: new Set(),
  draftIds: new Set(),
  ...over,
});

describe("the overlay alphabet", () => {
  it("is exactly the six declared overlays, in contract order", () => {
    expect([...DECLARED_INBOX_OVERLAYS]).toEqual([
      "create_stub",
      "triage_gesture",
      "focused",
      "pending_send",
      "revive",
      "draft_blank",
    ]);
  });
});

describe("overlaysAffecting / isOverlayAffected", () => {
  it("a non-Convex id is a create stub by construction", () => {
    const deps = emptyDeps();
    expect(overlaysAffecting("local-stub-1", deps)).toEqual(["create_stub"]);
    expect(isOverlayAffected("local-stub-1", deps)).toBe(true);
    expect(overlaysAffecting(CID, deps)).toEqual([]);
    expect(isOverlayAffected(CID, deps)).toBe(false);
  });

  it("a real id with an in-flight create is still the create_stub overlay", () => {
    const deps = emptyDeps({ pendingCreateIds: new Set([CID]) });
    expect(overlaysAffecting(CID, deps)).toContain("create_stub");
  });

  it("focused, pending send, and draft rows are overlay-affected", () => {
    expect(overlaysAffecting(CID, emptyDeps({ focusedId: CID }))).toEqual(["focused"]);
    expect(overlaysAffecting(CID, emptyDeps({ pendingSendIds: new Set([CID]) }))).toEqual(["pending_send"]);
    expect(overlaysAffecting(CID, emptyDeps({ draftIds: new Set([CID]) }))).toEqual(["draft_blank"]);
  });

  it("the revive overlay expires at BLOCKED_REVIVE_TTL_MS — bounded, then the server flag resurfaces", () => {
    // freshReviveRequestIds is the ONE revive predicate: the deps carry its
    // result, so the chokepoint, the banner and the compare read one set.
    const fresh = emptyDeps({ reviveIds: freshReviveRequestIds({ [CID]: NOW - BLOCKED_REVIVE_TTL_MS + 1 }, NOW) });
    expect(overlaysAffecting(CID, fresh)).toEqual(["revive"]);
    expect(isOverlayAffected(CID, fresh)).toBe(true);
    const expired = emptyDeps({ reviveIds: freshReviveRequestIds({ [CID]: NOW - BLOCKED_REVIVE_TTL_MS }, NOW) });
    expect(overlaysAffecting(CID, expired)).toEqual([]);
    expect(isOverlayAffected(CID, expired)).toBe(false);
  });

  it("isOverlayAffected and anyOverlayActive derive from the one predicate list", () => {
    // Every per-id set flips both; there is no second hand-written list to
    // fall out of step with overlaysAffecting.
    for (const over of [
      { pendingCreateIds: new Set([CID]) },
      { triagePendingIds: new Set([CID]) },
      { focusedId: CID },
      { pendingSendIds: new Set([CID]) },
      { reviveIds: new Set([CID]) },
      { draftIds: new Set([CID]) },
    ] as Array<Partial<InboxOverlayDeps>>) {
      const deps = emptyDeps(over);
      expect(overlaysAffecting(CID, deps).length).toBe(1);
      expect(isOverlayAffected(CID, deps)).toBe(true);
      expect(anyOverlayActive(deps)).toBe(true);
    }
    expect(anyOverlayActive(emptyDeps())).toBe(false);
  });

  it("a row can wear several overlays at once, in alphabet order", () => {
    const deps = emptyDeps({ focusedId: CID, pendingSendIds: new Set([CID]) });
    expect(overlaysAffecting(CID, deps)).toEqual(["focused", "pending_send"]);
  });
});

describe("collectTriagePendingIds — the triage_gesture bound", () => {
  it("collects live pending locks on triage fields from both row collections", () => {
    const ids = collectTriagePendingIds(
      {
        [`sessions:${CID}:inbox_dismissed_at`]: { type: "field", ts: NOW - 1000 },
        ["conversations:bbb:inbox_pinned_at"]: { type: "field", ts: NOW - 1000 },
        ["tasks:ccc:inbox_dismissed_at"]: { type: "field", ts: NOW - 1000 }, // wrong collection
        [`sessions:${CID}:title`]: { type: "field", ts: NOW - 1000 },        // not a triage field
        ["sessions:ddd:inbox_stashed_at"]: { type: "exclude" },              // not a field lock
      },
      NOW,
    );
    expect([...ids].sort()).toEqual([CID, "bbb"].sort());
  });

  it("expires a lock at HIDDEN_OVERRIDE_SETTLE_MS; an undated lock stays protected", () => {
    const ids = collectTriagePendingIds(
      {
        ["sessions:aged:inbox_dismissed_at"]: { type: "field", ts: NOW - HIDDEN_OVERRIDE_SETTLE_MS },
        ["sessions:undated:inbox_dismissed_at"]: { type: "field" },
      },
      NOW,
    );
    expect(ids.has("aged")).toBe(false);
    expect(ids.has("undated")).toBe(true);
  });
});

describe("collectInboxOverlayDeps + anyOverlayActive — the digest short-circuit gate", () => {
  const state = (over: Partial<InboxOverlayState> = {}): InboxOverlayState => ({
    sessions: {},
    pending: {},
    pendingSessionCreates: {},
    currentSessionId: null,
    sessionsWithQueuedMessages: new Set(),
    blockedReviveRequestedAt: {},
    ...over,
  });

  it("a quiet replica has no active overlay — the digest may short-circuit the compare", () => {
    expect(anyOverlayActive(collectInboxOverlayDeps(state(), NOW))).toBe(false);
  });

  it("each overlay source flips the gate", () => {
    expect(anyOverlayActive(collectInboxOverlayDeps(state({ pendingSessionCreates: { x: 1 } as any }), NOW))).toBe(true);
    expect(anyOverlayActive(collectInboxOverlayDeps(state({ currentSessionId: CID }), NOW))).toBe(true);
    expect(anyOverlayActive(collectInboxOverlayDeps(state({ sessionsWithQueuedMessages: new Set([CID]) }), NOW))).toBe(true);
    expect(anyOverlayActive(collectInboxOverlayDeps(state({ blockedReviveRequestedAt: { [CID]: NOW - 1 } }), NOW))).toBe(true);
    expect(anyOverlayActive(collectInboxOverlayDeps(state({ sessions: { [CID]: { _id: CID, _hasDraft: true } } }), NOW))).toBe(true);
    expect(anyOverlayActive(collectInboxOverlayDeps(
      state({ pending: { [`sessions:${CID}:inbox_pinned_at`]: { type: "field", ts: NOW - 1 } } }), NOW,
    ))).toBe(true);
  });

  it("an expired revive stamp does not hold the gate open", () => {
    const deps = collectInboxOverlayDeps(
      state({ blockedReviveRequestedAt: { [CID]: NOW - BLOCKED_REVIVE_TTL_MS - 1 } }),
      NOW,
    );
    expect(anyOverlayActive(deps)).toBe(false);
  });
});
