import { describe, expect, test } from "bun:test";
import type { Id } from "./_generated/dataModel";
import { makeFakeDb } from "./testDb";
import { enqueuePendingMessage, claimPendingMessageForDaemon, updatePendingMessageStatusForDaemon } from "./pendingMessages";
import {
  EXECUTION_PROTOCOL_CAPABILITIES,
  abandonAmbiguousAndResendInDb,
  activateAfterLegacyQuiescenceInDb,
  activateExecutionSuccessorInDb,
  authenticateExecutionDaemon,
  beginLegacyQuiescenceInDb,
  claimExecutionStartInDb,
  claimNextDeliveryInDb,
  completeDeliveryInDb,
  disposePreReadyBindingInDb,
  failDeliveryBeforeEffectInDb,
  initializeFencedExecutionInDb,
  markDeliveryAmbiguousInDb,
  publishReadyBindingInDb,
  publishRuntimeDispositionInDb,
  publishStartOutcomeInDb,
  recordExecutionSuccessorIntentInDb,
  registerExecutionDaemonBootInDb,
  releaseClaimBeforeEffectInDb,
  requestExecutionSuccessorInDb,
  resolveAmbiguousDeliveryInDb,
  startDeliveryInDb,
} from "./executionBindings";

const USER = "users_1" as Id<"users">;
const OTHER_USER = "users_2" as Id<"users">;
const CONVERSATION = "conversations_1" as Id<"conversations">;
const OTHER_CONVERSATION = "conversations_2" as Id<"conversations">;

function tables(options?: { legacyMessages?: any[] }) {
  return {
    users: [
      { _id: USER, name: "Owner" },
      { _id: OTHER_USER, name: "Other" },
    ],
    conversations: [
      {
        _id: CONVERSATION,
        user_id: USER,
        agent_type: "codex",
        owner_device_id: "device-1",
        status: "active",
        updated_at: 1,
      },
    ],
    pending_messages: options?.legacyMessages ?? [],
    conversation_execution_heads: [],
    execution_bindings: [],
    execution_daemon_boots: [],
    delivery_attempts: [],
  };
}

function target(overrides: Partial<any> = {}) {
  return {
    requestedAgent: "codex" as const,
    transport: "app-server" as const,
    projectPath: "/work/project",
    configurationRevision: 1,
    model: "gpt-5",
    effort: "high",
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    protocolVersion: 1,
    ...overrides,
  };
}

function supportedTransport(agent: string): "tmux" | "app-server" {
  return agent === "codex" ? "app-server" : "tmux";
}

async function initializeAndReady(db: any) {
  const ctx = { db };
  await initializeFencedExecutionInDb(ctx, USER, {
    conversationId: CONVERSATION,
    target: target(),
    now: 10,
  });
  const claim = await claimExecutionStartInDb(ctx, USER, {
    conversationId: CONVERSATION,
    epoch: 1,
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    configurationRevision: 1,
    protocolVersion: 1,
    requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    proposedOperationId: "start-1",
    now: 11,
  });
  expect(claim.state).toBe("claimed");
  const ready = await publishReadyBindingInDb(ctx, USER, {
    conversationId: CONVERSATION,
    epoch: 1,
    requestedAgent: "codex",
    actualAgent: "codex",
    transport: "app-server",
    handle: "thread-1",
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    runtimeId: "runtime-1",
    operationId: "start-1",
    appliedConfigurationRevision: 1,
    protocolVersion: 1,
    capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    now: 12,
  });
  expect(ready.accepted).toBe(true);
  return ctx;
}

function fence(permit: any) {
  return {
    messageId: permit.messageId,
    deliveryId: permit.deliveryId,
    conversationSequence: Number(permit.conversationSequence),
    attemptId: permit.attemptId,
    conversationId: CONVERSATION,
    executionEpoch: permit.executionEpoch,
    configurationRevision: permit.configurationRevision,
    ownerDeviceId: permit.ownerDeviceId,
    daemonBootId: permit.daemonBootId,
    runtimeId: permit.runtimeId,
  };
}

async function enqueue(ctx: any, clientId: string, content = clientId) {
  const conversation = await ctx.db.get(CONVERSATION);
  return await enqueuePendingMessage(ctx, conversation, USER, {
    content,
    client_id: clientId,
  });
}

async function claimDelivery(ctx: any, expectedMessageId?: any) {
  return await claimNextDeliveryInDb(ctx, USER, {
    conversationId: CONVERSATION,
    expectedMessageId,
    executionEpoch: 1,
    configurationRevision: 1,
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    runtimeId: "runtime-1",
    now: 20,
  });
}

async function recordRestartIntent(
  ctx: any,
  intentId: string,
  policy: "drain-current" | "cancel-unstarted",
  now: number,
) {
  return await recordExecutionSuccessorIntentInDb(ctx, USER, {
    conversationId: CONVERSATION,
    intentId,
    expectedCurrentEpoch: 1,
    kind: "restart",
    policy,
    now,
  });
}

describe("fenced execution startup authority", () => {
  test("ambient browser auth cannot enter the daemon effect authority", async () => {
    const browserOnlyCtx = {
      auth: { getUserIdentity: async () => ({ subject: String(USER) }) },
      db: {
        query() {
          throw new Error("token verification must not run without an explicit token");
        },
      },
    };
    await expect(
      authenticateExecutionDaemon(browserOnlyCtx as any, undefined),
    ).rejects.toThrow("DAEMON_TOKEN_REQUIRED");
  });

  test("every canonical family and compatibility alias refuses a cross-family successor", async () => {
    const cases = [
      ["claude", "claude"],
      ["claude_code", "claude"],
      ["cowork", "claude"],
      ["codex", "codex"],
      ["cursor", "cursor"],
      ["gemini", "gemini"],
      ["opencode", "opencode"],
      ["pi", "pi"],
    ] as const;
    for (const [conversationAgent, canonicalAgent] of cases) {
      const seeded = tables();
      seeded.conversations[0].agent_type = conversationAgent;
      const db = makeFakeDb(seeded);
      const ctx = { db };
      await initializeFencedExecutionInDb(ctx, USER, {
        conversationId: CONVERSATION,
        target: target({
          requestedAgent: canonicalAgent,
          transport: supportedTransport(canonicalAgent),
        }),
        now: 1,
      });
      const wrongAgent = canonicalAgent === "codex" ? "claude" : "codex";
      await recordRestartIntent(ctx, `wrong-agent-${conversationAgent}`, "drain-current", 1.5);
      await expect(
        requestExecutionSuccessorInDb(ctx, USER, {
          conversationId: CONVERSATION,
          intentId: `wrong-agent-${conversationAgent}`,
          expectedCurrentEpoch: 1,
          policy: "drain-current",
          target: target({
            requestedAgent: wrongAgent,
            transport: supportedTransport(wrongAgent),
            configurationRevision: 2,
          }),
          now: 2,
        }),
      ).rejects.toThrow("EXECUTION_SUCCESSOR_INTENT_MISMATCH");
    }
  });

  test("agent registry rejects unsupported fenced transports", async () => {
    for (const [conversationAgent, requestedAgent, transport] of [
      ["claude_code", "claude", "app-server"],
      ["opencode", "opencode", "app-server"],
      ["codex", "codex", "external"],
    ] as const) {
      const seeded = tables();
      seeded.conversations[0].agent_type = conversationAgent;
      const ctx = { db: makeFakeDb(seeded) };
      await expect(initializeFencedExecutionInDb(ctx, USER, {
        conversationId: CONVERSATION,
        target: target({ requestedAgent, transport }),
        now: 1,
      })).rejects.toThrow("EXECUTION_TRANSPORT_UNSUPPORTED");
    }
  });

  test("one exact daemon boot wins startup and ready publication is a strict CAS", async () => {
    const db = makeFakeDb(tables());
    const ctx = { db };
    await initializeFencedExecutionInDb(ctx, USER, {
      conversationId: CONVERSATION,
      target: target(),
      now: 1,
    });

    const winner = await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      configurationRevision: 1,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "winner",
      now: 2,
    });
    expect(winner.state).toBe("claimed");

    const otherOperation = await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      configurationRevision: 1,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "loser",
      now: 3,
    });
    expect(otherOperation.state).toBe("busy");

    const otherBoot = await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-2",
      configurationRevision: 1,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "other-boot",
      now: 4,
    });
    expect(otherBoot.state).toBe("rejected");
    expect(otherBoot.failure.code).toBe("EXECUTION_BINDING_FENCE_MISMATCH");

    const staleReady = await publishReadyBindingInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      requestedAgent: "codex",
      actualAgent: "codex",
      transport: "app-server",
      handle: "wrong-thread",
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      runtimeId: "wrong-runtime",
      operationId: "loser",
      appliedConfigurationRevision: 1,
      protocolVersion: 1,
      capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      now: 5,
    });
    expect(staleReady).toEqual({ accepted: false, reason: "compare-and-set-lost" });

    await expect(
      publishReadyBindingInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 1,
        requestedAgent: "codex",
        actualAgent: "claude",
        transport: "app-server",
        handle: "thread-1",
        ownerDeviceId: "device-1",
        daemonBootId: "boot-1",
        runtimeId: "runtime-1",
        operationId: "winner",
        appliedConfigurationRevision: 1,
        protocolVersion: 1,
        capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        now: 6,
      }),
    ).rejects.toThrow("REQUESTED_ACTUAL_AGENT_MISMATCH");

    const ready = await publishReadyBindingInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      requestedAgent: "codex",
      actualAgent: "codex",
      transport: "app-server",
      handle: "thread-1",
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      runtimeId: "runtime-1",
      operationId: "winner",
      appliedConfigurationRevision: 1,
      protocolVersion: 1,
      capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      now: 7,
    });
    expect(ready.accepted).toBe(true);
    expect(ready.binding.actualAgent).toBe("codex");
    expect(ready.binding.daemonBootId).toBe("boot-1");
  });

  test("a retryable pre-effect start reuses the exact operation id", async () => {
    const db = makeFakeDb(tables());
    const ctx = { db };
    await initializeFencedExecutionInDb(ctx, USER, {
      conversationId: CONVERSATION,
      target: target(),
      now: 1,
    });
    await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      configurationRevision: 1,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "stable-operation",
      now: 2,
    });
    expect(await publishStartOutcomeInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      configurationRevision: 1,
      operationId: "stable-operation",
      failureCode: "TEMPORARY_SETUP_FAILURE",
      failureMessage: "retry",
      failureRetryable: true,
      outcome: "start-failed-before-effect",
      now: 3,
    })).toEqual({ accepted: true });

    const replacementOperation = await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      configurationRevision: 1,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "replacement-operation",
      now: 4,
    });
    expect(replacementOperation).toMatchObject({
      state: "rejected",
      failure: { code: "START_RETRY_OPERATION_MISMATCH" },
    });

    const retry = await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      configurationRevision: 1,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "stable-operation",
      now: 5,
    });
    expect(retry).toMatchObject({ state: "claimed", operationId: "stable-operation" });
  });

  test("legacy quiescence blocks old endpoints and activation requires the exact old boot", async () => {
    const legacyMessage: any = {
      _id: "pending_messages_legacy" as Id<"pending_messages">,
      conversation_id: CONVERSATION,
      from_user_id: USER,
      owner_user_id: USER,
      client_id: "legacy-client-1",
      content: "queued before migration",
      status: "pending",
      created_at: 5,
      retry_count: 0,
    };
    const db = makeFakeDb(tables({ legacyMessages: [legacyMessage] }));
    const ctx = { db };
    await beginLegacyQuiescenceInDb(ctx, USER, {
      conversationId: CONVERSATION,
      ownerDeviceId: "device-1",
      legacyDaemonBootId: "old-boot",
      protocolVersion: 1,
      now: 10,
    });

    expect(await claimPendingMessageForDaemon(ctx, legacyMessage._id, USER, "device-1")).toBeNull();
    expect(
      await updatePendingMessageStatusForDaemon(
        ctx,
        legacyMessage._id,
        USER,
        "device-1",
        { status: "injected" },
      ),
    ).toEqual({ updated: false, skipped: true });

    await expect(
      activateAfterLegacyQuiescenceInDb(ctx, USER, {
        conversationId: CONVERSATION,
        target: target({ daemonBootId: "new-boot" }),
        terminatedLegacyDaemonBootId: "some-other-boot",
        runtimeDisposition: "stopped",
        terminationEvidence: "supervisor waitpid proof",
        now: 11,
      }),
    ).rejects.toThrow("LEGACY_BOOT_PROOF_MISMATCH");

    const activated = await activateAfterLegacyQuiescenceInDb(ctx, USER, {
      conversationId: CONVERSATION,
      target: target({ daemonBootId: "new-boot" }),
      terminatedLegacyDaemonBootId: "old-boot",
      runtimeDisposition: "stopped",
      terminationEvidence: "supervisor waitpid proof",
      now: 12,
    });
    expect(activated).toEqual({ state: "fenced", epoch: 1, migratedMessages: 1 });
    expect(legacyMessage.delivery_id).toBe("legacy-client-1");
    expect(legacyMessage.client_id).toBe("legacy-client-1");
    expect(legacyMessage.conversation_sequence).toBe(1);
    expect(legacyMessage.execution_epoch).toBe(1);
    expect(await claimPendingMessageForDaemon(ctx, legacyMessage._id, USER, "device-1")).toBeNull();

    const oldBoot = await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "old-boot",
      configurationRevision: 1,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "stale-start",
      now: 13,
    });
    expect(oldBoot.state).toBe("rejected");
  });

  test("pre-ready restart states require exact, evidence-bearing disposition", async () => {
    // No start claim is itself durable proof that no external start was authorized.
    {
      const db = makeFakeDb(tables());
      const ctx = { db };
      await initializeFencedExecutionInDb(ctx, USER, {
        conversationId: CONVERSATION,
        target: target(),
        now: 1,
      });
      expect(
        await disposePreReadyBindingInDb(ctx, USER, {
          conversationId: CONVERSATION,
          epoch: 1,
          expectedState: "requested",
          configurationRevision: 1,
          ownerDeviceId: "device-1",
          daemonBootId: "boot-1",
          inspection: "proven-no-effect",
          evidence: "no start operation was ever claimed",
          now: 2,
        }),
      ).toEqual({ state: "stopped" });
      await recordRestartIntent(ctx, "pre-ready-restart", "drain-current", 2.5);
      await requestExecutionSuccessorInDb(ctx, USER, {
        conversationId: CONVERSATION,
        intentId: "pre-ready-restart",
        expectedCurrentEpoch: 1,
        policy: "drain-current",
        target: target({ configurationRevision: 2, daemonBootId: "boot-2" }),
        now: 3,
      });
      await claimExecutionStartInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 2,
        ownerDeviceId: "device-1",
        daemonBootId: "boot-2",
        configurationRevision: 2,
        protocolVersion: 1,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        proposedOperationId: "replacement-start",
        now: 4,
      });
      await publishReadyBindingInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 2,
        requestedAgent: "codex",
        actualAgent: "codex",
        transport: "app-server",
        handle: "replacement-thread",
        ownerDeviceId: "device-1",
        daemonBootId: "boot-2",
        runtimeId: "replacement-runtime",
        operationId: "replacement-start",
        appliedConfigurationRevision: 2,
        protocolVersion: 1,
        capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        now: 5,
      });
      expect(
        (
          await activateExecutionSuccessorInDb(ctx, USER, {
            conversationId: CONVERSATION,
            expectedCurrentEpoch: 1,
            successorEpoch: 2,
            currentConfigurationRevision: 1,
            currentOwnerDeviceId: "device-1",
            currentDaemonBootId: "boot-1",
            successorConfigurationRevision: 2,
            successorOwnerDeviceId: "device-1",
            successorDaemonBootId: "boot-2",
            successorRuntimeId: "replacement-runtime",
            now: 6,
          })
        ).activated,
      ).toBe(true);
    }

    // Once startup is claimed, an unknown inspection becomes ambiguity. A
    // positive no-effect inspection may retire it; a timeout alone may not.
    {
      const db = makeFakeDb(tables());
      const ctx = { db };
      await initializeFencedExecutionInDb(ctx, USER, {
        conversationId: CONVERSATION,
        target: target(),
        now: 1,
      });
      await claimExecutionStartInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 1,
        ownerDeviceId: "device-1",
        daemonBootId: "boot-1",
        configurationRevision: 1,
        protocolVersion: 1,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        proposedOperationId: "start-before-effect",
        now: 2,
      });
      expect(
        await disposePreReadyBindingInDb(ctx, USER, {
          conversationId: CONVERSATION,
          epoch: 1,
          expectedState: "starting",
          configurationRevision: 1,
          ownerDeviceId: "device-1",
          daemonBootId: "boot-1",
          operationId: "start-before-effect",
          inspection: "unknown",
          evidence: "inspection transport timed out",
          now: 3,
        }),
      ).toEqual({ state: "start-ambiguous" });
      expect(
        await disposePreReadyBindingInDb(ctx, USER, {
          conversationId: CONVERSATION,
          epoch: 1,
          expectedState: "start-ambiguous",
          configurationRevision: 1,
          ownerDeviceId: "device-1",
          daemonBootId: "boot-1",
          operationId: "start-before-effect",
          inspection: "proven-no-effect",
          evidence: "driver enumerated operation tag and found no runtime",
          now: 4,
        }),
      ).toEqual({ state: "stopped" });
    }

    // A possibly-created runtime must remain named and quarantined.
    {
      const db = makeFakeDb(tables());
      const ctx = { db };
      await initializeFencedExecutionInDb(ctx, USER, {
        conversationId: CONVERSATION,
        target: target(),
        now: 1,
      });
      await claimExecutionStartInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 1,
        ownerDeviceId: "device-1",
        daemonBootId: "boot-1",
        configurationRevision: 1,
        protocolVersion: 1,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        proposedOperationId: "post-create",
        now: 2,
      });
      await publishStartOutcomeInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 1,
        ownerDeviceId: "device-1",
        daemonBootId: "boot-1",
        configurationRevision: 1,
        operationId: "post-create",
        failureCode: "START_ACK_LOST",
        failureMessage: "runtime creation may have completed",
        suspectedRuntimeId: "suspect-runtime",
        outcome: "start-ambiguous",
        now: 3,
      });
      expect(
        await disposePreReadyBindingInDb(ctx, USER, {
          conversationId: CONVERSATION,
          epoch: 1,
          expectedState: "start-ambiguous",
          configurationRevision: 1,
          ownerDeviceId: "device-1",
          daemonBootId: "boot-1",
          operationId: "post-create",
          inspection: "runtime-quarantined",
          suspectedRuntimeId: "suspect-runtime",
          evidence: "runtime tagged and isolated from delivery",
          now: 4,
        }),
      ).toEqual({ state: "quarantined" });
    }

    // A non-retryable pre-effect failure cannot silently re-enter starting.
    {
      const db = makeFakeDb(tables());
      const ctx = { db };
      await initializeFencedExecutionInDb(ctx, USER, {
        conversationId: CONVERSATION,
        target: target(),
        now: 1,
      });
      await claimExecutionStartInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 1,
        ownerDeviceId: "device-1",
        daemonBootId: "boot-1",
        configurationRevision: 1,
        protocolVersion: 1,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        proposedOperationId: "bad-config",
        now: 2,
      });
      await publishStartOutcomeInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 1,
        ownerDeviceId: "device-1",
        daemonBootId: "boot-1",
        configurationRevision: 1,
        operationId: "bad-config",
        failureCode: "INVALID_MODEL",
        failureMessage: "configuration is not supported",
        failureRetryable: false,
        outcome: "start-failed-before-effect",
        now: 3,
      });
      const retry = await claimExecutionStartInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 1,
        ownerDeviceId: "device-1",
        daemonBootId: "boot-1",
        configurationRevision: 1,
        protocolVersion: 1,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        proposedOperationId: "unsafe-retry",
        now: 4,
      });
      expect(retry.state).toBe("busy");
      expect(retry.failure.code).toBe("START_NOT_RETRYABLE");
    }
  });
});

describe("cross-boot recovery", () => {
  const claimAs = (ctx: any, daemonBootId: string, proposedOperationId: string, now: number) =>
    claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      ownerDeviceId: "device-1",
      daemonBootId,
      configurationRevision: 1,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId,
      now,
    });

  test("the registered successor boot adopts a starting binding with recovery proof", async () => {
    const db = makeFakeDb(tables());
    const ctx = { db };
    await initializeFencedExecutionInDb(ctx, USER, {
      conversationId: CONVERSATION,
      target: target(),
      now: 1,
    });
    expect((await claimAs(ctx, "boot-1", "start-1", 2)).state).toBe("claimed");

    // The daemon restarts; the new boot registers, then re-proposes the exact
    // durable operation from the prior boot's journal.
    await registerExecutionDaemonBootInDb(ctx, USER, {
      ownerDeviceId: "device-1",
      daemonBootId: "boot-2",
      now: 3,
    });
    const recovered = await claimAs(ctx, "boot-2", "start-1", 4);
    expect(recovered).toMatchObject({
      state: "claimed",
      operationId: "start-1",
      recovery: {
        state: "recovering",
        previousDaemonBootId: "boot-1",
        previousBootTerminated: true,
      },
    });
    expect(db._tables.execution_bindings[0].daemon_boot_id).toBe("boot-2");

    // A different operation id proves the caller does NOT hold the journal.
    expect((await claimAs(ctx, "boot-2", "unrelated-op", 5)).state).toBe("busy");
  });

  test("the registered successor boot adopts a ready binding", async () => {
    const ctx = await initializeAndReady(makeFakeDb(tables()));
    await registerExecutionDaemonBootInDb(ctx, USER, {
      ownerDeviceId: "device-1",
      daemonBootId: "boot-2",
      now: 20,
    });
    const recovered = await claimAs(ctx, "boot-2", "any-op", 21);
    expect(recovered.state).toBe("ready");
    expect(recovered.binding.daemonBootId).toBe("boot-2");
    expect((ctx as any).db._tables.execution_bindings[0].daemon_boot_id).toBe("boot-2");
  });

  test("an unregistered boot and the dead boot's late claim both stay fenced out", async () => {
    const ctx = await initializeAndReady(makeFakeDb(tables()));
    await registerExecutionDaemonBootInDb(ctx, USER, {
      ownerDeviceId: "device-1",
      daemonBootId: "boot-2",
      now: 20,
    });
    // boot-3 never registered: no transfer.
    const unregistered = await claimAs(ctx, "boot-3", "op-3", 21);
    expect(unregistered.state).toBe("rejected");

    // boot-2 adopts; the dead boot-1's delayed claim can never steal it back.
    expect((await claimAs(ctx, "boot-2", "any-op", 22)).state).toBe("ready");
    const stale = await claimAs(ctx, "boot-1", "start-1", 23);
    expect(stale.state).toBe("rejected");
    expect((ctx as any).db._tables.execution_bindings[0].daemon_boot_id).toBe("boot-2");
  });

  test("a requested binding transfers to the registered successor boot", async () => {
    const db = makeFakeDb(tables());
    const ctx = { db };
    await initializeFencedExecutionInDb(ctx, USER, {
      conversationId: CONVERSATION,
      target: target(),
      now: 1,
    });
    await registerExecutionDaemonBootInDb(ctx, USER, {
      ownerDeviceId: "device-1",
      daemonBootId: "boot-2",
      now: 2,
    });
    const recovered = await claimAs(ctx, "boot-2", "start-2", 3);
    expect(recovered).toMatchObject({
      state: "claimed",
      operationId: "start-2",
      recovery: { state: "recovering", previousDaemonBootId: "boot-1" },
    });
    const binding = db._tables.execution_bindings[0];
    expect(binding.daemon_boot_id).toBe("boot-2");
    expect(binding.state).toBe("starting");
  });
});

describe("browser successor intent boundary", () => {
  test("requires exact conversation ownership", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    await expect(
      recordExecutionSuccessorIntentInDb(ctx, OTHER_USER, {
        conversationId: CONVERSATION,
        intentId: "not-owner",
        expectedCurrentEpoch: 1,
        kind: "restart",
        policy: "drain-current",
        now: 20,
      }),
    ).rejects.toThrow("EXECUTION_NOT_OWNER");
  });

  test("an intent is scoped to exactly one conversation", async () => {
    const seeded = tables();
    seeded.conversations.push({
      ...seeded.conversations[0],
      _id: OTHER_CONVERSATION,
    });
    const db = makeFakeDb(seeded);
    const ctx = await initializeAndReady(db);
    await initializeFencedExecutionInDb(ctx, USER, {
      conversationId: OTHER_CONVERSATION,
      target: target(),
      now: 13,
    });
    await recordRestartIntent(ctx, "conversation-one-only", "drain-current", 14);
    await expect(
      requestExecutionSuccessorInDb(ctx, USER, {
        conversationId: OTHER_CONVERSATION,
        intentId: "conversation-one-only",
        expectedCurrentEpoch: 1,
        policy: "drain-current",
        target: target({ configurationRevision: 2, daemonBootId: "boot-2" }),
        now: 15,
      }),
    ).rejects.toThrow("EXECUTION_SUCCESSOR_INTENT_MISSING");
  });

  test("rejects a stale epoch before recording product intent", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    await expect(
      recordExecutionSuccessorIntentInDb(ctx, USER, {
        conversationId: CONVERSATION,
        intentId: "stale",
        expectedCurrentEpoch: 2,
        kind: "restart",
        policy: "drain-current",
        now: 20,
      }),
    ).rejects.toThrow("EXECUTION_EPOCH_FENCE_MISMATCH");
  });

  test("same-id exact replay is idempotent and changed payload is rejected", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    const first = await recordRestartIntent(ctx, "stable-intent", "drain-current", 20);
    const replay = await recordRestartIntent(ctx, "stable-intent", "drain-current", 21);
    expect(replay).toEqual(first);
    await expect(
      recordExecutionSuccessorIntentInDb(ctx, USER, {
        conversationId: CONVERSATION,
        intentId: "stable-intent",
        expectedCurrentEpoch: 1,
        kind: "restart",
        policy: "cancel-unstarted",
        now: 22,
      }),
    ).rejects.toThrow("EXECUTION_INTENT_ID_REUSED");
  });

  test("the head serializes competing intents and derives configuration policy", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    const accepted = await recordExecutionSuccessorIntentInDb(ctx, USER, {
      conversationId: CONVERSATION,
      intentId: "winner",
      expectedCurrentEpoch: 1,
      kind: "reconfigure",
      policy: "drain-current",
      model: "gpt-5.4",
      effort: "xhigh",
      now: 20,
    });
    expect(accepted).toMatchObject({ state: "pending", configurationRevision: 2 });
    const intent = (db._tables.conversation_execution_heads[0] as any).successor_intent;
    expect(intent).toMatchObject({
      requested_agent: "codex",
      transport: "app-server",
      project_path: "/work/project",
      owner_device_id: "device-1",
      model: "gpt-5.4",
      effort: "xhigh",
      configuration_revision: 2,
    });
    expect(intent.daemon_boot_id).toBeUndefined();
    expect(intent.operation_id).toBeUndefined();
    await expect(
      recordRestartIntent(ctx, "race-loser", "drain-current", 21),
    ).rejects.toThrow("EXECUTION_SUCCESSOR_INTENT_ALREADY_PENDING");
  });
});

describe("conversation-global ordered delivery", () => {
  test("server order, one slot, started/ambiguous blocking, and successor admission are atomic", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    const firstId = await enqueue(ctx, "command-1", "first");
    const secondId = await enqueue(ctx, "command-2", "second");
    const first: any = await db.get(firstId);
    const second: any = await db.get(secondId);
    expect([first.conversation_sequence, second.conversation_sequence]).toEqual([1, 2]);
    expect([first.delivery_id, second.delivery_id]).toEqual(["command-1", "command-2"]);

    await expect(
      enqueuePendingMessage(ctx, await db.get(CONVERSATION), USER, { content: "missing id" }),
    ).rejects.toThrow("FENCED_DELIVERY_ID_REQUIRED");

    const wrongCandidate = await claimDelivery(ctx, secondId);
    expect(wrongCandidate).toEqual({
      state: "waiting-for-earlier-message",
      messageId: String(firstId),
    });
    const firstClaim = await claimDelivery(ctx, firstId);
    expect(firstClaim.state).toBe("claimed");
    const recoveredClaim = await claimDelivery(ctx);
    expect(recoveredClaim.state).toBe("claimed");
    expect(recoveredClaim.recovered).toBe(true);
    expect(recoveredClaim.permit.attemptId).toBe(firstClaim.permit.attemptId);

    await recordRestartIntent(ctx, "drain-restart", "drain-current", 29);
    const successor = await requestExecutionSuccessorInDb(ctx, USER, {
      conversationId: CONVERSATION,
      intentId: "drain-restart",
      expectedCurrentEpoch: 1,
      policy: "drain-current",
      target: target({
        requestedAgent: "codex",
        transport: "app-server",
        configurationRevision: 2,
        daemonBootId: "boot-2",
      }),
      now: 30,
    });
    expect(successor.epoch).toBe(2);
    const successorStart = await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 2,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-2",
      configurationRevision: 2,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "start-2",
      now: 30.1,
    });
    expect(successorStart.state).toBe("claimed");
    expect(
      (
        await publishReadyBindingInDb(ctx, USER, {
          conversationId: CONVERSATION,
          epoch: 2,
          requestedAgent: "codex",
          actualAgent: "codex",
          transport: "app-server",
          handle: "thread-2",
          ownerDeviceId: "device-1",
          daemonBootId: "boot-2",
          runtimeId: "runtime-2",
          operationId: "start-2",
          appliedConfigurationRevision: 2,
          protocolVersion: 1,
          capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
          now: 30.2,
        })
      ).accepted,
    ).toBe(true);
    await expect(
      recordExecutionSuccessorIntentInDb(ctx, USER, {
        conversationId: CONVERSATION,
        intentId: "competing-intent",
        expectedCurrentEpoch: 1,
        kind: "restart",
        policy: "drain-current",
        now: 31,
      }),
    ).rejects.toThrow("EXECUTION_SUCCESSOR_INTENT_ALREADY_PENDING");

    const thirdId = await enqueue(ctx, "command-3", "after boundary");
    const third: any = await db.get(thirdId);
    expect(third.conversation_sequence).toBe(3);
    expect(third.execution_epoch).toBe(2);

    await expect(
      publishRuntimeDispositionInDb(ctx, USER, {
        conversationId: CONVERSATION,
        epoch: 1,
        configurationRevision: 1,
        ownerDeviceId: "device-1",
        daemonBootId: "boot-1",
        runtimeId: "runtime-1",
        disposition: "stopped",
        reason: "unsafe early stop",
        now: 31.5,
      }),
    ).rejects.toThrow("EXECUTION_SUCCESSOR_WAITING_FOR_DRAIN");

    const started = await startDeliveryInDb(ctx, USER, {
      ...fence(firstClaim.permit),
      now: 32,
    });
    expect(started.state).toBe("delivery-started");
    expect(
      (
        await startDeliveryInDb(ctx, USER, {
          ...fence(firstClaim.permit),
          now: 32.1,
        })
      ).attemptId,
    ).toBe(started.attemptId);
    await expect(
      activateExecutionSuccessorInDb(ctx, USER, {
        conversationId: CONVERSATION,
        expectedCurrentEpoch: 1,
        successorEpoch: 2,
        currentConfigurationRevision: 1,
        currentOwnerDeviceId: "device-1",
        currentDaemonBootId: "boot-1",
        currentOperationId: "start-1",
        currentRuntimeId: "runtime-1",
        successorConfigurationRevision: 2,
        successorOwnerDeviceId: "device-1",
        successorDaemonBootId: "boot-2",
        successorRuntimeId: "runtime-2",
        now: 33,
      }),
    ).rejects.toThrow("ACTIVE_DELIVERY_PREVENTS_EPOCH_ACTIVATION");

    await markDeliveryAmbiguousInDb(ctx, USER, {
      ...fence(started),
      failureCode: "TURN_TIMEOUT",
      failureMessage: "effect may have happened",
      now: 34,
    });
    expect(
      (
        await markDeliveryAmbiguousInDb(ctx, USER, {
          ...fence(started),
          failureCode: "TURN_TIMEOUT",
          failureMessage: "effect may have happened",
          now: 34.1,
        })
      ).blocked,
    ).toBe(true);
    expect((await claimDelivery(ctx)).state).toBe("busy");
    await expect(
      activateExecutionSuccessorInDb(ctx, USER, {
        conversationId: CONVERSATION,
        expectedCurrentEpoch: 1,
        successorEpoch: 2,
        currentConfigurationRevision: 1,
        currentOwnerDeviceId: "device-1",
        currentDaemonBootId: "boot-1",
        currentOperationId: "start-1",
        currentRuntimeId: "runtime-1",
        successorConfigurationRevision: 2,
        successorOwnerDeviceId: "device-1",
        successorDaemonBootId: "boot-2",
        successorRuntimeId: "runtime-2",
        now: 35,
      }),
    ).rejects.toThrow("ACTIVE_DELIVERY_PREVENTS_EPOCH_ACTIVATION");

    await resolveAmbiguousDeliveryInDb(ctx, USER, {
      ...fence(started),
      resolution: "correlated-delivered",
      resolutionEvidence: "transcript contains command-1 exactly once",
      now: 36,
    });
    expect(first.delivery_status).toBe("correlated-delivered");

    const secondClaim = await claimDelivery(ctx, secondId);
    const secondStarted = await startDeliveryInDb(ctx, USER, {
      ...fence(secondClaim.permit),
      now: 37,
    });
    await completeDeliveryInDb(ctx, USER, {
      ...fence(secondStarted),
      externalDeliveryId: "turn-2",
      now: 38,
    });
    expect(
      await completeDeliveryInDb(ctx, USER, {
        ...fence(secondStarted),
        externalDeliveryId: "turn-2",
        now: 38.1,
      }),
    ).toEqual({ accepted: true });
    expect(second.delivery_status).toBe("delivered");

    await publishRuntimeDispositionInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      configurationRevision: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      runtimeId: "runtime-1",
      disposition: "stopped",
      reason: "drained for successor",
      now: 39,
    });
    const activation = await activateExecutionSuccessorInDb(ctx, USER, {
      conversationId: CONVERSATION,
      expectedCurrentEpoch: 1,
      successorEpoch: 2,
      currentConfigurationRevision: 1,
      currentOwnerDeviceId: "device-1",
      currentDaemonBootId: "boot-1",
      currentOperationId: "start-1",
      currentRuntimeId: "runtime-1",
      successorConfigurationRevision: 2,
      successorOwnerDeviceId: "device-1",
      successorDaemonBootId: "boot-2",
      successorRuntimeId: "runtime-2",
      now: 40,
    });
    expect(activation.activated).toBe(true);
    expect((db._tables.conversation_execution_heads[0] as any).next_nonterminal_sequence).toBe(3);
  });

  test("failed-before-effect releases the slot but retries the same sequence and delivery id", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    const messageId = await enqueue(ctx, "stable-command", "retry me");
    const firstClaim = await claimDelivery(ctx, messageId);
    const firstStarted = await startDeliveryInDb(ctx, USER, {
      ...fence(firstClaim.permit),
      now: 21,
    });
    const retry = await failDeliveryBeforeEffectInDb(ctx, USER, {
      ...fence(firstStarted),
      failureCode: "DRIVER_REJECTED_BEFORE_WRITE",
      failureMessage: "socket was closed before request write",
      now: 22,
    });
    expect(retry).toEqual({ retryable: true, deliveryId: "stable-command" });

    const message: any = await db.get(messageId);
    expect(message.delivery_status).toBe("pending");
    expect(message.conversation_sequence).toBe(1);
    expect(message.delivery_id).toBe("stable-command");
    const secondClaim = await claimDelivery(ctx, messageId);
    expect(secondClaim.permit.attemptId).not.toBe(firstClaim.permit.attemptId);
    expect(secondClaim.permit.deliveryId).toBe(firstClaim.permit.deliveryId);
    expect(secondClaim.permit.conversationSequence).toBe(firstClaim.permit.conversationSequence);
  });

  test("restart may release a claimed permit, but a started permit becomes ambiguity", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    const messageId = await enqueue(ctx, "crash-window", "crash me");
    const claimed = await claimDelivery(ctx, messageId);
    expect(
      await releaseClaimBeforeEffectInDb(ctx, USER, {
        ...fence(claimed.permit),
        reason: "daemon exited before calling startDelivery",
        evidence: "server attempt state remained claimed",
        now: 21,
      }),
    ).toEqual({ retryable: true, deliveryId: "crash-window" });
    expect(
      await releaseClaimBeforeEffectInDb(ctx, USER, {
        ...fence(claimed.permit),
        reason: "daemon exited before calling startDelivery",
        evidence: "server attempt state remained claimed",
        now: 21.1,
      }),
    ).toEqual({ retryable: true, deliveryId: "crash-window" });

    const reclaimed = await claimDelivery(ctx, messageId);
    const started = await startDeliveryInDb(ctx, USER, {
      ...fence(reclaimed.permit),
      now: 22,
    });
    await expect(
      releaseClaimBeforeEffectInDb(ctx, USER, {
        ...fence(started),
        reason: "daemon restarted",
        evidence: "elapsed timeout only",
        now: 23,
      }),
    ).rejects.toThrow("DELIVERY_ATTEMPT_STATE_MISMATCH");

    expect(
      await markDeliveryAmbiguousInDb(ctx, USER, {
        ...fence(started),
        failureCode: "DAEMON_RESTART_AFTER_DELIVERY_STARTED",
        failureMessage: "external effect is unknown",
        now: 24,
      }),
    ).toEqual({ blocked: true, deliveryId: "crash-window" });
    expect((db._tables.conversation_execution_heads[0] as any).active_delivery_state).toBe("ambiguous");
  });

  test("cancel-unstarted closes admission immediately and materializes a bounded audit batch", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    const messageIds = [];
    for (let index = 0; index < 130; index += 1) {
      messageIds.push(await enqueue(ctx, `cancel-${index}`));
    }
    const claimed = await claimDelivery(ctx, messageIds[0]);
    expect(claimed.state).toBe("claimed");

    await recordRestartIntent(ctx, "cancel-restart", "cancel-unstarted", 29);
    await requestExecutionSuccessorInDb(ctx, USER, {
      conversationId: CONVERSATION,
      intentId: "cancel-restart",
      expectedCurrentEpoch: 1,
      policy: "cancel-unstarted",
      target: target({ configurationRevision: 2, daemonBootId: "boot-2" }),
      now: 30,
    });
    expect((await db.get(messageIds[0]) as any).delivery_status).toBe("cancelled-by-supersession");
    const afterBoundaryId = await enqueue(ctx, "successor-message");
    expect((await db.get(afterBoundaryId) as any).execution_epoch).toBe(2);
    expect((await claimDelivery(ctx)).state).toBe("waiting-for-successor");

    await claimExecutionStartInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 2,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-2",
      configurationRevision: 2,
      protocolVersion: 1,
      requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposedOperationId: "successor-start",
      now: 31,
    });
    await publishReadyBindingInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 2,
      requestedAgent: "codex",
      actualAgent: "codex",
      transport: "app-server",
      handle: "successor-thread",
      ownerDeviceId: "device-1",
      daemonBootId: "boot-2",
      runtimeId: "successor-runtime",
      operationId: "successor-start",
      appliedConfigurationRevision: 2,
      protocolVersion: 1,
      capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      now: 32,
    });
    await publishRuntimeDispositionInDb(ctx, USER, {
      conversationId: CONVERSATION,
      epoch: 1,
      configurationRevision: 1,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      runtimeId: "runtime-1",
      disposition: "stopped",
      reason: "cancel unstarted predecessor",
      now: 33,
    });

    const firstBatch = await activateExecutionSuccessorInDb(ctx, USER, {
      conversationId: CONVERSATION,
      expectedCurrentEpoch: 1,
      successorEpoch: 2,
      currentConfigurationRevision: 1,
      currentOwnerDeviceId: "device-1",
      currentDaemonBootId: "boot-1",
      currentOperationId: "start-1",
      currentRuntimeId: "runtime-1",
      successorConfigurationRevision: 2,
      successorOwnerDeviceId: "device-1",
      successorDaemonBootId: "boot-2",
      successorRuntimeId: "successor-runtime",
      now: 34,
    });
    expect(firstBatch.activated).toBe(false);
    if (firstBatch.activated) throw new Error("expected bounded cancellation work");
    expect(firstBatch.cancelledMessages).toBe(128);
    expect(firstBatch.remainingCancellations).toBe(1);
    expect((db._tables.conversation_execution_heads[0] as any).current_epoch).toBe(1);

    const secondBatch = await activateExecutionSuccessorInDb(ctx, USER, {
      conversationId: CONVERSATION,
      expectedCurrentEpoch: 1,
      successorEpoch: 2,
      currentConfigurationRevision: 1,
      currentOwnerDeviceId: "device-1",
      currentDaemonBootId: "boot-1",
      currentOperationId: "start-1",
      currentRuntimeId: "runtime-1",
      successorConfigurationRevision: 2,
      successorOwnerDeviceId: "device-1",
      successorDaemonBootId: "boot-2",
      successorRuntimeId: "successor-runtime",
      now: 35,
    });
    expect(secondBatch.activated).toBe(true);
    expect((db._tables.conversation_execution_heads[0] as any).current_epoch).toBe(2);
    expect(
      messageIds.every(
        (id) => (db._tables.pending_messages.find((message: any) => message._id === id) as any)
          .delivery_status === "cancelled-by-supersession",
      ),
    ).toBe(true);
  });

  test("risk-bearing resend terminally abandons the original and creates a new logical delivery", async () => {
    const db = makeFakeDb(tables());
    const ctx = await initializeAndReady(db);
    const originalId = await enqueue(ctx, "possibly-delivered", "do the thing");
    const claimed = await claimDelivery(ctx, originalId);
    const started = await startDeliveryInDb(ctx, USER, {
      ...fence(claimed.permit),
      now: 21,
    });
    await markDeliveryAmbiguousInDb(ctx, USER, {
      ...fence(started),
      failureCode: "ACK_LOST",
      failureMessage: "the turn may have landed",
      now: 22,
    });

    const resent = await abandonAmbiguousAndResendInDb(ctx, USER, {
      ...fence(started),
      newClientId: "explicit-risk-resend",
      resolutionEvidence: "user accepted duplicate-effect risk",
      now: 23,
    });
    expect(resent.originalDeliveryId).toBe("possibly-delivered");
    expect(resent.deliveryId).toBe("explicit-risk-resend");
    expect(resent.conversationSequence).toBe("2");
    const original: any = await db.get(originalId);
    const replacement: any = await db.get(resent.messageId);
    expect(original.delivery_status).toBe("abandoned-ambiguous");
    expect(replacement.resend_of_delivery_id).toBe("possibly-delivered");
    expect(replacement.delivery_id).toBe(replacement.client_id);

    const replay = await abandonAmbiguousAndResendInDb(ctx, USER, {
      ...fence(started),
      newClientId: "explicit-risk-resend",
      resolutionEvidence: "user accepted duplicate-effect risk",
      now: 24,
    });
    expect(replay.messageId).toBe(resent.messageId);
    expect(db._tables.pending_messages).toHaveLength(2);
    const replacementClaim = await claimDelivery(ctx, resent.messageId);
    expect(replacementClaim.permit.deliveryId).toBe("explicit-risk-resend");
    expect(replacementClaim.permit.conversationSequence).toBe("2");
  });
});
