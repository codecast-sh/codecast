import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  addCommentV2,
  askAgentInThreadV2,
  deleteComment,
  deleteCommentV2,
  getCommentsV2,
  mirrorAgentReply,
  updateComment,
  updateCommentV2,
  updateGitHubCommentId,
} from "./comments";
import { applyPatches } from "./dispatch";
import { mergeDuplicateUser } from "./admin_mergeUser";
import { deleteAccount } from "./users";
import { runCommentViewTransition } from "./commentViewWrites";

const OWNER = "user-owner" as any;
const MEMBER = "user-member" as any;
const OTHER = "user-other" as any;
const TEAM = "team-main" as any;
const CONVERSATION = "conversation-main" as any;
const CONTRACT = "comments.byConversation/v2";
const VIEW_KEY = `comments:conversation:${CONVERSATION}`;
const GRANT_KEY = `comments:conversation-grant:${CONVERSATION}`;

function user(_id: string, name: string, extra: Record<string, unknown> = {}) {
  return { _id, name, email: `${_id}@example.test`, ...extra };
}

function conversation(
  _id = CONVERSATION,
  owner = OWNER,
  extra: Record<string, unknown> = {},
) {
  return {
    _id,
    user_id: owner,
    is_private: true,
    status: "active",
    ...extra,
  };
}

function sharedConversation(_id = CONVERSATION) {
  return conversation(_id, OWNER, { team_id: TEAM, is_private: false });
}

function memberships() {
  return [
    { _id: "membership-owner", user_id: OWNER, team_id: TEAM, visibility: "summary" },
    { _id: "membership-member", user_id: MEMBER, team_id: TEAM, visibility: "summary" },
  ];
}

function context(
  authenticatedUser: string | null,
  seed: Record<string, any[]> = {},
  options: {
    runMutation?: (reference: unknown, args: unknown) => Promise<unknown>;
    runAfter?: (delay: number, reference: unknown, args: unknown) => Promise<unknown>;
  } = {},
) {
  const db = makeFakeDb({
    users: [user(OWNER, "Owner"), user(MEMBER, "Member"), user(OTHER, "Other")],
    conversations: [],
    comments: [],
    messages: [],
    pull_requests: [],
    team_memberships: [],
    local_view_heads: [],
    local_command_receipts: [],
    pending_messages: [],
    conversation_execution_heads: [],
    execution_bindings: [],
    ...seed,
  });
  const mutationCalls: Array<{ reference: unknown; args: unknown }> = [];
  const scheduledCalls: Array<{ delay: number; reference: unknown; args: unknown }> = [];
  return {
    db,
    auth: {
      async getUserIdentity() {
        return authenticatedUser ? { subject: `${authenticatedUser}|session` } : null;
      },
    },
    async runMutation(reference: unknown, args: unknown) {
      mutationCalls.push({ reference, args });
      return options.runMutation ? await options.runMutation(reference, args) : undefined;
    },
    scheduler: {
      async runAfter(delay: number, reference: unknown, args: unknown) {
        scheduledCalls.push({ delay, reference, args });
        return options.runAfter ? await options.runAfter(delay, reference, args) : undefined;
      },
    },
    _mutationCalls: mutationCalls,
    _scheduledCalls: scheduledCalls,
  } as any;
}

function commentsFor(ctx: any, conversationId = CONVERSATION) {
  return ctx.db._tables.comments.filter(
    (comment: any) => String(comment.conversation_id) === String(conversationId),
  );
}

function heads(ctx: any) {
  return ctx.db._tables.local_view_heads;
}

function receipts(ctx: any) {
  return ctx.db._tables.local_command_receipts;
}

describe("comments v2 complete-view envelopes", () => {
  test("unauthenticated, missing, and forbidden are explicit and carry no rows", async () => {
    const unauthenticated = await (getCommentsV2 as any)._handler(context(null), {
      conversation_id: CONVERSATION,
    });
    expect(unauthenticated).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW_KEY,
      access: "unauthenticated",
    });
    expect("comments" in unauthenticated).toBe(false);

    const missing = await (getCommentsV2 as any)._handler(context(OWNER), {
      conversation_id: CONVERSATION,
    });
    expect(missing).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW_KEY,
      access: "missing",
      releasedGrantKeys: [GRANT_KEY],
      removals: [],
    });
    expect("comments" in missing).toBe(false);

    const forbidden = await (getCommentsV2 as any)._handler(context(MEMBER, {
      conversations: [conversation()],
    }), { conversation_id: CONVERSATION });
    expect(forbidden).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW_KEY,
      access: "forbidden",
      revokedGrantKeys: [GRANT_KEY],
    });
    expect("comments" in forbidden).toBe(false);
  });

  test("an authenticated empty conversation is a granted complete view at revision zero", async () => {
    const result = await (getCommentsV2 as any)._handler(context(OWNER, {
      conversations: [conversation()],
    }), { conversation_id: CONVERSATION });
    expect(result).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW_KEY,
      access: "granted",
      grantKeys: [GRANT_KEY],
      viewRevision: 0,
      coverage: { kind: "view-revision", revision: "0", revisionOrder: 0 },
      comments: [],
    });
  });

  test("a teammate reads the owner's revision domain and gets a deterministic projection", async () => {
    const ctx = context(MEMBER, {
      conversations: [sharedConversation()],
      team_memberships: memberships(),
      comments: [
        {
          _id: "comment-later",
          conversation_id: CONVERSATION,
          user_id: OWNER,
          content: "later",
          created_at: 20,
        },
        {
          _id: "comment-b",
          conversation_id: CONVERSATION,
          user_id: MEMBER,
          content: "same time, b",
          created_at: 10,
        },
        {
          _id: "comment-a",
          conversation_id: CONVERSATION,
          user_id: OWNER,
          content: "same time, a",
          created_at: 10,
        },
      ],
      local_view_heads: [{
        _id: "head-owner",
        principal_id: OWNER,
        contract_id: CONTRACT,
        view_key: VIEW_KEY,
        revision: 7,
        updated_at: 1,
      }, {
        _id: "head-member",
        principal_id: MEMBER,
        contract_id: CONTRACT,
        view_key: VIEW_KEY,
        revision: 99,
        updated_at: 1,
      }],
    });
    const result = await (getCommentsV2 as any)._handler(ctx, {
      conversation_id: CONVERSATION,
    });
    expect(result.access).toBe("granted");
    expect(result.viewRevision).toBe(7);
    expect(result.coverage).toEqual({
      kind: "view-revision",
      revision: "7",
      revisionOrder: 7,
    });
    expect(result.comments.map((comment: any) => comment._id)).toEqual([
      "comment-a",
      "comment-b",
      "comment-later",
    ]);
    expect(result.comments[0].user).toMatchObject({ _id: OWNER, name: "Owner" });
    expect(result.comments[1].user).toMatchObject({ _id: MEMBER, name: "Member" });

    ctx.db._tables.team_memberships = ctx.db._tables.team_memberships.filter(
      (membership: any) => membership.user_id !== MEMBER,
    );
    const revoked = await (getCommentsV2 as any)._handler(ctx, {
      conversation_id: CONVERSATION,
    });
    expect(revoked).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW_KEY,
      access: "forbidden",
      revokedGrantKeys: [GRANT_KEY],
    });
  });
});

describe("comments v2 create receipts and containment", () => {
  test("create commits one comment, one owner-domain revision, and one replayable receipt", async () => {
    const ctx = context(MEMBER, {
      conversations: [sharedConversation()],
      team_memberships: memberships(),
    });
    const args = {
      command_id: "comment-create-1",
      conversation_id: CONVERSATION,
      content: "hello from the team",
      client_id: "optimistic-comment-1",
    };
    const first = await (addCommentV2 as any)._handler(ctx, args);
    const sideEffectsAfterFirst = ctx._mutationCalls.length + ctx._scheduledCalls.length;
    const replay = await (addCommentV2 as any)._handler(ctx, args);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      commandId: "comment-create-1",
      commandName: "comments.create/v2",
      status: "acknowledged",
      result: { clientId: "optimistic-comment-1" },
      coverage: [{ contractId: CONTRACT, viewKey: VIEW_KEY, revision: 1 }],
      retryUntil: null,
    });
    expect(commentsFor(ctx)).toHaveLength(1);
    expect(receipts(ctx)).toHaveLength(1);
    expect(ctx._mutationCalls.length + ctx._scheduledCalls.length).toBe(sideEffectsAfterFirst);
    expect(heads(ctx)).toEqual([
      expect.objectContaining({ principal_id: OWNER, revision: 1 }),
    ]);
    expect(heads(ctx).some((head: any) => head.principal_id === MEMBER)).toBe(false);

    await expect((addCommentV2 as any)._handler(ctx, {
      ...args,
      content: "different intent",
    })).rejects.toThrow("different intent");
    expect(commentsFor(ctx)).toHaveLength(1);
    expect(receipts(ctx)).toHaveLength(1);
  });

  test("a duplicate client id is idempotent, but cannot be rebound to different intent", async () => {
    const existing = {
      _id: "comment-existing",
      conversation_id: CONVERSATION,
      user_id: OWNER,
      content: "same",
      created_at: 1,
      client_id: "stable-client-id",
    };
    const ctx = context(OWNER, {
      conversations: [conversation()],
      comments: [existing],
    });
    const accepted = await (addCommentV2 as any)._handler(ctx, {
      command_id: "duplicate-client-accepted",
      conversation_id: CONVERSATION,
      content: "same",
      client_id: "stable-client-id",
    });
    expect(accepted).toMatchObject({
      status: "acknowledged",
      result: { commentId: "comment-existing", clientId: "stable-client-id" },
      coverage: [{ contractId: CONTRACT, viewKey: VIEW_KEY, revision: 1 }],
    });
    expect(commentsFor(ctx)).toHaveLength(1);
    expect(heads(ctx)[0]).toMatchObject({ principal_id: OWNER, revision: 1 });

    const rejected = await (addCommentV2 as any)._handler(ctx, {
      command_id: "duplicate-client-rejected",
      conversation_id: CONVERSATION,
      content: "changed",
      client_id: "stable-client-id",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      rejection: { code: "CLIENT_ID_REUSED" },
      coverage: [],
    });
    expect(commentsFor(ctx)[0].content).toBe("same");
    expect(heads(ctx)[0].revision).toBe(1);
  });

  test("v2 create durably rejects a blank optimistic identity", async () => {
    const ctx = context(OWNER, { conversations: [conversation()] });
    const args = {
      command_id: "blank-create-client-id",
      conversation_id: CONVERSATION,
      content: "never written",
      client_id: "   ",
    };
    const first = await (addCommentV2 as any)._handler(ctx, args);
    const replay = await (addCommentV2 as any)._handler(ctx, args);
    expect(first).toMatchObject({
      status: "rejected",
      rejection: { code: "INVALID_ARGUMENT" },
      coverage: [],
    });
    expect(replay).toEqual(first);
    expect(commentsFor(ctx)).toHaveLength(0);
    expect(heads(ctx)).toHaveLength(0);
    expect(receipts(ctx)).toHaveLength(1);
  });

  test("message, parent, and pull-request relationship poisoning is durably rejected", async () => {
    const cases = [
      {
        label: "message",
        command_id: "poison-message",
        args: { message_id: "message-other" },
        code: "INVALID_RELATION",
      },
      {
        label: "parent",
        command_id: "poison-parent",
        args: { parent_comment_id: "comment-other" },
        code: "INVALID_RELATION",
      },
      {
        label: "unlinked pull request",
        command_id: "poison-pr-link",
        args: { pr_id: "pr-unlinked" },
        code: "INVALID_RELATION",
      },
      {
        label: "foreign pull request",
        command_id: "poison-pr-access",
        args: { pr_id: "pr-foreign" },
        code: "NOT_FOUND",
      },
    ];
    for (const scenario of cases) {
      const ctx = context(MEMBER, {
        conversations: [
          sharedConversation(),
          sharedConversation("conversation-other"),
        ],
        team_memberships: memberships(),
        messages: [{
          _id: "message-other",
          conversation_id: "conversation-other",
          content: "foreign anchor",
        }],
        comments: [{
          _id: "comment-other",
          conversation_id: "conversation-other",
          user_id: MEMBER,
          content: "foreign parent",
          created_at: 1,
        }],
        pull_requests: [{
          _id: "pr-unlinked",
          team_id: TEAM,
          linked_session_ids: ["conversation-other"],
          repository: "org/repo",
          number: 1,
        }, {
          _id: "pr-foreign",
          team_id: "team-foreign",
          linked_session_ids: [CONVERSATION],
          repository: "other/repo",
          number: 2,
        }],
      });
      const args = {
        command_id: scenario.command_id,
        conversation_id: CONVERSATION,
        content: scenario.label,
        client_id: `client-${scenario.command_id}`,
        ...scenario.args,
      };
      const first = await (addCommentV2 as any)._handler(ctx, args);
      const replay = await (addCommentV2 as any)._handler(ctx, args);
      expect(first, scenario.label).toMatchObject({
        status: "rejected",
        rejection: { code: scenario.code },
        coverage: [],
      });
      expect(replay, scenario.label).toEqual(first);
      expect(commentsFor(ctx)).toHaveLength(0);
      expect(heads(ctx)).toHaveLength(0);
      expect(receipts(ctx)).toHaveLength(1);
    }
  });

  test("missing and revoked conversations return terminal corrections without advancing", async () => {
    const missingCtx = context(OWNER);
    const missing = await (addCommentV2 as any)._handler(missingCtx, {
      command_id: "missing-conversation",
      conversation_id: CONVERSATION,
      content: "never written",
      client_id: "client-missing-conversation",
    });
    expect(missing).toMatchObject({
      status: "rejected",
      rejection: {
        code: "MISSING",
        correction: { releasedGrantKeys: [GRANT_KEY], removals: [] },
      },
      coverage: [],
    });
    expect(heads(missingCtx)).toHaveLength(0);

    const revokedCtx = context(MEMBER, { conversations: [conversation()] });
    const revoked = await (addCommentV2 as any)._handler(revokedCtx, {
      command_id: "revoked-conversation",
      conversation_id: CONVERSATION,
      content: "never written",
      client_id: "client-revoked-conversation",
    });
    expect(revoked).toMatchObject({
      status: "rejected",
      rejection: {
        code: "FORBIDDEN",
        correction: { revokedGrantKeys: [GRANT_KEY] },
      },
      coverage: [],
    });
    expect(heads(revokedCtx)).toHaveLength(0);
  });
});

describe("comments v2 dependent edit and delete", () => {
  test("client_id resolves the authoritative row and every change covers the same view", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      comments: [{
        _id: "comment-edit",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "before",
        created_at: 1,
        client_id: "optimistic-edit",
      }, {
        _id: "comment-delete",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "remove me",
        created_at: 2,
        client_id: "optimistic-delete",
      }],
    });
    const updated = await (updateCommentV2 as any)._handler(ctx, {
      command_id: "edit-by-client",
      conversation_id: CONVERSATION,
      client_id: "optimistic-edit",
      content: "after",
    });
    expect(updated).toMatchObject({
      status: "acknowledged",
      result: { commentId: "comment-edit", clientId: "optimistic-edit" },
      coverage: [{ contractId: CONTRACT, viewKey: VIEW_KEY, revision: 1 }],
    });
    expect(ctx.db._tables.comments.find((row: any) => row._id === "comment-edit").content)
      .toBe("after");

    const deleted = await (deleteCommentV2 as any)._handler(ctx, {
      command_id: "delete-by-client",
      conversation_id: CONVERSATION,
      client_id: "optimistic-delete",
    });
    expect(deleted).toMatchObject({
      status: "acknowledged",
      result: { commentId: "comment-delete", clientId: "optimistic-delete" },
      coverage: [{ contractId: CONTRACT, viewKey: VIEW_KEY, revision: 2 }],
    });
    expect(ctx.db._tables.comments.some((row: any) => row._id === "comment-delete"))
      .toBe(false);

    const replay = await (deleteCommentV2 as any)._handler(ctx, {
      command_id: "delete-by-client",
      conversation_id: CONVERSATION,
      client_id: "optimistic-delete",
    });
    expect(replay).toEqual(deleted);
    expect(heads(ctx)[0].revision).toBe(2);
  });

  test("no-op edits still prove positive coverage without patching the row", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      comments: [{
        _id: "comment-same",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "unchanged",
        created_at: 1,
        client_id: "same-client",
      }],
    });
    const receipt = await (updateCommentV2 as any)._handler(ctx, {
      command_id: "edit-no-op",
      conversation_id: CONVERSATION,
      client_id: "same-client",
      content: "unchanged",
    });
    expect(receipt).toMatchObject({
      status: "acknowledged",
      coverage: [{ contractId: CONTRACT, viewKey: VIEW_KEY, revision: 1 }],
    });
    expect(heads(ctx)[0]).toMatchObject({ principal_id: OWNER, revision: 1 });
    expect(ctx.db._patched).toHaveLength(0);
  });

  test("author and relationship checks fail closed before a write", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation(), conversation("conversation-other")],
      comments: [{
        _id: "comment-not-owned",
        conversation_id: CONVERSATION,
        user_id: OTHER,
        content: "protected",
        created_at: 1,
        client_id: "protected-client",
      }, {
        _id: "comment-wrong-conversation",
        conversation_id: "conversation-other",
        user_id: OWNER,
        content: "elsewhere",
        created_at: 1,
      }],
    });
    const forbidden = await (updateCommentV2 as any)._handler(ctx, {
      command_id: "edit-not-author",
      conversation_id: CONVERSATION,
      client_id: "protected-client",
      content: "attack",
    });
    expect(forbidden).toMatchObject({
      status: "rejected",
      rejection: { code: "FORBIDDEN" },
      coverage: [],
    });
    const poisoned = await (deleteCommentV2 as any)._handler(ctx, {
      command_id: "delete-wrong-conversation",
      conversation_id: CONVERSATION,
      comment_id: "comment-wrong-conversation",
    });
    expect(poisoned).toMatchObject({
      status: "rejected",
      rejection: { code: "INVALID_RELATION" },
      coverage: [],
    });
    expect(ctx.db._tables.comments.map((row: any) => row.content)).toEqual([
      "protected",
      "elsewhere",
    ]);
    expect(heads(ctx)).toHaveLength(0);
  });
});

describe("comments write-choke coverage", () => {
  test("the writer itself rejects a cross-conversation row mutation", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation(), conversation("conversation-other")],
      comments: [{
        _id: "comment-other-view",
        conversation_id: "conversation-other",
        user_id: OWNER,
        content: "protected",
        created_at: 1,
      }],
    });
    await expect(runCommentViewTransition(
      ctx,
      ctx.db._tables.conversations[0],
      "advance",
      async (writer) => writer.patch("comment-other-view" as any, { content: "poisoned" }),
    )).rejects.toThrow("crossed its bound conversation view");
    expect(ctx.db._tables.comments[0].content).toBe("protected");
    expect(heads(ctx)).toHaveLength(0);
  });

  test("legacy edit and delete paths still advance the complete-view head", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      comments: [{
        _id: "comment-legacy-edit",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "before",
        created_at: 1,
      }, {
        _id: "comment-legacy-delete",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "remove",
        created_at: 2,
      }],
    });
    expect(await (updateComment as any)._handler(ctx, {
      comment_id: "comment-legacy-edit",
      content: "after",
    })).toBe("comment-legacy-edit");
    expect(await (deleteComment as any)._handler(ctx, {
      comment_id: "comment-legacy-delete",
    })).toBe(true);
    expect(ctx.db._tables.comments).toEqual([
      expect.objectContaining({ _id: "comment-legacy-edit", content: "after" }),
    ]);
    expect(heads(ctx)[0]).toMatchObject({ principal_id: OWNER, revision: 2 });
  });

  test("ask-agent groups placeholder insert and fork link into one receipt revision", async () => {
    const forkId = "conversation-comment-fork" as any;
    let forkCalls = 0;
    const ctx = context(OWNER, {
      conversations: [conversation(), conversation(forkId)],
    }, {
      async runMutation() {
        forkCalls++;
        return { conversation_id: forkId };
      },
    });
    const args = {
      command_id: "ask-agent-once",
      conversation_id: CONVERSATION,
      client_id: "optimistic-agent-reply",
    };
    const first = await (askAgentInThreadV2 as any)._handler(ctx, args);
    const replay = await (askAgentInThreadV2 as any)._handler(ctx, args);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      status: "acknowledged",
      result: {
        forkConversationId: forkId,
        clientId: "optimistic-agent-reply",
      },
      coverage: [{ contractId: CONTRACT, viewKey: VIEW_KEY, revision: 1 }],
    });
    expect(forkCalls).toBe(1);
    expect(commentsFor(ctx)).toHaveLength(1);
    expect(commentsFor(ctx)[0]).toMatchObject({
      author_kind: "agent",
      agent_status: "thinking",
      fork_conversation_id: forkId,
    });
    expect(ctx.db._tables.pending_messages).toHaveLength(1);
    expect(ctx.db._tables.pending_messages[0].client_id)
      .toBe(`comment-agent:${commentsFor(ctx)[0]._id}`);
    expect(heads(ctx)[0]).toMatchObject({ principal_id: OWNER, revision: 1 });

    const duplicateClientReceipt = await (askAgentInThreadV2 as any)._handler(ctx, {
      ...args,
      command_id: "ask-agent-same-client-new-command",
    });
    expect(duplicateClientReceipt).toMatchObject({
      status: "acknowledged",
      coverage: [{ contractId: CONTRACT, viewKey: VIEW_KEY, revision: 2 }],
    });
    expect(forkCalls).toBe(1);
    expect(commentsFor(ctx)).toHaveLength(1);
    expect(ctx.db._tables.pending_messages).toHaveLength(1);
  });

  test("v2 ask-agent requires a non-blank optimistic identity", async () => {
    const ctx = context(OWNER, { conversations: [conversation()] });
    const receipt = await (askAgentInThreadV2 as any)._handler(ctx, {
      command_id: "ask-agent-blank-client",
      conversation_id: CONVERSATION,
      client_id: "",
    });
    expect(receipt).toMatchObject({
      status: "rejected",
      rejection: { code: "INVALID_ARGUMENT" },
      coverage: [],
    });
    expect(commentsFor(ctx)).toHaveLength(0);
    expect(heads(ctx)).toHaveLength(0);
  });

  test("GitHub id and mirrored agent reply patches each advance the root view", async () => {
    const forkId = "conversation-fork" as any;
    const ctx = context(OWNER, {
      conversations: [
        conversation(),
        conversation(forkId, OWNER, {
          comment_fork_parent: CONVERSATION,
          comment_fork_comment_id: "comment-agent",
          comment_fork_prompt_at: 5,
        }),
      ],
      comments: [{
        _id: "comment-agent",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "",
        created_at: 1,
        author_kind: "agent",
        agent_status: "thinking",
        fork_conversation_id: forkId,
      }],
      messages: [{
        _id: "message-reply",
        conversation_id: forkId,
        role: "assistant",
        content: "The answer from the agent",
        timestamp: 10,
      }],
    });
    expect(await (updateGitHubCommentId as any)._handler(ctx, {
      comment_id: "comment-agent",
      github_comment_id: 123,
    })).toBe(true);
    await (mirrorAgentReply as any)._handler(ctx, { fork_conversation_id: forkId });

    expect(ctx.db._tables.comments[0]).toMatchObject({
      github_comment_id: 123,
      content: "The answer from the agent",
      agent_status: "done",
    });
    expect(heads(ctx)[0]).toMatchObject({ principal_id: OWNER, revision: 2 });
  });

  test("a poisoned fork backlink cannot patch an unrelated comment view", async () => {
    const forkId = "conversation-poisoned-fork" as any;
    const ctx = context(OWNER, {
      conversations: [
        conversation(),
        conversation("conversation-other"),
        conversation(forkId, OWNER, {
          comment_fork_parent: "conversation-other",
          comment_fork_comment_id: "comment-root",
          comment_fork_prompt_at: 5,
        }),
      ],
      comments: [{
        _id: "comment-root",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "protected",
        created_at: 1,
        author_kind: "agent",
        agent_status: "thinking",
        fork_conversation_id: forkId,
      }],
      messages: [{
        _id: "message-poison",
        conversation_id: forkId,
        role: "assistant",
        content: "must not cross the relationship",
        timestamp: 10,
      }],
    });
    await (mirrorAgentReply as any)._handler(ctx, { fork_conversation_id: forkId });
    expect(ctx.db._tables.comments[0]).toMatchObject({
      content: "protected",
      agent_status: "thinking",
    });
    expect(heads(ctx)).toHaveLength(0);
  });

  test("generic dispatch can edit content but not structural comment fields", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      comments: [{
        _id: "comment-dispatch",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "before",
        created_at: 1,
        github_comment_id: 10,
        pr_id: "pr-original",
        file_path: "safe.ts",
        line_number: 4,
      }],
    });
    await applyPatches(ctx, OWNER, {
      comments: {
        "comment-dispatch": {
          content: "after",
          user_id: OTHER,
          conversation_id: "conversation-other",
          github_comment_id: 999,
          pr_id: "pr-poison",
          file_path: "poison.ts",
          line_number: 999,
        },
      },
    });
    expect(ctx.db._tables.comments[0]).toMatchObject({
      content: "after",
      user_id: OWNER,
      conversation_id: CONVERSATION,
      github_comment_id: 10,
      pr_id: "pr-original",
      file_path: "safe.ts",
      line_number: 4,
    });
    expect(heads(ctx)[0]).toMatchObject({ principal_id: OWNER, revision: 1 });
  });

  test("duplicate-user migration advances the conversation owner's view", async () => {
    const surviving = "user-surviving" as any;
    const ctx = context(null, {
      users: [
        user(OTHER, "Duplicate", { email: "same@example.test" }),
        user(surviving, "Survivor", { email: "same@example.test" }),
        user(OWNER, "Conversation owner"),
      ],
      conversations: [conversation()],
      comments: [{
        _id: "comment-migrated",
        conversation_id: CONVERSATION,
        user_id: OTHER,
        content: "keep me",
        created_at: 1,
      }],
    });
    await (mergeDuplicateUser as any)._handler(ctx, {
      from_user_id: OTHER,
      to_user_id: surviving,
      dry_run: false,
      delete_source: false,
    });
    expect(ctx.db._tables.comments[0].user_id).toBe(surviving);
    expect(heads(ctx)[0]).toMatchObject({ principal_id: OWNER, revision: 1 });
  });

  test("account deletion routes comment removal through the same view transition", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      comments: [{
        _id: "comment-account-delete",
        conversation_id: CONVERSATION,
        user_id: OWNER,
        content: "remove with account",
        created_at: 1,
      }],
    });
    const result = await (deleteAccount as any)._handler(ctx, {});
    expect(result).toMatchObject({ completed: true });
    expect(ctx.db._tables.comments).toHaveLength(0);
    expect(heads(ctx)[0]).toMatchObject({ principal_id: OWNER, revision: 1 });
  });
});
