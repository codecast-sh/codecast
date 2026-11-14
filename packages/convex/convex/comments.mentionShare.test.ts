// An owner's @mention on a private session shares it with the mentioned
// teammate (Alex, 2026-11-14). Before this, the mention notified a teammate who
// could not read the session, and the notification opened "Conversation not
// found" on the phone.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { commentRow } from "./testComments";
import { addComment, askAgentInThread, getCommentsV2 } from "./comments";
import { checkConversationAccess } from "./privacy";

const OWNER = "user-owner" as any;
const MEMBER = "user-member" as any;
const GUEST = "user-guest" as any;
const TEAM = "team-main" as any;
const CONVERSATION = "conversation-main" as any;

function context(authenticatedUser: string, seed: Record<string, any[]> = {}) {
  const { comments: seededComments = [], ...rest } = seed;
  const db = makeFakeDb({
    users: [
      { _id: OWNER, name: "Owner", github_username: "owner" },
      { _id: MEMBER, name: "Member", github_username: "member" },
      { _id: GUEST, name: "Guest", github_username: "guest" },
    ],
    conversations: [{ _id: CONVERSATION, user_id: OWNER, team_id: TEAM, is_private: true, status: "active" }],
    team_memberships: [
      { _id: "m-owner", user_id: OWNER, team_id: TEAM, visibility: "full" },
      { _id: "m-member", user_id: MEMBER, team_id: TEAM, visibility: "full" },
    ],
    review_comments: seededComments.map(commentRow),
    conversation_read_grants: [],
    share_redemptions: [],
    session_owners: [],
    messages: [],
    pull_requests: [],
    local_view_heads: [],
    local_command_receipts: [],
    pending_messages: [],
    conversation_execution_heads: [],
    execution_bindings: [],
    ...rest,
  });
  const calls: Array<{ reference: unknown; args: any }> = [];
  return {
    db,
    auth: { async getUserIdentity() { return { subject: `${authenticatedUser}|session` }; } },
    async runMutation(reference: unknown, args: any) { calls.push({ reference, args }); },
    scheduler: { async runAfter() {} },
    _calls: calls,
  } as any;
}

const mentionsTo = (ctx: any, userId: string) =>
  ctx._calls.filter((c: any) => c.args?.event_type === "mention" && c.args?.direct_recipient_id === userId);

describe("an @mention on a private session", () => {
  test("the owner's mention lets the teammate read the session and its comments", async () => {
    const ctx = context(OWNER);
    const conversation = await ctx.db.get(CONVERSATION);
    expect(await checkConversationAccess(ctx, MEMBER, conversation)).toBe("denied");

    await (addComment as any)._handler(ctx, { conversation_id: CONVERSATION, content: "cc @member, thoughts?" });

    expect(ctx.db._tables.conversation_read_grants).toEqual([
      expect.objectContaining({ conversation_id: CONVERSATION, user_id: MEMBER, granted_by: OWNER, source: "mention" }),
    ]);
    expect(mentionsTo(ctx, MEMBER)).toHaveLength(1);
    expect(await checkConversationAccess(ctx, MEMBER, conversation)).toBe("shared");

    const view = await (getCommentsV2 as any)._handler(context(MEMBER, { conversation_read_grants: ctx.db._tables.conversation_read_grants, comments: [] }), { conversation_id: CONVERSATION });
    expect(view.access).toBe("granted");
  });

  test("a second mention adds no second grant", async () => {
    const ctx = context(OWNER);
    await (addComment as any)._handler(ctx, { conversation_id: CONVERSATION, content: "@member one" });
    await (addComment as any)._handler(ctx, { conversation_id: CONVERSATION, content: "@member two" });
    expect(ctx.db._tables.conversation_read_grants).toHaveLength(1);
  });

  test("the grant ends when the teammate leaves the team", async () => {
    const ctx = context(OWNER);
    await (addComment as any)._handler(ctx, { conversation_id: CONVERSATION, content: "@member" });
    await ctx.db.delete("m-member");
    expect(await checkConversationAccess(ctx, MEMBER, await ctx.db.get(CONVERSATION))).toBe("denied");
  });

  test("the mentioned teammate can reply, but cannot run an agent in the thread", async () => {
    const owner = context(OWNER);
    await (addComment as any)._handler(owner, { conversation_id: CONVERSATION, content: "@member" });
    const member = context(MEMBER, { conversation_read_grants: owner.db._tables.conversation_read_grants });

    await (addComment as any)._handler(member, { conversation_id: CONVERSATION, content: "looks right" });
    expect(member.db._tables.review_comments.some((c: any) => c.content === "looks right")).toBe(true);

    await expect((askAgentInThread as any)._handler(member, { conversation_id: CONVERSATION })).rejects.toThrow();
  });

  test("a non-owner's mention of someone who cannot read is not delivered and shares nothing", async () => {
    const owner = context(OWNER);
    await (addComment as any)._handler(owner, { conversation_id: CONVERSATION, content: "@member" });
    const member = context(MEMBER, {
      conversation_read_grants: owner.db._tables.conversation_read_grants,
      team_memberships: [
        { _id: "m-owner", user_id: OWNER, team_id: TEAM, visibility: "full" },
        { _id: "m-member", user_id: MEMBER, team_id: TEAM, visibility: "full" },
        { _id: "m-guest", user_id: GUEST, team_id: TEAM, visibility: "full" },
      ],
    });
    await (addComment as any)._handler(member, { conversation_id: CONVERSATION, content: "@guest have a look" });
    expect(mentionsTo(member, GUEST)).toHaveLength(0);
    expect(member.db._tables.conversation_read_grants.map((g: any) => g.user_id)).toEqual([MEMBER]);
  });

  test("a teammate who already reads the session gets the mention and no grant", async () => {
    const ctx = context(OWNER, {
      conversations: [{ _id: CONVERSATION, user_id: OWNER, team_id: TEAM, is_private: false, team_visibility: "full", status: "active" }],
    });
    await (addComment as any)._handler(ctx, { conversation_id: CONVERSATION, content: "@member" });
    expect(ctx.db._tables.conversation_read_grants).toHaveLength(0);
    expect(mentionsTo(ctx, MEMBER)).toHaveLength(1);
  });
});
