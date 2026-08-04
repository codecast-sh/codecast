import { describe, expect, it } from "bun:test";
import {
  categorizeSessions,
  freshReviveRequestIds,
  BLOCKED_REVIVE_TTL_MS,
} from "./inboxStore";

// Regression: the blocked-sessions banner's continue/switch actions must render
// locally the moment the user clicks. pending_api_error is server-derived (it
// clears only after the agent resumes and its output syncs back), so the
// optimistic signal is a separate revive stamp — classification folds fresh
// stamps into the in-flight set (blocked → WORKING instantly), and an expired
// stamp lets the still-set server flag honestly resurface.

const NOW = Date.now();

function mk(over: Partial<any>): any {
  return {
    _id: over._id || "c1",
    session_id: over._id || "c1",
    agent_type: "claude_code",
    message_count: 5,
    started_at: NOW - 60 * 60 * 1000,
    updated_at: NOW,
    pending_api_error: true,
    pending_api_error_kind: "limit",
    ...over,
  };
}

function bucketsOf(sessions: any[], reviveRequestedAt?: Record<string, number>) {
  const map: Record<string, any> = {};
  for (const s of sessions) map[s._id] = s;
  const { working, needsInput } = categorizeSessions(map, new Set(), undefined, {
    reviveRequestedAt,
  });
  return {
    working: working.map((s) => s._id),
    needsInput: needsInput.map((s) => s._id),
  };
}

describe("categorizeSessions — blocked-banner revive stamps", () => {
  it("files a blocked session under needs-input with no stamp", () => {
    const { working, needsInput } = bucketsOf([mk({ _id: "blocked" })]);
    expect(needsInput).toContain("blocked");
    expect(working).not.toContain("blocked");
  });

  it("moves a blocked session to working while its revive stamp is fresh", () => {
    const { working, needsInput } = bucketsOf(
      [mk({ _id: "reviving" })],
      { reviving: NOW - 5_000 },
    );
    expect(working).toContain("reviving");
    expect(needsInput).not.toContain("reviving");
  });

  it("lets the blocked state resurface once the stamp expires", () => {
    const { working, needsInput } = bucketsOf(
      [mk({ _id: "failed" })],
      { failed: NOW - (BLOCKED_REVIVE_TTL_MS + 5_000) },
    );
    expect(needsInput).toContain("failed");
    expect(working).not.toContain("failed");
  });

  it("only lifts the stamped session, not its blocked siblings", () => {
    const { working, needsInput } = bucketsOf(
      [mk({ _id: "reviving" }), mk({ _id: "still-blocked" })],
      { reviving: NOW - 5_000 },
    );
    expect(working).toContain("reviving");
    expect(needsInput).toContain("still-blocked");
  });
});

describe("freshReviveRequestIds", () => {
  it("returns only stamps inside the TTL window", () => {
    const ids = freshReviveRequestIds(
      {
        fresh: NOW - 1_000,
        expired: NOW - (BLOCKED_REVIVE_TTL_MS + 1_000),
      },
      NOW,
    );
    expect(ids.has("fresh")).toBe(true);
    expect(ids.has("expired")).toBe(false);
  });

  it("handles a missing map", () => {
    expect(freshReviveRequestIds(undefined, NOW).size).toBe(0);
  });
});
