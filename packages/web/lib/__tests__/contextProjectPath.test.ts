import { describe, expect, test } from "bun:test";
import {
  resolveContextRow,
  resolveContextProjectPath,
  type ContextPathStoreSlice,
} from "../contextProjectPath";

// The regression with teeth: chatting from a doc page used to start the
// session in whatever repo the viewer's currentConversation had open, because
// only tasks resolved a context-derived path. A doc (or plan) must pin the new
// session to ITS project, through project_path, its project row, or its source
// conversation's repo.

const emptyStore = (): ContextPathStoreSlice => ({
  tasks: {},
  docs: {},
  docDetails: {},
  plans: {},
  projects: {},
  conversations: {},
});

describe("resolveContextProjectPath", () => {
  test("doc with its own project_path pins the session there", () => {
    const store = emptyStore();
    store.docs["d1"] = { _id: "d1", project_path: "~/src/mail" };
    const row = resolveContextRow(store, "doc", "d1");
    expect(resolveContextProjectPath(store, row)).toBe("~/src/mail");
  });

  test("doc without a path falls back to its project's path", () => {
    const store = emptyStore();
    store.docs["d1"] = { _id: "d1", project_id: "p1" };
    store.projects["p1"] = { _id: "p1", project_path: "~/src/mail" };
    const row = resolveContextRow(store, "doc", "d1");
    expect(resolveContextProjectPath(store, row)).toBe("~/src/mail");
  });

  test("doc falls back to its source conversation's repo (detail join, then store row)", () => {
    const store = emptyStore();
    // The docDetails row carries the joined conversation and wins over the thin list row.
    store.docDetails["d1"] = {
      _id: "d1",
      conversation: { project_path: "~/src/mail" },
    };
    store.docs["d1"] = { _id: "d1" };
    let row = resolveContextRow(store, "doc", "d1");
    expect(resolveContextProjectPath(store, row)).toBe("~/src/mail");

    // Thin row only: resolve the conversation from the store.
    delete store.docDetails["d1"];
    store.docs["d1"] = { _id: "d1", conversation_id: "c1" };
    store.conversations["c1"] = { _id: "c1", project_path: "~/src/codecast" };
    row = resolveContextRow(store, "doc", "d1");
    expect(resolveContextProjectPath(store, row)).toBe("~/src/codecast");
  });

  test("plan and task resolve through the same chain", () => {
    const store = emptyStore();
    store.plans["pl1"] = { _id: "pl1", project_id: "p1" };
    store.tasks["t1"] = { _id: "t1", project_path: "~/src/cli" };
    store.projects["p1"] = { _id: "p1", project_path: "~/src/mail" };
    expect(
      resolveContextProjectPath(store, resolveContextRow(store, "plan", "pl1"))
    ).toBe("~/src/mail");
    expect(
      resolveContextProjectPath(store, resolveContextRow(store, "task", "t1"))
    ).toBe("~/src/cli");
  });

  test("an object that pins nothing yields undefined, never the viewer's repo", () => {
    const store = emptyStore();
    store.docs["d1"] = { _id: "d1" };
    expect(
      resolveContextProjectPath(store, resolveContextRow(store, "doc", "d1"))
    ).toBeUndefined();
    // Unknown context types (workflow page) resolve no row at all.
    expect(resolveContextRow(store, "workflow", "w1")).toBeUndefined();
  });
});
