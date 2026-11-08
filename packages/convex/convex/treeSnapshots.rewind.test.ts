import { expect, test } from "bun:test";
import { editedPaths, reportRewindStaged } from "./treeSnapshots";
import { makeFakeDb } from "./testDb";

function fixture() {
  const db = makeFakeDb({
    conversations: [{ _id: "conv", user_id: "owner", session_id: "s" }],
    file_changes: [
      { _id: "f1", conversation_id: "conv", file_path: "/repo/before.ts", change_type: "edit", timestamp: 100 },
      { _id: "f2", conversation_id: "conv", file_path: "/repo/a.ts", change_type: "edit", timestamp: 200 },
      { _id: "f3", conversation_id: "conv", file_path: "/repo/a.ts", change_type: "write", timestamp: 300 },
      { _id: "f4", conversation_id: "conv", file_path: "/repo/gone.ts", change_type: "delete", timestamp: 300 },
      { _id: "f5", conversation_id: "conv", file_path: "", change_type: "commit", timestamp: 400 },
      { _id: "f6", conversation_id: "other", file_path: "/repo/theirs.ts", change_type: "edit", timestamp: 500 },
    ],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|login" }) } };
  return { db, ctx };
}

test("editedPaths lists the conversation's own file changes after the moment, once each, without commits", async () => {
  const f = fixture();
  const paths = await (editedPaths as any)._handler(f.ctx, { conversation_id: "conv", after: 150 });
  expect([...paths].sort()).toEqual(["/repo/a.ts", "/repo/gone.ts"]);
  f.ctx.auth.getUserIdentity = async () => ({ subject: "stranger|login" });
  expect(await (editedPaths as any)._handler(f.ctx, { conversation_id: "conv", after: 0 })).toEqual([]);
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
