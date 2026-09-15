import { describe, expect, test } from "bun:test";
import { groupDecisions, stackCursor, advisoryDefaults, decisionScopeKey, stackDue, sortStacksByDue } from "../decisionGroups";

const row = (id: string, extra: Record<string, any> = {}) => ({
  _id: id,
  conversation_id: "c1",
  session_id: "s1",
  question: id,
  options: [{ label: "A" }, { label: "B" }],
  blocking: true,
  status: "pending" as const,
  created_at: 100,
  ...extra,
});

const stack = (id: string, decision_ids: string[], policy: Record<string, any> = {}) => ({
  _id: id, title: id, owner_user_id: "u", policy, status: "open" as const, decision_ids,
  total: decision_ids.length, resolved: 0, pending: decision_ids.length, created_at: 1, updated_at: 1,
});

describe("groupDecisions", () => {
  test("stack first in stack order, then scopes by age, then role-held last", () => {
    const rows = [
      row("d1", { scope_keys: ["project:p1"], created_at: 300 }),
      row("d2", { stack_id: "st1", created_at: 50 }),
      row("d3", { stack_id: "st1", created_at: 10 }),
      row("d4", { holder: { kind: "role", id: "r1" }, created_at: 1 }),
      row("d5", { scope_keys: ["plan:pl1"], created_at: 200 }),
      row("d6", { status: "answered" }),
    ];
    const groups = groupDecisions(rows as any, [stack("st1", ["d2", "d3"])]);
    expect(groups.map((g) => g.kind)).toEqual(["stack", "scope", "scope", "role"]);
    expect(groups[0].items.map((i) => i._id)).toEqual(["d2", "d3"]);
    expect((groups[1] as any).scopeKey).toBe("plan:pl1");
    expect((groups[2] as any).scopeKey).toBe("project:p1");
    expect(groups[3].items.map((i) => i._id)).toEqual(["d4"]);
  });

  test("a stack_id whose stack the viewer cannot see falls back to scope grouping", () => {
    const groups = groupDecisions([row("d1", { stack_id: "ghost" })] as any, []);
    expect(groups[0].kind).toBe("scope");
    expect((groups[0] as any).scopeKey).toBe("session:c1");
  });

  test("blocking outranks advisory inside a scope", () => {
    const groups = groupDecisions([row("a", { blocking: false, created_at: 1 }), row("b", { created_at: 5 })] as any, []);
    expect(groups[0].items.map((i) => i._id)).toEqual(["b", "a"]);
  });
});

describe("decisionScopeKey", () => {
  test("project beats plan beats role beats session", () => {
    expect(decisionScopeKey({ scope_keys: ["role:r", "plan:p", "project:x"], conversation_id: "c" })).toBe("project:x");
    expect(decisionScopeKey({ scope_keys: ["role:r", "plan:p"], conversation_id: "c" })).toBe("plan:p");
    expect(decisionScopeKey({ scope_keys: [], conversation_id: "c" })).toBe("session:c");
  });
});

describe("stackCursor", () => {
  const ids = ["a", "b", "c", "d"];
  const pending = new Set(["a", "c", "d"]);
  test("starts at the first pending member and skips resolved ones", () => {
    expect(stackCursor(ids, pending, null, 0)).toBe("a");
    expect(stackCursor(ids, pending, "a", 1)).toBe("c");
    expect(stackCursor(ids, pending, "a", -1)).toBe("d");
    expect(stackCursor(ids, pending, "d", 1)).toBe("a");
  });
  test("a resolved current re-anchors on the first pending", () => {
    expect(stackCursor(ids, pending, "b", 0)).toBe("a");
    expect(stackCursor(ids, new Set(), "a", 0)).toBeNull();
  });
});

describe("advisoryDefaults", () => {
  test("only pending advisory members with a default", () => {
    const out = advisoryDefaults([
      row("x", { blocking: false, default_option: 1 }),
      row("y", { blocking: true, default_option: 0 }),
      row("z", { blocking: false }),
      row("w", { blocking: false, default_option: 0, status: "answered" }),
    ] as any);
    expect(out).toEqual([{ id: "x", index: 1 }]);
  });
});

// Due (the-line.md L10): the label the group header and the stacks index
// show, and the sort that puts an overdue stack first.
describe("stackDue", () => {
  const now = 10 * 3_600_000;
  test("no due, no label", () => {
    expect(stackDue({}, now)).toBeNull();
    expect(stackDue(undefined, now)).toBeNull();
  });
  test("a future due reads as due in, in minutes, hours or days", () => {
    expect(stackDue({ due_at: now + 5 * 60_000 }, now)).toEqual({ text: "due in 5m", overdue: false, at: now + 5 * 60_000 });
    expect(stackDue({ due_at: now + 3 * 3_600_000 }, now)?.text).toBe("due in 3h");
    expect(stackDue({ due_at: now + 72 * 3_600_000 }, now)?.text).toBe("due in 3d");
  });
  test("a passed due reads as overdue and flags red", () => {
    expect(stackDue({ due_at: now - 2 * 3_600_000 }, now)).toEqual({ text: "overdue 2h", overdue: true, at: now - 2 * 3_600_000 });
    expect(stackDue({ due_at: now - 10_000 }, now)?.text).toBe("due now");
  });
});

describe("overdue stacks sort first", () => {
  const now = 100 * 3_600_000;
  test("sortStacksByDue: the longest overdue first, the rest keep their order", () => {
    const rows = [
      stack("fresh", ["a"]),
      stack("soon", ["b"], { due_at: now + 3_600_000 }),
      stack("late", ["c"], { due_at: now - 3_600_000 }),
      stack("later", ["d"], { due_at: now - 5 * 3_600_000 }),
    ];
    expect(sortStacksByDue(rows, now).map((s) => s._id)).toEqual(["later", "late", "fresh", "soon"]);
  });
  test("groupDecisions lists an overdue stack's group before an earlier listed stack", () => {
    const rows = [
      row("d1", { stack_id: "st1", created_at: 10 }),
      row("d2", { stack_id: "st2", created_at: 20 }),
    ];
    const groups = groupDecisions(rows as any, [stack("st1", ["d1"]), stack("st2", ["d2"], { due_at: now - 60_000 })], now);
    expect(groups.map((g) => g.key)).toEqual(["stack:st2", "stack:st1"]);
    // The clock decides: before the due passes, the server's order stands.
    const before = groupDecisions(rows as any, [stack("st1", ["d1"]), stack("st2", ["d2"], { due_at: now - 60_000 })], now - 120_000);
    expect(before.map((g) => g.key)).toEqual(["stack:st1", "stack:st2"]);
  });
});
