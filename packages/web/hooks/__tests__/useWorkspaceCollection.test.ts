import { describe, expect, it } from "bun:test";
import { defaultFieldSig, membershipSig } from "../useWorkspaceCollection";

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
