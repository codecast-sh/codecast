// Codecast's retry queue: the generic machine from @platform/cli-kit/retryQueue
// plus the one thing that is ours — the shape of a conversation.
//
// The package owns backoff, the global rate limit hold, bounded concurrency with
// serialization by key, debounced persistence with a synchronous flush on exit,
// error classification, the dropped log with retention, and backoff collapse
// once the backend proves reachable. None of that mentions a conversation.
//
// What stays here is everything that does, wired in through the package's hooks:
//
//   serialKey       one op at a time per conversation ("conv:<id>")
//   onRestore       load-time heal: dedupe by message uuid, split oversized
//                   ops, compact a conversation's backlog into chunks
//   onFailure       split an addMessages op that timed out; drop an op whose
//                   conversation is permanently stale
//   dropContext     name the session in the drop log line
//   droppedFields   keep sessionId/conversationId as columns in the drop file,
//                   which `cast health` reads directly
//   add()           coalesce messages already queued, chunk by count and bytes,
//                   compact the conversation afterwards
//   getHealth()     message and conversation counts on top of the op count
//
// Every exported name keeps the signature it had when this file held the whole
// implementation, so daemon.ts and the tests are unchanged.

import {
  RetryQueue as GenericRetryQueue,
  type RetryOperation as GenericRetryOperation,
  type DroppedOperation as GenericDroppedOperation,
  type LogLevel,
  parseRateLimitDelay,
} from "@platform/cli-kit/retryQueue";
import { SHUTDOWN_FLUSH_MS } from "./shutdownBudget.js";

export { parseRateLimitDelay };
export type { LogLevel };

export type RetryOperationType = "createConversation" | "addMessage" | "addMessages" | "updateSessionId";

export interface RetryOperation extends GenericRetryOperation<Record<string, unknown>> {
  type: RetryOperationType;
}

export interface DroppedOperation extends GenericDroppedOperation<Record<string, unknown>> {
  type: RetryOperationType;
  sessionId?: string;
  conversationId?: string;
}

export interface RetryQueueConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  concurrency?: number;
  persistPath?: string;
  droppedPath?: string;
  /** Debounce window (ms) before coalesced mutations are written to disk. */
  persistDebounceMs?: number;
  onLog?: (message: string, level?: LogLevel) => void;
  // Fired when the queue grows (an op is enqueued). Lets the daemon refresh its
  // persisted health snapshot as backlog ACCUMULATES, not only when it drains —
  // otherwise `cast status` reads a success-only snapshot and prints "Queue:
  // empty" while messages pile into the queue. The drain side already refreshes
  // via the executor, so this hook only needs to cover enqueue.
  onEnqueue?: () => void;
}

// Match the Convex addMessages sub-batch size in syncService. Queueing a
// 5000-message blob as a single retry op meant every retry had to complete
// 200 sub-batches in serial within one mutation budget — any single
// sub-batch hitting the 60s timeout aborted the whole op, and the same
// blob got re-queued forever, jamming the concurrency=5 slots.
const RETRY_BATCH_CHUNK = 25;
const RETRY_BATCH_MAX_BYTES = 900_000;

function chunkRetryMessages<T>(
  messages: T[],
  maxCount: number = RETRY_BATCH_CHUNK,
  maxBytes: number = RETRY_BATCH_MAX_BYTES,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const msg of messages) {
    const bytes = Buffer.byteLength(JSON.stringify(msg));
    if (current.length > 0 && (current.length >= maxCount || currentBytes + bytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(msg);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Drop keys whose value is undefined, so they don't overwrite a default. */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const messageUuidOf = (msg: unknown): string | undefined =>
  msg && typeof msg === "object" ? (msg as { messageUuid?: string }).messageUuid : undefined;

const conversationIdOf = (op: { params: Record<string, unknown> }): string | null =>
  typeof op.params.conversationId === "string" ? op.params.conversationId : null;

const isAddMessagesFor = (op: RetryOperation, conversationId: string): boolean =>
  op.type === "addMessages" && op.params.conversationId === conversationId;

// Errors that mean the cached conversation_id is permanently invalid against the
// current api_token. Retrying with the same params will fail forever — the only
// recovery is for the caller to re-resolve the conversation (which happens on the
// next processSessionFile pass once the local conversation cache is dropped).
function isStaleConversationError(error: string): boolean {
  return error.includes("Conversation not found") ||
    error.includes("Unauthorized: can only add messages to your own conversations");
}

/**
 * Merge the given addMessages ops for one conversation into a single ordered,
 * de-duplicated message list and re-chunk it. Returns null when there is
 * nothing to merge; the caller decides which ops are eligible.
 */
function compactConversation(
  ops: RetryOperation[],
  conversationId: string,
  maxCount: number,
): { removeIds: string[]; replacements: RetryOperation[] } | null {
  if (ops.length <= 1) return null;

  const ordered = [...ops].sort((a, b) => a.createdAt - b.createdAt);
  const mergedMessages: unknown[] = [];
  const seen = new Set<string>();
  let attempts = 0;
  let createdAt = Date.now();
  let nextRetryAt = Date.now() + 1000;
  let lastError: string | undefined;

  for (const op of ordered) {
    attempts = Math.max(attempts, op.attempts);
    createdAt = Math.min(createdAt, op.createdAt);
    nextRetryAt = Math.min(nextRetryAt, op.nextRetryAt);
    if (op.lastError) lastError = op.lastError;
    const msgs = Array.isArray(op.params.messages) ? op.params.messages : [];
    for (const msg of msgs) {
      const uuid = messageUuidOf(msg);
      if (uuid) {
        if (seen.has(uuid)) continue;
        seen.add(uuid);
      }
      mergedMessages.push(msg);
    }
  }

  const chunks = chunkRetryMessages(mergedMessages, maxCount);
  const replacements = chunks.map((chunk, i) => ({
    id: `addMessages-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-c${i}`,
    type: "addMessages" as const,
    params: { conversationId, messages: chunk },
    attempts,
    nextRetryAt,
    createdAt,
    lastError,
  }));
  return { removeIds: ops.map((op) => op.id), replacements };
}

/**
 * Heal the queue read back from disk. A queue that jammed (e.g. an image batch
 * stuck under OCC contention) accumulates the SAME messages many times over as
 * the live path re-enqueues the backlog each poll — so a 16MB, 283-op file
 * collapses to its distinct messages on restart instead of draining the
 * duplicates one slow op at a time. Oversized ops are split so each fits a
 * single mutation budget and can't jam a concurrency slot.
 */
function healRestoredOperations(
  ops: RetryOperation[],
  log: (message: string, level?: LogLevel) => void,
): { ops: RetryOperation[]; changed: boolean } {
  let splitFrom = 0;
  let dedupedMsgs = 0;
  const kept: RetryOperation[] = [];
  const seenByConv = new Map<string, Set<string>>();

  for (const op of ops) {
    if (op.type === "addMessages" && Array.isArray(op.params?.messages)) {
      const convId = conversationIdOf(op);
      if (convId) {
        let seen = seenByConv.get(convId);
        if (!seen) { seen = new Set(); seenByConv.set(convId, seen); }
        const before = op.params.messages.length;
        const survivors = (op.params.messages as unknown[]).filter((m) => {
          const uuid = messageUuidOf(m);
          if (!uuid) return true; // can't dedup without a uuid — keep it
          if (seen!.has(uuid)) return false;
          seen!.add(uuid);
          return true;
        });
        dedupedMsgs += before - survivors.length;
        if (survivors.length === 0) continue; // every message already restored elsewhere
        op.params = { ...op.params, messages: survivors };
      }

      // Split children inherit the parent's attempts so genuinely-failing ops
      // still age toward drop.
      const chunks = chunkRetryMessages(op.params.messages as unknown[]);
      if (chunks.length > 1) {
        splitFrom++;
        for (let i = 0; i < chunks.length; i++) {
          kept.push({
            id: `${op.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-c${i}`,
            type: op.type,
            params: { ...op.params, messages: chunks[i] },
            attempts: op.attempts ?? 0,
            nextRetryAt: Date.now() + 1000,
            createdAt: op.createdAt ?? Date.now(),
            lastError: op.lastError,
          });
        }
        continue;
      }
    }
    kept.push(op);
  }

  const preCompact = kept.length;
  let healed = kept;
  for (const convId of seenByConv.keys()) {
    const matching = healed.filter((op) => isAddMessagesFor(op, convId));
    const compacted = compactConversation(matching, convId, RETRY_BATCH_CHUNK);
    if (!compacted) continue;
    const removed = new Set(compacted.removeIds);
    healed = [...healed.filter((op) => !removed.has(op.id)), ...compacted.replacements];
  }
  const compactedOps = preCompact - healed.length;

  const heals = [
    splitFrom > 0 ? `split ${splitFrom} oversized` : "",
    dedupedMsgs > 0 ? `deduped ${dedupedMsgs} duplicate msgs` : "",
    compactedOps > 0 ? `compacted ${compactedOps} ops` : "",
  ].filter(Boolean).join(", ");
  if (heals) log(`Healed the persisted queue: ${heals}`);
  return { ops: healed, changed: heals.length > 0 };
}


type GenericQueue = GenericRetryQueue<Record<string, unknown>>;

const chunkLimitFor = (limits: Map<string, number>, conversationId: string | null): number =>
  (conversationId ? limits.get(conversationId) : undefined) ?? RETRY_BATCH_CHUNK;

/** Merge a conversation's queued backlog, leaving any in-flight op alone: that
 *  op is being executed right now, so rewriting it would race the executor. */
function compactQueuedConversation(queue: GenericQueue, conversationId: string, limits: Map<string, number>): void {
  const matching = (queue.getPendingOperations() as RetryOperation[]).filter(
    (op) => isAddMessagesFor(op, conversationId) && !queue.isActive(op.id),
  );
  const compacted = compactConversation(matching, conversationId, chunkLimitFor(limits, conversationId));
  if (compacted) queue.replace(compacted.removeIds, compacted.replacements);
}

/**
 * A batch that times out is too big for one mutation budget. Halve it, learn a
 * smaller ceiling for this conversation, and retry the halves instead of the
 * same payload forever.
 */
function splitTimedOutAddMessages(
  queue: GenericQueue,
  op: RetryOperation,
  limits: Map<string, number>,
  log: (message: string, level?: LogLevel) => void,
): boolean {
  if (op.type !== "addMessages") return false;
  const conversationId = conversationIdOf(op);
  const msgs = Array.isArray(op.params.messages) ? op.params.messages : [];
  if (!conversationId || msgs.length <= 1) return false;

  const mid = Math.ceil(msgs.length / 2);
  const nextLimit = Math.max(1, mid);
  if (nextLimit < chunkLimitFor(limits, conversationId)) limits.set(conversationId, nextLimit);

  const halves = [msgs.slice(0, mid), msgs.slice(mid)].filter((chunk) => chunk.length > 0);
  queue.replace(
    [op.id],
    halves.map((half, i) => ({
      id: `${op.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-s${i}`,
      type: op.type,
      params: { ...op.params, messages: half },
      attempts: op.attempts,
      nextRetryAt: Date.now() + 1000,
      createdAt: op.createdAt,
      lastError: op.lastError,
    })),
  );
  compactQueuedConversation(queue, conversationId, limits);
  log(
    `Split timed-out addMessages retry for ${conversationId} from ${msgs.length} msgs into ${halves.map((h) => h.length).join("+")} (new limit ${chunkLimitFor(limits, conversationId)})`,
  );
  return true;
}

/**
 * The queue the daemon uses. A facade over the package's queue: the generic
 * machine does the work, this class carries the conversation shape and exposes
 * exactly the surface codecast calls.
 */
export class RetryQueue {
  private readonly queue: GenericQueue;
  /** Per-conversation chunk ceiling, lowered each time a batch times out. */
  private readonly conversationChunkLimits = new Map<string, number>();
  private readonly log: (message: string, level?: LogLevel) => void;

  constructor(config: RetryQueueConfig = {}) {
    const limits = this.conversationChunkLimits;
    const log = (this.log = config.onLog ?? (() => {}));
    // The package's constructor loads the persisted queue, so `onRestore` runs
    // before this one returns. Nothing it needs may live on `this`.
    let healedInPlace = false;

    this.queue = new GenericRetryQueue<Record<string, unknown>>({
      // Only the keys the caller actually set: the package fills its defaults by
      // spreading over them, and an explicit `undefined` would erase one.
      ...definedOnly(config),
      // Ops carrying a conversationId share a key (so they run one at a time);
      // ops without one stay fully parallel. The server addMessages mutation
      // reads+patches the conversation doc, so parallel ops for one conversation
      // collide on that hot doc → OCC retries → 60s timeouts → re-queue → worse
      // contention. That self-inflicted stampede turned one slow image batch
      // into a permanent 283-op stall.
      serialKey: (op) => {
        const convId = conversationIdOf(op);
        return convId ? `conv:${convId}` : null;
      },
      onRestore: (ops) => {
        const healed = healRestoredOperations(ops as RetryOperation[], log);
        // The package rewrites disk itself when the op COUNT changed. A dedupe
        // inside one op shrinks the file without changing the count, and it
        // cannot see that — so remember it and rewrite below. A restart must
        // see the collapsed file, not the bloat it just healed.
        healedInPlace = healed.changed && healed.ops.length === ops.length;
        return healed.ops;
      },
      onFailure: (op, error, queue) => {
        if (error.includes("timed out after") && splitTimedOutAddMessages(queue, op as RetryOperation, limits, log)) {
          return true;
        }
        if (isStaleConversationError(error)) {
          queue.drop(
            op,
            `DROPPED ${op.type}: stale conversation ${op.params.conversationId || "unknown"} (${error}). Will re-resolve on next sync.`,
            "warn",
          );
          return true;
        }
        return false;
      },
      dropContext: (op) => `. Session: ${op.params.sessionId || "unknown"}`,
      droppedFields: (op) => ({
        sessionId: op.params.sessionId as string | undefined,
        conversationId: op.params.conversationId as string | undefined,
      }),
    });

    if (healedInPlace) this.queue.persistNow({ sync: true });
  }

  // All message_uuids currently queued (pending or in-flight — failed in-flight
  // ops stay in the queue until they succeed) for a conversation.
  private pendingMessageUuids(conversationId: string): Set<string> {
    const uuids = new Set<string>();
    for (const op of this.getPendingOperations()) {
      if (!isAddMessagesFor(op, conversationId)) continue;
      const msgs = op.params.messages;
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        const uuid = messageUuidOf(m);
        if (uuid) uuids.add(uuid);
      }
    }
    return uuids;
  }

  add(type: RetryOperationType, params: Record<string, unknown>, error?: string): string {
    if (type !== "addMessages") return this.queue.add(type, params, error);

    let msgs = (params as { messages?: unknown[] }).messages;
    const conversationId = (params as { conversationId?: string }).conversationId;

    // Coalesce: drop messages already waiting in the queue for this conversation.
    // The live sync path re-reads and re-enqueues the same backlog every poll
    // while a batch is stuck, so without this the queue piles up the same
    // messages 12x. Server-side addMessages dedups by message_uuid anyway, so
    // dropping already-queued uuids here is purely a queue-size guard.
    if (Array.isArray(msgs) && typeof conversationId === "string") {
      const pending = this.pendingMessageUuids(conversationId);
      if (pending.size > 0) {
        const before = msgs.length;
        msgs = msgs.filter((m) => !pending.has(messageUuidOf(m) ?? ""));
        if (msgs.length === 0) {
          this.log(`Coalesced addMessages: all ${before} msgs already queued for ${conversationId}, skipping`);
          return "";
        }
        if (msgs.length < before) {
          this.log(`Coalesced addMessages: dropped ${before - msgs.length}/${before} already-queued msgs for ${conversationId}`);
        }
        params = { ...params, messages: msgs };
      }
    }

    const msgArr: unknown[] = Array.isArray(msgs) ? msgs : [];
    const chunks = Array.isArray(msgs)
      ? chunkRetryMessages(msgArr, chunkLimitFor(this.conversationChunkLimits, conversationId ?? null))
      : [];

    if (chunks.length > 1) {
      const ids = chunks.map((chunk) => this.queue.add(type, { ...params, messages: chunk }, error));
      if (typeof conversationId === "string") {
        compactQueuedConversation(this.queue, conversationId, this.conversationChunkLimits);
        this.queue.persistNow();
      }
      this.log(`Split oversized addMessages (${msgArr.length} msgs) into ${ids.length} retry chunks`);
      return ids[0] ?? "";
    }

    const id = this.queue.add(type, params, error);
    if (typeof conversationId === "string") {
      compactQueuedConversation(this.queue, conversationId, this.conversationChunkLimits);
      this.queue.persistNow();
    }
    return id;
  }

  setExecutor(executor: (op: RetryOperation) => Promise<boolean>): void {
    this.queue.setExecutor(executor as (op: GenericRetryOperation<Record<string, unknown>>) => Promise<boolean>);
  }

  start(): void {
    this.queue.start();
  }

  stop(): void {
    this.queue.stop();
  }

  clear(): void {
    this.queue.clear();
  }

  notifyConnectionRestored(): void {
    this.queue.notifyConnectionRestored();
  }

  /** Flush the queue to disk on demand. Used after an executor mutates an op's
   *  params in place (e.g. offloading image base64 → storageId) so the shrunk
   *  payload survives a restart and isn't re-processed as raw base64. */
  persistNow(opts: { sync?: boolean } = {}): void {
    this.queue.persistNow(opts);
  }

  getQueueSize(): number {
    return this.queue.getQueueSize();
  }

  getPendingOperations(): RetryOperation[] {
    return this.queue.getPendingOperations() as RetryOperation[];
  }

  getDroppedOperationCount(): number {
    return this.queue.getDroppedOperationCount();
  }

  getDroppedOperations(): DroppedOperation[] {
    return this.queue.getDroppedOperations() as DroppedOperation[];
  }

  clearDroppedOperations(): void {
    this.queue.clearDroppedOperations();
  }

  waitForCompletion(timeoutMs: number = 10000): Promise<boolean> {
    return this.queue.waitForCompletion(timeoutMs);
  }

  hasPendingConversation(conversationId: string): boolean {
    return this.queue.hasPending((op) => op.params.conversationId === conversationId);
  }

  getLogicalQueueSize(): number {
    let count = 0;
    const pendingAddMessagesConversations = new Set<string>();
    for (const op of this.getPendingOperations()) {
      if (op.type === "addMessages" && typeof op.params.conversationId === "string") {
        pendingAddMessagesConversations.add(op.params.conversationId);
        continue;
      }
      count++;
    }
    return count + pendingAddMessagesConversations.size;
  }

  // Live sync-backlog snapshot for `cast status` and the heartbeat. The point is
  // to make "synced" stop lying while data sits in the queue, so it reports what
  // a human needs to gauge how far behind we are:
  //   - ops:           queued retry operations (raw work units)
  //   - pending:       logical size (per-conversation for addMessages) — kept for
  //                    back-compat with the existing heartbeat field
  //   - messages:      total messages waiting across all addMessages ops
  //   - conversations: distinct conversations with any queued work
  //   - oldestPendingMs: age of the longest-waiting op = how far behind we are
  // One pass over the queued ops (not the messages on disk), so it stays cheap
  // enough to call on every heartbeat across 100+ sessions.
  getHealth(): {
    ops: number;
    pending: number;
    messages: number;
    conversations: number;
    oldestPendingMs: number;
  } {
    const now = Date.now();
    let oldestPendingMs = 0;
    let messages = 0;
    const conversations = new Set<string>();
    const addMessagesConversations = new Set<string>();
    let nonAddMessagesOps = 0;
    const ops = this.getPendingOperations();
    for (const op of ops) {
      const age = now - op.createdAt;
      if (age > oldestPendingMs) oldestPendingMs = age;
      const convId = conversationIdOf(op);
      if (convId) conversations.add(convId);
      if (op.type === "addMessages" && Array.isArray(op.params.messages)) {
        messages += op.params.messages.length;
        if (convId) addMessagesConversations.add(convId);
        else nonAddMessagesOps++;
      } else {
        nonAddMessagesOps++;
      }
    }
    return {
      ops: ops.length,
      // Logical size mirrors getLogicalQueueSize without a second pass.
      pending: addMessagesConversations.size + nonAddMessagesOps,
      messages,
      conversations: conversations.size,
      oldestPendingMs,
    };
  }
}

/** How long shutdown waits for the queue to drain before giving up on it.
 *  Defined next to the stop deadline it has to fit inside. */
export { SHUTDOWN_FLUSH_MS };

/** The slice of the queue a shutdown flush touches. Narrow on purpose so a
 *  test can hand this function a plain object. */
export interface ShutdownFlushable {
  getQueueSize(): number;
  notifyConnectionRestored(): void;
  persistNow(opts?: { sync?: boolean }): void;
}

/**
 * Drain the retry queue on the way out instead of abandoning it.
 *
 * The old shutdown logged "Dropping N pending retry operations", which was
 * never true: the generic queue flushes to disk on process exit, so the ops
 * came back on the next boot. What was actually lost is time. Every queued
 * message waited out a whole daemon restart before its first retry. Pulling
 * the retries forward and giving them a few seconds delivers most of them now.
 *
 * The budget is bounded so nothing outside ends shutdown for us. It has to fit
 * under two deadlines, and the tighter one is the caller's: `cast stop` sends
 * SIGKILL DAEMON_STOP_SIGKILL_MS after its SIGTERM, and the daemon's own hard
 * exit is 15s. Whatever is left is persisted synchronously and returned.
 */
export async function flushRetryQueueForShutdown(
  queue: ShutdownFlushable,
  timeoutMs = SHUTDOWN_FLUSH_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  if (queue.getQueueSize() === 0) return 0;
  // Pulls every nextRetryAt to now and schedules the check that runs them.
  queue.notifyConnectionRestored();
  const pollMs = 100;
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    if (queue.getQueueSize() === 0) break;
  }
  const remaining = queue.getQueueSize();
  queue.persistNow({ sync: true });
  return remaining;
}
