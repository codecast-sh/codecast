// "Make this a role" is offered on a session that fits (org-roles-run-work.md R2).
import { describe, expect, test } from "bun:test";
import { MAKE_ROLE_MIN_AGE_MS, sessionFitsARole } from "./MakeRoleDialog";

const NOW = Date.UTC(2026, 8, 18);
const old = { _id: "c1", short_id: "jx7b88a", title: "Market growth mandate", started_at: NOW - 34 * 86_400_000 };

describe("sessionFitsARole", () => {
  test("a top level session older than a week fits; a younger one does not", () => {
    expect(sessionFitsARole(old, NOW)).toBe(true);
    expect(sessionFitsARole({ ...old, started_at: NOW - MAKE_ROLE_MIN_AGE_MS + 1 }, NOW)).toBe(false);
    expect(sessionFitsARole({ ...old, started_at: undefined, created_at: NOW - 8 * 86_400_000 }, NOW)).toBe(true);
    expect(sessionFitsARole(undefined, NOW)).toBe(false);
  });
  test("a helper session, a session that reports to a role, and a role's own session are never offered", () => {
    expect(sessionFitsARole({ ...old, is_subagent: true }, NOW)).toBe(false);
    expect(sessionFitsARole({ ...old, parent_conversation_id: "c0" }, NOW)).toBe(false);
    expect(sessionFitsARole({ ...old, org_role_id: "r1" }, NOW)).toBe(false);
    expect(sessionFitsARole({ ...old, standing_role_id: "r1" }, NOW)).toBe(false);
    expect(sessionFitsARole({ ...old, anchor_id: "a1" }, NOW)).toBe(false);
  });
});
