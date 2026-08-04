import { describe, expect, it } from "bun:test";
import { shouldPlayWaitingSound } from "../useSyncInboxSessions";
import type { InboxSession } from "../../store/inboxStore";

const baseSession: InboxSession = {
  _id: "conv1",
  session_id: "session-1",
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 5,
  is_idle: false,
  has_pending: false,
};

function apply(
  sessions: InboxSession[],
  prev: Map<string, boolean> | null,
  notified: Map<string, string>,
) {
  return shouldPlayWaitingSound(sessions, new Set(), prev, notified);
}

describe("shouldPlayWaitingSound", () => {
  it("does not replay the same waiting episode after status flaps", () => {
    const notified = new Map<string, string>();

    let result = apply([{ ...baseSession, agent_status: "working", awaiting_input: false }], null, notified);
    expect(result.play).toBe(false);

    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: true }], result.nextWaiting, notified);
    expect(result.play).toBe(true);

    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: false }], result.nextWaiting, notified);
    expect(result.play).toBe(false);

    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: true }], result.nextWaiting, notified);
    expect(result.play).toBe(false);
  });

  it("plays again for a new waiting episode on the same session", () => {
    const notified = new Map<string, string>();

    let result = apply([{ ...baseSession, agent_status: "working", awaiting_input: false }], null, notified);
    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: true }], result.nextWaiting, notified);
    expect(result.play).toBe(true);

    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: false }], result.nextWaiting, notified);
    result = apply([{ ...baseSession, message_count: 6, agent_status: "working", awaiting_input: true }], result.nextWaiting, notified);
    expect(result.play).toBe(true);
  });

  it("seeds already-waiting sessions without playing on first sync", () => {
    const notified = new Map<string, string>();

    const result = apply([{ ...baseSession, agent_status: "permission_blocked" }], null, notified);
    expect(result.play).toBe(false);
    expect(notified.get("conv1")).toBe("conv1:5:permission_blocked");
  });

  // This sound and the server's needs-input push (convex/notifications.ts
  // checkNeedsInput) are documented mirrors. The server stands down on a killed
  // row via classifyWorkState's `killed` precedence; so must this. ct-41083.
  it("stays silent for a KILLED session that would otherwise chime", () => {
    const notified = new Map<string, string>();

    let result = apply([{ ...baseSession, agent_status: "working", awaiting_input: false, inbox_killed_at: 900 }], null, notified);
    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: true, inbox_killed_at: 900 }], result.nextWaiting, notified);
    expect(result.play).toBe(false);
    expect(notified.has("conv1")).toBe(false);
  });

  it("still chimes for the equivalent LIVE session (the killed case isn't silencing everything)", () => {
    const notified = new Map<string, string>();

    let result = apply([{ ...baseSession, agent_status: "working", awaiting_input: false }], null, notified);
    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: true }], result.nextWaiting, notified);
    expect(result.play).toBe(true);
  });

  // The server bails on `inbox_dismissed_at || inbox_stashed_at` outright
  // (notifications.ts checkNeedsInput) and these two are documented mirrors, so
  // a set-aside session must not chime either. Behavior change: stashed
  // sessions used to chime here.
  it("stays silent for a STASHED session, matching the server's stand-down", () => {
    const notified = new Map<string, string>();

    let result = apply([{ ...baseSession, agent_status: "working", awaiting_input: false, inbox_stashed_at: 900 }], null, notified);
    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: true, inbox_stashed_at: 900 }], result.nextWaiting, notified);
    expect(result.play).toBe(false);
    expect(notified.has("conv1")).toBe(false);
  });

  // Killed rows leave nextWaiting entirely (the `continue`), so a revival is
  // re-observed from scratch — no chime for a waiting episode that began while
  // the session was retired. Same shape as the dismiss path.
  it("does not chime on the sync right after a killed-and-waiting session is revived", () => {
    const notified = new Map<string, string>();

    let result = apply([{ ...baseSession, agent_status: "working", awaiting_input: true, inbox_killed_at: 900 }], null, notified);
    expect(result.nextWaiting.has("conv1")).toBe(false);

    result = apply([{ ...baseSession, agent_status: "working", awaiting_input: true }], result.nextWaiting, notified);
    expect(result.play).toBe(false);
  });
});
