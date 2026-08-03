import { describe, expect, test } from "bun:test";
import { applyPatches, classifyHideTransition, dispatch } from "./dispatch";
import { reconfigureSession } from "./conversations";
import { getReceipt } from "./localFirstCommands";
import { makeFakeDb } from "./testDb";

// The conversation hide-transition hook in applyPatches is the ONE place the
// "dismiss = kill, stash = keep alive" contract is enforced — every dismiss
// path (chord, palette, card button, /sessions toggle) funnels its patch
// through it. These tests pin the decision matrix.
describe("classifyHideTransition", () => {
  test("a patch with neither hide flag is inert", () => {
    expect(classifyHideTransition({}, {}, false)).toBe("none");
    expect(classifyHideTransition({ title: "x" } as any, {}, true)).toBe("none");
  });

  test("undo (flags cleared to null/undefined) never reaps or kills", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: undefined, inbox_stashed_at: undefined }, {}, false)).toBe("none");
  });

  test("hiding an EMPTY conversation reaps it — dismissed or stashed alike", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 111 }, {}, true)).toBe("reap");
    expect(classifyHideTransition({ inbox_stashed_at: 111 }, {}, true)).toBe("reap");
  });

  test("dismissing a conversation with real work kills the agent", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 111 }, {}, false)).toBe("kill");
  });

  test("stashing a conversation with real work does NOT kill — the whole point of stash", () => {
    expect(classifyHideTransition({ inbox_stashed_at: 111 }, {}, false)).toBe("none");
  });

  test("a re-asserted dismiss (already dismissed pre-patch) does not re-kill", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 222 }, { inbox_dismissed_at: 111 }, false)).toBe("none");
  });

  test("dismissing a previously-stashed session kills (stash is no shield once you dismiss)", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 222, inbox_stashed_at: null }, { inbox_dismissed_at: null }, false)).toBe("kill");
  });
});

// The conversations patch gate: the runner, the primary owner (owner_user_id
// cache), and a SECONDARY owner (session_owners row only) may all triage; a
// non-owner's patch is silently dropped. Regression for "dismiss doesn't stick
// on a session assigned to me": the gate consulted only the primary cache, so a
// secondary owner's dismiss never persisted and the reconcile resurrected it.
describe("applyPatches conversation owner gate", () => {
  const RUNNER = "users_runner";
  const PRIMARY = "users_primary";
  const SECONDARY = "users_secondary";
  const OUTSIDER = "users_outsider";
  const CONV = "conversations_1";

  function fixtures() {
    return makeFakeDb({
      conversations: [
        {
          _id: CONV,
          user_id: RUNNER,
          owner_user_id: PRIMARY,
          status: "active",
          message_count: 5,
        },
      ],
      session_owners: [
        { _id: "so_1", conversation_id: CONV, user_id: PRIMARY, added_by: RUNNER, added_at: 1 },
        { _id: "so_2", conversation_id: CONV, user_id: SECONDARY, added_by: RUNNER, added_at: 2 },
      ],
      messages: [],
      pending_messages: [],
    });
  }

  const stashPatch = { conversations: { [CONV]: { inbox_stashed_at: 111 } } };

  test("secondary owner's triage patch lands via the canonical owner set", async () => {
    const db = fixtures();
    await applyPatches({ db } as any, SECONDARY as any, stashPatch);
    expect(db._tables.conversations[0].inbox_stashed_at).toBe(111);
  });

  test("primary owner (cache) and runner still pass the fast checks", async () => {
    for (const user of [PRIMARY, RUNNER]) {
      const db = fixtures();
      await applyPatches({ db } as any, user as any, stashPatch);
      expect(db._tables.conversations[0].inbox_stashed_at).toBe(111);
    }
  });

  test("a non-owner's patch is dropped", async () => {
    const db = fixtures();
    await applyPatches({ db } as any, OUTSIDER as any, stashPatch);
    expect(db._tables.conversations[0].inbox_stashed_at).toBeUndefined();
  });

  test("named rekey flush applies the latest fields through the same owner gate", async () => {
    const db = fixtures();
    await (dispatch as any)._handler({
      auth: {
        getUserIdentity: async () => ({ subject: `${RUNNER}|session` }),
      },
      db,
    }, {
      action: "flushResolvedSessionFields",
      args: [CONV, { project_path: "/latest", git_root: "/latest" }],
    });
    expect(db._tables.conversations[0]).toMatchObject({
      project_path: "/latest",
      git_root: "/latest",
    });
  });
});

// Kill is a DESIRED STATE, not an event. A kill patch is indistinguishable at
// the FIELD level from a quiet re-assert of the same flag (a stub-rekey flush,
// an undo replay), so the dispatched ACTION NAME is the only signal of intent
// the server gets. Regression: a killed session whose worker a daemon bug
// revived still carried inbox_dismissed_at, so the hide transition classified
// "none" and no teardown was ever enqueued — the worker was unkillable.
describe("explicit kill actions force teardown", () => {
  const RUNNER = "users_runner";
  const CONV = "conversations_killed";

  function fixtures() {
    return makeFakeDb({
      // Already in the Killed bucket, with real work (so the empty-reap path
      // can't fire) — the resurrection case.
      conversations: [{
        _id: CONV, user_id: RUNNER, session_id: "s-1", status: "completed",
        message_count: 12, inbox_dismissed_at: 111, inbox_killed_at: 111,
      }],
      messages: [],
      pending_messages: [],
      client_state: [],
      managed_sessions: [],
      agent_tasks: [],
      daemon_commands: [],
      session_owners: [],
    });
  }

  const run = (db: any, action: string) => (dispatch as any)._handler({
    auth: { getUserIdentity: async () => ({ subject: `${RUNNER}|session` }) },
    db,
  }, {
    action,
    args: [],
    patches: { conversations: { [CONV]: { inbox_dismissed_at: 222 } } },
  });

  const teardowns = (db: any) =>
    db._tables.daemon_commands.filter((c: any) => c.command === "kill_session");

  test("killSession re-enqueues teardown on an already-killed session", async () => {
    const db = fixtures();
    await run(db, "killSession");
    expect(teardowns(db)).toHaveLength(1);
    expect(JSON.parse(teardowns(db)[0].args)).toMatchObject({ conversation_id: CONV, session_id: "s-1" });
  });

  test("killSessions (the bulk gesture) forces the same way", async () => {
    const db = fixtures();
    await run(db, "killSessions");
    expect(teardowns(db)).toHaveLength(1);
  });

  test("a quiet re-assert of the flag by any other action does NOT re-kill", async () => {
    const db = fixtures();
    await run(db, "patchConversation");
    expect(teardowns(db)).toHaveLength(0);
  });
});

describe("applyPatches bucket coverage", () => {
  test("a legacy generic bucket patch advances the v2 complete-view head once", async () => {
    const userId = "users_owner";
    const db = makeFakeDb({
      inbox_buckets: [{ _id: "bucket_1", user_id: userId, name: "Before", updated_at: 1 }],
      local_view_heads: [],
    });
    await applyPatches({ db } as any, userId as any, {
      inbox_buckets: {
        bucket_1: { name: "After", color: "blue" },
      },
    });
    expect(db._tables.inbox_buckets[0].name).toBe("After");
    expect(db._tables.local_view_heads).toMatchObject([{
      principal_id: userId,
      contract_id: "buckets.principal/v2",
      view_key: "buckets:principal",
      revision: 1,
    }]);
  });

  test("a forbidden bucket patch neither writes nor advances coverage", async () => {
    const db = makeFakeDb({
      inbox_buckets: [{ _id: "bucket_1", user_id: "owner", name: "Before", updated_at: 1 }],
      local_view_heads: [],
    });
    await applyPatches({ db } as any, "stranger" as any, {
      inbox_buckets: { bucket_1: { name: "Stolen" } },
    });
    expect(db._tables.inbox_buckets[0].name).toBe("Before");
    expect(db._tables.local_view_heads).toEqual([]);
  });
});

describe("createSession side effect", () => {
  const userId = "users_owner";

  function createSessionDb(extra: Record<string, any[]> = {}) {
    return makeFakeDb({
      rate_limits: [],
      directory_team_mappings: [],
      conversations: [],
      devices: [],
      daemon_commands: [],
      change_log: [],
      local_view_heads: [],
      docs: [],
      plans: [],
      tasks: [],
      team_memberships: [],
      ...extra,
    });
  }

  async function createLinkedSession(
    db: ReturnType<typeof makeFakeDb>,
    linkedObject: { type: "task" | "doc" | "plan"; id: string },
    sessionId = `client-${linkedObject.type}`,
  ) {
    return await (dispatch as any)._handler({
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
    }, {
      action: "createSession",
      args: [{
        agent_type: "claude_code",
        project_path: "/repo",
        session_id: sessionId,
        linked_object: linkedObject,
      }],
    });
  }

  test("forwards per-session stable-context preferences to start_session", async () => {
    const db = createSessionDb();

    await (dispatch as any)._handler({
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
    }, {
      action: "createSession",
      args: [{
        agent_type: "claude_code",
        project_path: "/repo",
        session_id: "client-stub",
        stable_mode: "solo",
        stable_exclude: ["team-feed", "recent-sessions"],
      }],
    });

    const start = db._tables.daemon_commands.find(
      (row: any) => row.command === "start_session",
    );
    expect(start).toBeDefined();
    expect(JSON.parse(start.args)).toMatchObject({
      stable_mode: "solo",
      stable_exclude: ["team-feed", "recent-sessions"],
    });
  });

  test("atomically links a context-created session to its task", async () => {
    const taskId = "tasks_context";
    const db = createSessionDb({
      tasks: [{
        _id: taskId,
        user_id: userId,
        title: "Investigate",
        project_path: "/repo",
        conversation_ids: [],
      }],
    });

    const conversationId = await createLinkedSession(db, { type: "task", id: taskId });
    const task = db._tables.tasks.find((row: any) => row._id === taskId);
    const conversation = db._tables.conversations.find((row: any) => row._id === conversationId);

    expect(task.conversation_ids).toEqual([conversationId]);
    expect(conversation.active_task_id).toBe(taskId);
  });

  test("atomically links a context-created session to its doc", async () => {
    const docId = "docs_context";
    const db = createSessionDb({
      docs: [{
        _id: docId,
        user_id: userId,
        title: "Context",
        related_conversation_ids: [],
      }],
    });

    const conversationId = await createLinkedSession(db, { type: "doc", id: docId });
    const doc = db._tables.docs.find((row: any) => row._id === docId);

    expect(doc.related_conversation_ids).toEqual([conversationId]);
  });

  test("atomically links a context-created session to its plan", async () => {
    const planId = "plans_context";
    const db = createSessionDb({
      plans: [{
        _id: planId,
        user_id: userId,
        title: "Context plan",
        session_ids: [],
      }],
    });

    const conversationId = await createLinkedSession(db, { type: "plan", id: planId });
    const plan = db._tables.plans.find((row: any) => row._id === planId);
    const conversation = db._tables.conversations.find((row: any) => row._id === conversationId);

    expect(plan.session_ids).toEqual([conversationId]);
    expect(conversation.active_plan_id).toBe(planId);
  });

  test("replaying a linked create is idempotent", async () => {
    const docId = "docs_replayed";
    const db = createSessionDb({
      docs: [{
        _id: docId,
        user_id: userId,
        title: "Replay",
        related_conversation_ids: [],
      }],
    });

    const first = await createLinkedSession(db, { type: "doc", id: docId }, "client-replayed");
    const second = await createLinkedSession(db, { type: "doc", id: docId }, "client-replayed");
    const doc = db._tables.docs.find((row: any) => row._id === docId);

    expect(second).toBe(first);
    expect(db._tables.conversations).toHaveLength(1);
    expect(doc.related_conversation_ids).toEqual([first]);
  });

  test("replaying create repairs a previously missing context link", async () => {
    const docId = "docs_repair";
    const existingConversationId = "conversations_existing";
    const db = createSessionDb({
      conversations: [{
        _id: existingConversationId,
        user_id: userId,
        session_id: "client-repair",
        agent_type: "claude_code",
        status: "active",
      }],
      docs: [{
        _id: docId,
        user_id: userId,
        title: "Repair",
        related_conversation_ids: [],
      }],
    });

    const result = await createLinkedSession(db, { type: "doc", id: docId }, "client-repair");
    const doc = db._tables.docs.find((row: any) => row._id === docId);

    expect(result).toBe(existingConversationId);
    expect(db._tables.conversations).toHaveLength(1);
    expect(doc.related_conversation_ids).toEqual([existingConversationId]);
  });
});

describe("receipt-backed create side effects", () => {
  test("replaying createDoc with the same command id returns one canonical result", async () => {
    const userId = "users_owner";
    const db = makeFakeDb({
      local_command_receipts: [],
      local_view_heads: [],
    });
    let creates = 0;
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
      runMutation: async () => {
        creates++;
        return { id: "docs_created" };
      },
    };
    const input = {
      action: "createDoc",
      args: [{ title: "Durable doc", doc_type: "note" }],
      result: {
        receiptActionVersion: 1,
        commandId: "create-doc-command",
      },
    };

    const first = await (dispatch as any)._handler(ctx, input);
    const replay = await (dispatch as any)._handler(ctx, input);
    const resolved = await (getReceipt as any)._handler(ctx, {
      command_id: "create-doc-command",
    });

    expect(creates).toBe(1);
    expect(first).toMatchObject({
      commandId: "create-doc-command",
      commandName: "docs.create/v2",
      status: "acknowledged",
      result: { id: "docs_created" },
    });
    expect(replay).toEqual(first);
    expect(resolved).toEqual(first);
    expect(db._tables.local_command_receipts).toHaveLength(1);
  });

  test("a command id cannot be reused for different create intent", async () => {
    const userId = "users_owner";
    const db = makeFakeDb({
      local_command_receipts: [],
      local_view_heads: [],
    });
    let creates = 0;
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
      runMutation: async () => {
        creates++;
        return { id: "docs_created" };
      },
    };
    const result = {
      receiptActionVersion: 1,
      commandId: "create-doc-command",
    };

    await (dispatch as any)._handler(ctx, {
      action: "createDoc",
      args: [{ title: "First", doc_type: "note" }],
      result,
    });
    await expect((dispatch as any)._handler(ctx, {
      action: "createDoc",
      args: [{ title: "Different", doc_type: "note" }],
      result,
    })).rejects.toThrow(/already bound to different intent/i);

    expect(creates).toBe(1);
  });

  test("plan and project creates use their own replay-safe receipt identities", async () => {
    for (const fixture of [
      {
        action: "createPlan",
        commandName: "plans.create/v2",
        args: { title: "Durable plan" },
        created: { id: "plans_created", short_id: "pl-created" },
      },
      {
        action: "createProject",
        commandName: "projects.create/v2",
        args: { title: "Durable project" },
        created: { id: "projects_created", short_id: "pj-created" },
      },
    ]) {
      const userId = "users_owner";
      const db = makeFakeDb({
        local_command_receipts: [],
        local_view_heads: [],
      });
      let creates = 0;
      const ctx = {
        auth: {
          getUserIdentity: async () => ({ subject: `${userId}|session` }),
        },
        db,
        runMutation: async () => {
          creates++;
          return fixture.created;
        },
      };
      const input = {
        action: fixture.action,
        args: [fixture.args],
        result: {
          receiptActionVersion: 1,
          commandId: `${fixture.action}-command`,
        },
      };

      const first = await (dispatch as any)._handler(ctx, input);
      const replay = await (dispatch as any)._handler(ctx, input);

      expect(creates).toBe(1);
      expect(first).toMatchObject({
        commandId: `${fixture.action}-command`,
        commandName: fixture.commandName,
        status: "acknowledged",
        result: fixture.created,
      });
      expect(replay).toEqual(first);
    }
  });

  test("createBucket delegates to the existing V2 receipt surface and preserves its canonical id", async () => {
    const userId = "users_owner";
    const db = makeFakeDb({});
    let mutationArgs: any;
    const receipt = {
      receiptVersion: 1,
      commandId: "create-bucket-command",
      commandName: "buckets.create/v2",
      status: "acknowledged",
      result: { bucketId: "inbox_buckets_created" },
      coverage: [],
      retryUntil: null,
    };
    const result = await (dispatch as any)._handler({
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
      runMutation: async (_mutation: unknown, args: unknown) => {
        mutationArgs = args;
        return receipt;
      },
    }, {
      action: "createBucket",
      args: [{ name: "Investigations", color: "cyan" }],
      result: {
        receiptActionVersion: 1,
        commandId: "create-bucket-command",
      },
    });

    expect(mutationArgs).toEqual({
      command_id: "create-bucket-command",
      name: "Investigations",
      color: "cyan",
    });
    expect(result).toEqual(receipt);
  });

  test("createBucket commits its dependent assignment once and replay cannot overwrite a newer filing", async () => {
    const userId = "users_owner";
    const conversationId = "conversations_target";
    const db = makeFakeDb({
      conversations: [{
        _id: conversationId,
        user_id: userId,
        session_id: "session-target",
      }],
      inbox_buckets: [],
      bucket_assignments: [],
      local_command_receipts: [],
      local_view_heads: [],
    });
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
    };
    const input = {
      action: "createBucket",
      args: [
        { name: "Durable assignment" },
        {
          version: 1,
          kind: "assignBucket",
          conversationIds: [conversationId],
        },
      ],
      result: {
        receiptActionVersion: 1,
        commandId: "create-and-assign-command",
        localResult: {
          stubId: "bucketstub-local",
          continuation: {
            version: 1,
            kind: "assignBucket",
            conversationIds: [conversationId],
          },
        },
      },
    };

    const first = await (dispatch as any)._handler(ctx, input);
    expect(first).toMatchObject({
      commandId: "create-and-assign-command",
      status: "acknowledged",
      result: { bucketId: expect.any(String) },
    });
    expect(db._tables.inbox_buckets).toHaveLength(1);
    expect(db._tables.bucket_assignments).toMatchObject([{
      user_id: userId,
      conversation_id: conversationId,
      bucket_id: first.result.bucketId,
    }]);

    // A newer manual filing happens after the acknowledged command. Replaying
    // the create receipt must be a pure read, not reapply the old continuation.
    db._tables.bucket_assignments[0].bucket_id = "inbox_buckets_newer";
    const replay = await (dispatch as any)._handler(ctx, input);

    expect(replay).toEqual(first);
    expect(db._tables.inbox_buckets).toHaveLength(1);
    expect(db._tables.bucket_assignments[0].bucket_id)
      .toBe("inbox_buckets_newer");
  });

  test("a pre-receipt create entry retains its legacy delivery path during rollout", async () => {
    const userId = "users_owner";
    const db = makeFakeDb({});
    let creates = 0;
    const result = await (dispatch as any)._handler({
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
      runMutation: async () => {
        creates++;
        return { id: "docs_legacy" };
      },
    }, {
      action: "createDoc",
      args: [{ title: "Already queued" }],
      result: null,
    });

    expect(creates).toBe(1);
    expect(result).toEqual({ id: "docs_legacy" });
    expect(db._tables.local_command_receipts).toBeUndefined();
  });
});

// Client stub ids reach the bucket receipt dispatches by design: fork label
// inheritance files the local fork stub (the server files the real row itself
// via inheritLabelAssignment), and a label can be edited before its create
// acknowledges. Regression for the final-mode cutover routing these into
// webAssignV2/webUpdateV2, whose v.id validators threw ArgumentValidationError
// — a permanent error on a must-deliver receipt entry, so the outbox re-fired
// the refusal (and its error toast) on every boot forever.
describe("bucket receipt dispatches tolerate client stub ids", () => {
  const USER = "users_owner";
  const CONV = "conversations_real";
  const BUCKET = "inbox_buckets_real";

  function makeCtx() {
    const db = makeFakeDb({
      conversations: [{ _id: CONV, user_id: USER }],
      inbox_buckets: [{ _id: BUCKET, user_id: USER, name: "api" }],
      local_command_receipts: [],
      local_view_heads: [],
    });
    const mutationCalls: any[] = [];
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: `${USER}|session` }),
      },
      db,
      runMutation: async (_fn: unknown, args: any) => {
        mutationCalls.push(args);
        return { commandId: args.command_id, status: "acknowledged" };
      },
    };
    return { ctx, db, mutationCalls };
  }

  test("assign with a stub conversation id (fork inheritance) acknowledges as a durable no-op", async () => {
    const { ctx, db, mutationCalls } = makeCtx();
    const input = {
      action: "assignSessionToBucket",
      args: ["p2juk3l0abcm9xylocalforkstub", BUCKET],
      result: { receiptActionVersion: 1, commandId: "assign-stub-conv" },
    };

    const first = await (dispatch as any)._handler(ctx, input);
    const replay = await (dispatch as any)._handler(ctx, input);

    expect(first).toMatchObject({
      commandId: "assign-stub-conv",
      status: "acknowledged",
      result: { gate: "conv_not_found" },
    });
    expect(replay).toEqual(first);
    expect(mutationCalls).toHaveLength(0);
    expect(db._tables.local_command_receipts).toHaveLength(1);
  });

  test("assign to a still-optimistic label stub acknowledges as a no-op", async () => {
    const { ctx, mutationCalls } = makeCtx();
    const receipt = await (dispatch as any)._handler(ctx, {
      action: "assignSessionToBucket",
      args: [CONV, "localbucketstub123"],
      result: { receiptActionVersion: 1, commandId: "assign-stub-bucket" },
    });

    expect(receipt).toMatchObject({
      status: "acknowledged",
      result: { gate: "bucket_not_owned" },
    });
    expect(mutationCalls).toHaveLength(0);
  });

  test("assign with real ids still delegates to webAssignV2", async () => {
    const { ctx, mutationCalls } = makeCtx();
    await (dispatch as any)._handler(ctx, {
      action: "assignSessionToBucket",
      args: [CONV, BUCKET],
      result: { receiptActionVersion: 1, commandId: "assign-real" },
    });

    expect(mutationCalls).toEqual([{
      command_id: "assign-real",
      conversation_id: CONV,
      bucket_id: BUCKET,
    }]);
  });

  test("updateBucket against a label stub returns a rejected receipt instead of throwing", async () => {
    const { ctx, mutationCalls } = makeCtx();
    const receipt = await (dispatch as any)._handler(ctx, {
      action: "updateBucket",
      args: ["localbucketstub123", { name: "renamed" }],
      result: { receiptActionVersion: 1, commandId: "update-stub-bucket" },
    });

    expect(receipt).toMatchObject({
      commandId: "update-stub-bucket",
      status: "rejected",
      rejection: { code: "NOT_FOUND" },
    });
    expect(mutationCalls).toHaveLength(0);
  });
});

describe("reconfigureSession stable-context forwarding", () => {
  test("relaunches a parked-create correction with the latest stable context", async () => {
    const userId = "users_owner";
    const conversationId = "conversations_reconfigure";
    const db = makeFakeDb({
      conversations: [{
        _id: conversationId,
        user_id: userId,
        session_id: "client-reconfigure",
        agent_type: "claude_code",
        project_path: "/repo",
        git_root: "/repo",
        message_count: 0,
        status: "active",
        updated_at: 1,
      }],
      devices: [],
      daemon_commands: [],
      directory_team_mappings: [],
      change_log: [],
      local_view_heads: [],
    });

    await (reconfigureSession as any)._handler({
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
    }, {
      conversation_id: conversationId,
      stable_mode: "solo",
      stable_exclude: ["conversation-old"],
    });

    const start = db._tables.daemon_commands.find(
      (row: any) => row.command === "start_session",
    );
    expect(start).toBeDefined();
    expect(JSON.parse(start.args)).toMatchObject({
      stable_mode: "solo",
      stable_exclude: ["conversation-old"],
    });
  });
});

describe("legacy comment action bridge", () => {
  test("routes create/delete/ask through receipt-backed v2 commands", async () => {
    const calls: any[] = [];
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: "users_owner|session" }),
      },
      db: makeFakeDb({}),
      runMutation: async (_fn: unknown, args: unknown) => {
        calls.push(args);
        return { status: "acknowledged" };
      },
    };

    await (dispatch as any)._handler(ctx, {
      action: "addComment",
      args: [],
      result: {
        conversationId: "conversations_1",
        content: "hello",
        clientId: "commentstub-1",
        commandId: "legacy-comments-create:commentstub-1",
      },
    });
    await (dispatch as any)._handler(ctx, {
      action: "deleteComment",
      args: [],
      result: {
        conversationId: "conversations_1",
        clientId: "commentstub-1",
        commandId: "legacy-comments-delete:commentstub-1",
      },
    });
    await (dispatch as any)._handler(ctx, {
      action: "askAgentInThread",
      args: [],
      result: {
        conversationId: "conversations_1",
        clientId: "commentstub-agent-1",
        commandId: "legacy-comments-ask:commentstub-agent-1",
      },
    });

    expect(calls).toEqual([
      {
        command_id: "legacy-comments-create:commentstub-1",
        conversation_id: "conversations_1",
        content: "hello",
        client_id: "commentstub-1",
      },
      {
        command_id: "legacy-comments-delete:commentstub-1",
        conversation_id: "conversations_1",
        client_id: "commentstub-1",
      },
      {
        command_id: "legacy-comments-ask:commentstub-agent-1",
        conversation_id: "conversations_1",
        client_id: "commentstub-agent-1",
      },
    ]);
  });

  test("unwraps receipt-action localResult and preserves the outer command identity", async () => {
    const calls: any[] = [];
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: "users_owner|session" }),
      },
      db: makeFakeDb({}),
      runMutation: async (_fn: unknown, args: unknown) => {
        calls.push(args);
        return {
          commandId: "outbox-command-1",
          status: "acknowledged",
        };
      },
    };

    await (dispatch as any)._handler(ctx, {
      action: "addComment",
      args: ["conversations_1", "hello"],
      result: {
        receiptActionVersion: 1,
        commandId: "outbox-command-1",
        localResult: {
          conversationId: "conversations_1",
          content: "hello",
          clientId: "commentstub-1",
          commandId: "legacy-comments-create:commentstub-1",
        },
      },
    });

    expect(calls).toEqual([{
      command_id: "outbox-command-1",
      conversation_id: "conversations_1",
      content: "hello",
      client_id: "commentstub-1",
    }]);
  });

  test("routes receipt-backed comment edits through updateCommentV2", async () => {
    const calls: any[] = [];
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: "users_owner|session" }),
      },
      db: makeFakeDb({}),
      runMutation: async (_fn: unknown, args: unknown) => {
        calls.push(args);
        return {
          commandId: "edit-outbox-command",
          status: "acknowledged",
        };
      },
    };

    await (dispatch as any)._handler(ctx, {
      action: "editComment",
      args: ["comments_1", "after"],
      result: {
        receiptActionVersion: 1,
        commandId: "edit-outbox-command",
        localResult: {
          commentId: "comments_1",
          conversationId: "conversations_1",
          clientId: "comment-client-1",
          content: "after",
          previousContent: "before",
        },
      },
    });

    expect(calls).toEqual([{
      command_id: "edit-outbox-command",
      conversation_id: "conversations_1",
      comment_id: "comments_1",
      client_id: "comment-client-1",
      content: "after",
    }]);
  });

  test("replays pre-command-id comment payloads with deterministic V2 ids", async () => {
    const calls: any[] = [];
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: "users_owner|session" }),
      },
      db: makeFakeDb({}),
      runMutation: async (_fn: unknown, args: unknown) => {
        calls.push(args);
        return { status: "acknowledged" };
      },
    };

    await (dispatch as any)._handler(ctx, {
      action: "addComment",
      args: [],
      result: {
        conversationId: "conversations_1",
        content: "from an older outbox",
        clientId: "commentstub-old",
      },
    });
    await (dispatch as any)._handler(ctx, {
      action: "askAgentInThread",
      args: [],
      result: {
        conversationId: "conversations_1",
        clientId: "commentstub-agent-old",
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        command_id: "legacy-comments-create:commentstub-old",
      }),
      expect.objectContaining({
        command_id: "legacy-comments-ask:commentstub-agent-old",
      }),
    ]);
  });
});
