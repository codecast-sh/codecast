import { describe, expect, it } from "bun:test";
import { categorizeSessions, isSessionBlockedOnUser, type InboxSession } from "../inboxStore";

// Guards the Anchor v2 inbox rule (and the round-1 regression it fixed): an
// anchor's standing thread is HIDDEN from the inbox in its normal idle-after-a-turn
// resting state, and surfaces ONLY when it's genuinely blocked on the user.

const mk = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 2,
  is_idle: true,
  has_pending: false,
  title: id,
  ...extra,
});

const inSorted = (sessions: Record<string, InboxSession>, id: string) =>
  categorizeSessions(sessions, new Set()).sorted.some((s) => s._id === id);

describe("anchor inbox visibility", () => {
  it("hides an idle anchor (the round-1 bug: it must NOT pop into the inbox after a turn)", () => {
    // idle-with-content is isSessionWaitingForInput's catch-all — but NOT blocked.
    expect(inSorted({ a: mk("a", { is_anchor: true }) }, "a")).toBe(false);
  });

  it("surfaces an anchor that is genuinely blocked on the user (open poll)", () => {
    expect(inSorted({ a: mk("a", { is_anchor: true, awaiting_input: true }) }, "a")).toBe(true);
  });

  it("surfaces an anchor blocked on a permission prompt", () => {
    expect(
      inSorted({ a: mk("a", { is_anchor: true, agent_status: "permission_blocked" }) }, "a"),
    ).toBe(true);
  });

  it("does NOT affect a normal (non-anchor) idle session", () => {
    expect(inSorted({ a: mk("a") }, "a")).toBe(true);
  });

  it("isSessionBlockedOnUser is narrow: idle-with-content is not 'blocked'", () => {
    expect(isSessionBlockedOnUser(mk("x"))).toBe(false);
    expect(isSessionBlockedOnUser(mk("x", { awaiting_input: true }))).toBe(true);
    expect(isSessionBlockedOnUser(mk("x", { pending_api_error: true }))).toBe(true);
  });
});
