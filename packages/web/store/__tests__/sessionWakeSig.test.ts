import { describe, expect, it } from "bun:test";
import {
  sessionStructuralSig,
  sessionsWakeSig,
  type InboxSession,
  type PlanRef,
} from "../inboxStore";

// A plausible "live working" session: has messages, not idle, recent heartbeat.
const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  updated_at: 1_000,
  last_heartbeat: 1_000,
  last_message_at: 1_000,
  agent_type: "claude_code",
  agent_status: "working",
  message_count: 5,
  is_idle: false,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

describe("sessionStructuralSig — heartbeat churn is inert", () => {
  it("ignores updated_at / last_heartbeat / last_message_at bumps", () => {
    const base = session("a");
    const ticked = session("a", {
      updated_at: 99_999,
      last_heartbeat: 99_999,
      last_message_at: 99_999,
    });
    expect(sessionStructuralSig(ticked)).toBe(sessionStructuralSig(base));
  });

  it("ignores a streamed message_count increment once already engaged", () => {
    const base = session("a", { message_count: 5 });
    const streamed = session("a", { message_count: 6 });
    expect(sessionStructuralSig(streamed)).toBe(sessionStructuralSig(base));
  });

  it("ignores a churny display field the sidebar reads but doesn't bucket on", () => {
    const base = session("a", { last_user_message: "hi" });
    const newPreview = session("a", { last_user_message: "a much longer reply" });
    expect(sessionStructuralSig(newPreview)).toBe(sessionStructuralSig(base));
  });
});

describe("sessionStructuralSig — real bucket/order changes flip it", () => {
  const base = session("a");

  it("flips when work state changes (working -> idle)", () => {
    // A real transition clears the daemon's active agent_status; is_idle alone is
    // inert while agent_status is "working" (isSessionEffectivelyIdle short-circuits).
    expect(
      sessionStructuralSig(session("a", { agent_status: undefined, is_idle: true })),
    ).not.toBe(sessionStructuralSig(base));
  });

  it("flips when pinned", () => {
    expect(sessionStructuralSig(session("a", { is_pinned: true }))).not.toBe(
      sessionStructuralSig(base),
    );
  });

  it("flips when an agent becomes permission-blocked (-> needs input)", () => {
    expect(
      sessionStructuralSig(session("a", { agent_status: "permission_blocked" })),
    ).not.toBe(sessionStructuralSig(base));
  });

  it("flips when an open poll arrives (awaiting_input -> needs input)", () => {
    expect(sessionStructuralSig(session("a", { awaiting_input: true }))).not.toBe(
      sessionStructuralSig(base),
    );
  });

  it("flips when dismissed", () => {
    expect(
      sessionStructuralSig(session("a", { inbox_dismissed_at: 123 })),
    ).not.toBe(sessionStructuralSig(base));
  });

  it("flips when crossing the brand-new boundary (0 -> 1 messages)", () => {
    const blank = session("a", { message_count: 0 });
    const engaged = session("a", { message_count: 1 });
    expect(sessionStructuralSig(engaged)).not.toBe(sessionStructuralSig(blank));
  });

  it("flips when a session becomes a subagent (nests under a parent)", () => {
    expect(
      sessionStructuralSig(session("a", { parent_conversation_id: "p1" })),
    ).not.toBe(sessionStructuralSig(base));
  });
});

// The "By plan" lens (groupSessionsByPlan), its switcher option (hasPlanSessions),
// and the status view's default-collapsed orchestration group all key off a
// session's plan THROUGH orchestrationGroupLabelOf ("pl-x · Title"), which the
// signature folds in. So a plan stamp/move/rename is what wakes the panel to
// recompute them — these assert that contract so the wake gate and the lens can't
// silently drift apart. (Within-group ORDER is updated_at-sorted and stays fresh
// on the useCoarseNow ticker, not via this signature — by design.)
describe("sessionStructuralSig — plan identity drives the 'By plan' lens", () => {
  const base = session("a");
  const plan = (short_id: string, title: string): PlanRef => ({
    _id: `id-${short_id}`,
    short_id,
    title,
    status: "active",
  });

  it("flips when a plan is stamped (active_plan undefined -> set)", () => {
    expect(
      sessionStructuralSig(session("a", { active_plan: plan("pl-1", "Rollout") })),
    ).not.toBe(sessionStructuralSig(base));
  });

  it("flips when a session moves to a different plan", () => {
    const onP1 = session("a", { active_plan: plan("pl-1", "Rollout") });
    const onP2 = session("a", { active_plan: plan("pl-2", "Rollout") });
    expect(sessionStructuralSig(onP2)).not.toBe(sessionStructuralSig(onP1));
  });

  it("flips when the plan title changes (the heading the lens renders)", () => {
    const before = session("a", { active_plan: plan("pl-1", "Rollout") });
    const renamed = session("a", { active_plan: plan("pl-1", "Rollout v2") });
    expect(sessionStructuralSig(renamed)).not.toBe(sessionStructuralSig(before));
  });
});

describe("sessionsWakeSig — collection-level wake gate", () => {
  it("a heartbeat-only resync produces the SAME signature across map refs", () => {
    const before: Record<string, InboxSession> = { a: session("a"), b: session("b") };
    const sig1 = sessionsWakeSig(before);
    // A new map object (as syncTable hands back) with only churn fields bumped.
    const after: Record<string, InboxSession> = {
      a: session("a", { updated_at: 50_000, last_heartbeat: 50_000, message_count: 9 }),
      b: session("b", { updated_at: 50_000, last_heartbeat: 50_000 }),
    };
    expect(sessionsWakeSig(after)).toBe(sig1);
  });

  it("a real bucket change in one row flips the collection signature", () => {
    const before: Record<string, InboxSession> = { a: session("a"), b: session("b") };
    const sig1 = sessionsWakeSig(before);
    const after: Record<string, InboxSession> = {
      a: session("a", { agent_status: undefined, is_idle: true }), // a finished -> idle bucket
      b: session("b"),
    };
    expect(sessionsWakeSig(after)).not.toBe(sig1);
  });

  it("adding or removing a row flips the signature", () => {
    const before: Record<string, InboxSession> = { a: session("a") };
    const sig1 = sessionsWakeSig(before);
    const grown: Record<string, InboxSession> = { a: session("a"), b: session("b") };
    expect(sessionsWakeSig(grown)).not.toBe(sig1);
  });
});
