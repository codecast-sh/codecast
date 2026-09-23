import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { materializeFileChanges } from "../messages";

// Disk-observed changes (the shell-changes hook + daemon, packages/cli/src/
// shellChanges.ts) ride the message payload as file_changes and land in the
// same table as the tool-call extraction, keyed by the Bash call they belong to.
async function seed() {
  const t = convexTest(schema, { "./_generated/server.ts": () => import("../_generated/server") });
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "U" });
    const conversation = await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id: "s", started_at: 1, updated_at: 1,
      message_count: 0, is_private: false, status: "active",
    });
    const message = await ctx.db.insert("messages", { conversation_id: conversation, role: "user", timestamp: 5 });
    return { conversation, message };
  });
  return { t, ...ids };
}

const bashResult = [{ tool_use_id: "toolu_1", content: "ok" }];
const observed = [
  { tool_call_id: "toolu_1", seq: 0, file_path: "/r/src/a.ts", change_type: "write" as const, old_content: "one\n", new_content: "one\ntwo\n" },
  { tool_call_id: "toolu_1", seq: 1, file_path: "/r/src/gone.ts", change_type: "delete" as const, old_content: "bye\n", new_content: "" },
  { tool_call_id: "toolu_1", seq: 2, file_path: "/r/src/new.ts", change_type: "write" as const, new_content: "hi\n" },
];

test("observed changes materialize as rows keyed by the Bash call, and a re-sync upserts rather than duplicates", async () => {
  const { t, conversation, message } = await seed();
  await t.run((ctx) => materializeFileChanges(ctx, conversation, message, 5, undefined, bashResult, [], observed));
  await t.run((ctx) => materializeFileChanges(ctx, conversation, message, 5, undefined, bashResult, [], observed));
  const rows = await t.run((ctx) =>
    ctx.db.query("file_changes").withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation)).collect());
  // The text sits in file_change_bodies (fileChangeBodies.ts); the row holds sizes.
  const bodies = new Map(await t.run(async (ctx) => {
    const out: Array<[string, { old_content?: string; new_content: string }]> = [];
    for (const row of rows) {
      const body = await ctx.db.query("file_change_bodies").withIndex("by_conversation_change_key", (q) =>
        q.eq("conversation_id", conversation).eq("change_key", row.change_key)).unique();
      if (body) out.push([row.change_key, body]);
    }
    return out;
  }));
  expect(rows.map((r) => [r.change_key, r.file_path, r.change_type, bodies.get(r.change_key)?.old_content, bodies.get(r.change_key)?.new_content, r.seq])).toEqual([
    ["toolu_1:fs:0", "/r/src/a.ts", "write", "one\n", "one\ntwo\n", 0],
    ["toolu_1:fs:1", "/r/src/gone.ts", "delete", "bye\n", "", 1],
    ["toolu_1:fs:2", "/r/src/new.ts", "write", undefined, "hi\n", 2],
  ]);
  expect(rows.map((r) => [r.old_bytes, r.new_bytes, r.new_content])).toEqual([[4, 8, undefined], [4, 0, undefined], [undefined, 3, undefined]]);
  expect(rows.every((r) => r.tool_call_id === "toolu_1" && r.message_id === message && r.timestamp === 5)).toBe(true);
  const conv = await t.run((ctx) => ctx.db.get(conversation));
  // Newest change first, as feed cards read it.
  expect(conv?.recent_files).toEqual(["/r/src/new.ts", "/r/src/gone.ts", "/r/src/a.ts"]);
});

test("a message with a tool result and no observed changes materializes nothing", async () => {
  const { t, conversation, message } = await seed();
  await t.run((ctx) => materializeFileChanges(ctx, conversation, message, 5, undefined, bashResult, [], []));
  const rows = await t.run((ctx) =>
    ctx.db.query("file_changes").withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation)).collect());
  expect(rows).toEqual([]);
});
