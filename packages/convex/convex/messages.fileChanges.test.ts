import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addMessage, materializeFileChanges, getConversationFileChanges, buildExistingMessagePatch } from "./messages";
import { extractFileChanges, type ExtractableMessage } from "./fileChanges/extractor";

function setup() {
  const db = makeFakeDb({
    conversations: [{ _id: "conversation", user_id: "owner", is_private: true }],
    file_changes: [],
  });
  return { db, auth: { getUserIdentity: async () => ({ subject: "owner|session" }) } } as any;
}

const call = { id: "patch", name: "fileChange", input: JSON.stringify({ changes: "update: a.ts" }) };
const result = { tool_use_id: "patch", content: "@@ -1 +1 @@\n-before\n+after" };

async function ingest(ctx: any, message: ExtractableMessage, previous?: ExtractableMessage) {
  await materializeFileChanges(ctx, "conversation" as any, message._id as any, message.timestamp,
    message.tool_calls ?? undefined, message.tool_results ?? undefined, previous ? extractFileChanges([previous]) : []);
}

describe("session file changes persist as agent messages stream", () => {
  test("the message ingest endpoint refreshes a streamed Codex file change", async () => {
    const ctx = setup();
    ctx.db._tables.messages = [{
      _id: "message", message_uuid: "streamed", conversation_id: "conversation", role: "assistant",
      timestamp: 10, tool_calls: [call],
    }];
    await (addMessage as any)._handler(ctx, {
      conversation_id: "conversation", message_uuid: "streamed", role: "assistant",
      tool_calls: [call], tool_results: [result],
    });
    const rows = await (getConversationFileChanges as any)._handler(ctx, { conversation_id: "conversation" });
    expect(rows[0]).toMatchObject({ filePath: "a.ts", oldContent: "before", newContent: "after" });
    expect(ctx.db._tables.messages).toHaveLength(1);
  });
  test("a completed Codex patch appears in the full-session query and replay is idempotent", async () => {
    const ctx = setup();
    const started = { _id: "message", role: "assistant", timestamp: 10, tool_calls: [call] };
    await ingest(ctx, started);
    expect(ctx.db._tables.file_changes).toEqual([]);
    const completed = { ...started, tool_results: [result] };
    const updated = { ...started, ...buildExistingMessagePatch(started, completed) };
    await ingest(ctx, updated, started);
    await ingest(ctx, completed, completed);
    expect(ctx.db._tables.file_changes).toHaveLength(1);
    expect(ctx.db._tables.conversations[0].recent_files).toEqual(["a.ts"]);
    const rows = await (getConversationFileChanges as any)._handler(ctx, { conversation_id: "conversation" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filePath: "a.ts", oldContent: "before", newContent: "after", messageId: "message" });
  });

  test("late failed result removes the proposed file change", async () => {
    const ctx = setup();
    const proposed: ExtractableMessage = { _id: "message", timestamp: 10, tool_calls: [{
      id: "edit", name: "edit", input: JSON.stringify({ path: "a.ts", oldText: "before", newText: "after" }),
    }] };
    await ingest(ctx, proposed);
    expect(ctx.db._tables.file_changes).toHaveLength(1);
    await ingest(ctx, { ...proposed, tool_results: [{ tool_use_id: "edit", is_error: true, content: "not found" }] }, proposed);
    expect(ctx.db._tables.file_changes).toEqual([]);
  });

  test("resync backfills an already stored tool call without adding duplicates", async () => {
    const ctx = setup();
    const message = { _id: "message", timestamp: 10, tool_calls: [call], tool_results: [result] };
    await ingest(ctx, message, message);
    await ingest(ctx, message, message);
    expect(ctx.db._inserted.filter((insert: any) => insert.table === "file_changes")).toHaveLength(1);
    expect(ctx.db._patched.filter((patch: any) => patch._id !== "conversation")).toHaveLength(0);
  });

  test("session file query still excludes an outsider", async () => {
    const ctx = setup();
    await ingest(ctx, { _id: "message", timestamp: 10, tool_calls: [call], tool_results: [result] });
    ctx.auth.getUserIdentity = async () => ({ subject: "outsider|session" });
    expect(await (getConversationFileChanges as any)._handler(ctx, { conversation_id: "conversation" })).toEqual([]);
  });
});
