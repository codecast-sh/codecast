import { describe, expect, it } from "bun:test";
import { classifyWorkState, type WorkState } from "@codecast/shared/contracts";
import { agentStatusAt } from "../../lib/liveness";
import {
  classifySession,
  isSessionEffectivelyIdle,
  verdictOfWorkState,
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

// The SHARED work state a row's facts produce: its shipped live fields and
// the status the row's raw one is trusted to say now (agentStatusAt).
const sharedWorkState = (s: InboxSession): WorkState =>
  classifyWorkState({
    agentStatus: agentStatusAt(s, Date.now()),
    isIdle: !!s.is_idle,
    awaitingInput: !!s.awaiting_input,
    hasPending: !!s.has_pending,
    isUnresponsive: !!s.is_unresponsive,
    messageCount: s.message_count ?? 0,
    killed: !!s.inbox_killed_at,
    pendingApiError: s.pending_api_error === true,
    settleVerdict: s.settle_verdict ?? null,
    declaredStatus: s.thread_state_status ?? null,
  });

describe("classifySession is a thin adapter over the shared classifier (no second classifier)", () => {
  it("equals verdictOfWorkState(classifyWorkState(row)) on every branch", () => {
    for (const s of [
      sess({ is_idle: true }),
      sess({ awaiting_input: true }),
      sess({ agent_status: "permission_blocked", message_count: 2 }),
      sess({ agent_status: "running", is_idle: false }),
      sess({ message_count: 0 }),
      sess({ agent_status: "stopped" }),
      sess({ is_unresponsive: true, is_idle: false, has_pending: true }),
      sess({ agent_status: "dormant" }),
      sess({ agent_status: "done" }),
      sess({ settle_verdict: "done" }),
      sess({ thread_state_status: "blocked", settle_verdict: "done" }),
      sess({ inbox_killed_at: 5, agent_status: "working", is_idle: false }),
      sess({ pending_api_error: true, agent_status: "working", is_idle: false }),
    ]) {
      const c = classifySession(s);
      expect(c).toEqual(verdictOfWorkState(sharedWorkState(s)));
      expect(isSessionEffectivelyIdle(s)).toBe(c.idle);
    }
  });

  it("an unresponsive row with queued work is NEEDS YOU — the arm the legacy chain never had (ct: two-replica simulation)", () => {
    // message_count 12, is_idle false, has_pending true, no status: the
    // legacy isSessionWaitingForInput read `canDeliver && has_pending` as
    // working; the shared rule files a dead daemon's queue as a hard block.
    const c = classifySession(sess({ message_count: 12, is_idle: false, has_pending: true, is_unresponsive: true }));
    expect(c).toEqual({ idle: true, waiting: true, rest: "needs_input" });
  });

  it("is identity-stable: the same object reference reuses the cached verdict", () => {
    const s = sess();
    expect(classifySession(s)).toBe(classifySession(s));
  });

  it("a changed row arrives as a new object and misses the cache (no stale verdict)", () => {
    // The store hands out a new object whenever a row actually changes, so a
    // new ref must recompute rather than reuse the old row's verdict.
    const waiting = sess({ awaiting_input: true });
    expect(classifySession(waiting).waiting).toBe(true);
    expect(classifySession({ ...waiting, awaiting_input: false, agent_status: "running", is_idle: false }).waiting).toBe(false);
  });

  // A person's view: a wait its role drives is the role's work (shared
  // personWorkState), so the chime, the counts and every mark read it working.
  it("a wait its role drives reads working; a paused role's wait is the person's", () => {
    const roleDriven = sess({ org_role_id: "org_roles_infra", awaiting_input: true } as any);
    expect(classifySession(roleDriven)).toEqual({ idle: false, waiting: false, rest: "needs_input" });
    expect(classifySession({ ...roleDriven, driver_user_id: "u1" } as any).waiting).toBe(true);
  });
});
