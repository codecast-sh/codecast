import { describe, expect, it } from "bun:test";
import {
  freshReviveRequestIds,
  showsBlockedBadge,
  BLOCKED_REVIVE_TTL_MS,
} from "./inboxStore";
import { placeSections } from "./__tests__/placeTestHarness";

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
  const { working, needsInput } = placeSections(map, new Set(), undefined, {
    reviveRequestedAt,
  });
  return {
    working: working.map((s) => s._id),
    needsInput: needsInput.map((s) => s._id),
  };
}

describe("placeSections — blocked-banner revive stamps (the revive overlay)", () => {
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

// Regression: the amber chip on the session row read ONLY the server's
// pending_api_error, so pressing "Restart & continue all N" moved the
// count and the banner but left every row still wearing "login" until the
// daemon had killed, restarted and resynced each session.
describe("showsBlockedBadge", () => {
  it("shows the chip on a blocked session nobody has acted on", () => {
    expect(showsBlockedBadge(true, false, undefined, NOW)).toBe(true);
  });

  it("never shows it on a session that isn't blocked", () => {
    expect(showsBlockedBadge(false, false, undefined, NOW)).toBe(false);
    expect(showsBlockedBadge(undefined, false, undefined, NOW)).toBe(false);
  });

  it("drops it while a message of the user's is still in the outbox", () => {
    expect(showsBlockedBadge(true, true, undefined, NOW)).toBe(false);
  });

  it("drops it on a fresh revive stamp", () => {
    expect(showsBlockedBadge(true, false, NOW - 5_000, NOW)).toBe(false);
  });

  it("brings it back once the stamp expires", () => {
    expect(showsBlockedBadge(true, false, NOW - (BLOCKED_REVIVE_TTL_MS + 1_000), NOW)).toBe(true);
  });
});
