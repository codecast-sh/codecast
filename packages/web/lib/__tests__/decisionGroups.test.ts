import { describe, expect, test } from "bun:test";
import { groupDecisions, stackCursor, advisoryDefaults, decisionScopeKey } from "../decisionGroups";

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

const stack = (id: string, decision_ids: string[]) => ({
  _id: id, title: id, owner_user_id: "u", policy: {}, status: "open" as const, decision_ids,
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
