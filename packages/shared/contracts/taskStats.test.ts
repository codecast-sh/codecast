import { describe, expect, test } from "bun:test";
import { computeConversationTaskStats } from "./taskStats";

const todo = (ts: number, todos: { content: string; status: string }[], name = "TodoWrite") => ({
  role: "assistant",
  timestamp: ts,
  tool_calls: [{ name, input: JSON.stringify({ todos }) }],
});

describe("computeConversationTaskStats", () => {
  test("returns null for empty or tool-less windows", () => {
    expect(computeConversationTaskStats(undefined)).toBeNull();
    expect(computeConversationTaskStats([])).toBeNull();
    expect(computeConversationTaskStats([
      { role: "assistant", timestamp: 1, tool_calls: [{ name: "Write", input: "{\"path\":\"a.ts\"}" }] },
    ])).toBeNull();
  });

  test("uses the newest TodoWrite, including grok's todo_write id", () => {
    const stats = computeConversationTaskStats([
      todo(100, [{ content: "old", status: "pending" }]),
      todo(300, [{ content: "ship", status: "in_progress" }], "todo_write"),
      todo(200, [{ content: "mid", status: "completed" }]),
    ]);
    expect(stats).toEqual({
      total: 1,
      done: 0,
      in_progress: 1,
      open: 0,
      items: [{ id: "todo-0", content: "ship", status: "in_progress" }],
    });
  });

  test("merges TaskCreate/TaskUpdate in chronological id order", () => {
    const stats = computeConversationTaskStats([
      {
        role: "assistant",
        timestamp: 200,
        tool_calls: [{ name: "TaskCreate", input: JSON.stringify({ subject: "second" }) }],
      },
      {
        role: "assistant",
        timestamp: 100,
        tool_calls: [{ name: "TaskCreate", input: JSON.stringify({ subject: "first" }) }],
      },
      {
        role: "assistant",
        timestamp: 300,
        tool_calls: [{ name: "TaskUpdate", input: JSON.stringify({ taskId: "1", status: "completed" }) }],
      },
    ]);
    expect(stats?.items).toEqual([
      { id: "1", content: "first", status: "done" },
      { id: "2", content: "second", status: "open" },
    ]);
    expect(stats?.done).toBe(1);
    expect(stats?.open).toBe(1);
  });

  test("drops TaskCreate rows later marked deleted", () => {
    const stats = computeConversationTaskStats([
      {
        role: "assistant",
        timestamp: 1,
        tool_calls: [{ name: "TaskCreate", input: JSON.stringify({ subject: "gone" }) }],
      },
      {
        role: "assistant",
        timestamp: 2,
        tool_calls: [{ name: "TaskUpdate", input: JSON.stringify({ taskId: "1", status: "deleted" }) }],
      },
    ]);
    expect(stats).toBeNull();
  });

  test("accepts already-parsed tool input (client optimistic rows)", () => {
    const stats = computeConversationTaskStats([
      {
        role: "assistant",
        timestamp: 1,
        tool_calls: [{ name: "TodoWrite", input: { todos: [{ id: "a", content: "live", status: "pending" }] } }],
      },
    ]);
    expect(stats?.items).toEqual([{ id: "a", content: "live", status: "open" }]);
  });
});
