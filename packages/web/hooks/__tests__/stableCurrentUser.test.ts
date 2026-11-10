import { expect, test } from "bun:test";
import { CURRENT_USER_CHURN, stableCurrentUser } from "../useCurrentUser";

const row = (extra: Record<string, unknown> = {}) => ({
  _id: "user_1",
  name: "Ada",
  email: "ada@example.com",
  notification_preferences: { mention: true, team_session_start: false, permission_request: true },
  daemon_last_seen: 1_700_000_040_000,
  daemon_pending_sync_count: 3,
  daemon_oldest_pending_ms: 1200,
  ...extra,
});

test("a push that moves only daemon health stamps hands back the same user", () => {
  const first = stableCurrentUser(row());
  const second = stableCurrentUser(row({ daemon_pending_sync_count: 9, daemon_oldest_pending_ms: 48_000, last_message_sent_at: 5 }));
  expect(second).toBe(first);
});

test("a fresh copy of a nested object with the same value is not a change", () => {
  const first = stableCurrentUser(row({ name: "Nested" }));
  const second = stableCurrentUser(row({ name: "Nested", notification_preferences: { mention: true, team_session_start: false, permission_request: true } }));
  expect(second).toBe(first);
});

test("a field a caller shows wakes it, nested or not", () => {
  const first = stableCurrentUser(row({ name: "Before" }));
  const renamed = stableCurrentUser(row({ name: "After" }));
  expect(renamed).not.toBe(first);
  expect(renamed.name).toBe("After");
  const prefs = stableCurrentUser(row({ name: "After", notification_preferences: { mention: false, team_session_start: false, permission_request: true } }));
  expect(prefs).not.toBe(renamed);
  expect(prefs.notification_preferences.mention).toBe(false);
});

test("the minute presence stamps the profile page and tmux banner render still wake", () => {
  expect(CURRENT_USER_CHURN.has("daemon_last_seen")).toBe(false);
  expect(CURRENT_USER_CHURN.has("last_heartbeat")).toBe(false);
  const first = stableCurrentUser(row({ name: "Seen" }));
  const next = stableCurrentUser(row({ name: "Seen", daemon_last_seen: 1_700_000_100_000 }));
  expect(next).not.toBe(first);
});

test("signed out and loading stay distinct", () => {
  stableCurrentUser(row());
  expect(stableCurrentUser(null)).toBeNull();
  expect(stableCurrentUser(undefined)).toBeUndefined();
  const back = row({ name: "Back" });
  expect(stableCurrentUser(back)).toBe(back);
});

test("the same store row returns the same answer without re-deriving", () => {
  const r = row({ name: "Same" });
  expect(stableCurrentUser(r)).toBe(stableCurrentUser(r));
});
