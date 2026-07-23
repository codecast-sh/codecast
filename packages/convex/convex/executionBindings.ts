/**
 * Convex authority for fenced runtime selection and ordered delivery.
 *
 * This module is intentionally additive. A conversation with no
 * execution_protocol_state remains on the legacy rail. Once quiescing starts,
 * every legacy claim/status path fails closed; once fenced, only the CAS and
 * permit transitions below can authorize an external runtime side effect.
 */
import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  AGENT_MODEL_CONFIG,
  agentSupportsExecutionTransport,
} from "@codecast/shared/contracts";
import type { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { insertRiskResendPendingMessage } from "./pendingMessageWrites";

export const EXECUTION_PROTOCOL_VERSION = 1 as const;

export const EXECUTION_PROTOCOL_CAPABILITIES = [
  "single-flight-binding",
  "delivery-permit-v1",
  "strict-agent-routing",
  "runtime-inspection-v1",
] as const;

type AgentClientId = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi";
type RuntimeTransport = "tmux" | "app-server" | "external";
type RuntimeCapability = (typeof EXECUTION_PROTOCOL_CAPABILITIES)[number];
type SuccessorPolicy = "drain-current" | "cancel-unstarted";
type SuccessorIntentKind = "restart" | "reconfigure";
type DbCtx = { db: any };

type TargetInput = {
  requestedAgent: AgentClientId;
  transport: RuntimeTransport;
  projectPath: string;
  isolation?: {
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    isolated?: boolean;
    worktreeName?: string;
  };
  configurationRevision: number;
  model?: string;
  effort?: string;
  ownerDeviceId: string;
  daemonBootId: string;
  requiredCapabilities: RuntimeCapability[];
  protocolVersion: number;
};

type PermitFence = {
  messageId: any;
  deliveryId: string;
  conversationSequence: number;
  attemptId: any;
  conversationId: Id<"conversations">;
  executionEpoch: number;
  configurationRevision: number;
  ownerDeviceId: string;
  daemonBootId: string;
  runtimeId: string;
};

type SuccessorIntentRequest = {
  intentId: string;
  expectedCurrentEpoch: number;
  kind: SuccessorIntentKind;
  policy: SuccessorPolicy;
  /** Stable product option keys. `default` means clear the launch override. */
  model?: string;
  effort?: string;
};

const TERMINAL_DELIVERY_STATES = new Set([
  "delivered",
  "rejected",
  "cancelled-by-supersession",
  "correlated-delivered",
  "abandoned-ambiguous",
]);

export class ExecutionAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExecutionAuthorityError";
  }
}

function fail(code: string, message: string): never {
  throw new ExecutionAuthorityError(code, message);
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) fail("INVALID_EXECUTION_ARGUMENT", `${field} must be non-empty`);
}

function requireSafePositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("INVALID_EXECUTION_ARGUMENT", `${field} must be a positive safe integer`);
  }
}

function requireProtocolVersion(version: number): void {
  if (version !== EXECUTION_PROTOCOL_VERSION) {
    fail(
      "EXECUTION_PROTOCOL_VERSION_MISMATCH",
      `expected protocol ${EXECUTION_PROTOCOL_VERSION}, received ${version}`,
    );
  }
}

function normalizedCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities)].sort();
}

function capabilitiesEqual(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizedCapabilities(left);
  const b = normalizedCapabilities(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function requireProtocolCapabilities(capabilities: readonly string[]): void {
  const normalized = normalizedCapabilities(capabilities);
  if (
    normalized.length !== EXECUTION_PROTOCOL_CAPABILITIES.length ||
    !EXECUTION_PROTOCOL_CAPABILITIES.every((capability) => normalized.includes(capability))
  ) {
    fail(
      "EXECUTION_CAPABILITY_MISMATCH",
      `protocol v1 requires exactly ${EXECUTION_PROTOCOL_CAPABILITIES.join(", ")}`,
    );
  }
}

function strictConversationAgent(agentType: unknown): AgentClientId {
  switch (agentType) {
    case "claude":
    case "claude_code":
    case "cowork":
      return "claude";
    case "codex":
    case "cursor":
    case "gemini":
    case "opencode":
    case "pi":
      return agentType;
    default:
      return fail("INVALID_EXECUTION_AGENT", `unsupported conversation agent ${String(agentType)}`);
  }
}

function validateTargetInput(input: TargetInput): void {
  requireProtocolVersion(input.protocolVersion);
  requireSafePositive(input.configurationRevision, "configurationRevision");
  requireNonEmpty(input.projectPath, "projectPath");
  requireNonEmpty(input.ownerDeviceId, "ownerDeviceId");
  requireNonEmpty(input.daemonBootId, "daemonBootId");
  requireProtocolCapabilities(input.requiredCapabilities);
  if (!agentSupportsExecutionTransport(input.requestedAgent, input.transport)) {
    fail(
      "EXECUTION_TRANSPORT_UNSUPPORTED",
      `${input.requestedAgent} does not support fenced ${input.transport} execution`,
    );
  }
}

async function executionHead(ctx: DbCtx, conversationId: Id<"conversations">): Promise<any | null> {
  const rows = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  if (rows.length > 1) fail("EXECUTION_PROTOCOL_INVARIANT", "conversation has multiple execution heads");
  return rows[0] ?? null;
}

async function executionBinding(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
  epoch: number,
): Promise<any | null> {
  const rows = await ctx.db
    .query("execution_bindings")
    .withIndex("by_conversation_epoch", (q: any) =>
      q.eq("conversation_id", conversationId).eq("epoch", epoch),
    )
    .collect();
  if (rows.length > 1) {
    fail("EXECUTION_PROTOCOL_INVARIANT", `conversation has multiple bindings for epoch ${epoch}`);
  }
  return rows[0] ?? null;
}

async function requireOwnedConversation(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
  userId: Id<"users">,
): Promise<any> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) fail("CONVERSATION_NOT_FOUND", "conversation does not exist");
  if (String(conversation.user_id) !== String(userId)) {
    fail("EXECUTION_NOT_OWNER", "only the account that runs the conversation may control execution");
  }
  return conversation;
}

function storedIsolation(input: TargetInput["isolation"]): any {
  if (!input) return undefined;
  return {
    sandbox: input.sandbox,
    approval_policy: input.approvalPolicy,
    isolated: input.isolated,
    worktree_name: input.worktreeName,
  };
}

function wireIsolation(input: any): TargetInput["isolation"] | undefined {
  if (!input) return undefined;
  return {
    sandbox: input.sandbox,
    approvalPolicy: input.approval_policy,
    isolated: input.isolated,
    worktreeName: input.worktree_name,
  };
}

async function insertRequestedBinding(
  ctx: DbCtx,
  conversation: any,
  epoch: number,
  input: TargetInput,
  now: number,
): Promise<any> {
  validateTargetInput(input);
  if (strictConversationAgent(conversation.agent_type) !== input.requestedAgent) {
    fail(
      "EXECUTION_TARGET_MISMATCH",
      "execution target must match the conversation's authoritative strict agent family",
    );
  }
  const existing = await executionBinding(ctx, conversation._id, epoch);
  if (existing) fail("EXECUTION_EPOCH_ALREADY_EXISTS", `epoch ${epoch} already exists`);

  return await ctx.db.insert("execution_bindings", {
    conversation_id: conversation._id,
    epoch,
    owner_user_id: conversation.user_id,
    owner_device_id: input.ownerDeviceId,
    daemon_boot_id: input.daemonBootId,
    requested_agent: input.requestedAgent,
    transport: input.transport,
    project_path: input.projectPath,
    isolation: storedIsolation(input.isolation),
    configuration_revision: input.configurationRevision,
    model: input.model,
    effort: input.effort,
    protocol_version: input.protocolVersion,
    required_capabilities: normalizedCapabilities(input.requiredCapabilities),
    state: "requested" as const,
    created_at: now,
    updated_at: now,
  });
}

function bindingTargetMatches(binding: any, input: TargetInput): boolean {
  return (
    binding.requested_agent === input.requestedAgent &&
    binding.transport === input.transport &&
    binding.project_path === input.projectPath &&
    JSON.stringify(wireIsolation(binding.isolation) ?? null) ===
      JSON.stringify(input.isolation ?? null) &&
    binding.configuration_revision === input.configurationRevision &&
    binding.model === input.model &&
    binding.effort === input.effort &&
    binding.owner_device_id === input.ownerDeviceId &&
    binding.daemon_boot_id === input.daemonBootId &&
    binding.protocol_version === input.protocolVersion &&
    capabilitiesEqual(binding.required_capabilities ?? [], input.requiredCapabilities)
  );
}

function isTerminalDeliveryState(state: unknown): boolean {
  return typeof state === "string" && TERMINAL_DELIVERY_STATES.has(state);
}

function isEffectivelyTerminalDelivery(message: any, head?: any): boolean {
  if (isTerminalDeliveryState(message.delivery_status)) return true;
  if (
    head?.pending_policy === "cancel-unstarted" &&
    Number.isSafeInteger(head.cancelled_through_sequence) &&
    message.execution_epoch === head.current_epoch &&
    message.conversation_sequence <= head.cancelled_through_sequence &&
    message.delivery_status !== "delivery-started" &&
    message.delivery_status !== "ambiguous"
  ) {
    return true;
  }
  return false;
}

async function fencedMessages(ctx: DbCtx, conversationId: Id<"conversations">): Promise<any[]> {
  const messages = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  return messages.filter((message: any) => message.delivery_protocol_version !== undefined);
}

function orderedNonterminalMessages(messages: readonly any[], head?: any): any[] {
  return messages
    .filter(
      (message) =>
        Number.isSafeInteger(message.conversation_sequence) &&
        !isEffectivelyTerminalDelivery(message, head),
    )
    .sort((left, right) =>
      left.conversation_sequence - right.conversation_sequence ||
      String(left._id).localeCompare(String(right._id)),
    );
}

async function advanceNonterminalHead(
  ctx: DbCtx,
  head: any,
  now: number,
): Promise<number> {
  const messages = await fencedMessages(ctx, head.conversation_id);
  const first = orderedNonterminalMessages(messages, head)[0];
  const next = first?.conversation_sequence ?? head.next_conversation_sequence;
  await ctx.db.patch(head._id, {
    next_nonterminal_sequence: next,
    updated_at: now,
  });
  return next;
}

async function clearPendingFlagIfQuiet(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
): Promise<void> {
  const messages = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  const hasNonterminal = messages.some((message: any) => {
    if (message.delivery_protocol_version !== undefined) {
      return !isTerminalDeliveryState(message.delivery_status);
    }
    return !["delivered", "cancelled"].includes(message.status);
  });
  if (!hasNonterminal) {
    await ctx.db.patch(conversationId, { has_pending_messages: false });
  }
}

function canonicalLegacyDeliveryId(messageId: unknown): string {
  return `legacy:${String(messageId)}`;
}

/** Used by the shared pending-message insertion choke point. */
export async function allocateFencedDeliveryMetadata(
  ctx: DbCtx,
  conversation: any,
  clientId?: string,
): Promise<null | {
  protocolVersion: number;
  conversationSequence: number;
  executionEpoch: number;
  deliveryId: string;
}> {
  const head = await executionHead(ctx, conversation._id);
  const marker = conversation.execution_protocol_state;

  if (!marker && !head) return null;
  if (!head || marker !== head.protocol_state) {
    fail("EXECUTION_PROTOCOL_INVARIANT", "conversation marker and execution head disagree");
  }
  if (head.protocol_state === "legacy-quiescing") {
    fail(
      "EXECUTION_LEGACY_QUIESCING",
      "message admission is paused until the exact legacy daemon boot is quiesced",
    );
  }
  if (head.protocol_state !== "fenced" || marker !== "fenced") {
    fail("EXECUTION_PROTOCOL_INVARIANT", "unknown execution protocol state");
  }
  if (!clientId?.trim() || clientId !== clientId.trim()) {
    fail(
      "FENCED_DELIVERY_ID_REQUIRED",
      "fenced messages require a caller-stable client_id used as delivery_id",
    );
  }
  requireProtocolVersion(head.protocol_version);
  const executionEpoch = head.admission_epoch ?? head.current_epoch;
  requireSafePositive(executionEpoch, "admissionEpoch");
  const binding = await executionBinding(ctx, conversation._id, executionEpoch);
  if (!binding || binding.protocol_version !== head.protocol_version) {
    fail("EXECUTION_BINDING_MISSING", `admission epoch ${executionEpoch} has no binding`);
  }
  const conversationSequence = head.next_conversation_sequence;
  requireSafePositive(conversationSequence, "nextConversationSequence");
  await ctx.db.patch(head._id, {
    next_conversation_sequence: conversationSequence + 1,
    updated_at: Date.now(),
  });
  return {
    protocolVersion: head.protocol_version,
    conversationSequence,
    executionEpoch,
    deliveryId: clientId,
  };
}

export function isFencedPendingMessage(message: any): boolean {
  return message?.delivery_protocol_version !== undefined;
}

export function legacyConversationAcceptsDaemonWork(conversation: any): boolean {
  return conversation?.execution_protocol_state === undefined;
}

export async function beginLegacyQuiescenceInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    ownerDeviceId: string;
    legacyDaemonBootId: string;
    protocolVersion: number;
    now: number;
  },
): Promise<{ state: "legacy-quiescing" }> {
  requireProtocolVersion(args.protocolVersion);
  requireNonEmpty(args.ownerDeviceId, "ownerDeviceId");
  requireNonEmpty(args.legacyDaemonBootId, "legacyDaemonBootId");
  const conversation = await requireOwnedConversation(ctx, args.conversationId, userId);
  const existingHead = await executionHead(ctx, args.conversationId);
  if (
    conversation.execution_protocol_state === "legacy-quiescing" &&
    existingHead?.protocol_state === "legacy-quiescing" &&
    existingHead.protocol_version === args.protocolVersion &&
    existingHead.legacy_owner_device_id === args.ownerDeviceId &&
    existingHead.legacy_daemon_boot_id === args.legacyDaemonBootId
  ) {
    return { state: "legacy-quiescing" };
  }
  if (conversation.execution_protocol_state !== undefined) {
    fail("EXECUTION_PROTOCOL_ALREADY_INITIALIZED", "conversation already entered execution migration");
  }
  if (conversation.owner_device_id && conversation.owner_device_id !== args.ownerDeviceId) {
    fail("EXECUTION_OWNER_FENCE_MISMATCH", "legacy owner device does not match conversation owner");
  }
  if (existingHead) {
    fail("EXECUTION_PROTOCOL_INVARIANT", "execution head exists without conversation marker");
  }

  await ctx.db.insert("conversation_execution_heads", {
    conversation_id: args.conversationId,
    owner_user_id: userId,
    protocol_state: "legacy-quiescing" as const,
    protocol_version: args.protocolVersion,
    next_conversation_sequence: 1,
    next_nonterminal_sequence: 1,
    legacy_owner_device_id: args.ownerDeviceId,
    legacy_daemon_boot_id: args.legacyDaemonBootId,
    created_at: args.now,
    updated_at: args.now,
  });
  await ctx.db.patch(args.conversationId, {
    owner_device_id: args.ownerDeviceId,
    execution_protocol_state: "legacy-quiescing" as const,
    execution_protocol_version: args.protocolVersion,
  });
  return { state: "legacy-quiescing" };
}

export async function initializeFencedExecutionInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: { conversationId: Id<"conversations">; target: TargetInput; now: number },
): Promise<{ state: "fenced"; epoch: number }> {
  validateTargetInput(args.target);
  const conversation = await requireOwnedConversation(ctx, args.conversationId, userId);
  const existingHead = await executionHead(ctx, args.conversationId);
  if (
    conversation.execution_protocol_state === "fenced" &&
    existingHead?.protocol_state === "fenced" &&
    existingHead.current_epoch === 1
  ) {
    const existingBinding = await executionBinding(ctx, args.conversationId, 1);
    if (existingBinding && bindingTargetMatches(existingBinding, args.target)) {
      return { state: "fenced", epoch: 1 };
    }
  }
  if (conversation.execution_protocol_state !== undefined || existingHead) {
    fail("EXECUTION_PROTOCOL_ALREADY_INITIALIZED", "conversation already has execution authority");
  }
  if (conversation.owner_device_id && conversation.owner_device_id !== args.target.ownerDeviceId) {
    fail("EXECUTION_OWNER_FENCE_MISMATCH", "target owner device does not match conversation owner");
  }
  if (strictConversationAgent(conversation.agent_type) !== args.target.requestedAgent) {
    fail("EXECUTION_TARGET_MISMATCH", "initial target must match the conversation's strict agent family");
  }
  const existingMessages = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversationId))
    .collect();
  if (existingMessages.some((message: any) => !["delivered", "cancelled"].includes(message.status))) {
    fail(
      "LEGACY_MESSAGES_REQUIRE_QUIESCENCE",
      "a conversation with legacy in-flight messages must cross the quiescence gate",
    );
  }

  await ctx.db.insert("conversation_execution_heads", {
    conversation_id: args.conversationId,
    owner_user_id: userId,
    protocol_state: "fenced" as const,
    protocol_version: args.target.protocolVersion,
    current_epoch: 1,
    admission_epoch: 1,
    next_conversation_sequence: 1,
    next_nonterminal_sequence: 1,
    created_at: args.now,
    updated_at: args.now,
  });
  await insertRequestedBinding(ctx, conversation, 1, args.target, args.now);
  await ctx.db.patch(args.conversationId, {
    owner_device_id: args.target.ownerDeviceId,
    execution_protocol_state: "fenced" as const,
    execution_protocol_version: args.target.protocolVersion,
  });
  return { state: "fenced", epoch: 1 };
}

export async function activateAfterLegacyQuiescenceInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    target: TargetInput;
    terminatedLegacyDaemonBootId: string;
    runtimeDisposition: "stopped" | "adopted" | "quarantined";
    terminationEvidence: string;
    now: number;
  },
): Promise<{ state: "fenced"; epoch: number; migratedMessages: number }> {
  validateTargetInput(args.target);
  requireNonEmpty(args.terminatedLegacyDaemonBootId, "terminatedLegacyDaemonBootId");
  requireNonEmpty(args.terminationEvidence, "terminationEvidence");
  const conversation = await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  if (
    head?.protocol_state === "fenced" &&
    conversation.execution_protocol_state === "fenced" &&
    head.current_epoch === 1 &&
    head.terminated_legacy_daemon_boot_id === args.terminatedLegacyDaemonBootId &&
    head.replacement_daemon_boot_id === args.target.daemonBootId &&
    head.legacy_runtime_disposition === args.runtimeDisposition &&
    head.termination_evidence === args.terminationEvidence
  ) {
    const existingBinding = await executionBinding(ctx, args.conversationId, 1);
    if (existingBinding && bindingTargetMatches(existingBinding, args.target)) {
      const migratedMessages = (await fencedMessages(ctx, args.conversationId)).filter(
        (message) => message.execution_epoch === 1,
      ).length;
      return { state: "fenced", epoch: 1, migratedMessages };
    }
  }
  if (
    !head ||
    head.protocol_state !== "legacy-quiescing" ||
    conversation.execution_protocol_state !== "legacy-quiescing"
  ) {
    fail("EXECUTION_NOT_QUIESCING", "conversation is not at the legacy quiescence gate");
  }
  if (
    head.legacy_owner_device_id !== args.target.ownerDeviceId ||
    conversation.owner_device_id !== args.target.ownerDeviceId
  ) {
    fail("EXECUTION_OWNER_FENCE_MISMATCH", "quiescing device does not match replacement target");
  }
  if (head.legacy_daemon_boot_id !== args.terminatedLegacyDaemonBootId) {
    fail("LEGACY_BOOT_PROOF_MISMATCH", "termination proof names a different legacy daemon boot");
  }
  if (args.target.daemonBootId === args.terminatedLegacyDaemonBootId) {
    fail("LEGACY_BOOT_STILL_ACTIVE", "replacement daemon must have a new boot id");
  }
  if (strictConversationAgent(conversation.agent_type) !== args.target.requestedAgent) {
    fail("EXECUTION_TARGET_MISMATCH", "migration target must match the conversation's strict agent family");
  }

  const allMessages = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversationId))
    .collect();
  const legacyInFlight = allMessages
    .filter(
      (message: any) =>
        message.delivery_protocol_version === undefined &&
        !["delivered", "cancelled"].includes(message.status),
    )
    .sort(
      (left: any, right: any) =>
        left.created_at - right.created_at || String(left._id).localeCompare(String(right._id)),
    );
  const unsafe = legacyInFlight.find((message: any) => message.status !== "pending");
  if (unsafe) {
    fail(
      "LEGACY_DELIVERY_OUTCOME_UNRESOLVED",
      `legacy message ${String(unsafe._id)} is ${unsafe.status}; resolve it before activation`,
    );
  }

  let sequence = 1;
  for (const message of legacyInFlight) {
    const deliveryId = message.client_id?.trim() || canonicalLegacyDeliveryId(message._id);
    await ctx.db.patch(message._id, {
      client_id: deliveryId,
      delivery_protocol_version: args.target.protocolVersion,
      delivery_id: deliveryId,
      conversation_sequence: sequence,
      execution_epoch: 1,
      delivery_status: "pending" as const,
    });
    sequence += 1;
  }

  await insertRequestedBinding(ctx, conversation, 1, args.target, args.now);
  await ctx.db.patch(head._id, {
    protocol_state: "fenced" as const,
    current_epoch: 1,
    admission_epoch: 1,
    next_conversation_sequence: sequence,
    next_nonterminal_sequence: 1,
    terminated_legacy_daemon_boot_id: args.terminatedLegacyDaemonBootId,
    replacement_daemon_boot_id: args.target.daemonBootId,
    legacy_runtime_disposition: args.runtimeDisposition,
    termination_evidence: args.terminationEvidence,
    updated_at: args.now,
  });
  await ctx.db.patch(args.conversationId, {
    execution_protocol_state: "fenced" as const,
    execution_protocol_version: args.target.protocolVersion,
    owner_device_id: args.target.ownerDeviceId,
  });
  return { state: "fenced", epoch: 1, migratedMessages: legacyInFlight.length };
}

function sameSuccessorIntentRequest(intent: any, request: SuccessorIntentRequest): boolean {
  return (
    intent.intent_id === request.intentId &&
    intent.expected_current_epoch === request.expectedCurrentEpoch &&
    intent.kind === request.kind &&
    intent.policy === request.policy &&
    intent.requested_model_option === request.model &&
    intent.requested_effort_option === request.effort
  );
}

function successorIntentMatchesTarget(intent: any, target: TargetInput): boolean {
  return (
    intent.requested_agent === target.requestedAgent &&
    intent.transport === target.transport &&
    intent.project_path === target.projectPath &&
    JSON.stringify(wireIsolation(intent.isolation) ?? null) ===
      JSON.stringify(target.isolation ?? null) &&
    intent.configuration_revision === target.configurationRevision &&
    intent.model === target.model &&
    intent.effort === target.effort &&
    intent.owner_device_id === target.ownerDeviceId &&
    intent.protocol_version === target.protocolVersion &&
    capabilitiesEqual(intent.required_capabilities ?? [], target.requiredCapabilities)
  );
}

/**
 * Session-authenticated product intent. This is deliberately incapable of
 * authorizing an external effect: every runtime/effect-bearing value is copied
 * from server authority, while the daemon boot and operation id do not exist in
 * this request at all. The API-token-only proposal below consumes the intent.
 */
export async function recordExecutionSuccessorIntentInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: SuccessorIntentRequest & { conversationId: Id<"conversations">; now: number },
): Promise<{
  intentId: string;
  state: "pending" | "consumed" | "activated";
  expectedCurrentEpoch: number;
  configurationRevision: number;
  successorEpoch?: number;
}> {
  requireNonEmpty(args.intentId, "intentId");
  if (args.intentId !== args.intentId.trim()) {
    fail("INVALID_EXECUTION_ARGUMENT", "intentId must be a canonical non-whitespace string");
  }
  requireSafePositive(args.expectedCurrentEpoch, "expectedCurrentEpoch");
  const conversation = await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  if (!head || head.protocol_state !== "fenced" || conversation.execution_protocol_state !== "fenced") {
    fail("EXECUTION_NOT_FENCED", "successor intent requires a fenced conversation");
  }

  const existingIntent = head.successor_intent;
  if (existingIntent?.intent_id === args.intentId) {
    if (!sameSuccessorIntentRequest(existingIntent, args)) {
      fail("EXECUTION_INTENT_ID_REUSED", "intent id was already used for different product intent");
    }
    return {
      intentId: existingIntent.intent_id,
      state: existingIntent.status,
      expectedCurrentEpoch: existingIntent.expected_current_epoch,
      configurationRevision: existingIntent.configuration_revision,
      successorEpoch: existingIntent.successor_epoch,
    };
  }
  if (head.current_epoch !== args.expectedCurrentEpoch) {
    fail("EXECUTION_EPOCH_FENCE_MISMATCH", "current epoch changed before successor intent");
  }
  if (head.pending_epoch !== undefined || (existingIntent && existingIntent.status !== "activated")) {
    fail("EXECUTION_SUCCESSOR_INTENT_ALREADY_PENDING", "only one successor intent may be live at a time");
  }

  const current = await executionBinding(ctx, args.conversationId, args.expectedCurrentEpoch);
  if (!current) fail("EXECUTION_BINDING_MISSING", "current epoch binding is missing");
  const requestedAgent = strictConversationAgent(conversation.agent_type);
  if (current.requested_agent !== requestedAgent) {
    fail("EXECUTION_PROTOCOL_INVARIANT", "current binding disagrees with the conversation agent");
  }
  if (
    conversation.owner_device_id &&
    conversation.owner_device_id !== current.owner_device_id
  ) {
    fail("EXECUTION_OWNER_FENCE_MISMATCH", "conversation and current binding disagree on owner device");
  }
  requireProtocolVersion(head.protocol_version);
  if (current.protocol_version !== head.protocol_version) {
    fail("EXECUTION_PROTOCOL_VERSION_MISMATCH", "current binding and execution head disagree");
  }
  requireProtocolCapabilities(current.required_capabilities ?? []);

  if (args.kind === "restart" && (args.model !== undefined || args.effort !== undefined)) {
    fail("EXECUTION_INTENT_UNSUPPORTED", "restart intent cannot carry model or effort changes");
  }
  if (args.kind === "reconfigure" && args.model === undefined && args.effort === undefined) {
    fail("EXECUTION_INTENT_UNSUPPORTED", "reconfigure intent requires a model or effort choice");
  }

  const modelConfig = AGENT_MODEL_CONFIG[requestedAgent];
  let model = current.model as string | undefined;
  let effort = current.effort as string | undefined;
  if (args.model !== undefined) {
    const option = modelConfig?.models.find((candidate) => candidate.key === args.model);
    if (!option) fail("EXECUTION_MODEL_UNSUPPORTED", `unknown ${requestedAgent} model option ${args.model}`);
    if (option.midSessionOnly) {
      fail("EXECUTION_MODEL_UNSUPPORTED", `${args.model} cannot be applied to a replacement runtime`);
    }
    model = option.cliAlias;
  }
  if (args.effort !== undefined) {
    if (args.effort === "default") {
      effort = undefined;
    } else {
      if (!modelConfig?.efforts.includes(args.effort)) {
        fail("EXECUTION_EFFORT_UNSUPPORTED", `unknown ${requestedAgent} effort option ${args.effort}`);
      }
      effort = args.effort;
    }
  }
  if (args.kind === "reconfigure" && model === current.model && effort === current.effort) {
    fail("EXECUTION_INTENT_NO_CHANGE", "reconfigure intent must change model or effort");
  }

  const intent = {
    intent_id: args.intentId,
    requested_by_user_id: userId,
    expected_current_epoch: args.expectedCurrentEpoch,
    kind: args.kind,
    policy: args.policy,
    requested_model_option: args.model,
    requested_effort_option: args.effort,
    requested_agent: requestedAgent,
    transport: current.transport,
    project_path: current.project_path,
    isolation: current.isolation,
    configuration_revision: current.configuration_revision + 1,
    model,
    effort,
    owner_device_id: current.owner_device_id,
    protocol_version: head.protocol_version,
    required_capabilities: normalizedCapabilities(current.required_capabilities ?? []),
    status: "pending" as const,
    created_at: args.now,
  };
  await ctx.db.patch(head._id, { successor_intent: intent, updated_at: args.now });
  return {
    intentId: args.intentId,
    state: "pending",
    expectedCurrentEpoch: args.expectedCurrentEpoch,
    configurationRevision: intent.configuration_revision,
  };
}

export async function requestExecutionSuccessorInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    intentId: string;
    expectedCurrentEpoch: number;
    policy: SuccessorPolicy;
    target: TargetInput;
    now: number;
  },
): Promise<{ created: boolean; epoch: number; admissionBoundary: number }> {
  validateTargetInput(args.target);
  requireNonEmpty(args.intentId, "intentId");
  requireSafePositive(args.expectedCurrentEpoch, "expectedCurrentEpoch");
  const conversation = await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  if (
    !head ||
    head.protocol_state !== "fenced" ||
    conversation.execution_protocol_state !== "fenced"
  ) {
    fail("EXECUTION_NOT_FENCED", "successors require a fenced conversation");
  }
  if (head.current_epoch !== args.expectedCurrentEpoch) {
    fail("EXECUTION_EPOCH_FENCE_MISMATCH", "current epoch changed before successor request");
  }
  const intent = head.successor_intent;
  if (!intent || intent.intent_id !== args.intentId) {
    fail("EXECUTION_SUCCESSOR_INTENT_MISSING", "daemon proposal has no exact pending browser intent");
  }
  if (
    intent.expected_current_epoch !== args.expectedCurrentEpoch ||
    intent.policy !== args.policy ||
    !successorIntentMatchesTarget(intent, args.target)
  ) {
    fail("EXECUTION_SUCCESSOR_INTENT_MISMATCH", "daemon proposal differs from durable browser intent");
  }
  requireProtocolVersion(head.protocol_version);
  if (args.target.protocolVersion !== head.protocol_version) {
    fail("EXECUTION_PROTOCOL_VERSION_MISMATCH", "successor protocol differs from conversation head");
  }
  const current = await executionBinding(ctx, args.conversationId, args.expectedCurrentEpoch);
  if (!current) fail("EXECUTION_BINDING_MISSING", "current epoch binding is missing");
  if (args.target.configurationRevision <= current.configuration_revision) {
    fail(
      "CONFIGURATION_REVISION_NOT_MONOTONIC",
      "successor configuration revision must be greater than the current revision",
    );
  }

  if (head.pending_epoch !== undefined) {
    const pending = await executionBinding(ctx, args.conversationId, head.pending_epoch);
    if (
      pending &&
      intent.status === "consumed" &&
      intent.successor_epoch === head.pending_epoch &&
      intent.consumed_daemon_boot_id === args.target.daemonBootId &&
      head.pending_policy === args.policy &&
      bindingTargetMatches(pending, args.target)
    ) {
      return {
        created: false,
        epoch: head.pending_epoch,
        admissionBoundary: head.pending_requested_at_sequence,
      };
    }
    fail("EXECUTION_SUCCESSOR_ALREADY_PENDING", "successor intent was already consumed by another proposal");
  }
  if (intent.status !== "pending") {
    fail("EXECUTION_SUCCESSOR_INTENT_CONSUMED", `successor intent is already ${intent.status}`);
  }

  const epoch = args.expectedCurrentEpoch + 1;
  const admissionBoundary = head.next_conversation_sequence;
  await insertRequestedBinding(ctx, conversation, epoch, args.target, args.now);
  let releasedClaim = false;
  if (args.policy === "cancel-unstarted" && head.active_delivery_state === "claimed") {
    const attempt = head.active_delivery_attempt_id
      ? await ctx.db.get(head.active_delivery_attempt_id)
      : null;
    const message = attempt ? await ctx.db.get(attempt.message_id) : null;
    if (
      !attempt ||
      !message ||
      attempt.state !== "claimed" ||
      message.delivery_status !== "claimed" ||
      message.execution_epoch !== args.expectedCurrentEpoch ||
      message.conversation_sequence >= admissionBoundary
    ) {
      fail("DELIVERY_SLOT_INVARIANT", "active claimed permit does not match the supersession cutoff");
    }
    await ctx.db.patch(attempt._id, {
      state: "cancelled-by-supersession" as const,
      completed_at: args.now,
    });
    await ctx.db.patch(message._id, {
      delivery_status: "cancelled-by-supersession" as const,
      active_delivery_attempt_id: undefined,
      status: "cancelled" as const,
    });
    releasedClaim = true;
  }
  const headPatch = {
    pending_epoch: epoch,
    admission_epoch: epoch,
    pending_policy: args.policy,
    pending_requested_at_sequence: admissionBoundary,
    cancelled_through_sequence:
      args.policy === "cancel-unstarted" ? admissionBoundary - 1 : undefined,
    successor_intent: {
      ...intent,
      status: "consumed" as const,
      successor_epoch: epoch,
      consumed_daemon_boot_id: args.target.daemonBootId,
      consumed_at: args.now,
    },
    ...(releasedClaim
      ? { active_delivery_attempt_id: undefined, active_delivery_state: undefined }
      : {}),
    updated_at: args.now,
  };
  await ctx.db.patch(head._id, headPatch);
  if (args.policy === "cancel-unstarted") {
    await advanceNonterminalHead(ctx, { ...head, ...headPatch }, args.now);
  }
  return { created: true, epoch, admissionBoundary };
}

function bindingEvidenceWire(binding: any): any {
  if (
    !binding.operation_id ||
    !binding.actual_agent ||
    !binding.runtime_id ||
    !binding.handle ||
    binding.applied_configuration_revision === undefined ||
    !binding.capabilities
  ) {
    fail("READY_BINDING_INCOMPLETE", "ready binding is missing required evidence");
  }
  if (binding.requested_agent !== binding.actual_agent) {
    fail("REQUESTED_ACTUAL_AGENT_MISMATCH", "binding evidence changed agent family");
  }
  return {
    conversationId: String(binding.conversation_id),
    epoch: binding.epoch,
    requestedAgent: binding.requested_agent,
    actualAgent: binding.actual_agent,
    transport: binding.transport,
    handle: binding.handle,
    ownerDeviceId: binding.owner_device_id,
    daemonBootId: binding.daemon_boot_id,
    runtimeId: binding.runtime_id,
    operationId: binding.operation_id,
    appliedConfigurationRevision: binding.applied_configuration_revision,
    protocolVersion: binding.protocol_version,
    capabilities: binding.capabilities,
  };
}

function readyBindingWire(binding: any): any {
  if (binding.state !== "ready") {
    fail("READY_BINDING_INCOMPLETE", "binding is not ready");
  }
  return bindingEvidenceWire(binding);
}

export async function claimExecutionStartInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    ownerDeviceId: string;
    daemonBootId: string;
    configurationRevision: number;
    protocolVersion: number;
    requiredCapabilities: RuntimeCapability[];
    proposedOperationId: string;
    now: number;
  },
): Promise<any> {
  requireSafePositive(args.epoch, "epoch");
  requireSafePositive(args.configurationRevision, "configurationRevision");
  requireProtocolVersion(args.protocolVersion);
  requireProtocolCapabilities(args.requiredCapabilities);
  requireNonEmpty(args.ownerDeviceId, "ownerDeviceId");
  requireNonEmpty(args.daemonBootId, "daemonBootId");
  requireNonEmpty(args.proposedOperationId, "proposedOperationId");
  const conversation = await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  if (!head || head.protocol_state !== "fenced" || conversation.execution_protocol_state !== "fenced") {
    return {
      state: "rejected" as const,
      failure: { code: "EXECUTION_NOT_FENCED", message: "conversation is not fenced" },
    };
  }
  if (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch) {
    return {
      state: "rejected" as const,
      failure: { code: "EXECUTION_EPOCH_FENCE_MISMATCH", message: "epoch is neither current nor pending" },
    };
  }
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (!binding) {
    return {
      state: "rejected" as const,
      failure: { code: "EXECUTION_BINDING_MISSING", message: "binding does not exist" },
    };
  }
  if (
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.daemon_boot_id !== args.daemonBootId ||
    binding.configuration_revision !== args.configurationRevision ||
    binding.protocol_version !== args.protocolVersion ||
    !capabilitiesEqual(binding.required_capabilities ?? [], args.requiredCapabilities)
  ) {
    return {
      state: "rejected" as const,
      failure: {
        code: "EXECUTION_BINDING_FENCE_MISMATCH",
        message: "owner device, daemon boot, configuration, protocol, or capabilities differ",
      },
    };
  }
  if (binding.state === "ready") {
    return { state: "ready" as const, binding: readyBindingWire(binding) };
  }
  if (binding.state === "starting") {
    if (
      binding.operation_id === args.proposedOperationId &&
      binding.daemon_boot_id === args.daemonBootId
    ) {
      return {
        state: "claimed" as const,
        operationId: binding.operation_id,
        recovery: { state: "fresh" as const },
      };
    }
    return {
      state: "busy" as const,
      operationId: binding.operation_id,
      failure: { code: "START_ALREADY_CLAIMED", message: "another start operation owns this epoch" },
    };
  }
  const retryingBeforeEffect =
    binding.state === "start-failed-before-effect" && binding.failure_retryable === true;
  if (binding.state !== "requested" && !retryingBeforeEffect) {
    return {
      state: "busy" as const,
      operationId: binding.operation_id,
      failure: {
        code: binding.state === "start-ambiguous" ? "START_AMBIGUOUS" : "START_NOT_RETRYABLE",
        message: `binding state ${binding.state} does not authorize startup`,
      },
    };
  }
  if (retryingBeforeEffect && binding.operation_id !== args.proposedOperationId) {
    return {
      state: "rejected" as const,
      failure: {
        code: "START_RETRY_OPERATION_MISMATCH",
        message: "a proven pre-effect retry must reuse the exact durable operation id",
      },
    };
  }

  await ctx.db.patch(binding._id, {
    state: "starting" as const,
    operation_id: args.proposedOperationId,
    failure_code: undefined,
    failure_message: undefined,
    failure_retryable: undefined,
    suspected_runtime_id: undefined,
    updated_at: args.now,
  });
  return {
    state: "claimed" as const,
    operationId: args.proposedOperationId,
    recovery: { state: "fresh" as const },
  };
}

export async function publishReadyBindingInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    requestedAgent: AgentClientId;
    actualAgent: AgentClientId;
    transport: RuntimeTransport;
    handle: string;
    ownerDeviceId: string;
    daemonBootId: string;
    runtimeId: string;
    operationId: string;
    appliedConfigurationRevision: number;
    protocolVersion: number;
    capabilities: RuntimeCapability[];
    now: number;
  },
): Promise<{ accepted: boolean; binding?: any; reason?: string }> {
  await requireOwnedConversation(ctx, args.conversationId, userId);
  requireSafePositive(args.epoch, "epoch");
  requireSafePositive(args.appliedConfigurationRevision, "appliedConfigurationRevision");
  requireProtocolVersion(args.protocolVersion);
  requireProtocolCapabilities(args.capabilities);
  for (const [field, value] of [
    ["handle", args.handle],
    ["ownerDeviceId", args.ownerDeviceId],
    ["daemonBootId", args.daemonBootId],
    ["runtimeId", args.runtimeId],
    ["operationId", args.operationId],
  ] as const) requireNonEmpty(value, field);
  if (args.requestedAgent !== args.actualAgent) {
    fail("REQUESTED_ACTUAL_AGENT_MISMATCH", "actual agent must equal requested agent exactly");
  }
  const head = await executionHead(ctx, args.conversationId);
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (!head || !binding || (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch)) {
    return { accepted: false, reason: "stale-epoch" };
  }
  if (binding.state === "ready") {
    const exact =
      binding.requested_agent === args.requestedAgent &&
      binding.actual_agent === args.actualAgent &&
      binding.transport === args.transport &&
      binding.handle === args.handle &&
      binding.owner_device_id === args.ownerDeviceId &&
      binding.daemon_boot_id === args.daemonBootId &&
      binding.runtime_id === args.runtimeId &&
      binding.operation_id === args.operationId &&
      binding.applied_configuration_revision === args.appliedConfigurationRevision &&
      binding.protocol_version === args.protocolVersion &&
      capabilitiesEqual(binding.capabilities ?? [], args.capabilities);
    return exact
      ? { accepted: true, binding: readyBindingWire(binding) }
      : { accepted: false, reason: "ready-binding-conflict" };
  }
  if (binding.state !== "starting") return { accepted: false, reason: `state-${binding.state}` };
  if (
    binding.requested_agent !== args.requestedAgent ||
    binding.transport !== args.transport ||
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.daemon_boot_id !== args.daemonBootId ||
    binding.operation_id !== args.operationId ||
    binding.configuration_revision !== args.appliedConfigurationRevision ||
    binding.protocol_version !== args.protocolVersion ||
    !capabilitiesEqual(binding.required_capabilities ?? [], args.capabilities)
  ) {
    return { accepted: false, reason: "compare-and-set-lost" };
  }

  await ctx.db.patch(binding._id, {
    state: "ready" as const,
    actual_agent: args.actualAgent,
    runtime_id: args.runtimeId,
    handle: args.handle,
    applied_configuration_revision: args.appliedConfigurationRevision,
    capabilities: normalizedCapabilities(args.capabilities),
    updated_at: args.now,
  });
  return {
    accepted: true,
    binding: readyBindingWire({
      ...binding,
      state: "ready",
      actual_agent: args.actualAgent,
      runtime_id: args.runtimeId,
      handle: args.handle,
      applied_configuration_revision: args.appliedConfigurationRevision,
      capabilities: normalizedCapabilities(args.capabilities),
    }),
  };
}

export async function publishStartOutcomeInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    ownerDeviceId: string;
    daemonBootId: string;
    configurationRevision: number;
    operationId: string;
    failureCode: string;
    failureMessage: string;
    failureRetryable?: boolean;
    suspectedRuntimeId?: string;
    outcome: "start-failed-before-effect" | "start-ambiguous";
    now: number;
  },
): Promise<{ accepted: boolean }> {
  await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (!head || !binding || (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch)) {
    return { accepted: false };
  }
  if (
    binding.state === args.outcome &&
    binding.owner_device_id === args.ownerDeviceId &&
    binding.daemon_boot_id === args.daemonBootId &&
    binding.configuration_revision === args.configurationRevision &&
    binding.operation_id === args.operationId &&
    binding.failure_code === args.failureCode &&
    binding.failure_message === args.failureMessage &&
    binding.failure_retryable === args.failureRetryable &&
    binding.suspected_runtime_id === args.suspectedRuntimeId
  ) {
    return { accepted: true };
  }
  if (
    binding.state !== "starting" ||
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.daemon_boot_id !== args.daemonBootId ||
    binding.configuration_revision !== args.configurationRevision ||
    binding.operation_id !== args.operationId
  ) {
    return { accepted: false };
  }
  await ctx.db.patch(binding._id, {
    state: args.outcome,
    failure_code: args.failureCode,
    failure_message: args.failureMessage,
    failure_retryable: args.failureRetryable,
    suspected_runtime_id: args.suspectedRuntimeId,
    updated_at: args.now,
  });
  return { accepted: true };
}

export async function disposePreReadyBindingInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    expectedState: "requested" | "starting" | "start-failed-before-effect" | "start-ambiguous";
    configurationRevision: number;
    ownerDeviceId: string;
    daemonBootId: string;
    operationId?: string;
    inspection: "proven-no-effect" | "runtime-quarantined" | "unknown";
    suspectedRuntimeId?: string;
    evidence: string;
    now: number;
  },
): Promise<{ state: "stopped" | "quarantined" | "start-ambiguous" }> {
  requireNonEmpty(args.evidence, "evidence");
  await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (!head || !binding || (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch)) {
    fail("EXECUTION_EPOCH_FENCE_MISMATCH", "epoch is no longer current or pending");
  }
  if (
    binding.configuration_revision !== args.configurationRevision ||
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.daemon_boot_id !== args.daemonBootId
  ) {
    fail("EXECUTION_BINDING_FENCE_MISMATCH", "pre-ready binding fence changed");
  }
  const operationMatches = (binding.operation_id ?? undefined) === args.operationId;
  if (
    operationMatches &&
    binding.disposition_evidence === args.evidence &&
    args.inspection === "proven-no-effect" &&
    binding.state === "stopped" &&
    binding.pre_ready_disposition === "no-runtime-proven"
  ) {
    return { state: "stopped" };
  }
  if (
    operationMatches &&
    binding.disposition_evidence === args.evidence &&
    args.inspection === "runtime-quarantined" &&
    binding.state === "quarantined" &&
    binding.pre_ready_disposition === "runtime-quarantined" &&
    binding.suspected_runtime_id === args.suspectedRuntimeId
  ) {
    return { state: "quarantined" };
  }
  if (
    operationMatches &&
    binding.disposition_evidence === args.evidence &&
    args.inspection === "unknown" &&
    binding.state === "start-ambiguous" &&
    binding.suspected_runtime_id === args.suspectedRuntimeId
  ) {
    return { state: "start-ambiguous" };
  }
  if (binding.state !== args.expectedState) {
    fail("EXECUTION_BINDING_FENCE_MISMATCH", "pre-ready binding state changed");
  }
  if (binding.state === "requested") {
    if (args.operationId !== undefined || binding.operation_id !== undefined) {
      fail("EXECUTION_OPERATION_FENCE_MISMATCH", "requested binding must not have a start operation");
    }
    if (args.inspection !== "proven-no-effect") {
      fail("PRE_READY_INSPECTION_REQUIRED", "an unclaimed request has no runtime to quarantine");
    }
  } else {
    requireNonEmpty(args.operationId ?? "", "operationId");
    if (binding.operation_id !== args.operationId) {
      fail("EXECUTION_OPERATION_FENCE_MISMATCH", "startup operation changed");
    }
  }

  if (args.inspection === "unknown") {
    // A claimed startup can cross the external-create boundary. Uncertainty is
    // durable ambiguity, never a synonym for missing/no-effect.
    if (binding.state === "requested") {
      fail("PRE_READY_INSPECTION_REQUIRED", "requested state is already proof no start was claimed");
    }
    await ctx.db.patch(binding._id, {
      state: "start-ambiguous" as const,
      failure_code: "START_INSPECTION_UNKNOWN",
      failure_message: "runtime inspection could not prove absence or quarantine",
      suspected_runtime_id: args.suspectedRuntimeId,
      disposition_evidence: args.evidence,
      updated_at: args.now,
    });
    return { state: "start-ambiguous" };
  }

  if (args.inspection === "runtime-quarantined") {
    requireNonEmpty(args.suspectedRuntimeId ?? "", "suspectedRuntimeId");
    await ctx.db.patch(binding._id, {
      state: "quarantined" as const,
      pre_ready_disposition: "runtime-quarantined" as const,
      suspected_runtime_id: args.suspectedRuntimeId,
      disposition_evidence: args.evidence,
      stopped_reason: "pre-ready runtime quarantined",
      updated_at: args.now,
    });
    return { state: "quarantined" };
  }

  await ctx.db.patch(binding._id, {
    state: "stopped" as const,
    pre_ready_disposition: "no-runtime-proven" as const,
    disposition_evidence: args.evidence,
    stopped_reason: "inspection proved startup had no external effect",
    updated_at: args.now,
  });
  return { state: "stopped" };
}

function assertReadyFence(
  head: any,
  binding: any,
  fence: {
    executionEpoch: number;
    configurationRevision: number;
    ownerDeviceId: string;
    daemonBootId: string;
    runtimeId: string;
  },
): void {
  if (head.protocol_state !== "fenced" || head.current_epoch !== fence.executionEpoch) {
    fail("EXECUTION_EPOCH_FENCE_MISMATCH", "delivery epoch is not current");
  }
  if (
    !binding ||
    binding.state !== "ready" ||
    binding.epoch !== fence.executionEpoch ||
    binding.configuration_revision !== fence.configurationRevision ||
    binding.applied_configuration_revision !== fence.configurationRevision ||
    binding.owner_device_id !== fence.ownerDeviceId ||
    binding.daemon_boot_id !== fence.daemonBootId ||
    binding.runtime_id !== fence.runtimeId ||
    binding.requested_agent !== binding.actual_agent
  ) {
    fail(
      "DELIVERY_BINDING_FENCE_MISMATCH",
      "ready binding does not match epoch, configuration, owner device, daemon boot, runtime, or agent",
    );
  }
}

function claimedPermitWire(attempt: any): any {
  return {
    state: "claimed" as const,
    messageId: String(attempt.message_id),
    deliveryId: attempt.delivery_id,
    conversationSequence: String(attempt.conversation_sequence),
    attemptId: String(attempt._id),
    conversationId: String(attempt.conversation_id),
    executionEpoch: attempt.execution_epoch,
    configurationRevision: attempt.configuration_revision,
    ownerDeviceId: attempt.owner_device_id,
    daemonBootId: attempt.daemon_boot_id,
    runtimeId: attempt.runtime_id,
  };
}

function startedPermitWire(attempt: any): any {
  return { ...claimedPermitWire(attempt), state: "delivery-started" as const };
}

function attemptMatchesFence(attempt: any, fence: PermitFence, userId?: Id<"users">): boolean {
  return !!attempt &&
    String(attempt._id) === String(fence.attemptId) &&
    String(attempt.message_id) === String(fence.messageId) &&
    String(attempt.conversation_id) === String(fence.conversationId) &&
    (userId === undefined || String(attempt.owner_user_id) === String(userId)) &&
    attempt.delivery_id === fence.deliveryId &&
    attempt.conversation_sequence === fence.conversationSequence &&
    attempt.execution_epoch === fence.executionEpoch &&
    attempt.configuration_revision === fence.configurationRevision &&
    attempt.owner_device_id === fence.ownerDeviceId &&
    attempt.daemon_boot_id === fence.daemonBootId &&
    attempt.runtime_id === fence.runtimeId;
}

export async function claimNextDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    expectedMessageId?: Id<"pending_messages">;
    executionEpoch: number;
    configurationRevision: number;
    ownerDeviceId: string;
    daemonBootId: string;
    runtimeId: string;
    now: number;
  },
): Promise<any> {
  await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  const binding = await executionBinding(ctx, args.conversationId, args.executionEpoch);
  if (!head) fail("EXECUTION_HEAD_MISSING", "conversation has no execution head");
  assertReadyFence(head, binding, args);

  if (head.active_delivery_attempt_id !== undefined) {
    const activeAttempt = await ctx.db.get(head.active_delivery_attempt_id);
    if (
      activeAttempt?.state === "claimed" &&
      activeAttempt.execution_epoch === args.executionEpoch &&
      activeAttempt.configuration_revision === args.configurationRevision &&
      activeAttempt.owner_device_id === args.ownerDeviceId &&
      activeAttempt.daemon_boot_id === args.daemonBootId &&
      activeAttempt.runtime_id === args.runtimeId &&
      (!args.expectedMessageId || String(activeAttempt.message_id) === String(args.expectedMessageId))
    ) {
      const activeMessage = await ctx.db.get(activeAttempt.message_id);
      return {
        state: "claimed" as const,
        recovered: true,
        permit: claimedPermitWire(activeAttempt),
        message: activeMessage
          ? {
              _id: activeMessage._id,
              content: activeMessage.content,
              image_storage_id: activeMessage.image_storage_id,
              image_storage_ids: activeMessage.image_storage_ids,
              client_id: activeMessage.client_id,
            }
          : undefined,
      };
    }
    return {
      state: "busy" as const,
      attemptId: String(head.active_delivery_attempt_id),
      activeState: head.active_delivery_state,
    };
  }

  const messages = orderedNonterminalMessages(await fencedMessages(ctx, args.conversationId), head);
  const message = messages[0];
  if (!message) {
    if (head.next_nonterminal_sequence !== head.next_conversation_sequence) {
      await ctx.db.patch(head._id, {
        next_nonterminal_sequence: head.next_conversation_sequence,
        updated_at: args.now,
      });
    }
    return { state: "empty" as const };
  }
  if (message.conversation_sequence !== head.next_nonterminal_sequence) {
    fail(
      "DELIVERY_SEQUENCE_HEAD_MISMATCH",
      `durable head ${head.next_nonterminal_sequence} differs from first nonterminal ${message.conversation_sequence}`,
    );
  }
  if (args.expectedMessageId && String(args.expectedMessageId) !== String(message._id)) {
    return { state: "waiting-for-earlier-message" as const, messageId: String(message._id) };
  }
  if (message.execution_epoch !== head.current_epoch) {
    return {
      state: "waiting-for-successor" as const,
      messageId: String(message._id),
      executionEpoch: message.execution_epoch,
    };
  }
  if (
    message.delivery_status !== "pending" ||
    message.delivery_protocol_version !== head.protocol_version ||
    !message.delivery_id ||
    !message.client_id ||
    message.delivery_id !== message.client_id
  ) {
    fail(
      "DELIVERY_MESSAGE_INVARIANT",
      "head message is not a pending fenced message with one stable client/delivery id",
    );
  }

  const attemptId = await ctx.db.insert("delivery_attempts", {
    conversation_id: args.conversationId,
    message_id: message._id,
    delivery_id: message.delivery_id,
    conversation_sequence: message.conversation_sequence,
    execution_epoch: args.executionEpoch,
    configuration_revision: args.configurationRevision,
    owner_user_id: userId,
    owner_device_id: args.ownerDeviceId,
    daemon_boot_id: args.daemonBootId,
    runtime_id: args.runtimeId,
    state: "claimed" as const,
    claimed_at: args.now,
  });
  await ctx.db.patch(message._id, {
    delivery_status: "claimed" as const,
    active_delivery_attempt_id: attemptId,
  });
  await ctx.db.patch(head._id, {
    active_delivery_attempt_id: attemptId,
    active_delivery_state: "claimed" as const,
    updated_at: args.now,
  });
  const attempt = await ctx.db.get(attemptId);
  return {
    state: "claimed" as const,
    permit: claimedPermitWire(attempt),
    message: {
      _id: message._id,
      content: message.content,
      image_storage_id: message.image_storage_id,
      image_storage_ids: message.image_storage_ids,
      client_id: message.client_id,
    },
  };
}

export async function rejectHeadDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    messageId: Id<"pending_messages">;
    deliveryId: string;
    conversationSequence: number;
    executionEpoch: number;
    reason: string;
    now: number;
  },
): Promise<{ rejected: true }> {
  requireNonEmpty(args.reason, "reason");
  await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  if (!head || head.protocol_state !== "fenced") {
    fail("EXECUTION_NOT_FENCED", "delivery rejection requires fenced authority");
  }
  if (head.active_delivery_attempt_id !== undefined) {
    fail("DELIVERY_SLOT_BUSY", "an active attempt must reach its own explicit disposition");
  }
  const existingMessage = await ctx.db.get(args.messageId);
  if (
    existingMessage?.delivery_status === "rejected" &&
    existingMessage.delivery_id === args.deliveryId &&
    existingMessage.client_id === args.deliveryId &&
    existingMessage.conversation_sequence === args.conversationSequence &&
    existingMessage.execution_epoch === args.executionEpoch &&
    existingMessage.delivery_disposition_reason === args.reason
  ) {
    return { rejected: true };
  }
  const message = orderedNonterminalMessages(
    await fencedMessages(ctx, args.conversationId),
    head,
  )[0];
  if (
    !message ||
    String(message._id) !== String(args.messageId) ||
    message.delivery_id !== args.deliveryId ||
    message.client_id !== args.deliveryId ||
    message.conversation_sequence !== args.conversationSequence ||
    message.execution_epoch !== args.executionEpoch ||
    message.delivery_status !== "pending"
  ) {
    fail("DELIVERY_SEQUENCE_HEAD_MISMATCH", "only the exact pending global head may be rejected");
  }
  await ctx.db.patch(message._id, {
    delivery_status: "rejected" as const,
    delivery_disposition_reason: args.reason,
    status: "cancelled" as const,
  });
  await advanceNonterminalHead(ctx, head, args.now);
  await clearPendingFlagIfQuiet(ctx, args.conversationId);
  return { rejected: true };
}

async function verifyAttemptFence(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence,
  expectedAttemptStates: readonly string[],
): Promise<{ conversation: any; head: any; binding: any; message: any; attempt: any }> {
  const conversation = await requireOwnedConversation(ctx, fence.conversationId, userId);
  const [head, binding, message, attempt] = await Promise.all([
    executionHead(ctx, fence.conversationId),
    executionBinding(ctx, fence.conversationId, fence.executionEpoch),
    ctx.db.get(fence.messageId),
    ctx.db.get(fence.attemptId),
  ]);
  if (!head || !message || !attempt) {
    fail("DELIVERY_PERMIT_NOT_FOUND", "head, message, or attempt is missing");
  }
  assertReadyFence(head, binding, fence);
  const exact =
    attemptMatchesFence(attempt, fence, userId) &&
    String(head.active_delivery_attempt_id) === String(fence.attemptId) &&
    String(message.active_delivery_attempt_id) === String(fence.attemptId) &&
    message.delivery_id === fence.deliveryId &&
    message.client_id === fence.deliveryId &&
    message.conversation_sequence === fence.conversationSequence &&
    message.execution_epoch === fence.executionEpoch;
  if (!exact) fail("DELIVERY_PERMIT_FENCE_MISMATCH", "permit no longer owns the exact durable slot");
  if (!expectedAttemptStates.includes(attempt.state)) {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", `attempt is ${attempt.state}`);
  }
  return { conversation, head, binding, message, attempt };
}

export async function startDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { now: number },
): Promise<any> {
  const { head, message, attempt } = await verifyAttemptFence(ctx, userId, fence, [
    "claimed",
    "delivery-started",
  ]);
  if (
    attempt.state === "delivery-started" &&
    head.active_delivery_state === "delivery-started" &&
    message.delivery_status === "delivery-started"
  ) {
    return startedPermitWire(attempt);
  }
  if (head.active_delivery_state !== "claimed" || message.delivery_status !== "claimed") {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "conversation slot or message is not claimed");
  }
  await ctx.db.patch(attempt._id, {
    state: "delivery-started" as const,
    delivery_started_at: fence.now,
  });
  await ctx.db.patch(message._id, { delivery_status: "delivery-started" as const });
  await ctx.db.patch(head._id, {
    active_delivery_state: "delivery-started" as const,
    updated_at: fence.now,
  });
  return startedPermitWire({ ...attempt, state: "delivery-started" });
}

export async function releaseClaimBeforeEffectInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { reason: string; evidence: string; now: number },
): Promise<{ retryable: true; deliveryId: string }> {
  requireNonEmpty(fence.reason, "reason");
  requireNonEmpty(fence.evidence, "evidence");
  await requireOwnedConversation(ctx, fence.conversationId, userId);
  const existingAttempt = await ctx.db.get(fence.attemptId);
  if (
    existingAttempt?.state === "failed-before-effect" &&
    attemptMatchesFence(existingAttempt, fence, userId)
  ) {
    return { retryable: true, deliveryId: existingAttempt.delivery_id };
  }
  const { head, message, attempt } = await verifyAttemptFence(ctx, userId, fence, ["claimed"]);
  if (head.active_delivery_state !== "claimed" || message.delivery_status !== "claimed") {
    fail(
      "DELIVERY_ALREADY_STARTED",
      "only a claim that never crossed delivery-started can be safely released",
    );
  }
  await ctx.db.patch(attempt._id, {
    state: "failed-before-effect" as const,
    failure_code: "CLAIM_RELEASED_BEFORE_EFFECT",
    failure_message: fence.reason,
    resolution_evidence: fence.evidence,
    completed_at: fence.now,
  });
  await ctx.db.patch(message._id, {
    delivery_status: "pending" as const,
    active_delivery_attempt_id: undefined,
    retry_count: (message.retry_count ?? 0) + 1,
  });
  await ctx.db.patch(head._id, {
    active_delivery_attempt_id: undefined,
    active_delivery_state: undefined,
    updated_at: fence.now,
  });
  return { retryable: true, deliveryId: message.delivery_id };
}

async function finishTerminalDelivery(
  ctx: DbCtx,
  head: any,
  message: any,
  attempt: any,
  args: {
    attemptState: "delivered" | "correlated-delivered" | "abandoned-ambiguous";
    messageState: "delivered" | "correlated-delivered" | "abandoned-ambiguous";
    externalDeliveryId?: string;
    resolutionEvidence?: string;
    now: number;
  },
): Promise<void> {
  await ctx.db.patch(attempt._id, {
    state: args.attemptState,
    external_delivery_id: args.externalDeliveryId,
    resolution_evidence: args.resolutionEvidence,
    completed_at: args.now,
  });
  await ctx.db.patch(message._id, {
    delivery_status: args.messageState,
    active_delivery_attempt_id: undefined,
    // Legacy status is projection-only for fenced rows. Keeping terminal rows
    // out of legacy indexes prevents healer/backlog amplification.
    status: args.messageState === "abandoned-ambiguous" ? "cancelled" : "delivered",
    delivered_at: args.messageState === "abandoned-ambiguous" ? undefined : args.now,
  });
  await ctx.db.patch(head._id, {
    active_delivery_attempt_id: undefined,
    active_delivery_state: undefined,
    updated_at: args.now,
  });
  await advanceNonterminalHead(ctx, head, args.now);
  await clearPendingFlagIfQuiet(ctx, head.conversation_id);
}

export async function completeDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { externalDeliveryId?: string; now: number },
): Promise<{ accepted: true }> {
  await requireOwnedConversation(ctx, fence.conversationId, userId);
  const existingAttempt = await ctx.db.get(fence.attemptId);
  if (existingAttempt?.state === "delivered" && attemptMatchesFence(existingAttempt, fence, userId)) {
    if (
      fence.externalDeliveryId !== undefined &&
      existingAttempt.external_delivery_id !== fence.externalDeliveryId
    ) {
      fail("DELIVERY_COMPLETION_CONFLICT", "external delivery id differs from durable completion");
    }
    return { accepted: true };
  }
  const { head, message, attempt } = await verifyAttemptFence(ctx, userId, fence, [
    "delivery-started",
  ]);
  if (head.active_delivery_state !== "delivery-started" || message.delivery_status !== "delivery-started") {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "delivery was not durably started");
  }
  await finishTerminalDelivery(ctx, head, message, attempt, {
    attemptState: "delivered",
    messageState: "delivered",
    externalDeliveryId: fence.externalDeliveryId,
    now: fence.now,
  });
  return { accepted: true };
}

export async function failDeliveryBeforeEffectInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { failureCode: string; failureMessage: string; now: number },
): Promise<{ retryable: true; deliveryId: string }> {
  await requireOwnedConversation(ctx, fence.conversationId, userId);
  const existingAttempt = await ctx.db.get(fence.attemptId);
  if (
    existingAttempt?.state === "failed-before-effect" &&
    attemptMatchesFence(existingAttempt, fence, userId)
  ) {
    return { retryable: true, deliveryId: existingAttempt.delivery_id };
  }
  const { head, message, attempt } = await verifyAttemptFence(ctx, userId, fence, [
    "delivery-started",
  ]);
  if (head.active_delivery_state !== "delivery-started" || message.delivery_status !== "delivery-started") {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "delivery was not durably started");
  }
  await ctx.db.patch(attempt._id, {
    state: "failed-before-effect" as const,
    failure_code: fence.failureCode,
    failure_message: fence.failureMessage,
    completed_at: fence.now,
  });
  await ctx.db.patch(message._id, {
    delivery_status: "pending" as const,
    active_delivery_attempt_id: undefined,
    retry_count: (message.retry_count ?? 0) + 1,
  });
  await ctx.db.patch(head._id, {
    active_delivery_attempt_id: undefined,
    active_delivery_state: undefined,
    updated_at: fence.now,
  });
  // Deliberately do not advance next_nonterminal_sequence: the same deliveryId
  // and sequence are retryable only because the driver proved no effect.
  return { retryable: true, deliveryId: message.delivery_id };
}

export async function markDeliveryAmbiguousInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & { failureCode: string; failureMessage: string; now: number },
): Promise<{ blocked: true; deliveryId: string }> {
  const { head, message, attempt } = await verifyAttemptFence(ctx, userId, fence, [
    "delivery-started",
    "ambiguous",
  ]);
  if (
    attempt.state === "ambiguous" &&
    head.active_delivery_state === "ambiguous" &&
    message.delivery_status === "ambiguous"
  ) {
    return { blocked: true, deliveryId: message.delivery_id };
  }
  if (head.active_delivery_state !== "delivery-started" || message.delivery_status !== "delivery-started") {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "delivery was not durably started");
  }
  await ctx.db.patch(attempt._id, {
    state: "ambiguous" as const,
    failure_code: fence.failureCode,
    failure_message: fence.failureMessage,
  });
  await ctx.db.patch(message._id, { delivery_status: "ambiguous" as const });
  await ctx.db.patch(head._id, {
    active_delivery_state: "ambiguous" as const,
    updated_at: fence.now,
  });
  // The slot remains owned. A timeout can never be silently reclassified as a
  // pre-effect failure or allow a successor/later message to pass.
  return { blocked: true, deliveryId: message.delivery_id };
}

export async function resolveAmbiguousDeliveryInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & {
    resolution: "correlated-delivered" | "proven-no-effect" | "abandoned-ambiguous";
    resolutionEvidence: string;
    now: number;
  },
): Promise<{ state: string }> {
  requireNonEmpty(fence.resolutionEvidence, "resolutionEvidence");
  const { head, message, attempt } = await verifyAttemptFence(ctx, userId, fence, ["ambiguous"]);
  if (head.active_delivery_state !== "ambiguous" || message.delivery_status !== "ambiguous") {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "delivery is not ambiguity-blocked");
  }
  if (fence.resolution === "proven-no-effect") {
    await ctx.db.patch(attempt._id, {
      state: "failed-before-effect" as const,
      resolution_evidence: fence.resolutionEvidence,
      completed_at: fence.now,
    });
    await ctx.db.patch(message._id, {
      delivery_status: "pending" as const,
      active_delivery_attempt_id: undefined,
      retry_count: (message.retry_count ?? 0) + 1,
    });
    await ctx.db.patch(head._id, {
      active_delivery_attempt_id: undefined,
      active_delivery_state: undefined,
      updated_at: fence.now,
    });
    return { state: "pending" };
  }
  const state = fence.resolution;
  await finishTerminalDelivery(ctx, head, message, attempt, {
    attemptState: state,
    messageState: state,
    resolutionEvidence: fence.resolutionEvidence,
    now: fence.now,
  });
  return { state };
}

export async function abandonAmbiguousAndResendInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  fence: PermitFence & {
    newClientId: string;
    resolutionEvidence: string;
    now: number;
  },
): Promise<{
  originalDeliveryId: string;
  messageId: any;
  deliveryId: string;
  conversationSequence: string;
  executionEpoch: number;
}> {
  requireNonEmpty(fence.resolutionEvidence, "resolutionEvidence");
  if (!fence.newClientId.trim() || fence.newClientId !== fence.newClientId.trim()) {
    fail("INVALID_DELIVERY_ID", "newClientId must be non-empty canonical text");
  }
  if (fence.newClientId === fence.deliveryId) {
    fail("RISK_RESEND_REQUIRES_NEW_ID", "risk-bearing resend must use a new logical delivery id");
  }
  const conversation = await requireOwnedConversation(ctx, fence.conversationId, userId);
  const existingRows = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_client_id", (q: any) =>
      q.eq("conversation_id", fence.conversationId).eq("client_id", fence.newClientId),
    )
    .collect();
  if (existingRows.length > 1) {
    fail("DELIVERY_ID_INVARIANT", "conversation contains duplicate client/delivery ids");
  }
  const existingAttempt = await ctx.db.get(fence.attemptId);
  const existingResend = existingRows[0];
  if (
    existingAttempt?.state === "abandoned-ambiguous" &&
    attemptMatchesFence(existingAttempt, fence, userId) &&
    existingAttempt.resolution_evidence === fence.resolutionEvidence &&
    existingResend?.resend_of_delivery_id === fence.deliveryId &&
    existingResend.delivery_id === fence.newClientId
  ) {
    return {
      originalDeliveryId: fence.deliveryId,
      messageId: existingResend._id,
      deliveryId: existingResend.delivery_id,
      conversationSequence: String(existingResend.conversation_sequence),
      executionEpoch: existingResend.execution_epoch,
    };
  }
  if (existingResend) {
    fail("DELIVERY_ID_ALREADY_EXISTS", "newClientId already names another logical delivery");
  }

  const { head, message, attempt } = await verifyAttemptFence(ctx, userId, fence, ["ambiguous"]);
  if (head.active_delivery_state !== "ambiguous" || message.delivery_status !== "ambiguous") {
    fail("DELIVERY_ATTEMPT_STATE_MISMATCH", "delivery is not ambiguity-blocked");
  }
  await finishTerminalDelivery(ctx, head, message, attempt, {
    attemptState: "abandoned-ambiguous",
    messageState: "abandoned-ambiguous",
    resolutionEvidence: fence.resolutionEvidence,
    now: fence.now,
  });

  const allocation = await allocateFencedDeliveryMetadata(ctx, conversation, fence.newClientId);
  if (!allocation) fail("EXECUTION_NOT_FENCED", "risk resend lost fenced execution authority");
  const messageId = await insertRiskResendPendingMessage(ctx, {
    conversationId: fence.conversationId,
    fromUserId: message.from_user_id,
    ownerUserId: message.owner_user_id ?? conversation.user_id,
    fromConversationId: message.from_conversation_id,
    content: message.content,
    imageStorageId: message.image_storage_id,
    imageStorageIds: message.image_storage_ids,
    clientId: fence.newClientId,
    origin: message.origin,
    createdAt: fence.now,
    delivery: allocation,
    resendOfDeliveryId: fence.deliveryId,
  });
  const machineWake = message.origin === "scheduler";
  await ctx.db.patch(fence.conversationId, {
    updated_at: fence.now,
    has_pending_messages: true,
    ...(conversation.status === "completed" ? { status: "active" as const } : {}),
    ...(conversation.inbox_dismissed_at ? { inbox_dismissed_at: undefined } : {}),
    ...(conversation.inbox_stashed_at && !machineWake ? { inbox_stashed_at: undefined } : {}),
    ...(conversation.inbox_killed_at ? { inbox_killed_at: undefined } : {}),
  });
  return {
    originalDeliveryId: fence.deliveryId,
    messageId,
    deliveryId: allocation.deliveryId,
    conversationSequence: String(allocation.conversationSequence),
    executionEpoch: allocation.executionEpoch,
  };
}

export async function publishRuntimeDispositionInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    epoch: number;
    configurationRevision: number;
    ownerDeviceId: string;
    daemonBootId: string;
    runtimeId: string;
    disposition: "stopped" | "quarantined";
    reason: string;
    now: number;
  },
): Promise<{ accepted: boolean }> {
  requireNonEmpty(args.reason, "reason");
  await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  const binding = await executionBinding(ctx, args.conversationId, args.epoch);
  if (!head || !binding || (head.current_epoch !== args.epoch && head.pending_epoch !== args.epoch)) {
    return { accepted: false };
  }
  if (
    binding.state === args.disposition &&
    binding.configuration_revision === args.configurationRevision &&
    binding.applied_configuration_revision === args.configurationRevision &&
    binding.owner_device_id === args.ownerDeviceId &&
    binding.daemon_boot_id === args.daemonBootId &&
    binding.runtime_id === args.runtimeId &&
    binding.stopped_reason === args.reason
  ) {
    return { accepted: true };
  }
  if (
    binding.state !== "ready" ||
    binding.requested_agent !== binding.actual_agent ||
    binding.configuration_revision !== args.configurationRevision ||
    binding.applied_configuration_revision !== args.configurationRevision ||
    binding.owner_device_id !== args.ownerDeviceId ||
    binding.daemon_boot_id !== args.daemonBootId ||
    binding.runtime_id !== args.runtimeId
  ) {
    return { accepted: false };
  }
  if (
    head.current_epoch === args.epoch &&
    (head.active_delivery_state === "delivery-started" || head.active_delivery_state === "ambiguous")
  ) {
    fail(
      "ACTIVE_DELIVERY_PREVENTS_RUNTIME_DISPOSITION",
      "a started or ambiguous delivery still depends on this runtime",
    );
  }
  if (head.current_epoch === args.epoch && head.pending_policy === "drain-current") {
    const remaining = (await fencedMessages(ctx, args.conversationId)).filter(
      (message) =>
        message.execution_epoch === args.epoch &&
        !isTerminalDeliveryState(message.delivery_status),
    );
    if (remaining.length > 0) {
      fail(
        "EXECUTION_SUCCESSOR_WAITING_FOR_DRAIN",
        "drain-current cannot stop its only ready runtime while old-epoch messages remain",
      );
    }
  }
  await ctx.db.patch(binding._id, {
    state: args.disposition,
    stopped_reason: args.reason,
    updated_at: args.now,
  });
  return { accepted: true };
}

async function cancelUnstartedOldEpoch(
  ctx: DbCtx,
  head: any,
  currentEpoch: number,
  now: number,
): Promise<{ cancelled: number; remaining: number }> {
  const MAX_CANCELLATIONS_PER_ACTIVATION = 128;
  const messages = (await fencedMessages(ctx, head.conversation_id)).filter(
    (message) =>
      message.execution_epoch === currentEpoch &&
      message.conversation_sequence <= head.cancelled_through_sequence &&
      !isTerminalDeliveryState(message.delivery_status),
  );
  const batch = messages
    .sort((left, right) => left.conversation_sequence - right.conversation_sequence)
    .slice(0, MAX_CANCELLATIONS_PER_ACTIVATION);
  let cancelled = 0;
  for (const message of batch) {
    if (message.delivery_status === "delivery-started" || message.delivery_status === "ambiguous") {
      fail(
        "ACTIVE_DELIVERY_PREVENTS_EPOCH_ACTIVATION",
        `message ${String(message._id)} has a started or ambiguous effect`,
      );
    }
    if (message.delivery_status === "claimed") {
      const attempt = message.active_delivery_attempt_id
        ? await ctx.db.get(message.active_delivery_attempt_id)
        : null;
      if (!attempt || attempt.state !== "claimed") {
        fail("DELIVERY_SLOT_INVARIANT", "claimed message lacks its claimed attempt");
      }
      await ctx.db.patch(attempt._id, {
        state: "cancelled-by-supersession" as const,
        completed_at: now,
      });
    } else if (message.delivery_status !== "pending") {
      fail(
        "DELIVERY_SLOT_INVARIANT",
        `cannot cancel old-epoch message in state ${String(message.delivery_status)}`,
      );
    }
    await ctx.db.patch(message._id, {
      delivery_status: "cancelled-by-supersession" as const,
      active_delivery_attempt_id: undefined,
      status: "cancelled" as const,
    });
    cancelled += 1;
  }
  if (head.active_delivery_state === "claimed") {
    await ctx.db.patch(head._id, {
      active_delivery_attempt_id: undefined,
      active_delivery_state: undefined,
      updated_at: now,
    });
  }
  return { cancelled, remaining: messages.length - batch.length };
}

export async function activateExecutionSuccessorInDb(
  ctx: DbCtx,
  userId: Id<"users">,
  args: {
    conversationId: Id<"conversations">;
    expectedCurrentEpoch: number;
    successorEpoch: number;
    currentConfigurationRevision: number;
    currentOwnerDeviceId: string;
    currentDaemonBootId: string;
    currentOperationId?: string;
    currentRuntimeId?: string;
    successorConfigurationRevision: number;
    successorOwnerDeviceId: string;
    successorDaemonBootId: string;
    successorRuntimeId: string;
    now: number;
  },
): Promise<
  | { activated: true; epoch: number; cancelledMessages: number }
  | {
      activated: false;
      epoch: number;
      cancelledMessages: number;
      remainingCancellations: number;
    }
> {
  const conversation = await requireOwnedConversation(ctx, args.conversationId, userId);
  const head = await executionHead(ctx, args.conversationId);
  if (!head || head.protocol_state !== "fenced" || conversation.execution_protocol_state !== "fenced") {
    fail("EXECUTION_NOT_FENCED", "successor activation requires a fenced conversation");
  }
  if (
    head.current_epoch !== args.expectedCurrentEpoch ||
    head.pending_epoch !== args.successorEpoch ||
    args.successorEpoch !== args.expectedCurrentEpoch + 1
  ) {
    fail("EXECUTION_EPOCH_FENCE_MISMATCH", "current or pending epoch changed before activation");
  }
  const successorIntent = head.successor_intent;
  if (
    !successorIntent ||
    successorIntent.status !== "consumed" ||
    successorIntent.expected_current_epoch !== args.expectedCurrentEpoch ||
    successorIntent.successor_epoch !== args.successorEpoch ||
    successorIntent.consumed_daemon_boot_id !== args.successorDaemonBootId
  ) {
    fail("EXECUTION_SUCCESSOR_INTENT_MISMATCH", "activation does not match the consumed successor intent");
  }
  if (head.active_delivery_state === "delivery-started" || head.active_delivery_state === "ambiguous") {
    fail(
      "ACTIVE_DELIVERY_PREVENTS_EPOCH_ACTIVATION",
      `conversation slot is ${head.active_delivery_state}`,
    );
  }
  const current = await executionBinding(ctx, args.conversationId, args.expectedCurrentEpoch);
  const successor = await executionBinding(ctx, args.conversationId, args.successorEpoch);
  if (!current || !successor) fail("EXECUTION_BINDING_MISSING", "current or successor binding is missing");
  if (
    current.configuration_revision !== args.currentConfigurationRevision ||
    current.owner_device_id !== args.currentOwnerDeviceId ||
    current.daemon_boot_id !== args.currentDaemonBootId
  ) {
    fail("EXECUTION_BINDING_FENCE_MISMATCH", "current binding fence changed before activation");
  }
  if (current.state !== "stopped" && current.state !== "quarantined") {
    fail(
      "PREDECESSOR_RUNTIME_NOT_DISPOSED",
      "the prior runtime must be stopped or durably quarantined before epoch activation",
    );
  }
  if (current.pre_ready_disposition) {
    if (
      !current.disposition_evidence ||
      (current.operation_id ?? undefined) !== args.currentOperationId
    ) {
      fail(
        "EXECUTION_OPERATION_FENCE_MISMATCH",
        "pre-ready disposition lacks evidence or names a different operation",
      );
    }
    if (
      current.pre_ready_disposition === "no-runtime-proven" &&
      args.currentRuntimeId !== undefined
    ) {
      fail("EXECUTION_RUNTIME_FENCE_MISMATCH", "no-runtime proof must not name a runtime");
    }
    if (
      current.pre_ready_disposition === "runtime-quarantined" &&
      (!args.currentRuntimeId || current.suspected_runtime_id !== args.currentRuntimeId)
    ) {
      fail("EXECUTION_RUNTIME_FENCE_MISMATCH", "quarantined runtime id does not match");
    }
  } else if (
    !args.currentOperationId ||
    current.operation_id !== args.currentOperationId ||
    !args.currentRuntimeId ||
    current.applied_configuration_revision !== args.currentConfigurationRevision ||
    current.runtime_id !== args.currentRuntimeId ||
    current.requested_agent !== current.actual_agent
  ) {
    fail(
      "EXECUTION_BINDING_FENCE_MISMATCH",
      "disposed ready predecessor lacks exact operation/runtime/configuration evidence",
    );
  }
  if (
    successor.configuration_revision !== args.successorConfigurationRevision ||
    successor.applied_configuration_revision !== args.successorConfigurationRevision ||
    successor.owner_device_id !== args.successorOwnerDeviceId ||
    successor.daemon_boot_id !== args.successorDaemonBootId ||
    successor.runtime_id !== args.successorRuntimeId ||
    successor.state !== "ready" ||
    successor.requested_agent !== successor.actual_agent ||
    !successor.handle ||
    !successor.operation_id ||
    !capabilitiesEqual(successor.required_capabilities ?? [], successor.capabilities ?? [])
  ) {
    fail(
      "SUCCESSOR_BINDING_NOT_READY",
      "successor lacks a complete strict ready binding or its fence changed",
    );
  }

  let cancelledMessages = 0;
  if (head.pending_policy === "cancel-unstarted") {
    const cancellation = await cancelUnstartedOldEpoch(
      ctx,
      head,
      args.expectedCurrentEpoch,
      args.now,
    );
    cancelledMessages = cancellation.cancelled;
    await advanceNonterminalHead(ctx, head, args.now);
    if (cancellation.remaining > 0) {
      return {
        activated: false as const,
        epoch: args.successorEpoch,
        cancelledMessages,
        remainingCancellations: cancellation.remaining,
      };
    }
  } else if (head.active_delivery_state === "claimed") {
    fail("ACTIVE_DELIVERY_PREVENTS_EPOCH_ACTIVATION", "drain-current cannot cancel a claimed delivery");
  }

  const remainingOld = (await fencedMessages(ctx, args.conversationId)).filter(
    (message) =>
      message.execution_epoch === args.expectedCurrentEpoch &&
      !isTerminalDeliveryState(message.delivery_status),
  );
  if (remainingOld.length > 0) {
    fail(
      "EXECUTION_SUCCESSOR_WAITING_FOR_DRAIN",
      `${remainingOld.length} old-epoch message(s) are still nonterminal`,
    );
  }

  await ctx.db.patch(head._id, {
    current_epoch: args.successorEpoch,
    admission_epoch: args.successorEpoch,
    pending_epoch: undefined,
    pending_policy: undefined,
    pending_requested_at_sequence: undefined,
    cancelled_through_sequence: undefined,
    active_delivery_attempt_id: undefined,
    active_delivery_state: undefined,
    successor_intent: {
      ...successorIntent,
      status: "activated" as const,
      activated_at: args.now,
    },
    updated_at: args.now,
  });
  await advanceNonterminalHead(ctx, head, args.now);
  await ctx.db.patch(args.conversationId, { owner_device_id: args.successorOwnerDeviceId });
  await clearPendingFlagIfQuiet(ctx, args.conversationId);
  return { activated: true, epoch: args.successorEpoch, cancelledMessages };
}

// Validators are intentionally declared in this module rather than imported
// from CLI/shared code. Convex analyzes function validators at bundle time; a
// self-contained wire contract prevents runtime/toolchain imports from silently
// widening the authority boundary.
const agentClientValidator = v.union(
  v.literal("claude"),
  v.literal("codex"),
  v.literal("cursor"),
  v.literal("gemini"),
  v.literal("opencode"),
  v.literal("pi"),
);
const transportValidator = v.union(
  v.literal("tmux"),
  v.literal("app-server"),
  v.literal("external"),
);
const capabilityValidator = v.union(
  v.literal("single-flight-binding"),
  v.literal("delivery-permit-v1"),
  v.literal("strict-agent-routing"),
  v.literal("runtime-inspection-v1"),
);
const isolationValidator = v.object({
  sandbox: v.optional(v.union(
    v.literal("read-only"),
    v.literal("workspace-write"),
    v.literal("danger-full-access"),
  )),
  approval_policy: v.optional(v.union(
    v.literal("untrusted"),
    v.literal("on-failure"),
    v.literal("on-request"),
    v.literal("never"),
  )),
  isolated: v.optional(v.boolean()),
  worktree_name: v.optional(v.string()),
});
const targetValidator = v.object({
  requested_agent: agentClientValidator,
  transport: transportValidator,
  project_path: v.string(),
  isolation: v.optional(isolationValidator),
  configuration_revision: v.number(),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  owner_device_id: v.string(),
  daemon_boot_id: v.string(),
  required_capabilities: v.array(capabilityValidator),
  protocol_version: v.number(),
});
const permitValidator = v.object({
  message_id: v.id("pending_messages"),
  delivery_id: v.string(),
  conversation_sequence: v.string(),
  attempt_id: v.id("delivery_attempts"),
  conversation_id: v.id("conversations"),
  execution_epoch: v.number(),
  configuration_revision: v.number(),
  owner_device_id: v.string(),
  daemon_boot_id: v.string(),
  runtime_id: v.string(),
});

function targetFromWire(target: any): TargetInput {
  return {
    requestedAgent: target.requested_agent,
    transport: target.transport,
    projectPath: target.project_path,
    isolation: target.isolation
      ? {
          sandbox: target.isolation.sandbox,
          approvalPolicy: target.isolation.approval_policy,
          isolated: target.isolation.isolated,
          worktreeName: target.isolation.worktree_name,
        }
      : undefined,
    configurationRevision: target.configuration_revision,
    model: target.model,
    effort: target.effort,
    ownerDeviceId: target.owner_device_id,
    daemonBootId: target.daemon_boot_id,
    requiredCapabilities: target.required_capabilities,
    protocolVersion: target.protocol_version,
  };
}

function sequenceFromWire(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    fail("INVALID_CONVERSATION_SEQUENCE", "conversation_sequence must be a canonical positive integer string");
  }
  return parsed;
}

function permitFromWire(permit: any): PermitFence {
  return {
    messageId: permit.message_id,
    deliveryId: permit.delivery_id,
    conversationSequence: sequenceFromWire(permit.conversation_sequence),
    attemptId: permit.attempt_id,
    conversationId: permit.conversation_id,
    executionEpoch: permit.execution_epoch,
    configurationRevision: permit.configuration_revision,
    ownerDeviceId: permit.owner_device_id,
    daemonBootId: permit.daemon_boot_id,
    runtimeId: permit.runtime_id,
  };
}

export async function authenticateExecutionDaemon(
  ctx: DbCtx,
  apiToken: string | undefined,
): Promise<Id<"users">> {
  // Effect authority never falls back to ambient browser/session auth. The
  // caller must present the daemon/CLI bearer explicitly on every mutation.
  if (!apiToken) fail("DAEMON_TOKEN_REQUIRED", "execution control requires an API token");
  const result = await verifyApiToken(ctx, apiToken);
  if (!result) fail("DAEMON_TOKEN_INVALID", "execution control API token is invalid");
  return result.userId;
}

export const beginLegacyQuiescence = mutation({
  args: {
    conversation_id: v.id("conversations"),
    owner_device_id: v.string(),
    legacy_daemon_boot_id: v.string(),
    protocol_version: v.number(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await beginLegacyQuiescenceInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      ownerDeviceId: args.owner_device_id,
      legacyDaemonBootId: args.legacy_daemon_boot_id,
      protocolVersion: args.protocol_version,
      now: Date.now(),
    }),
});

export const initializeFencedExecution = mutation({
  args: {
    conversation_id: v.id("conversations"),
    target: targetValidator,
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await initializeFencedExecutionInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      target: targetFromWire(args.target),
      now: Date.now(),
    }),
});

export const activateAfterLegacyQuiescence = mutation({
  args: {
    conversation_id: v.id("conversations"),
    target: targetValidator,
    terminated_legacy_daemon_boot_id: v.string(),
    runtime_disposition: v.union(
      v.literal("stopped"),
      v.literal("adopted"),
      v.literal("quarantined"),
    ),
    termination_evidence: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await activateAfterLegacyQuiescenceInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      target: targetFromWire(args.target),
      terminatedLegacyDaemonBootId: args.terminated_legacy_daemon_boot_id,
      runtimeDisposition: args.runtime_disposition,
      terminationEvidence: args.termination_evidence,
      now: Date.now(),
    }),
});

// Product authority only. This endpoint accepts browser session auth and no API
// token; conversely it cannot name any device/boot/runtime/operation/transport
// or capability. The daemon endpoint below is the only effect-authority path.
export const requestExecutionSuccessorIntent = mutation({
  args: {
    conversation_id: v.id("conversations"),
    intent_id: v.string(),
    expected_current_epoch: v.number(),
    kind: v.union(v.literal("restart"), v.literal("reconfigure")),
    policy: v.union(v.literal("drain-current"), v.literal("cancel-unstarted")),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) fail("EXECUTION_BROWSER_AUTH_REQUIRED", "successor intent requires a browser session");
    return await recordExecutionSuccessorIntentInDb(ctx, userId, {
      conversationId: args.conversation_id,
      intentId: args.intent_id,
      expectedCurrentEpoch: args.expected_current_epoch,
      kind: args.kind,
      policy: args.policy,
      model: args.model,
      effort: args.effort,
      now: Date.now(),
    });
  },
});

export const requestExecutionSuccessor = mutation({
  args: {
    conversation_id: v.id("conversations"),
    intent_id: v.string(),
    expected_current_epoch: v.number(),
    policy: v.union(v.literal("drain-current"), v.literal("cancel-unstarted")),
    target: targetValidator,
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await requestExecutionSuccessorInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      intentId: args.intent_id,
      expectedCurrentEpoch: args.expected_current_epoch,
      policy: args.policy,
      target: targetFromWire(args.target),
      now: Date.now(),
    }),
});

export const claimExecutionStart = mutation({
  args: {
    conversation_id: v.id("conversations"),
    epoch: v.number(),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    configuration_revision: v.number(),
    protocol_version: v.number(),
    required_capabilities: v.array(capabilityValidator),
    proposed_operation_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await claimExecutionStartInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      epoch: args.epoch,
      ownerDeviceId: args.owner_device_id,
      daemonBootId: args.daemon_boot_id,
      configurationRevision: args.configuration_revision,
      protocolVersion: args.protocol_version,
      requiredCapabilities: args.required_capabilities,
      proposedOperationId: args.proposed_operation_id,
      now: Date.now(),
    }),
});

export const publishReadyBinding = mutation({
  args: {
    conversation_id: v.id("conversations"),
    epoch: v.number(),
    requested_agent: agentClientValidator,
    actual_agent: agentClientValidator,
    transport: transportValidator,
    handle: v.string(),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    runtime_id: v.string(),
    operation_id: v.string(),
    applied_configuration_revision: v.number(),
    protocol_version: v.number(),
    capabilities: v.array(capabilityValidator),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await publishReadyBindingInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      epoch: args.epoch,
      requestedAgent: args.requested_agent,
      actualAgent: args.actual_agent,
      transport: args.transport,
      handle: args.handle,
      ownerDeviceId: args.owner_device_id,
      daemonBootId: args.daemon_boot_id,
      runtimeId: args.runtime_id,
      operationId: args.operation_id,
      appliedConfigurationRevision: args.applied_configuration_revision,
      protocolVersion: args.protocol_version,
      capabilities: args.capabilities,
      now: Date.now(),
    }),
});

const startOutcomeArgs = {
  conversation_id: v.id("conversations"),
  epoch: v.number(),
  owner_device_id: v.string(),
  daemon_boot_id: v.string(),
  configuration_revision: v.number(),
  operation_id: v.string(),
  failure_code: v.string(),
  failure_message: v.string(),
  failure_retryable: v.optional(v.boolean()),
  api_token: v.string(),
};

export const publishStartFailedBeforeEffect = mutation({
  args: startOutcomeArgs,
  handler: async (ctx, args) =>
    await publishStartOutcomeInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      epoch: args.epoch,
      ownerDeviceId: args.owner_device_id,
      daemonBootId: args.daemon_boot_id,
      configurationRevision: args.configuration_revision,
      operationId: args.operation_id,
      failureCode: args.failure_code,
      failureMessage: args.failure_message,
      failureRetryable: args.failure_retryable,
      outcome: "start-failed-before-effect",
      now: Date.now(),
    }),
});

export const publishStartAmbiguous = mutation({
  args: { ...startOutcomeArgs, suspected_runtime_id: v.optional(v.string()) },
  handler: async (ctx, args) =>
    await publishStartOutcomeInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      epoch: args.epoch,
      ownerDeviceId: args.owner_device_id,
      daemonBootId: args.daemon_boot_id,
      configurationRevision: args.configuration_revision,
      operationId: args.operation_id,
      failureCode: args.failure_code,
      failureMessage: args.failure_message,
      failureRetryable: args.failure_retryable,
      suspectedRuntimeId: args.suspected_runtime_id,
      outcome: "start-ambiguous",
      now: Date.now(),
    }),
});

export const disposePreReadyBinding = mutation({
  args: {
    conversation_id: v.id("conversations"),
    epoch: v.number(),
    expected_state: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("start-failed-before-effect"),
      v.literal("start-ambiguous"),
    ),
    configuration_revision: v.number(),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    operation_id: v.optional(v.string()),
    inspection: v.union(
      v.literal("proven-no-effect"),
      v.literal("runtime-quarantined"),
      v.literal("unknown"),
    ),
    suspected_runtime_id: v.optional(v.string()),
    evidence: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await disposePreReadyBindingInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      epoch: args.epoch,
      expectedState: args.expected_state,
      configurationRevision: args.configuration_revision,
      ownerDeviceId: args.owner_device_id,
      daemonBootId: args.daemon_boot_id,
      operationId: args.operation_id,
      inspection: args.inspection,
      suspectedRuntimeId: args.suspected_runtime_id,
      evidence: args.evidence,
      now: Date.now(),
    }),
});

export const claimNextDelivery = mutation({
  args: {
    conversation_id: v.id("conversations"),
    expected_message_id: v.optional(v.id("pending_messages")),
    execution_epoch: v.number(),
    configuration_revision: v.number(),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    runtime_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await claimNextDeliveryInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      expectedMessageId: args.expected_message_id,
      executionEpoch: args.execution_epoch,
      configurationRevision: args.configuration_revision,
      ownerDeviceId: args.owner_device_id,
      daemonBootId: args.daemon_boot_id,
      runtimeId: args.runtime_id,
      now: Date.now(),
    }),
});

export const rejectHeadDelivery = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("pending_messages"),
    delivery_id: v.string(),
    conversation_sequence: v.string(),
    execution_epoch: v.number(),
    reason: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await rejectHeadDeliveryInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      messageId: args.message_id,
      deliveryId: args.delivery_id,
      conversationSequence: sequenceFromWire(args.conversation_sequence),
      executionEpoch: args.execution_epoch,
      reason: args.reason,
      now: Date.now(),
    }),
});

export const startDelivery = mutation({
  args: { permit: permitValidator, api_token: v.string() },
  handler: async (ctx, args) =>
    await startDeliveryInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      ...permitFromWire(args.permit),
      now: Date.now(),
    }),
});

export const releaseClaimBeforeEffect = mutation({
  args: {
    permit: permitValidator,
    reason: v.string(),
    evidence: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await releaseClaimBeforeEffectInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      ...permitFromWire(args.permit),
      reason: args.reason,
      evidence: args.evidence,
      now: Date.now(),
    }),
});

export const completeDelivery = mutation({
  args: {
    permit: permitValidator,
    external_delivery_id: v.optional(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await completeDeliveryInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      ...permitFromWire(args.permit),
      externalDeliveryId: args.external_delivery_id,
      now: Date.now(),
    }),
});

export const failDeliveryBeforeEffect = mutation({
  args: {
    permit: permitValidator,
    failure_code: v.string(),
    failure_message: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await failDeliveryBeforeEffectInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      ...permitFromWire(args.permit),
      failureCode: args.failure_code,
      failureMessage: args.failure_message,
      now: Date.now(),
    }),
});

export const markDeliveryAmbiguous = mutation({
  args: {
    permit: permitValidator,
    failure_code: v.string(),
    failure_message: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await markDeliveryAmbiguousInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      ...permitFromWire(args.permit),
      failureCode: args.failure_code,
      failureMessage: args.failure_message,
      now: Date.now(),
    }),
});

export const resolveAmbiguousDelivery = mutation({
  args: {
    permit: permitValidator,
    resolution: v.union(
      v.literal("correlated-delivered"),
      v.literal("proven-no-effect"),
      v.literal("abandoned-ambiguous"),
    ),
    resolution_evidence: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await resolveAmbiguousDeliveryInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      ...permitFromWire(args.permit),
      resolution: args.resolution,
      resolutionEvidence: args.resolution_evidence,
      now: Date.now(),
    }),
});

export const abandonAmbiguousAndResend = mutation({
  args: {
    permit: permitValidator,
    new_client_id: v.string(),
    resolution_evidence: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await abandonAmbiguousAndResendInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      ...permitFromWire(args.permit),
      newClientId: args.new_client_id,
      resolutionEvidence: args.resolution_evidence,
      now: Date.now(),
    }),
});

export const publishRuntimeDisposition = mutation({
  args: {
    conversation_id: v.id("conversations"),
    epoch: v.number(),
    configuration_revision: v.number(),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    runtime_id: v.string(),
    disposition: v.union(v.literal("stopped"), v.literal("quarantined")),
    reason: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await publishRuntimeDispositionInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      epoch: args.epoch,
      configurationRevision: args.configuration_revision,
      ownerDeviceId: args.owner_device_id,
      daemonBootId: args.daemon_boot_id,
      runtimeId: args.runtime_id,
      disposition: args.disposition,
      reason: args.reason,
      now: Date.now(),
    }),
});

export const activateExecutionSuccessor = mutation({
  args: {
    conversation_id: v.id("conversations"),
    expected_current_epoch: v.number(),
    successor_epoch: v.number(),
    current_configuration_revision: v.number(),
    current_owner_device_id: v.string(),
    current_daemon_boot_id: v.string(),
    current_operation_id: v.optional(v.string()),
    current_runtime_id: v.optional(v.string()),
    successor_configuration_revision: v.number(),
    successor_owner_device_id: v.string(),
    successor_daemon_boot_id: v.string(),
    successor_runtime_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) =>
    await activateExecutionSuccessorInDb(ctx, await authenticateExecutionDaemon(ctx, args.api_token), {
      conversationId: args.conversation_id,
      expectedCurrentEpoch: args.expected_current_epoch,
      successorEpoch: args.successor_epoch,
      currentConfigurationRevision: args.current_configuration_revision,
      currentOwnerDeviceId: args.current_owner_device_id,
      currentDaemonBootId: args.current_daemon_boot_id,
      currentOperationId: args.current_operation_id,
      currentRuntimeId: args.current_runtime_id,
      successorConfigurationRevision: args.successor_configuration_revision,
      successorOwnerDeviceId: args.successor_owner_device_id,
      successorDaemonBootId: args.successor_daemon_boot_id,
      successorRuntimeId: args.successor_runtime_id,
      now: Date.now(),
    }),
});

export const getExecutionAuthority = query({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await authenticateExecutionDaemon(ctx, args.api_token);
    await requireOwnedConversation(ctx, args.conversation_id, userId);
    const head = await executionHead(ctx, args.conversation_id);
    if (!head) return null;
    const bindings = await (ctx.db as any)
      .query("execution_bindings")
      .withIndex("by_conversation_epoch", (q: any) => q.eq("conversation_id", args.conversation_id))
      .collect();
    const activeAttempt = head.active_delivery_attempt_id
      ? await ctx.db.get(head.active_delivery_attempt_id)
      : null;
    return { head, bindings, activeAttempt };
  },
});

function executionRequestWire(binding: any): any {
  return {
    target: {
      conversationId: String(binding.conversation_id),
      epoch: binding.epoch,
      requestedAgent: binding.requested_agent,
      transport: binding.transport,
      projectPath: binding.project_path,
      isolation: wireIsolation(binding.isolation),
    },
    configuration: {
      revision: binding.configuration_revision,
      model: binding.model,
      effort: binding.effort,
    },
    ownerDeviceId: binding.owner_device_id,
    daemonBootId: binding.daemon_boot_id,
    requiredCapabilities: binding.required_capabilities,
    protocolVersion: binding.protocol_version,
    trigger: "recovery" as const,
  };
}

/**
 * Reactive daemon work feed. Query args are an explicit capability handshake,
 * not authority: rows are still fenced to the API-token owner, device, binding
 * boot, epoch and runtime before any mutation can issue a permit.
 */
export const listExecutionWork = query({
  args: {
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    protocol_version: v.number(),
    capabilities: v.array(capabilityValidator),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await authenticateExecutionDaemon(ctx, args.api_token);
    requireNonEmpty(args.owner_device_id, "ownerDeviceId");
    requireNonEmpty(args.daemon_boot_id, "daemonBootId");
    requireProtocolVersion(args.protocol_version);
    requireProtocolCapabilities(args.capabilities);
    const heads = await (ctx.db as any)
      .query("conversation_execution_heads")
      .withIndex("by_owner_state", (q: any) =>
        q.eq("owner_user_id", userId).eq("protocol_state", "fenced"),
      )
      .collect();
    const work: any[] = [];
    for (const head of heads) {
      if (head.protocol_version !== args.protocol_version) {
        fail("EXECUTION_PROTOCOL_VERSION_MISMATCH", "stored head differs from daemon handshake");
      }
      const epochs = [...new Set([head.current_epoch, head.pending_epoch].filter(Number.isSafeInteger))];
      const bindings = [];
      for (const epoch of epochs) {
        const binding = await executionBinding(ctx, head.conversation_id, epoch as number);
        if (!binding || binding.owner_device_id !== args.owner_device_id) continue;
        if (!capabilitiesEqual(binding.required_capabilities ?? [], args.capabilities)) {
          fail("EXECUTION_CAPABILITY_MISMATCH", "stored binding differs from daemon handshake");
        }
        const hasRuntimeEvidence =
          binding.state === "ready" || binding.state === "stopped" || binding.state === "quarantined";
        bindings.push({
          state: binding.state,
          daemonBootMatch: binding.daemon_boot_id === args.daemon_boot_id,
          request: executionRequestWire(binding),
          ...(hasRuntimeEvidence && !binding.pre_ready_disposition
            ? { binding: bindingEvidenceWire(binding) }
            : {}),
        });
      }
      const intent = head.successor_intent;
      const pendingIntent =
        intent?.status === "pending" && intent.owner_device_id === args.owner_device_id
          ? {
              intentId: intent.intent_id,
              expectedCurrentEpoch: intent.expected_current_epoch,
              policy: intent.policy,
              request: {
                target: {
                  conversationId: String(head.conversation_id),
                  epoch: intent.expected_current_epoch + 1,
                  requestedAgent: intent.requested_agent,
                  transport: intent.transport,
                  projectPath: intent.project_path,
                  isolation: wireIsolation(intent.isolation),
                },
                configuration: {
                  revision: intent.configuration_revision,
                  model: intent.model,
                  effort: intent.effort,
                },
                ownerDeviceId: intent.owner_device_id,
                daemonBootId: args.daemon_boot_id,
                requiredCapabilities: intent.required_capabilities,
                protocolVersion: intent.protocol_version,
                trigger: "recovery" as const,
              },
            }
          : undefined;
      if (bindings.length > 0 || pendingIntent) {
        work.push({
          conversationId: String(head.conversation_id),
          currentEpoch: head.current_epoch,
          pendingEpoch: head.pending_epoch,
          pendingPolicy: head.pending_policy,
          bindings,
          pendingIntent,
        });
      }
    }
    return work;
  },
});
