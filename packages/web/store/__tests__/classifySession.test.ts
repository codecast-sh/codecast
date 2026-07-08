import { describe, expect, it } from "bun:test";
import {
  classifySession,
  isSessionEffectivelyIdle,
  isSessionWaitingForInput,
  type InboxSession,
} from "../inboxStore";

const sess = (extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: "c1",
  session_id: "s1",
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: "t",
  ...extra,
});

describe("classifySession", () => {
  it("matches the underlying predicates it memoizes", () => {
    for (const s of [
      sess({ is_idle: true }),
      sess({ awaiting_input: true }),
      sess({ agent_status: "permission_blocked", message_count: 2 }),
      sess({ agent_status: "running", is_idle: false }),
      sess({ message_count: 0 }),
    ]) {
      const c = classifySession(s);
      expect(c.idle).toBe(isSessionEffectivelyIdle(s));
      // The memo stores the NO-in-flight verdict (categorize layers in-flight on top).
      expect(c.waiting).toBe(isSessionWaitingForInput(s));
    }
  });

  it("is identity-stable: the same object reference reuses the cached verdict", () => {
    const s = sess();
    expect(classifySession(s)).toBe(classifySession(s));
  });

  it("a changed row arrives as a new object and misses the cache (no stale verdict)", () => {
    // Same fields, different reference — the store hands out a new object whenever
    // a row actually changes, so a new ref must recompute rather than reuse.
    const a = classifySession(sess({ awaiting_input: true }));
    const b = classifySession(sess({ awaiting_input: true }));
    expect(a).not.toBe(b);
    expect(b.waiting).toBe(a.waiting);
  });
});
