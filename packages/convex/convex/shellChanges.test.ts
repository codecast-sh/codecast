import { expect, test } from "bun:test";
import { sync } from "./shellChanges";
import { makeFakeDb } from "./testDb";

function setup() {
  const db = makeFakeDb({
    users: [{ _id: "owner" }],
    conversations: [{ _id: "conv", user_id: "owner", is_private: true, updated_at: 1, message_count: 1 }],
    messages: [{ _id: "msg", conversation_id: "conv", message_uuid: "uuid", role: "user", content: "original", timestamp: 5,
      tool_results: [{ tool_use_id: "toolu_x", content: "original output" }] }],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|session" }) }, scheduler: { runAfter: async () => "scheduled" } };
  return { db, ctx, run: (changes: any[]) => (sync as any)._handler(ctx, { conversation_id: "conv", message_uuid: "uuid", changes }) };
}
const change = (seq: number) => ({ tool_call_id: "toolu_x", seq, file_path: `/repo/${seq}.ts`, change_type: "write", old_content: "before", new_content: "after" });

test("separate diff batches preserve message content, ordering and idempotence", async () => {
  const { db, run } = setup();
  const original = structuredClone(db._tables.messages[0]);
  await run([change(0), change(1)]);
  await run([change(2), change(3)]);
  await run([change(2), change(3)]);
  expect(db._tables.messages).toEqual([original]);
  expect(db._tables.file_changes.map((r: any) => [r.change_key, r.seq])).toEqual([
    ["toolu_x:fs:0", 0], ["toolu_x:fs:1", 1], ["toolu_x:fs:2", 2], ["toolu_x:fs:3", 3],
  ]);
});

test("only the conversation owner may attach diffs to an existing tool result", async () => {
  const { ctx, run, db } = setup();
  ctx.auth.getUserIdentity = async () => ({ subject: "outsider|session" });
  await expect(run([change(0)])).rejects.toThrow("Unauthorized");
  ctx.auth.getUserIdentity = async () => ({ subject: "owner|session" });
  await expect(run([{ ...change(0), tool_call_id: "unrelated" }])).rejects.toThrow("does not match");
  db._tables.messages = [];
  await expect(run([change(0)])).rejects.toThrow("not synced yet");
});

test("rejects excessive work before touching the database", async () => {
  const { run } = setup();
  await expect(run(Array.from({ length: 9 }, (_, n) => change(n)))).rejects.toThrow("budget");
  await expect(run([{ ...change(0), new_content: "x".repeat(800_000) }])).rejects.toThrow("budget");
});
