import { describe, expect, test } from "bun:test";
import { putBackLedger, rewindLedger, splitRewindDiff, stagedRewindOf } from "../rewindFiles";
import type { SessionCommandRow } from "../sessionCommands";

const row = (over: Partial<SessionCommandRow> & { reply?: unknown }): SessionCommandRow => {
  const { reply, ...rest } = over;
  return { _id: "r", command: "rewind_files", kind: "rewind", conversation_id: "c1", requested_at: 1000, executed_at: reply ? 1100 : null, result: reply ? JSON.stringify(reply) : null, error: null, ...rest };
};
const planReply = (over: Record<string, unknown> = {}) => ({
  op: "plan", turns: 2, shared: 0, head_moved: false, busy: false, staged: null, fingerprint: "fp",
  files: [
    { path: "a.ts", action: "restore", conflict: false },
    { path: "new.ts", action: "delete", conflict: false },
    { path: "b.ts", action: "restore", conflict: true },
  ],
  counts: { restore: 2, delete: 1, recreate: 0, conflict: 1, total: 3 },
  ...over,
});
const ledger = (plan: SessionCommandRow | undefined, extra: Partial<Parameters<typeof rewindLedger>[0]> = {}) =>
  rewindLedger({ subject: "fix the parser", plan, overwrite: false, now: 2000, onDiff: () => {}, onPutBack: () => {}, ...extra });

describe("rewindLedger", () => {
  test("waits on the machine, and says so once nobody took the ask", () => {
    expect(ledger(row({})).blocked).toBe("Reading the files…");
    expect(ledger(row({}), { now: 1000 + 25_000 }).blocked).toBe("Waiting for the machine");
  });

  test("a server without the step says so instead of waiting forever", () => {
    const l = ledger(row({ executed_at: 1100, result: "dispatch_refused", error: "Error: [CONVEX M(dispatch:dispatch)] Server Error\nUncaught Error: Unknown dispatch action\n at handler" }));
    expect(l.alert).toBe("The server can't do this yet");
    expect(l.blocked).toBe("Can't rewind");
    expect(ledger(row({ executed_at: 1100, result: "dispatch_refused", error: "Server Error\nUncaught Error: Only the person whose machine runs this session can rewind its files\n" })).alert).toBe("Only the person whose machine runs this session can rewind its files");
  });

  test("an old daemon or a failure blocks the review with the reason", () => {
    const l = ledger(row({ executed_at: 1100, error: "Unknown command: rewind_files" }));
    expect(l.alert).toBe("Update codecast on that machine");
    expect(l.blocked).toBe("Can't rewind");
  });

  test("others' edits stop the rewind until the person picks Overwrite", () => {
    const plan = row({ reply: planReply() });
    const stopped = ledger(plan);
    expect(stopped.blocked).toBe("1 file changed by someone else");
    expect(stopped.pick?.value).toBe("Stop");
    expect(stopped.rows.find((r) => r.k === "Edited since")?.list).toEqual(["b.ts"]);
    expect(stopped.figures.map((f) => f.value)).toEqual(["3", "2", "1"]);
    const go = ledger(plan, { overwrite: true });
    expect(go.blocked).toBeUndefined();
    expect(go.confirm).toBe("Overwrite and rewind 3 files");
  });

  test("a clean plan lists each kind of change and confirms with the count", () => {
    const l = ledger(row({ reply: planReply({ files: [{ path: "a.ts", action: "restore", conflict: false }], counts: { restore: 1, delete: 0, recreate: 0, conflict: 0, total: 1 }, head_moved: true, shared: 2 }) }));
    expect(l.confirm).toBe("Rewind 1 file");
    expect(l.blocked).toBeUndefined();
    expect(l.rows.map((r) => r.k)).toEqual(["Restored", "Diff", "Commits", "Checkout", "Continues", "Undo"]);
  });

  test("nothing to do, a working agent, a staged rewind and a stage in flight each block", () => {
    expect(ledger(row({ reply: planReply({ files: [], counts: { restore: 0, delete: 0, recreate: 0, conflict: 0, total: 0 } }) })).blocked).toBe("Files already match");
    expect(ledger(row({ reply: planReply({ busy: true }) }), { overwrite: true }).blocked).toBe("The agent is working");
    const staged = ledger(row({ reply: planReply({ staged: { id: "x", conversation_id: "c1", at: 1, staged_at: 2, files: [{ path: "a.ts", action: "restore" }] } }) }));
    expect(staged.blocked).toBe("Put back or keep it first");
    expect(staged.rows[0].act?.label).toBe("Put back");
    const inFlight = ledger(row({ reply: planReply() }), { overwrite: true, stage: row({ _id: "s" }) });
    expect(inFlight.blocked).toBe("Rewinding…");
    const refused = ledger(row({ reply: planReply() }), { overwrite: true, stage: row({ _id: "s", reply: { op: "stage", refused: "the files changed since the review: look again" } }) });
    expect(refused.alert).toBe("the files changed since the review: look again");
  });
});

describe("stagedRewindOf", () => {
  test("the newest reply that says what is staged wins, across the session and its parent", () => {
    const staged = { id: "x", conversation_id: "parent", at: 1, staged_at: 5, files: [{ path: "a", action: "restore" }, { path: "b", action: "delete" }] };
    const rows = {
      a: row({ _id: "a", conversation_id: "parent", requested_at: 10, reply: { op: "stage", staged } }),
      d: row({ _id: "d", conversation_id: "parent", requested_at: 15, reply: { op: "diff", diff: "" } }),
    };
    expect(stagedRewindOf(rows, ["fork", "parent"])).toEqual({ conversationId: "parent", files: 2, stagedAt: 5, at: 1 });
    expect(stagedRewindOf(rows, ["other"])).toBeNull();
    const after = { ...rows, p: row({ _id: "p", conversation_id: "fork", requested_at: 20, reply: { op: "put_back", staged: null, restored: 2 } }) };
    expect(stagedRewindOf(after, ["fork", "parent"])).toBeNull();
  });
});

test("putBackLedger names the edits it discards", () => {
  const l = putBackLedger({ paths: ["a.ts"], total: 3 });
  expect(l.alert).toBe("1 file edited since the rewind");
  expect(l.confirm).toBe("Discard and put back");
});

test("splitRewindDiff splits the daemon's diff per file", () => {
  const parts = splitRewindDiff("diff a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n\ndiff dir/b c.ts\n--- a/dir/b c.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n- diff x\n");
  expect(parts.map((p) => p.path)).toEqual(["a.ts", "dir/b c.ts"]);
  expect(parts[1].patch).toContain("- diff x");
});
