import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  advanceLocalViewRevision,
  canonicalCommandArguments,
  commandArgumentsFingerprint,
  getReceipt,
  readLocalViewRevision,
  runLocalCommand,
} from "./localFirstCommands";

function context(tables: Record<string, any[]> = {}) {
  return {
    db: makeFakeDb({
      local_view_heads: [],
      local_command_receipts: [],
      ...tables,
    }),
  } as any;
}

describe("local-first command receipts", () => {
  test("canonical arguments ignore object insertion order without collapsing values", () => {
    expect(canonicalCommandArguments({ b: 2, a: [1, { z: true }] }))
      .toBe(canonicalCommandArguments({ a: [1, { z: true }], b: 2 }));
    expect(canonicalCommandArguments({ a: 1 })).not.toBe(canonicalCommandArguments({ a: "1" }));
  });

  test("the persisted fingerprint is stable and does not retain command payload", async () => {
    const first = await commandArgumentsFingerprint({ content: "private comment", nested: { b: 2, a: 1 } });
    const reordered = await commandArgumentsFingerprint({ nested: { a: 1, b: 2 }, content: "private comment" });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).not.toContain("private comment");
  });

  test("an exact replay returns the original receipt and executes once", async () => {
    const ctx = context();
    let executions = 0;
    const invoke = () => runLocalCommand(ctx, {
      principalId: "user_a" as any,
      commandId: "cmd-1",
      commandName: "bucket.rename/v1",
      arguments: { bucketId: "b1", name: "Now" },
    }, async () => {
      executions++;
      return {
        status: "acknowledged" as const,
        result: { bucketId: "b1" },
        coverageViews: [{ contractId: "buckets.principal/v2", viewKey: "buckets:principal" }],
      };
    });

    const first = await invoke();
    const replay = await invoke();
    expect(executions).toBe(1);
    expect(replay).toEqual(first);
    expect(first.coverage).toEqual([{
      contractId: "buckets.principal/v2",
      viewKey: "buckets:principal",
      revision: 1,
    }]);
    expect(first.retryUntil).toBeNull();
  });

  test("command-id coverage is payload-free, stable on replay, and does not advance a view head", async () => {
    const ctx = context();
    let executions = 0;
    const invoke = () => runLocalCommand(ctx, {
      principalId: "user_a" as any,
      commandId: "message-command-1",
      commandName: "messages.send/v2",
      arguments: {
        conversationId: "conversation_1",
        content: "private message body",
        imageStorageIds: ["storage-secret"],
      },
    }, async () => {
      executions++;
      return {
        status: "acknowledged" as const,
        coverageViews: [],
        coverageCommandIds: [{
          kind: "command-id" as const,
          contractId: "messages.byConversation/v2",
          viewKey: "messages:conversation:conversation_1",
        }],
      };
    });

    const first = await invoke();
    expect(await invoke()).toEqual(first);
    expect(executions).toBe(1);
    expect(first.coverage).toEqual([{
      kind: "command-id",
      contractId: "messages.byConversation/v2",
      viewKey: "messages:conversation:conversation_1",
      commandId: "message-command-1",
    }]);
    expect((ctx.db as any)._tables.local_view_heads).toEqual([]);

    const stored = (ctx.db as any)._tables.local_command_receipts[0];
    expect(stored.coverage).toEqual([{
      kind: "command-id",
      contract_id: "messages.byConversation/v2",
      view_key: "messages:conversation:conversation_1",
      command_id: "message-command-1",
    }]);
    expect(JSON.stringify(stored)).not.toContain("private message body");
    expect(JSON.stringify(stored)).not.toContain("storage-secret");
    expect(stored.result).toBeUndefined();
  });

  test("reusing a command id for different intent is rejected before execution", async () => {
    const ctx = context();
    const base = {
      principalId: "user_a" as any,
      commandId: "cmd-2",
      commandName: "bucket.rename/v1",
    };
    await runLocalCommand(ctx, { ...base, arguments: { name: "A" } }, async () => ({
      status: "acknowledged",
      coverageViews: [],
    }));
    let executed = false;
    await expect(runLocalCommand(ctx, { ...base, arguments: { name: "B" } }, async () => {
      executed = true;
      return { status: "acknowledged", coverageViews: [] };
    })).rejects.toThrow("different intent");
    expect(executed).toBe(false);
  });

  test("command ids are exact canonical identities, never silently trimmed", async () => {
    const ctx = context();
    await expect(runLocalCommand(ctx, {
      principalId: "user_a" as any,
      commandId: " cmd-with-space",
      commandName: "test/v1",
      arguments: {},
    }, async () => ({ status: "acknowledged", coverageViews: [] })))
      .rejects.toThrow("canonical string");
    expect((ctx.db as any)._tables.local_command_receipts).toHaveLength(0);
  });

  test("a known rejection is durable and never advances authoritative coverage", async () => {
    const ctx = context();
    let executions = 0;
    const invoke = () => runLocalCommand(ctx, {
      principalId: "user_a" as any,
      commandId: "cmd-rejected",
      commandName: "bucket.assign/v1",
      arguments: { conversationId: "foreign" },
    }, async () => {
      executions++;
      return {
        status: "rejected" as const,
        code: "FORBIDDEN",
        message: "Conversation access was revoked",
        correction: { removeAssignment: "foreign" },
      };
    });

    const first = await invoke();
    const replay = await invoke();
    expect(executions).toBe(1);
    expect(replay).toEqual(first);
    expect(first.status).toBe("rejected");
    expect(first.coverage).toEqual([]);
    expect(await readLocalViewRevision(
      ctx,
      "user_a" as any,
      "buckets.principal/v2",
      "buckets:principal",
    )).toBe(0);
  });

  test("view heads are monotonic and isolated by principal and contract", async () => {
    const ctx = context();
    expect(await advanceLocalViewRevision(ctx, "user_a" as any, "buckets", "principal")).toEqual({
      contractId: "buckets",
      viewKey: "principal",
      revision: 1,
    });
    expect(await advanceLocalViewRevision(ctx, "user_a" as any, "buckets", "principal")).toEqual({
      contractId: "buckets",
      viewKey: "principal",
      revision: 2,
    });
    expect(await advanceLocalViewRevision(ctx, "user_b" as any, "buckets", "principal")).toEqual({
      contractId: "buckets",
      viewKey: "principal",
      revision: 1,
    });
    expect(await advanceLocalViewRevision(ctx, "user_a" as any, "comments", "conversation:c1")).toEqual({
      contractId: "comments",
      viewKey: "conversation:c1",
      revision: 1,
    });
  });

  test("receipt lookup is authenticated and principal scoped", async () => {
    const ctx = context({
      local_command_receipts: [{
        _id: "receipt_1",
        principal_id: "user_a",
        command_id: "cmd-private",
        command_name: "test/v1",
        receipt_version: 1,
        argument_fingerprint: "{}",
        status: "acknowledged",
        coverage: [],
        created_at: 1,
      }],
    });
    const withAuth = (userId: string | null) => ({
      ...ctx,
      auth: {
        async getUserIdentity() {
          return userId ? { subject: `${userId}|session` } : null;
        },
      },
    });
    expect(await (getReceipt as any)._handler(withAuth("user_a"), { command_id: "cmd-private" }))
      .toMatchObject({ commandId: "cmd-private", status: "acknowledged" });
    expect(await (getReceipt as any)._handler(withAuth("user_b"), { command_id: "cmd-private" }))
      .toBeNull();
    await expect((getReceipt as any)._handler(withAuth(null), { command_id: "cmd-private" }))
      .rejects.toThrow("Unauthorized");
  });

  test("a shared-view command advances the server-derived revision owner, not the actor", async () => {
    const ctx = context();
    const receipt = await runLocalCommand(ctx, {
      principalId: "team_member" as any,
      commandId: "cmd-shared",
      commandName: "comments.create/v2",
      arguments: { conversationId: "conversation_1", content: "hello" },
    }, async () => ({
      status: "acknowledged",
      coverageViews: [{
        contractId: "comments.byConversation/v2",
        viewKey: "comments:conversation:conversation_1",
        revisionPrincipalId: "conversation_owner" as any,
      }],
    }));
    expect(receipt.coverage).toEqual([{
      contractId: "comments.byConversation/v2",
      viewKey: "comments:conversation:conversation_1",
      revision: 1,
    }]);
    expect(await readLocalViewRevision(
      ctx,
      "conversation_owner" as any,
      "comments.byConversation/v2",
      "comments:conversation:conversation_1",
    )).toBe(1);
    expect(await readLocalViewRevision(
      ctx,
      "team_member" as any,
      "comments.byConversation/v2",
      "comments:conversation:conversation_1",
    )).toBe(0);
  });
});
