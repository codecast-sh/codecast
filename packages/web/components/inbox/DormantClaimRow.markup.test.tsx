import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PARKED_WAKE_TTL_MS } from "@codecast/shared/contracts/inboxPlacement";
import type { InboxSession } from "../../store/inboxStore";
import { DormantClaimRow } from "./DormantWakeRows";

// The row under a Needs You card whose pin still declares dormant: why the
// card asks although the agent claimed a machine wakes it.

const HOUR = 3_600_000;
const session = (extra: Partial<InboxSession>): InboxSession => {
  const now = Date.now();
  return {
    _id: "s1", session_id: "s1", agent_type: "claude_code", message_count: 40, is_idle: true, title: "s",
    updated_at: now - 3 * HOUR, thread_state: "Waiting on the PR", thread_state_status: "dormant",
    thread_state_at: now - 3 * HOUR, thread_state_msg_count: 40,
    ...extra,
  } as InboxSession;
};
const html = (s: InboxSession) => renderToStaticMarkup(<DormantClaimRow session={s} isActive={false} hasOtherRows={false} onOpen={() => {}} />);

describe("DormantClaimRow", () => {
  test("a bare claim reads as unverified", () => {
    const out = html(session({}));
    expect(out).toContain("state claims a machine wake");
    expect(out).toContain("no trigger, watch, loop, background work, task, wait or run");
    expect(out).toContain("unverified");
  });

  // The pin is hidden as stale past 48h; a wait's stamp lives 72h, and
  // past it the wake is named as unconfirmed, never dropped.
  test("a wait past its trust is named although the pin is too old to show", () => {
    const now = Date.now();
    const quiet = PARKED_WAKE_TTL_MS + HOUR;
    const out = html(session({ updated_at: now - quiet, thread_state_at: now - quiet, parked_wake_kind: "wait" }));
    expect(out).toContain("a pending wait · unconfirmed 3d 1h");
    expect(out).toContain("unverified");
    // With no park to name, a stale pin earns no row.
    expect(html(session({ updated_at: now - quiet, thread_state_at: now - quiet }))).toBe("");
  });

  // A live wake under a current pin is not why the card asks (it asks for a
  // decision, a banner, queued work, the person's filing): no row.
  test("a live park or armed trigger under a current pin renders nothing", () => {
    expect(html(session({ parked_wake_kind: "blocker" }))).toBe("");
    expect(html(session({ parked_wake_kind: "wait" }))).toBe("");
    expect(html(session({ parked_wake_kind: "run", last_heartbeat: Date.now() - 5_000 }))).toBe("");
    expect(html(session({ armed_trigger_kind: "standing" }))).toBe("");
  });

  // A run the classifier drops (this session's daemon stopped) is why the
  // card asks: the row names it with why, the same helper the classifier uses.
  test("a run while its session's daemon is not reporting is named, not hidden", () => {
    const out = html(session({ parked_wake_kind: "run", last_heartbeat: Date.now() - 3 * HOUR }));
    expect(out).toContain("a run it started · its session&#x27;s daemon is not reporting");
    expect(out).toContain("unverified");
  });

  // The live-wake test is the classifier's own (rowVerifiedWake): a loop, a
  // producing child or checked open work count, not only a park or trigger.
  test("a loop, a producing child or open background work renders nothing", () => {
    const now = Date.now();
    expect(html(session({ loop_state: { status: "armed", wakeup_at: now + HOUR, event_at: now - HOUR } as any }))).toBe("");
    expect(html(session({ producing_until: now + 60_000 }))).toBe("");
    expect(html(session({ open_tasks: [{ kind: "background", command: "bun test" }] as any, open_tasks_at: now - 5_000, last_heartbeat: now - 5_000 }))).toBe("");
  });

  // Filed Needs You because a turn opened after the pin, while the park is live.
  test("a pin older than the last turn says so, not that the wake is unverified", () => {
    const now = Date.now();
    const out = html(session({ parked_wake_kind: "blocker", thread_state_at: now - 3 * HOUR, last_turn_at: now - 2 * HOUR }));
    expect(out).toContain("state is older than the session&#x27;s last turn");
    expect(out).toContain("a task it waits on");
    expect(out).toContain("outdated");
    expect(out).not.toContain("unverified");
  });
});
