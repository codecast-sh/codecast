import { describe, expect, it } from "bun:test";
import { defaultFieldSig, membershipSig, workspaceRows } from "../useWorkspaceCollection";

// Regression: marking a task done flips row.status/updated_at but does NOT
// change which rows are in the workspace. The membership-only signature was
// blind to that, so /tasks (and every other list surface) kept painting the
// old status until some row entered or left the workspace. The default field
// signature folds updated_at into the wake signature, so any real edit
// re-renders the caller.
const KEY = "team:t1";
const row = (id: string, status: string, updated_at: number) => ({
  _id: id,
  workspace: KEY,
  status,
  updated_at,
});

describe("useWorkspaceCollection wake signature", () => {
  it("shares row scans but gives each caller its own sortable array", () => {
    let reads = 0;
    const a = row("a", "open", 1);
    const coll = { get a() { reads++; return a; } };
    const first = workspaceRows("tasks", coll, KEY);
    first.pop();
    expect(workspaceRows("tasks", coll, KEY)).toEqual([a]);
    expect(reads).toBe(1);
    expect(workspaceRows("tasks", coll, "team:t2")).toEqual([]);
    expect(workspaceRows("tasks", { a: { ...a, workspace: "team:t2" } }, KEY)).toEqual([]);
  });
  it("retains signatures for two workspaces without rescanning on each switch", () => {
    let reads = 0;
    const coll = {
      get a() { reads++; return row("a", "open", 1); },
      get b() { reads++; return { ...row("b", "open", 1), workspace: "team:t2" }; },
    };
    const first = membershipSig(coll, KEY, defaultFieldSig, "tasks");
    const second = membershipSig(coll, "team:t2", defaultFieldSig, "tasks");
    expect(first).not.toBe(second);
    for (let i = 0; i < 10; i++) {
      expect(membershipSig(coll, KEY, defaultFieldSig, "tasks")).toBe(first);
      expect(membershipSig(coll, "team:t2", defaultFieldSig, "tasks")).toBe(second);
    }
    expect(reads).toBe(4);
  });

  it("changes when a row is edited in place (mark done bumps updated_at)", () => {
    const before = { a: row("a", "open", 100), b: row("b", "open", 100) };
    const after = { a: row("a", "done", 200), b: row("b", "open", 100) };

    expect(membershipSig(after, KEY, defaultFieldSig)).not.toBe(
      membershipSig(before, KEY, defaultFieldSig),
    );
  });

  it("is stable across a no-op sync push (same rows, new collection ref)", () => {
    const a = { a: row("a", "open", 100) };
    const b = { a: row("a", "open", 100) };

    expect(membershipSig(b, KEY, defaultFieldSig)).toBe(membershipSig(a, KEY, defaultFieldSig));
  });

  it("membership-only mode (sig: null) stays blind to field edits — the old default this bug lived in", () => {
    const before = { a: row("a", "open", 100) };
    const after = { a: row("a", "done", 200) };

    expect(membershipSig(after, KEY, null)).toBe(membershipSig(before, KEY, null));
  });

  it("still changes on membership moves either way", () => {
    const inWs = { a: row("a", "open", 100) };
    const gone = {};

    expect(membershipSig(gone, KEY, defaultFieldSig)).not.toBe(
      membershipSig(inWs, KEY, defaultFieldSig),
    );
  });
});

// The sync log delivers a soft-deleted row (an archived doc, with archived_at
// set) so the undo's tombstone check and other devices know its state; the
// list channels drop such rows on the server. Enumeration applies the same
// rule on the client, from the collection's registry entry, so every list
// reader inherits it and an archived doc never comes back into a list.
describe("rows the list channels would not deliver", () => {
  it("does not scan cached rows before the viewer is known", async () => {
    const { workspaceRows } = await import("../useWorkspaceCollection");
    const coll = { get a() { throw new Error("unresolved viewer must not scan"); } };
    expect(workspaceRows("tasks", coll, null)).toEqual([]);
  });

  it("preserves workspace isolation, own keys, canonical ids and order", async () => {
    const { workspaceRows } = await import("../useWorkspaceCollection");
    const a = row("a", "open", 1);
    const b = row("b", "done", 2);
    const coll = Object.assign(Object.create({ inherited: row("inherited", "open", 1) }), {
      a, alias: a, foreign: { ...row("foreign", "open", 1), workspace: "team:other" }, b,
    });
    expect(workspaceRows("tasks", coll, KEY)).toEqual([a, b]);
    expect(workspaceRows("tasks", coll, null)).toEqual([]);
  });

  it("an archived doc leaves the docs enumeration and its wake signature", async () => {
    const { workspaceRows } = await import("../useWorkspaceCollection");
    const live = { _id: "d1", workspace: KEY, title: "kept", updated_at: 1 };
    const archived = { _id: "d2", workspace: KEY, title: "gone", updated_at: 2, archived_at: 3 };
    const coll = { d1: live, d2: archived };
    expect(workspaceRows("docs", coll, KEY).map((r: any) => r._id)).toEqual(["d1"]);
    expect(membershipSig(coll, KEY, null, "docs")).toBe(membershipSig({ d1: live }, KEY, null, "docs"));
    expect(workspaceRows("docs", { ...coll, d2: { ...archived, archived_at: undefined } }, KEY).map((r: any) => r._id)).toEqual(["d1", "d2"]);
  });
});
