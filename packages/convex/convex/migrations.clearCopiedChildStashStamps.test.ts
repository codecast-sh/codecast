import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { clearCopiedChildStashStamps } from "./migrations";

// A parent's stash used to copy its stamp onto every nested child, and a
// restore never cleared it. The cleanup clears the provable copies and keeps
// a stamp that is an act on the child itself.

const sub = (id: string, parent: string | undefined, stashedAt: number, over: Record<string, unknown> = {}) =>
  ({ _id: id, _creationTime: 1, user_id: "u1", is_subagent: true, parent_conversation_id: parent, inbox_stashed_at: stashedAt, inbox_stash_hidden: true, ...over });

function world() {
  const db = makeFakeDb({
    users: [{ _id: "u1", _creationTime: 1 }, { _id: "u2", _creationTime: 2 }],
    conversations: [
      { _id: "stashed_parent", _creationTime: 1, user_id: "u1", inbox_stashed_at: 100 },
      { _id: "active_parent", _creationTime: 1, user_id: "u1" },
      { _id: "foreign_parent", _creationTime: 1, user_id: "u2", inbox_stashed_at: 100 },
      sub("copied", "stashed_parent", 100),
      sub("moved", "foreign_parent", 100),
      sub("orphaned", "deleted_parent", 100),
      // The parent was restored after a stash that stamped both children.
      sub("left_a", "active_parent", 70),
      sub("left_b", "active_parent", 70),
      // The person stashed this one child on its own.
      sub("explicit", "active_parent", 50),
      // Trigger runs fold by their own stamp, shared or not.
      sub("run_a", "active_parent", 60, { agent_task_id: "t1" }),
      sub("run_b", "active_parent", 60, { agent_task_id: "t1" }),
      // A workflow sub with no parent pointer: its stash was never a copy.
      { _id: "wf_sub", _creationTime: 1, user_id: "u1", is_workflow_sub: true, inbox_stashed_at: 100 },
      // A plain session the person stashed: never a nested child, never touched.
      { _id: "plain", _creationTime: 1, user_id: "u1", inbox_stashed_at: 100 },
    ],
  }, { strictPatch: true });
  const scheduled: any[] = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => void scheduled.push(args) } } as any;
  const stamp = (id: string) => db._tables.conversations.find((c: any) => c._id === id)?.inbox_stashed_at;
  return { db, ctx, scheduled, stamp };
}

const run = (ctx: any, args: any) => (clearCopiedChildStashStamps as any)._handler(ctx, args);
const CLEARED = ["copied", "moved", "orphaned", "left_a", "left_b"];

describe("migrations.clearCopiedChildStashStamps", () => {
  test("clears the copies and keeps acts on the child, runs and plain rows", async () => {
    const w = world();
    expect(await run(w.ctx, { user_id: "u1", dry_run: false })).toMatchObject({
      examined: 6, cleared: 5, kept_explicit: 1, done: true,
      by_reason: { parent_missing: 1, parent_other_user: 1, copied_from_stashed_parent: 1, shared_with_sibling: 2 },
    });
    for (const id of CLEARED) expect(w.stamp(id)).toBeUndefined();
    expect(w.db._tables.conversations.find((c: any) => c._id === "copied").inbox_stash_hidden).toBeUndefined();
    expect(w.stamp("explicit")).toBe(50);
    expect(w.stamp("run_a")).toBe(60);
    expect(w.stamp("run_b")).toBe(60);
    expect(w.stamp("wf_sub")).toBe(100);
    expect(w.stamp("plain")).toBe(100);
    expect(w.stamp("stashed_parent")).toBe(100);

    // Safe to run twice: nothing left to clear.
    expect(await run(w.ctx, { user_id: "u1", dry_run: false })).toMatchObject({ examined: 1, cleared: 0, kept_explicit: 1 });
  });

  test("a dry run writes nothing and schedules nothing", async () => {
    const w = world();
    expect(await run(w.ctx, { user_id: "u1", dry_run: true })).toMatchObject({ examined: 6, would_clear: 5, kept_explicit: 1 });
    expect(await run(w.ctx, { dry_run: true })).toMatchObject({ users_scanned: 2, users: [{ user_id: "u1", would_clear: 5 }] });
    for (const id of CLEARED) expect(w.stamp(id)).not.toBeUndefined();
    expect(w.scheduled).toEqual([]);
  });

  test("without a user, a real run schedules one run per user", async () => {
    const w = world();
    await run(w.ctx, { dry_run: false });
    expect(w.scheduled).toEqual([{ user_id: "u1", dry_run: false }, { user_id: "u2", dry_run: false }]);
  });
});
