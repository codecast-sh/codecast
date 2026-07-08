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
});
