import { expect, test } from "bun:test";
import { editedPaths, record, reportRewindStaged } from "./treeSnapshots";
import { makeFakeDb } from "./testDb";

function fixture() {
  const db = makeFakeDb({
    conversations: [
      { _id: "conv", user_id: "owner", session_id: "s", git_root: "/repo", started_at: 1, updated_at: 900 },
      { _id: "sib", user_id: "owner", session_id: "s2", git_root: "/repo", started_at: 2, updated_at: 800 },
      { _id: "idle", user_id: "owner", session_id: "s3", git_root: "/repo", started_at: 0, updated_at: 50 },
      { _id: "elsewhere", user_id: "owner", session_id: "s4", git_root: "/other", started_at: 3, updated_at: 800 },
      { _id: "child", user_id: "owner", session_id: "s5", git_root: "/repo", started_at: 4, updated_at: 800, parent_conversation_id: "conv", is_subagent: true },
      // A native fork carries the parent pointer too, but it is a session of its own.
      { _id: "fork", user_id: "owner", session_id: "s6", git_root: "/repo", started_at: 5, updated_at: 800, parent_conversation_id: "conv" },
    ],
    file_changes: [
      { _id: "f1", conversation_id: "conv", file_path: "/repo/before.ts", change_type: "edit", timestamp: 100 },
      { _id: "f2", conversation_id: "conv", file_path: "/repo/a.ts", change_type: "edit", timestamp: 200 },
      { _id: "f3", conversation_id: "conv", file_path: "/repo/a.ts", change_type: "write", timestamp: 300 },
      { _id: "f4", conversation_id: "conv", file_path: "/repo/gone.ts", change_type: "delete", timestamp: 300 },
      { _id: "f5", conversation_id: "conv", file_path: "", change_type: "commit", timestamp: 400 },
      { _id: "f6", conversation_id: "other", file_path: "/repo/theirs.ts", change_type: "edit", timestamp: 500 },
      // A backfill inserted after the turn's edits, dated long before: it must not end the read.
      { _id: "f7", conversation_id: "conv", file_path: "/repo/old.ts", change_type: "edit", timestamp: 10 },
      { _id: "f8", conversation_id: "sib", file_path: "/repo/a.ts", change_type: "edit", timestamp: 250 },
      { _id: "f9", conversation_id: "elsewhere", file_path: "/repo/a.ts", change_type: "edit", timestamp: 250 },
      { _id: "f10", conversation_id: "child", file_path: "/repo/sub.ts", change_type: "write", timestamp: 260 },
      { _id: "f11", conversation_id: "fork", file_path: "/repo/forked.ts", change_type: "edit", timestamp: 270 },
    ],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|login" }) } };
  return { db, ctx };
}

test("editedPaths lists the conversation's own file changes after the moment, once each, without commits", async () => {
  const f = fixture();
  const out = await (editedPaths as any)._handler(f.ctx, { conversation_id: "conv", after: 150 });
  // A subagent's edit is the session's own, not another session's.
  expect([...out.edits].sort((a: any, b: any) => a.path.localeCompare(b.path))).toEqual([{ path: "/repo/a.ts", at: [200, 300] }, { path: "/repo/gone.ts", at: [300] }, { path: "/repo/sub.ts", at: [260] }]);
  expect(out.complete).toBe(true);
  // The person's other session in the same checkout edited a.ts in the stretch; one in another checkout does not count.
  expect([...out.others].sort((a: any, b: any) => a.path.localeCompare(b.path))).toEqual([{ path: "/repo/a.ts", at: [250] }, { path: "/repo/forked.ts", at: [270] }]);
  expect(out.others_complete).toBe(true);
  expect(out.synced_at).toBe(900);
  f.ctx.auth.getUserIdentity = async () => ({ subject: "stranger|login" });
  expect(await (editedPaths as any)._handler(f.ctx, { conversation_id: "conv", after: 0 })).toEqual({ edits: [], complete: false, others: [], others_complete: false, synced_at: 0 });
});

test("reportRewindStaged writes the mark for the runner only, and clears it", async () => {
  const f = fixture();
  const mark = { id: "r1", files: 3, staged_at: 10, at: 5 };
  expect(await (reportRewindStaged as any)._handler(f.ctx, { api_token: "t", conversation_id: "conv", staged: mark })).toEqual({ written: true });
  expect(f.db._tables.conversations[0].rewind_staged).toEqual(mark);
  expect(await (reportRewindStaged as any)._handler(f.ctx, { api_token: "t", conversation_id: "conv", staged: mark })).toEqual({ written: false });
  await (reportRewindStaged as any)._handler(f.ctx, { api_token: "t", conversation_id: "conv", staged: null });
  expect(f.db._tables.conversations[0].rewind_staged).toBeNull();
  f.ctx.auth.getUserIdentity = async () => ({ subject: "stranger|login" });
  expect(await (reportRewindStaged as any)._handler(f.ctx, { api_token: "t", conversation_id: "conv", staged: mark })).toEqual({ written: false });
  expect(f.db._tables.conversations[0].rewind_staged).toBeNull();
});

test("each prompt gets its own row even when the tree, and so the sha, is the turn's before it", async () => {
  const f = fixture();
  (f.db._tables as any).tree_snapshots = [];
  const row = (over: Record<string, unknown>) => ({ conversation_id: "conv", sha: "s1", tree_sha: "t", base_sha: "h", depth: 1, changed_paths: [], changed_count: 0, dirty: false, checkout_key: "k", source: "turn", taken_at: 1, turn_completed_at: 1, ...over });
  const put = (r: Record<string, unknown>) => (record as any)._handler(f.ctx, { api_token: "t", rows: [r] });
  expect((await put(row({}))).written).toBe(1);
  expect((await put(row({ source: "prompt", taken_at: 5, turn_completed_at: undefined }))).written).toBe(1);
  expect((await put(row({ source: "prompt", taken_at: 9, turn_completed_at: undefined }))).written).toBe(1);
  expect((await put(row({ source: "prompt", taken_at: 9, turn_completed_at: undefined }))).written).toBe(0);
  expect((await put(row({}))).written).toBe(0);
});
