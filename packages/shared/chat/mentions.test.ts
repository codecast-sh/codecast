import { describe, expect, test } from "bun:test";
import { SESSION_SHORT_ID_RE, mentionKey, mentionRoles, mentionSessions, mentionUserIds, mentionsId } from "./mentions";

const rows = [
  "user-1",
  { kind: "role" as const, role_id: "role-1", short_id: "or-7", handle: "growth" },
  { kind: "session" as const, conversation_id: "conv-1", short_id: "jx7abcd" },
];

describe("chat mention refs", () => {
  test("a bare string is a person; objects are roles and sessions", () => {
    expect(mentionUserIds(rows)).toEqual(["user-1"]);
    expect(mentionRoles(rows).map((r) => r.handle)).toEqual(["growth"]);
    expect(mentionSessions(rows).map((s) => s.short_id)).toEqual(["jx7abcd"]);
    expect(mentionUserIds(undefined)).toEqual([]);
  });
  test("mentionsId answers for every shape and mentionKey is stable", () => {
    expect(mentionsId(rows, "user-1")).toBe(true);
    expect(mentionsId(rows, "role-1")).toBe(true);
    expect(mentionsId(rows, "conv-1")).toBe(true);
    expect(mentionsId(rows, "conv-2")).toBe(false);
    expect(rows.map(mentionKey)).toEqual(["user-1", "role:role-1", "session:conv-1"]);
  });
  test("only a 7-character jx short id names a session", () => {
    expect(SESSION_SHORT_ID_RE.test("jx7abcd")).toBe(true);
    expect(SESSION_SHORT_ID_RE.test("jx7abcde")).toBe(false);
    expect(SESSION_SHORT_ID_RE.test("growth")).toBe(false);
  });
});
