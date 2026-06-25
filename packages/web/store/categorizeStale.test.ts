import { describe, expect, it } from "bun:test";
import { categorizeSessions } from "./inboxStore";
import { STATUS_TRUST_TTL_MS } from "@codecast/shared/contracts";

// Regression: a session that has aged out of the liveness overlay's window keeps
// its last-synced live status frozen (the base cache never prunes, the overlay
// only refreshes in-window rows). A frozen `agent_status:"working"` would pin the
// row in the WORKING fallthrough bucket forever. categorizeSessions must distrust
// a stale active status past STATUS_TRUST_TTL_MS — keyed on updated_at — and file
// the settled session under needsInput instead. Mirrors the backend's
// trustedAgentStatus coercion for rows the overlay can no longer reach.

const NOW = Date.now();

function mk(over: Partial<any>): any {
  return {
    _id: over._id || "c1",
    session_id: over._id || "c1",
    agent_type: "claude_code",
    message_count: 5,
    started_at: NOW - 24 * 60 * 60 * 1000,
    updated_at: NOW,
    ...over,
  };
}

function bucketsOf(sessions: any[]) {
  const map: Record<string, any> = {};
  for (const s of sessions) map[s._id] = s;
  const { working, needsInput } = categorizeSessions(map, new Set());
  return {
    working: working.map((s) => s._id),
    needsInput: needsInput.map((s) => s._id),
  };
}

describe("categorizeSessions — stale frozen-working safety net", () => {
  it("keeps a genuinely-active, freshly-updated session in working", () => {
    const s = mk({ _id: "live", agent_status: "working", is_idle: false, updated_at: NOW - 30_000 });
    const { working, needsInput } = bucketsOf([s]);
    expect(working).toContain("live");
    expect(needsInput).not.toContain("live");
  });

  it("moves a frozen 'working' row that aged past the trust TTL into needs-input", () => {
    // agent_status still says working and is_idle is stale-false (frozen overlay),
    // but the conversation hasn't been touched in well over an hour.
    const s = mk({
      _id: "stale",
      agent_status: "working",
      is_idle: false,
      updated_at: NOW - (STATUS_TRUST_TTL_MS + 60_000),
    });
    const { working, needsInput } = bucketsOf([s]);
    expect(working).not.toContain("stale");
    expect(needsInput).toContain("stale");
  });

  it("also catches an aged row whose liveness was never synced (is_idle undefined)", () => {
    const s = mk({ _id: "noliveness", updated_at: NOW - (STATUS_TRUST_TTL_MS + 60_000) });
    delete s.is_idle;
    delete s.agent_status;
    const { working, needsInput } = bucketsOf([s]);
    expect(working).not.toContain("noliveness");
    expect(needsInput).toContain("noliveness");
  });

  it("does not touch a blank (0-message) aged session — it isn't work", () => {
    const s = mk({ _id: "blank", message_count: 0, agent_status: "working", updated_at: NOW - 2 * STATUS_TRUST_TTL_MS });
    const { working, needsInput } = bucketsOf([s]);
    expect(working).not.toContain("blank");
    expect(needsInput).not.toContain("blank");
  });
});
