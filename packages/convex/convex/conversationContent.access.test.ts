// A teammate reads a session's content only when its owner shares it at Full.
// Summary (the owner's level, or the session's own team_visibility) shows what
// the session was about and none of its messages: the settings promise
// "teammates see what each session was about, not the conversation itself",
// and the server used to hand every Summary-level teammate the transcript.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const viewer = await ctx.db.insert("users", { name: "Viewer" });
    const T = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "t" });
    const join = (user_id: any, visibility?: string) =>
      ctx.db.insert("team_memberships", { user_id, team_id: T, role: "member", joined_at: now, ...(visibility ? { visibility } : {}) } as any);
    await join(viewer);
    await ctx.db.patch(viewer, { active_team_id: T });
    const session = async (name: string, ownerLevel: string | undefined, team_visibility?: string) => {
      const owner = await ctx.db.insert("users", { name });
      await join(owner, ownerLevel);
      const conversation_id = await ctx.db.insert("conversations", {
        user_id: owner, team_id: T, is_private: false, ...(team_visibility ? { team_visibility } : {}),
        agent_type: "claude_code", session_id: name, started_at: now, updated_at: now, message_count: 1, status: "active",
        title: `${name} session`, last_message_preview: `${name} secret prompt`,
      } as any);
      await ctx.db.insert("messages", { conversation_id, message_uuid: name, role: "user", content: `${name} secret prompt text`, timestamp: now } as any);
      return conversation_id;
    };
    return {
      viewer,
      byDefault: await session("Default", undefined),
      full: await session("Full", "full"),
      summary: await session("Summary", "summary"),
      sessionSummary: await session("Override", "full", "summary"),
    };
  });
}

test("content reaches a teammate only at Full; Summary sends what it was about", async () => {
  const t = convexTest(schema, allModules);
  const ids = await seed(t);
  const as = t.withIdentity({ subject: ids.viewer });

  for (const id of [ids.byDefault, ids.full]) {
    const conv: any = await as.query(api.conversations.getConversation, { conversation_id: id });
    expect(conv.content_access).toBeUndefined();
    expect(conv.messages.map((m: any) => m.content)).toHaveLength(1);
  }
  for (const id of [ids.summary, ids.sessionSummary]) {
    const conv: any = await as.query(api.conversations.getConversation, { conversation_id: id });
    expect(conv.content_access).toBe("summary");
    expect(conv.messages).toEqual([]);
    expect(conv.title).toContain("session");
    expect(conv.last_message_preview).toBeUndefined();
    const meta: any = await as.query(api.conversations.getConversationWithMeta, { conversation_id: id });
    expect(meta.content_access).toBe("summary");
    expect(meta.last_message_preview).toBeUndefined();
    expect(await as.query(api.conversations.listMessagesTail, { conversation_id: id, after_timestamp: 0 })).toBeNull();
  }

  const feed: any = await as.query(api.conversations.getMessageFeed, { filter: "team" });
  expect(feed.messages.map((m: any) => m.content).sort()).toEqual(["Default secret prompt text", "Full secret prompt text"]);
});

test("message links are the owner's: a teammate cannot mint one, and an old teammate-minted link stops serving", async () => {
  const t = convexTest(schema, allModules);
  const ids = await seed(t);
  const { ownerId, messageId } = await t.run(async (ctx) => {
    const conv = (await ctx.db.get(ids.full))!;
    const message = (await ctx.db.query("messages").withIndex("by_conversation_id", (q) => q.eq("conversation_id", ids.full)).first())!;
    // A link a teammate made before minting became owner-only.
    await ctx.db.insert("message_shares", { share_token: "old-teammate-link", message_id: message._id, user_id: ids.viewer, created_at: Date.now() });
    return { ownerId: conv.user_id, messageId: message._id };
  });

  await expect(t.withIdentity({ subject: ids.viewer }).mutation(api.messages.generateMessageShareLink, { message_id: messageId })).rejects.toThrow();
  expect(await t.query(api.messages.getSharedMessage, { share_token: "old-teammate-link" })).toBeNull();
  expect(await t.query(api.messages.getSharedMessageMeta, { share_token: "old-teammate-link" })).toBeNull();

  const token = await t.withIdentity({ subject: ownerId }).mutation(api.messages.generateMessageShareLink, { message_id: messageId });
  const served: any = await t.query(api.messages.getSharedMessage, { share_token: token as any });
  expect(served).not.toBeNull();
});
