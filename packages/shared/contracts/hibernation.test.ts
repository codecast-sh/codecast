import { describe, expect, test } from "bun:test";
import { AGENT_STATUSES, ACTIVE_AGENT_STATUSES, STATUS_TRUST_TTL_MS, trustedAgentStatus } from "./agentStatus";
import { classifyWorkState, DEAD_AGENT_STATUSES, deriveLiveAt, placeInboxRow, type InboxPlacementInput } from "./inboxProjection";
import { HIBERNATED_COPY, isHibernated, sessionCommandOutcome } from "./hibernation";

const base = { agentStatus: "hibernated", isIdle: false, awaitingInput: false, hasPending: false, isUnresponsive: false, messageCount: 5 };

describe("intentional hibernation", () => {
  test("survives lost heartbeat and trust TTL without becoming dead or active", () => {
    expect(AGENT_STATUSES).toContain("hibernated");
    expect(DEAD_AGENT_STATUSES.has("hibernated")).toBe(false);
    expect(ACTIVE_AGENT_STATUSES.has("hibernated")).toBe(false);
    expect(trustedAgentStatus("hibernated", 1, STATUS_TRUST_TTL_MS * 24, false)).toBe("hibernated");
    expect(classifyWorkState(base)).toBe("dormant");
    expect(HIBERNATED_COPY).toBe("hibernated, resumes on send");
  });

  test("actual questions, errors and queued work retain priority", () => {
    expect(classifyWorkState({ ...base, awaitingInput: true })).toBe("needs_input");
    expect(classifyWorkState({ ...base, pendingApiError: true })).toBe("needs_input");
    expect(classifyWorkState({ ...base, sessionError: true })).toBe("needs_input");
    expect(classifyWorkState({ ...base, hasPending: true })).toBe("working");
    expect(classifyWorkState({ ...base, hasPending: true, isUnresponsive: true })).toBe("needs_input");
    expect(classifyWorkState({ ...base, killed: true, hasPending: true })).toBe("idle");
  });

  test("liveness derives park without phantom heartbeat, but keeps open questions", () => {
    const facts = { agent_status: "hibernated", updated_at: 1, message_count: 5, last_heartbeat: 1, last_role_is_user: true, auq_open: true };
    const live = deriveLiveAt(facts, STATUS_TRUST_TTL_MS * 24);
    expect(live).toMatchObject({ agent_status: "hibernated", is_idle: true, is_unresponsive: false, awaiting_input: true, daemon_alive: false });
    expect(isHibernated({ agent_status: "working", hibernated_at: 10 } as any)).toBe(false);
    expect(classifyWorkState({ ...base, agentStatus: "working" })).toBe("working");
  });

  test("a parked update leaves stashed visibility alone", () => {
    const row = { ...base, stashed: true, dismissed: false, pinned: false, isAnchor: false, asking: false, isNew: false, stashHidden: false } as unknown as InboxPlacementInput;
    expect(placeInboxRow(row).bucket).toBe("stashed");
  });

  test("command completion distinguishes acknowledgment, refusal, failure and unknown", () => {
    expect(sessionCommandOutcome({ command: "hibernate_session" }).message).toBe("parking requested");
    expect(sessionCommandOutcome({ command: "hibernate_session", executed_at: 1, result: "hibernated" }).state).toBe("succeeded");
    expect(sessionCommandOutcome({ executed_at: 1, result: "skipped_target-unverified", error: "not parked: target-unverified" }).state).toBe("skipped");
    expect(sessionCommandOutcome({ executed_at: 1, error: "offline" }).state).toBe("failed");
    expect(sessionCommandOutcome({ command: "resume_session", executed_at: 1, result: '{"resumed":true}' }).state).toBe("succeeded");
    expect(sessionCommandOutcome({ command: "resume_session", executed_at: 1, result: '{"resumed":false}' }).state).toBe("failed");
  });
});
