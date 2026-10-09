import { describe, expect, test } from "bun:test";
import { subtaskTally } from "./subtaskTally";

describe("subtaskTally", () => {
  test("reuses unchanged collections without enumerating them again", () => {
    let reads = 0;
    const tasks = { get child() { reads++; return { _id: "child", parent_id: "parent", status: "done" }; } };
    expect(subtaskTally("parent", tasks)).toBe("1/1");
    for (let i = 0; i < 100; i++) expect(subtaskTally("parent", tasks)).toBe("1/1");
    expect(reads).toBe(1);
  });

  test("recomputes after optimistic updates and keeps parents separate", () => {
    const child = { _id: "child", parent_id: "parent", status: "open" };
    const tasks = { child };
    expect(subtaskTally("parent", tasks)).toBe("0/1");
    expect(subtaskTally("other", tasks)).toBe("");
    expect(subtaskTally("parent", { child: { ...child, status: "done" } })).toBe("1/1");
    expect(subtaskTally("parent", {})).toBe("");
    expect(subtaskTally("parent", tasks)).toBe("0/1");
  });

  test("indexes different parents in one collection scan", () => {
    let reads = 0;
    const tasks = {
      get first() { reads++; return { _id: "first", parent_id: "a", status: "done" }; },
      get second() { reads++; return { _id: "second", parent_id: "b", status: "open" }; },
    };
    expect(subtaskTally("a", tasks)).toBe("1/1");
    expect(subtaskTally("b", tasks)).toBe("0/1");
    expect(subtaskTally("absent", tasks)).toBe("");
    expect(reads).toBe(2);
  });

  test("preserves deduplication and progress eligibility", () => {
    const child = { _id: "child", parent_id: "parent", status: "done" };
    expect(subtaskTally("parent", {
      child, duplicate: child,
      dropped: { _id: "dropped", parent_id: "parent", status: "dropped" },
      suggested: { _id: "suggested", parent_id: "parent", triage_status: "suggested" },
      grandchild: { _id: "grandchild", parent_id: "child", status: "open" },
    })).toBe("1/1");
  });
});
