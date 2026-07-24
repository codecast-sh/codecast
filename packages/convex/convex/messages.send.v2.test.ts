import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getReceipt } from "./localFirstCommands";
import {
  pendingMessageMatchesProductIntent,
  sendMessageV2,
} from "./pendingMessages";
import {
  getMessageCoverageV2,
  MESSAGE_COVERAGE_COMMAND_ID_LIMIT,
} from "./messages";

const OWNER = "user-owner" as any;
const MEMBER = "user-member" as any;
const OTHER = "user-other" as any;
const TEAM = "team-main" as any;
const CONVERSATION = "conversation-main" as any;
const OTHER_CONVERSATION = "conversation-other" as any;
const COMMAND = "message-command-1";
const CONTRACT = "messages.byConversation/v2";
const VIEW = `messages:conversation:${CONVERSATION}`;
const GRANT = `messages:conversation-grant:${CONVERSATION}`;

function conversation(
  _id = CONVERSATION,
  owner = OWNER,
  extra: Record<string, unknown> = {},
) {
  return {
    _id,
    user_id: owner,
    owner_user_id: owner,
    is_private: true,
    status: "active",
    updated_at: 1,
    message_count: 0,
    ...extra,
  };
}

function pending(
  clientId = COMMAND,
  extra: Record<string, unknown> = {},
) {
  return {
    _id: `pending-${clientId}`,
    conversation_id: CONVERSATION,
    from_user_id: OWNER,
    owner_user_id: OWNER,
    content: "hello from durable intent",
    client_id: clientId,
    status: "pending",
    created_at: 1,
    retry_count: 0,
    ...extra,
  };
}

function transcript(
  clientId = COMMAND,
  conversationId = CONVERSATION,
  extra: Record<string, unknown> = {},
) {
  return {
    _id: `message-${conversationId}-${clientId}`,
    conversation_id: conversationId,
    role: "user",
    content: "private transcript payload",
    images: [{ media_type: "image/png", storage_id: "private-storage-id" }],
    client_id: clientId,
    timestamp: 2,
    ...extra,
  };
}

function context(authenticatedUser: string | null, seed: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: [
      { _id: OWNER, name: "Owner", email: "owner@example.test" },
      { _id: MEMBER, name: "Member", email: "member@example.test" },
      { _id: OTHER, name: "Other", email: "other@example.test" },
    ],
    teams: [],
    team_memberships: [],
    session_owners: [],
    collab_grants: [],
    conversations: [],
    messages: [],
    pending_messages: [],
    conversation_execution_heads: [],
    execution_bindings: [],
    local_view_heads: [],
    local_command_receipts: [],
    change_log: [],
    ...seed,
  });
  return {
    db,
    auth: {
      async getUserIdentity() {
        return authenticatedUser ? { subject: `${authenticatedUser}|session` } : null;
      },
    },
  } as any;
}

function sendArgs(extra: Record<string, unknown> = {}) {
  return {
    command_id: COMMAND,
    conversation_id: CONVERSATION,
    content: "hello from durable intent",
    client_id: COMMAND,
    ...extra,
  };
}

function rows(ctx: any, table: string) {
  return ctx.db._tables[table];
}

describe("messages.send/v2 durable command", () => {
  test("owner send inserts once, returns command coverage, and stores no receipt payload", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation(CONVERSATION, OWNER, {
        status: "completed",
        inbox_dismissed_at: 1,
        inbox_stashed_at: 2,
        inbox_killed_at: 3,
      })],
    });
    const args = sendArgs({ image_storage_ids: [] });
    const first = await (sendMessageV2 as any)._handler(ctx, args);
    const replay = await (sendMessageV2 as any)._handler(ctx, {
      ...args,
      image_storage_ids: undefined,
    });

    expect(replay).toEqual(first);
    expect(first).toEqual({
      receiptVersion: 1,
      commandId: COMMAND,
      commandName: "messages.send/v2",
      status: "acknowledged",
      coverage: [{
        kind: "command-id",
        contractId: CONTRACT,
        viewKey: VIEW,
        commandId: COMMAND,
      }],
      retryUntil: null,
    });
    expect(rows(ctx, "pending_messages")).toHaveLength(1);
    expect(rows(ctx, "pending_messages")[0]).toMatchObject({
      conversation_id: CONVERSATION,
      from_user_id: OWNER,
      owner_user_id: OWNER,
      content: "hello from durable intent",
      client_id: COMMAND,
      status: "pending",
      retry_count: 0,
    });
    expect(rows(ctx, "conversations")[0]).toMatchObject({
      status: "active",
      has_pending_messages: true,
      inbox_dismissed_at: undefined,
      inbox_stashed_at: undefined,
      inbox_killed_at: undefined,
    });

    const storedReceipt = rows(ctx, "local_command_receipts")[0];
    const serialized = JSON.stringify(storedReceipt);
    expect(serialized).not.toContain("hello from durable intent");
    expect(serialized).not.toContain("image_storage_ids");
    expect(storedReceipt.result).toBeUndefined();
    expect(rows(ctx, "local_view_heads")).toEqual([]);
  });

  test("a command id cannot be replayed with changed content, images, or conversation", async () => {
    for (const changed of [
      { content: "changed intent" },
      { image_storage_ids: ["storage-other" as any] },
      { conversation_id: OTHER_CONVERSATION },
    ]) {
      const ctx = context(OWNER, {
        conversations: [conversation(), conversation(OTHER_CONVERSATION)],
      });
      await (sendMessageV2 as any)._handler(ctx, sendArgs());
      await expect((sendMessageV2 as any)._handler(ctx, sendArgs(changed)))
        .rejects.toThrow("already bound to different intent");
      expect(rows(ctx, "pending_messages")).toHaveLength(1);
    }
  });

  test("command_id must be the exact client_id and the rejection is durable", async () => {
    const ctx = context(OWNER, { conversations: [conversation()] });
    const args = sendArgs({ client_id: "different-client-id" });
    const first = await (sendMessageV2 as any)._handler(ctx, args);
    expect(await (sendMessageV2 as any)._handler(ctx, args)).toEqual(first);
    expect(first).toMatchObject({
      status: "rejected",
      rejection: { code: "INVALID_ARGUMENT" },
      coverage: [],
    });
    expect(rows(ctx, "pending_messages")).toEqual([]);
    expect(rows(ctx, "local_command_receipts")).toHaveLength(1);
  });

  test("an exact existing pending intent dedupes without waking or inserting", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      pending_messages: [pending()],
    });
    const receipt = await (sendMessageV2 as any)._handler(ctx, sendArgs());
    expect(receipt.status).toBe("acknowledged");
    expect(rows(ctx, "pending_messages")).toHaveLength(1);
    expect(ctx.db._patched.some((write: any) => write._id === CONVERSATION)).toBe(false);
  });

  test("every poisoned existing row rejects instead of being accepted as dedupe", async () => {
    const poisonCases: Array<[string, Record<string, unknown>]> = [
      ["principal", { from_user_id: OTHER }],
      ["delivery owner", { owner_user_id: OTHER }],
      ["content", { content: "poisoned" }],
      ["singular image", { image_storage_id: "storage-poison" }],
      ["image list", { image_storage_ids: ["storage-poison"] }],
      ["source conversation", { from_conversation_id: OTHER_CONVERSATION }],
      ["origin", { origin: "scheduler" }],
      ["resend provenance", { resend_of_delivery_id: "old-delivery" }],
    ];
    for (const [label, poison] of poisonCases) {
      const ctx = context(OWNER, {
        conversations: [conversation()],
        pending_messages: [pending(COMMAND, poison)],
      });
      const result = await (sendMessageV2 as any)._handler(ctx, sendArgs());
      expect(result, label).toMatchObject({
        status: "rejected",
        rejection: { code: "CLIENT_ID_REUSED" },
        coverage: [],
      });
      expect(rows(ctx, "pending_messages")).toHaveLength(1);
    }
  });

  test("duplicate pending identities fail closed", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      pending_messages: [pending(), pending(COMMAND, { _id: "pending-duplicate" })],
    });
    expect(await (sendMessageV2 as any)._handler(ctx, sendArgs())).toMatchObject({
      status: "rejected",
      rejection: { code: "CLIENT_ID_INVARIANT" },
    });
    expect(rows(ctx, "pending_messages")).toHaveLength(2);
  });

  test("a transcript collision without exact pending intent cannot manufacture coverage", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      messages: [transcript()],
    });
    expect(await (sendMessageV2 as any)._handler(ctx, sendArgs())).toMatchObject({
      status: "rejected",
      rejection: { code: "CLIENT_ID_REUSED" },
      coverage: [],
    });
    expect(rows(ctx, "pending_messages")).toEqual([]);
  });

  test("cross-principal reuse is rejected against exact pending intent", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      session_owners: [{
        _id: "owner-member",
        conversation_id: CONVERSATION,
        user_id: MEMBER,
        added_by: OWNER,
        added_at: 1,
      }],
    });
    expect((await (sendMessageV2 as any)._handler(ctx, sendArgs())).status)
      .toBe("acknowledged");
    ctx.auth.getUserIdentity = async () => ({ subject: `${MEMBER}|session` });
    const member = await (sendMessageV2 as any)._handler(ctx, sendArgs());
    expect(member).toMatchObject({
      status: "rejected",
      rejection: { code: "CLIENT_ID_REUSED" },
    });
    expect(rows(ctx, "pending_messages")).toHaveLength(1);
    expect(rows(ctx, "local_command_receipts")).toHaveLength(2);
  });

  test("owner-set, team, and explicitly granted collaborators share the current send rule", async () => {
    const authorizedSeeds: Array<[string, Record<string, any[]>]> = [
      ["primary owner cache", {
        conversations: [conversation(CONVERSATION, OWNER, { owner_user_id: MEMBER })],
      }],
      ["secondary owner", {
        conversations: [conversation()],
        session_owners: [{
          _id: "owner-member",
          conversation_id: CONVERSATION,
          user_id: MEMBER,
          added_by: OWNER,
          added_at: 1,
        }],
      }],
      ["team member", {
        conversations: [conversation(CONVERSATION, OWNER, {
          team_id: TEAM,
          is_private: false,
        })],
        team_memberships: [
          { _id: "team-owner", team_id: TEAM, user_id: OWNER, visibility: "summary" },
          { _id: "team-member", team_id: TEAM, user_id: MEMBER, visibility: "summary" },
        ],
      }],
      ["shared-link grantee", {
        conversations: [conversation(CONVERSATION, OWNER, { share_token: "shared" })],
        collab_grants: [{
          _id: "grant-member",
          conversation_id: CONVERSATION,
          grantee_user_id: MEMBER,
          owner_user_id: OWNER,
          status: "granted",
        }],
      }],
    ];

    for (const [label, seed] of authorizedSeeds) {
      const ctx = context(MEMBER, seed);
      const result = await (sendMessageV2 as any)._handler(ctx, sendArgs({
        command_id: `command-${label}`,
        client_id: `command-${label}`,
      }));
      expect(result.status, label).toBe("acknowledged");
      expect(rows(ctx, "pending_messages")[0]).toMatchObject({
        from_user_id: MEMBER,
        owner_user_id: OWNER,
      });
    }
  });

  test("missing, foreign, and revoked collaboration access reject durably", async () => {
    const cases: Array<[string, Record<string, any[]>, string]> = [
      ["missing", {}, "MISSING"],
      ["foreign", { conversations: [conversation()] }, "FORBIDDEN"],
      ["revoked", {
        conversations: [conversation(CONVERSATION, OWNER, { share_token: "shared" })],
        collab_grants: [{
          _id: "grant-member",
          conversation_id: CONVERSATION,
          grantee_user_id: MEMBER,
          owner_user_id: OWNER,
          status: "revoked",
        }],
      }, "FORBIDDEN"],
    ];
    for (const [label, seed, code] of cases) {
      const ctx = context(MEMBER, seed);
      const result = await (sendMessageV2 as any)._handler(ctx, sendArgs());
      expect(result, label).toMatchObject({
        status: "rejected",
        rejection: { code },
        coverage: [],
      });
      expect(rows(ctx, "pending_messages")).toEqual([]);
      expect(rows(ctx, "local_command_receipts")).toHaveLength(1);
    }
  });

  test("session authentication is mandatory and no token-shaped argument exists", async () => {
    const ctx = context(null, { conversations: [conversation()] });
    await expect((sendMessageV2 as any)._handler(ctx, sendArgs()))
      .rejects.toThrow("Unauthorized");
    expect(rows(ctx, "pending_messages")).toEqual([]);
    expect(rows(ctx, "local_command_receipts")).toEqual([]);
  });

  test("receipt lookup is principal scoped and exposes the payload-free proof", async () => {
    const ctx = context(OWNER, { conversations: [conversation()] });
    await (sendMessageV2 as any)._handler(ctx, sendArgs({
      image_storage_ids: ["private-storage-id" as any],
    }));
    const receipt = await (getReceipt as any)._handler(ctx, { command_id: COMMAND });
    expect(receipt.coverage).toEqual([{
      kind: "command-id",
      contractId: CONTRACT,
      viewKey: VIEW,
      commandId: COMMAND,
    }]);
    expect(JSON.stringify(receipt)).not.toContain("hello from durable intent");
    expect(JSON.stringify(receipt)).not.toContain("private-storage-id");

    ctx.auth.getUserIdentity = async () => ({ subject: `${OTHER}|session` });
    expect(await (getReceipt as any)._handler(ctx, { command_id: COMMAND })).toBeNull();
  });
});

describe("messages.byConversation/v2 command coverage", () => {
  test("pending intent is not covered until the exact transcript relation carries its id", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation(), conversation(OTHER_CONVERSATION)],
      pending_messages: [pending()],
      messages: [
        transcript(COMMAND, OTHER_CONVERSATION),
        transcript("covered-two", CONVERSATION),
      ],
    });
    const before = await (getMessageCoverageV2 as any)._handler(ctx, {
      conversation_id: CONVERSATION,
      command_ids: ["uncovered", "covered-two", COMMAND, "covered-two"],
    });
    expect(before).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW,
      access: "granted",
      grantKeys: [GRANT],
      coverage: { kind: "command-ids", commandIds: ["covered-two"] },
    });

    rows(ctx, "messages").push(transcript(COMMAND));
    const after = await (getMessageCoverageV2 as any)._handler(ctx, {
      conversation_id: CONVERSATION,
      command_ids: [COMMAND, "covered-two"],
    });
    expect(after.coverage).toEqual({
      kind: "command-ids",
      commandIds: ["covered-two", COMMAND].sort(),
    });
    const serialized = JSON.stringify(after);
    expect(serialized).not.toContain("private transcript payload");
    expect(serialized).not.toContain("private-storage-id");
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("images");
  });

  test("an empty demand set is a granted, payload-free empty proof", async () => {
    const result = await (getMessageCoverageV2 as any)._handler(context(OWNER, {
      conversations: [conversation()],
      messages: [transcript()],
    }), {
      conversation_id: CONVERSATION,
      command_ids: [],
    });
    expect(result).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW,
      access: "granted",
      grantKeys: [GRANT],
      coverage: { kind: "command-ids", commandIds: [] },
    });
  });

  test("missing, foreign, revoked, and unauthenticated access are explicit", async () => {
    expect(await (getMessageCoverageV2 as any)._handler(context(null), {
      conversation_id: CONVERSATION,
      command_ids: [],
    })).toEqual({ contractId: CONTRACT, viewKey: VIEW, access: "unauthenticated" });

    expect(await (getMessageCoverageV2 as any)._handler(context(OWNER), {
      conversation_id: CONVERSATION,
      command_ids: [],
    })).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW,
      access: "missing",
      releasedGrantKeys: [GRANT],
      removals: [],
    });

    const forbidden = await (getMessageCoverageV2 as any)._handler(context(MEMBER, {
      conversations: [conversation()],
    }), { conversation_id: CONVERSATION, command_ids: [COMMAND] });
    expect(forbidden).toEqual({
      contractId: CONTRACT,
      viewKey: VIEW,
      access: "forbidden",
      revokedGrantKeys: [GRANT],
    });

    const revoked = await (getMessageCoverageV2 as any)._handler(context(MEMBER, {
      conversations: [conversation(CONVERSATION, OWNER, { share_token: "shared" })],
      collab_grants: [{
        _id: "grant-member",
        conversation_id: CONVERSATION,
        grantee_user_id: MEMBER,
        owner_user_id: OWNER,
        status: "revoked",
      }],
    }), { conversation_id: CONVERSATION, command_ids: [COMMAND] });
    expect(revoked).toEqual(forbidden);
  });

  test("command ids are canonical, deduplicated, and hard capped", async () => {
    const ctx = context(OWNER, { conversations: [conversation()] });
    await expect((getMessageCoverageV2 as any)._handler(ctx, {
      conversation_id: CONVERSATION,
      command_ids: [" leading-space"],
    })).rejects.toThrow("canonical string");
    await expect((getMessageCoverageV2 as any)._handler(ctx, {
      conversation_id: CONVERSATION,
      command_ids: Array.from(
        { length: MESSAGE_COVERAGE_COMMAND_ID_LIMIT + 1 },
        (_unused, index) => `command-${index}`,
      ),
    })).rejects.toThrow(`At most ${MESSAGE_COVERAGE_COMMAND_ID_LIMIT}`);
  });

  test("authorized team and granted-link collaborators receive the same opaque scope", async () => {
    const teamCtx = context(MEMBER, {
      conversations: [conversation(CONVERSATION, OWNER, { team_id: TEAM, is_private: false })],
      team_memberships: [
        { _id: "team-owner", team_id: TEAM, user_id: OWNER, visibility: "summary" },
        { _id: "team-member", team_id: TEAM, user_id: MEMBER, visibility: "summary" },
      ],
    });
    expect((await (getMessageCoverageV2 as any)._handler(teamCtx, {
      conversation_id: CONVERSATION,
      command_ids: [],
    })).grantKeys).toEqual([GRANT]);

    const grantCtx = context(MEMBER, {
      conversations: [conversation(CONVERSATION, OWNER, { share_token: "shared" })],
      collab_grants: [{
        _id: "grant-member",
        conversation_id: CONVERSATION,
        grantee_user_id: MEMBER,
        owner_user_id: OWNER,
        status: "granted",
      }],
    });
    expect((await (getMessageCoverageV2 as any)._handler(grantCtx, {
      conversation_id: CONVERSATION,
      command_ids: [],
    })).grantKeys).toEqual([GRANT]);
  });
});

describe("pending intent identity comparison", () => {
  test("matches every canonical field and nothing operational", () => {
    const conv = conversation();
    expect(pendingMessageMatchesProductIntent(pending(), conv, OWNER, {
      content: "hello from durable intent",
      clientId: COMMAND,
    })).toBe(true);
    expect(pendingMessageMatchesProductIntent(pending(COMMAND, {
      status: "injected",
      retry_count: 9,
      delivered_at: 20,
    }), conv, OWNER, {
      content: "hello from durable intent",
      clientId: COMMAND,
    })).toBe(true);
  });
});
