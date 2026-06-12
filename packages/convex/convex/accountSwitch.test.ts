import { describe, expect, test } from "bun:test";
import {
  isBlockedConversation,
  isSubagentConversation,
  isDeviceOnline,
  isValidProfileName,
  shouldSweepStaleFlag,
  DEVICE_ONLINE_MS,
  STALE_FLAG_AFTER_MS,
} from "./ccAccountsShared";

describe("isBlockedConversation", () => {
  const base = { pending_api_error: true, pending_api_error_kind: "limit", agent_type: "claude_code" };

  test("selects claude conversations parked on a limit or auth banner", () => {
    expect(isBlockedConversation(base)).toBe(true);
    expect(isBlockedConversation({ ...base, pending_api_error_kind: "auth" })).toBe(true);
  });

  test("never revives what the user dismissed", () => {
    expect(isBlockedConversation({ ...base, inbox_dismissed_at: 123 })).toBe(false);
  });

  test("transient provider errors are not blocked sessions", () => {
    // A 529/500 banner (kind "error") self-heals on the next message — counting
    // it threw a mid-conversation 500 into the "blocked on usage limits" banner.
    expect(isBlockedConversation({ ...base, pending_api_error_kind: "error" })).toBe(false);
    // Pre-kind rows (flag without a kind) are also out: unknown ≠ revivable.
    expect(isBlockedConversation({ ...base, pending_api_error_kind: undefined })).toBe(false);
  });

  test("ignores healthy conversations and other agents", () => {
    expect(isBlockedConversation({ ...base, pending_api_error: false })).toBe(false);
    expect(isBlockedConversation({ agent_type: "claude_code" })).toBe(false);
    // The account swap only affects claude's credential — codex/cursor banners
    // are someone else's login problem.
    expect(isBlockedConversation({ ...base, agent_type: "codex" })).toBe(false);
  });
});

describe("isDeviceOnline", () => {
  test("live within the heartbeat window, dead past it", () => {
    const now = 1_000_000_000;
    expect(isDeviceOnline({ last_seen: now - 30_000 }, now)).toBe(true);
    expect(isDeviceOnline({ last_seen: now - DEVICE_ONLINE_MS - 1 }, now)).toBe(false);
  });
});

describe("isValidProfileName", () => {
  test("mirrors the CLI rules", () => {
    expect(isValidProfileName("footage")).toBe(true);
    expect(isValidProfileName("work-2.bak_1")).toBe(true);
    for (const bad of ["", "-lead", "has space", "a/b", "a;b", "x".repeat(50)]) {
      expect(isValidProfileName(bad)).toBe(false);
    }
  });
});

describe("isSubagentConversation", () => {
  test("flags explicit subagents and parent-linked workers", () => {
    expect(isSubagentConversation({ is_subagent: true })).toBe(true);
    expect(isSubagentConversation({ parent_conversation_id: "jx7parent" })).toBe(true);
  });

  test("a plain top-level conversation is not a subagent", () => {
    expect(isSubagentConversation({})).toBe(false);
    expect(isSubagentConversation({ is_subagent: false, parent_conversation_id: undefined })).toBe(false);
  });
});

describe("shouldSweepStaleFlag", () => {
  const now = 1_000_000_000_000;

  test("sweeps flagged conversations older than the revive window", () => {
    expect(
      shouldSweepStaleFlag({ pending_api_error: true, updated_at: now - STALE_FLAG_AFTER_MS - 1 }, now),
    ).toBe(true);
  });

  test("leaves fresh incidents and unflagged conversations alone", () => {
    // Inside the window = still the current incident; the banner should act on it.
    expect(
      shouldSweepStaleFlag({ pending_api_error: true, updated_at: now - STALE_FLAG_AFTER_MS + 60_000 }, now),
    ).toBe(false);
    expect(shouldSweepStaleFlag({ pending_api_error: false, updated_at: 0 }, now)).toBe(false);
  });
});
