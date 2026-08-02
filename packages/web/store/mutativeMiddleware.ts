import { create as mutativeCreate, type Patch } from "mutative";
import {
  DISPATCH_FIELD_TABLE_MAP,
  DISPATCH_TABLE_MAP,
  isProtectedSyncCollection,
} from "./clientSyncRegistry";
import { consumeViewNav, noteViewNavApplied, recordNavEvent } from "./viewNav";
import {
  isPrincipalDispatchAuthorizationCurrent,
  type DispatchAuthorizationCapture,
} from "./local-first/dispatchGate";
import { isLocalFirstWriteEnabled } from "./local-first/featureFlags";
import { assertDurableOfflineWriteCapability } from "./local-first/storagePersistence";

type DispatchFn = (action: string, args: any, patches?: any, result?: any) => Promise<any>;
type MaybePromise<T> = T | Promise<T>;
type IDBWriteFn = (patches: Patch[], state: any) => MaybePromise<void>;
type OutboxEntry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
  attempts?: number;
  operationSchemaVersion?: number;
};
type OutboxEnqueueFn = (entry: OutboxEntry) => MaybePromise<void>;
type OutboxRemoveFn = (id: string) => MaybePromise<void>;
type OutboxLoadFn = () => Promise<OutboxEntry[]>;
type DispatchBinding = {
  epoch: number;
  fn: DispatchFn;
  owner?: object;
  authorization?: DispatchAuthorizationCapture;
};
type ReceiptWaiter = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export class StaleDispatchBindingError extends Error {
  constructor() {
    super("Dispatch binding changed while work was in flight");
    this.name = "StaleDispatchBindingError";
  }
}

export class CommandReceiptRejectedError extends Error {
  readonly code: string;
  readonly correction?: unknown;

  constructor(rejection: { code: string; message: string; correction?: unknown }) {
    super(rejection.message);
    this.name = "CommandReceiptRejectedError";
    this.code = rejection.code;
    this.correction = rejection.correction;
  }
}

// An asyncAction fired while no dispatch binding exists. `parked: true` means
// the write is durably queued in the outbox and WILL deliver on the next drain
// — callers should treat that as "pending", not "failed" (don't revert local
// state, don't toast). `parked: false` means the write is genuinely gone.
export class DispatchNotWiredError extends Error {
  parked: boolean;
  constructor(action: string, parked: boolean) {
    super(
      parked
        ? `Dispatch not wired — "${action}" parked for later delivery`
        : `Dispatch not wired — "${action}" was dropped (no outbox)`,
    );
    this.name = "DispatchNotWiredError";
    this.parked = parked;
  }
}

export function isParkedDispatchError(error: unknown): error is DispatchNotWiredError {
  return error instanceof DispatchNotWiredError && error.parked;
}

function isBrowserEventLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const EventCtor = typeof Event === "function" ? Event : null;
  if (EventCtor && value instanceof EventCtor) return true;
  const nativeEvent = (value as { nativeEvent?: unknown }).nativeEvent;
  return !!EventCtor && nativeEvent instanceof EventCtor;
}

// React passes its event object into a directly-bound callback even when that
// callback declares no arguments. For local actions that is harmless to the
// action body, but the middleware also persists invocation args in IndexedDB;
// a SyntheticEvent's nested PointerEvent is not structured-cloneable. Normalize
// only this provably-extraneous shape. Parameterized actions keep their exact
// args, so no business input is truncated based on Function.length.
function normalizeZeroArgumentEventCall(fn: Function, args: any[]): any[] {
  return fn.length === 0 && args.length === 1 && isBrowserEventLike(args[0])
    ? []
    : args;
}

const ACTION_FLAG = Symbol("action");
const ASYNC_ACTION_FLAG = Symbol("asyncAction");
const RECEIPT_ASYNC_ACTION_FLAG = Symbol("receiptAsyncAction");
const SYNC_FLAG = Symbol("sync");

type ReceiptActionEnvelope = {
  receiptActionVersion: 1;
  commandId: string;
  localResult?: unknown;
};

export type DurableCreateContinuation =
  | { version: 1; kind: "navigate" }
  | { version: 1; kind: "assignBucket"; conversationIds: string[] };

type PublicCommandReceipt = {
  commandId: string;
  status: "acknowledged" | "rejected";
  result?: unknown;
  rejection?: { code: string; message: string; correction?: unknown };
};

export function action<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ACTION_FLAG] = true;
  return fn;
}

/** Like action(), but returns a Promise that resolves to the server dispatch result. */
export function asyncAction<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ASYNC_ACTION_FLAG] = true;
  return fn;
}

/**
 * A result-dependent, server-deduplicated action. Unlike ordinary asyncAction,
 * an unwired call remains pending while its durable outbox entry waits for a
 * dispatch binding. The exact command id is persisted with that entry, and the
 * original promise resolves from the durable server receipt after replay.
 */
export function receiptAsyncAction<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ASYNC_ACTION_FLAG] = true;
  (fn as any)[RECEIPT_ASYNC_ACTION_FLAG] = true;
  return fn;
}

export function sync<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[SYNC_FLAG] = true;
  return fn;
}

function isAction(fn: any): boolean {
  return typeof fn === "function" && fn[ACTION_FLAG] === true;
}

function isAsyncAction(fn: any): boolean {
  return typeof fn === "function" && fn[ASYNC_ACTION_FLAG] === true;
}

function isReceiptAsyncAction(fn: any): boolean {
  return typeof fn === "function" && fn[RECEIPT_ASYNC_ACTION_FLAG] === true;
}

function isSync(fn: any): boolean {
  return typeof fn === "function" && fn[SYNC_FLAG] === true;
}

const TABLE_MAP = DISPATCH_TABLE_MAP;
const FIELD_TO_TABLE = DISPATCH_FIELD_TABLE_MAP;



const SINGLETON_KEY = "_";

// Convex document ids are 32-char base32. Stub/local ids (e.g. fresh sessions
// before server assignment) are shorter and would crash applyPatches server-side.
const CONVEX_ID_RE = /^[a-z0-9]{32}$/;

function setNested(obj: any, path: (string | number)[], value: any): any {
  if (path.length === 0) return value;
  const result = typeof obj === "object" && obj !== null ? { ...obj } : {};
  const [head, ...tail] = path;
  result[head] = setNested(result[head], tail, value);
  return result;
}

/**
 * Scan mutative patches from an action() and auto-generate pending entries
 * for synced collections. Returns null if no pending changes needed.
 */
function generateAutoPending(
  patches: Patch[],
  currentPending: Record<string, any>,
): Record<string, any> | null {
  let result: Record<string, any> | null = null;
  const now = Date.now();

  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length < 2) continue;

    const storeKey = String(path[0]);
    if (storeKey === "pending" || !isProtectedSyncCollection(storeKey)) continue;

    const recordId = String(path[1]);

    if (patch.op === "remove" && path.length === 2) {
      // Record deleted from collection → exclude from server sync
      if (!result) result = { ...currentPending };
      result[`${storeKey}:${recordId}`] = { type: "exclude", ts: now };
    } else if (patch.op === "add" && path.length === 2) {
      // Record added to collection → include (keep until server acknowledges)
      if (!result) result = { ...currentPending };
      result[`${storeKey}:${recordId}`] = { type: "include", ts: now };
    } else if ((patch.op === "replace" || patch.op === "add" || patch.op === "remove") && path.length >= 3) {
      // Field modified (or cleared — remove op) on a collection record →
      // protect field value; a cleared field protects as undefined, which
      // matches the server echo once the null tombstone lands.
      const field = String(path[2]);
      if (!result) result = { ...currentPending };
      result[`${storeKey}:${recordId}:${field}`] = {
        type: "field",
        value: patch.value,
        ts: now,
      };
    }
  }

  return result;
}

export function groupPatchesByTable(
  patches: Patch[],
  state?: any,
): Record<string, Record<string, Record<string, any>>> {
  const result: Record<string, Record<string, Record<string, any>>> = {};

  for (const patch of patches) {
    if (patch.op !== "replace" && patch.op !== "add" && patch.op !== "remove") continue;
    const path = patch.path as (string | number)[];
    if (path.length < 1) continue;

    // A cleared field must reach the server as an explicit null tombstone:
    // mutative encodes `obj.f = undefined` as replace-with-undefined and
    // `delete obj.f` as a remove op, and sanitizeForConvex drops undefined
    // keys from the payload — without the null, the clear silently never
    // syncs (the server-side applyPatches turns null into a field removal).
    // Field-level removes pass the op gate above; record-level removes
    // (collection path.length === 2) still fall out at the length checks.
    const value = patch.value === undefined ? null : patch.value;

    const storeKey = String(path[0]);

    const fieldMapping = FIELD_TO_TABLE[storeKey];
    if (fieldMapping && state) {
      result[fieldMapping.table] ??= {};
      result[fieldMapping.table][SINGLETON_KEY] ??= {};
      result[fieldMapping.table][SINGLETON_KEY][storeKey] = state[storeKey] === undefined ? null : state[storeKey];
      continue;
    }

    if (path.length < 2) continue;
    const mapping = TABLE_MAP[storeKey];
    if (!mapping) continue;

    const { table, kind } = mapping;
    result[table] ??= {};

    if (kind === "collection") {
      if (path.length < 3) continue;
      const docId = String(path[1]);
      // Skip stub ids — server can't act on them. Once the session is rekeyed
      // to its real Convex id, subsequent patches will dispatch normally.
      if (!CONVEX_ID_RE.test(docId)) continue;
      const field = String(path[2]);
      if (mapping.fields && !mapping.fields.includes(field)) continue;
      const nested = path.slice(3);

      result[table][docId] ??= {};
      if (nested.length === 0) {
        result[table][docId][field] = value;
      } else {
        result[table][docId][field] = setNested(
          result[table][docId][field] ?? {},
          nested,
          value
        );
      }
    } else {
      const field = String(path[1]);
      const nested = path.slice(2);

      result[table][SINGLETON_KEY] ??= {};
      if (nested.length === 0) {
        result[table][SINGLETON_KEY][field] = value;
      } else {
        result[table][SINGLETON_KEY][field] = setNested(
          result[table][SINGLETON_KEY][field] ?? {},
          nested,
          value
        );
      }
    }
  }

  return result;
}

// A replayed dispatch is stale by definition — it survived a reload. The
// conversation pointer means "where the user is right now", so re-pushing an
// old value from the outbox would repoint the user's other clients at a
// position they already left. Drop it from replays; the rest of the patch
// (and the action itself) still re-fires.
export function stripStalePointerFromReplay(patches: any): any {
  const cs = patches?.client_state?.[SINGLETON_KEY];
  if (!cs || typeof cs !== "object" || !("current_conversation_id" in cs)) return patches;
  const { current_conversation_id: _omit, ...rest } = cs;
  if (Object.keys(rest).length > 0) {
    return { ...patches, client_state: { ...patches.client_state, [SINGLETON_KEY]: rest } };
  }
  const { [SINGLETON_KEY]: _doc, ...otherDocs } = patches.client_state;
  const { client_state: _table, ...otherTables } = patches;
  if (Object.keys(otherDocs).length > 0) {
    return { ...otherTables, client_state: otherDocs };
  }
  return Object.keys(otherTables).length > 0 ? otherTables : undefined;
}

const RETRY_DELAYS = [1000, 2000, 4000];

// A rejection from the Convex client means the backend ANSWERED — network
// drops never reject (the WS client re-queues those internally across
// reconnects). Answers split two ways:
//  - the function itself threw ("Uncaught Error: …" / "Uncaught ConvexError: …")
//    or the args failed validation ("ArgumentValidationError"): deterministic —
//    replaying the identical payload can only fail the identical way, so the
//    retry ladder and the outbox re-drives just multiply the same refusal.
//  - backend system errors ("Your request timed out…", "Try again later"):
//    transient overload, carry neither marker, and stay retryable.
export function isPermanentDispatchError(error: unknown): boolean {
  if (error instanceof CommandReceiptRejectedError) return true;
  const msg = String((error as { message?: unknown })?.message ?? error ?? "");
  return /\bUncaught\b|ArgumentValidationError|Could not find public function/.test(msg);
}

// How many boots a failed outbox entry survives before it's given up on.
// Each boot attempt already runs the full in-session retry ladder, so this
// bounds permanently-broken dispatches (they'd otherwise slow every page
// load forever) while letting writes stranded by an outage outlive reloads
// that happen during that same outage.
export const MAX_OUTBOX_BOOT_ATTEMPTS = 5;

// Actions carrying user-authored content that MUST reach the server — losing
// one silently drops something the user typed. These are never given up on:
// they ride the outbox until the server acknowledges them, however many
// reloads/outages that takes. The boot cap above only bounds low-stakes
// bookkeeping writes (dismiss, client_state) whose loss is recoverable and
// which must not slow every page load forever if permanently broken.
// dispatch.sendMessage dedups on client_id, so unbounded retry is safe.
export const MUST_DELIVER_ACTIONS = new Set([
  "sendMessage",
  "addComment",
  "editComment",
  "deleteComment",
  "askAgentInThread",
]);

// Fork creates ride convCommand, so the action name alone can't mark them —
// but they carry the same "user-authored intent" stakes as a send: giving one
// up silently strands a fork stub the user is already working in. Safe to
// retry forever: forkFromMessage dedups on session_id.
export function isMustDeliverEntry(entry: OutboxEntry): boolean {
  if (MUST_DELIVER_ACTIONS.has(entry.action)) return true;
  if (isReceiptActionEnvelope(entry.result)) return true;
  return entry.action === "convCommand" && Array.isArray(entry.args) && entry.args[1] === "forkFromMessage";
}

// What to do with an outbox entry whose boot-time replay failed: keep it for
// the next boot with the attempt counted, or give up at the cap. User sends
// and fork creates are never dropped — see isMustDeliverEntry.
export function outboxFailureDisposition(entry: OutboxEntry): { keep: boolean; entry: OutboxEntry } {
  const attempts = (entry.attempts ?? 0) + 1;
  return { keep: isMustDeliverEntry(entry) || attempts < MAX_OUTBOX_BOOT_ATTEMPTS, entry: { ...entry, attempts } };
}

function isReceiptActionEnvelope(value: unknown): value is ReceiptActionEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReceiptActionEnvelope>;
  return candidate.receiptActionVersion === 1 &&
    typeof candidate.commandId === "string" &&
    candidate.commandId.length > 0;
}

function unwrapReceiptActionResponse(
  envelope: ReceiptActionEnvelope,
  response: unknown,
): unknown {
  if (!response || typeof response !== "object") {
    throw new Error("Receipt-aware dispatch returned no command receipt");
  }
  const receipt = response as Partial<PublicCommandReceipt>;
  if (receipt.commandId !== envelope.commandId) {
    throw new Error("Receipt-aware dispatch returned a mismatched command receipt");
  }
  if (receipt.status === "rejected") {
    if (!receipt.rejection?.code || !receipt.rejection.message) {
      throw new Error("Rejected command receipt is missing rejection details");
    }
    throw new CommandReceiptRejectedError(receipt.rejection);
  }
  if (receipt.status !== "acknowledged") {
    throw new Error("Receipt-aware dispatch returned an invalid command status");
  }
  return receipt.result;
}

const LEGACY_RECEIPT_ACTIONS = new Set([
  "addComment",
  "editComment",
  "deleteComment",
  "askAgentInThread",
]);

/** Slices governed by the combined read/write rollback rail. */
export const LOCAL_FIRST_WRITE_ACTIONS = new Set([
  "createBucket",
  "updateBucket",
  "assignSessionToBucket",
  "addComment",
  "editComment",
  "deleteComment",
  "askAgentInThread",
  "sendMessage",
]);

// Actions promoted to receipt envelopes BY the final-mode release. With the
// write master off they demote to their pre-release fire-and-forget action()
// semantics, so the rollback posture is exactly the last shipped prod build.
// The other receipt actions (comments, createBucket, create*) shipped
// envelope-backed long before final mode and keep their envelopes in BOTH
// postures — regressing them on rollback would drop the receipt-rejection
// reconciliation that is already load-bearing in production.
export const FLAG_PROMOTED_RECEIPT_ACTIONS = new Set([
  "updateBucket",
  "assignSessionToBucket",
  "sendMessage",
]);

export const CURRENT_OUTBOX_OPERATION_SCHEMA_VERSION = 1;

export class UnsupportedOutboxOperationSchemaError extends Error {
  constructor(readonly entryId: string, readonly schemaVersion: number) {
    super(`Outbox ${entryId} uses unsupported operation schema ${schemaVersion}`);
    this.name = "UnsupportedOutboxOperationSchemaError";
  }
}

function assertSupportedOutboxOperationSchema(entry: OutboxEntry): void {
  // Version 0 is the explicitly supported migration route for rows written
  // before the field existed. Version 1 is the concrete current shape.
  const version = entry.operationSchemaVersion ?? 0;
  if (version !== 0 && version !== CURRENT_OUTBOX_OPERATION_SCHEMA_VERSION) {
    throw new UnsupportedOutboxOperationSchemaError(entry.id, version);
  }
}

// Comment commands were briefly persisted with their optimistic payload as
// `result`, before receiptAsyncAction added an envelope. New servers still
// return a V2 command receipt for those rows. Interpret a terminal rejection
// during replay so an upgraded client does not acknowledge it as success and
// leave the optimistic comment protected forever.
function unwrapLegacyReceiptActionResponse(
  action: string,
  response: unknown,
): unknown {
  if (!LEGACY_RECEIPT_ACTIONS.has(action) ||
      !response || typeof response !== "object") {
    return response;
  }
  const receipt = response as Partial<PublicCommandReceipt>;
  if (receipt.status === "rejected") {
    if (!receipt.rejection?.code || !receipt.rejection.message) {
      throw new Error("Rejected command receipt is missing rejection details");
    }
    throw new CommandReceiptRejectedError(receipt.rejection);
  }
  return response;
}

function durableCreateContinuation(
  actionName: string,
  localResult: unknown,
): DurableCreateContinuation | null {
  if (!localResult || typeof localResult !== "object") return null;
  const raw = (localResult as { continuation?: unknown }).continuation;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<DurableCreateContinuation>;
  if (candidate.version !== 1) return null;

  if (
    candidate.kind === "navigate" &&
    (actionName === "createDoc" ||
      actionName === "createPlan" ||
      actionName === "createProject")
  ) {
    return { version: 1, kind: "navigate" };
  }

  if (
    candidate.kind === "assignBucket" &&
    actionName === "createBucket" &&
    Array.isArray(candidate.conversationIds)
  ) {
    const conversationIds = [...new Set(candidate.conversationIds)]
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, 100);
    if (conversationIds.length > 0) {
      return { version: 1, kind: "assignBucket", conversationIds };
    }
  }
  return null;
}

function acknowledgedNavigationHref(
  actionName: string,
  result: unknown,
): string | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  if (actionName === "createDoc" && typeof value.id === "string" && value.id) {
    return `/docs/${encodeURIComponent(value.id)}`;
  }
  if (
    actionName === "createPlan" &&
    typeof value.short_id === "string" &&
    value.short_id
  ) {
    return `/plans/${encodeURIComponent(value.short_id)}`;
  }
  if (
    actionName === "createProject" &&
    typeof value.id === "string" &&
    value.id
  ) {
    return `/projects/${encodeURIComponent(value.id)}`;
  }
  return null;
}

// Convex rejects `undefined` anywhere in the payload. Action functions are
// free to leave optional args/return values as `undefined`, so normalize at
// the dispatch boundary instead of forcing every call site to do it.
function sanitizeForConvex(value: any): any {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(sanitizeForConvex);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = sanitizeForConvex(v);
    }
    return out;
  }
  return value;
}

async function dispatchWithRetry(
  fn: DispatchFn,
  action: string,
  args: any,
  grouped: any,
  result: any,
  onError?: (action: string, error: unknown, args?: unknown) => void,
  retryDelays: number[] = RETRY_DELAYS,
  assertCurrent: () => void = () => {},
): Promise<any> {
  const safeArgs = sanitizeForConvex(args);
  const safeGrouped = grouped !== undefined ? sanitizeForConvex(grouped) : undefined;
  const safeResult = result === undefined ? null : sanitizeForConvex(result);
  for (let attempt = 0; ; attempt++) {
    assertCurrent();
    try {
      const response = await fn(action, safeArgs, safeGrouped, safeResult);
      assertCurrent();
      return response;
    } catch (e) {
      assertCurrent();
      if (attempt >= retryDelays.length || isPermanentDispatchError(e)) {
        assertCurrent();
        onError?.(action, e, args);
        throw e;
      }
      await new Promise(r => setTimeout(r, retryDelays[attempt]));
      assertCurrent();
    }
  }
}

// The two fields that decide which conversation the user is looking at.
// Changing either to a different conversation requires a declared
// ViewNavSource (see viewNav.ts); an undeclared change is reverted and logged
// instead of applied. Clearing to null is always allowed (it can't teleport
// anyone) but still audited.
const VIEW_FIELDS = ["currentSessionId", "pendingNavigateId"] as const;
type ViewField = (typeof VIEW_FIELDS)[number];

// Shared verdict for both write paths (action patches and raw setState).
// Returns the fields that must be reverted to their previous values.
function auditViewWrites(
  changes: Array<{ field: ViewField; from: string | null; to: string | null }>,
  actionName: string,
): ViewField[] {
  // Consume unconditionally: a token declared by a write that ended up not
  // changing the view must not linger and authorize a later unrelated write.
  const source = consumeViewNav();
  if (changes.length === 0) return [];
  const revert: ViewField[] = [];
  for (const { field, from, to } of changes) {
    if (source) {
      recordNavEvent({ field, from, to, source });
      if (field === "currentSessionId") noteViewNavApplied();
    } else if (to == null) {
      recordNavEvent({ field, from, to: null, source: `untracked:${actionName}` });
    } else {
      recordNavEvent({ field, from, to, source: `untracked:${actionName}`, blocked: "undeclared view change" });
      revert.push(field);
    }
  }
  return revert;
}

export function mutativeMiddleware(config: any, opts?: {
  retryDelays?: number[];
  localFirstWritesEnabled?: () => boolean;
  online?: () => boolean;
}): any {
  const retryDelays = opts?.retryDelays ?? RETRY_DELAYS;
  const localFirstWritesEnabled = opts?.localFirstWritesEnabled ?? isLocalFirstWriteEnabled;
  const online = opts?.online ?? (() =>
    typeof navigator === "undefined" ? true : navigator.onLine);
  return (set: any, get: any, api: any) => {
    let dispatchBinding: DispatchBinding | null = null;
    let dispatchEpoch = 0;
    let lastOutboxTs = 0;
    let idbWriteFn: IDBWriteFn | null = null;
    let dispatchErrorFn: ((action: string, error: unknown, args?: unknown) => void) | undefined;
    let outboxEnqueueFn: OutboxEnqueueFn | null = null;
    let outboxRemoveFn: OutboxRemoveFn | null = null;
    let outboxLoadFn: OutboxLoadFn | null = null;
    const receiptWaiters = new Map<string, ReceiptWaiter>();

    const receiptWaiterFor = (entryId: string): ReceiptWaiter => {
      const existing = receiptWaiters.get(entryId);
      if (existing) return existing;
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const waiter = { promise, resolve, reject };
      receiptWaiters.set(entryId, waiter);
      return waiter;
    };

    const resolveReceiptWaiter = (entryId: string, value: unknown) => {
      const waiter = receiptWaiters.get(entryId);
      if (!waiter) return;
      receiptWaiters.delete(entryId);
      waiter.resolve(value);
    };

    const rejectReceiptWaiter = (entryId: string, error: unknown) => {
      const waiter = receiptWaiters.get(entryId);
      if (!waiter) return;
      receiptWaiters.delete(entryId);
      waiter.reject(error);
    };

    const applyReceiptRejection = async (
      actionName: string,
      localResult: unknown,
    ): Promise<boolean> => {
      const handler = get()?._handleReceiptRejection;
      if (typeof handler !== "function") {
        console.error(
          `[local-first] cannot reconcile rejected "${actionName}" receipt: rollback handler is unavailable`,
        );
        return false;
      }
      try {
        // This hook is a sync()-wrapped, local-only reducer. It removes or
        // restores the exact optimistic row and clears its pending protection.
        const affectedKeys = handler(actionName, localResult);
        if (!Array.isArray(affectedKeys) || affectedKeys.length === 0) {
          return false;
        }

        if (idbWriteFn) {
          // Ordinary sync() persistence is intentionally fire-and-forget. A
          // terminal receipt is different: deleting the receipt row before the
          // rollback reaches disk can resurrect an optimistic ghost after a
          // crash with no command left to reconcile it. Run an idempotent,
          // full-key barrier through the same serialized IDB queue and await it.
          // If the wrapper's first write failed, its persisted shadow was not
          // advanced, so this call retries the exact outstanding diff.
          const state = get();
          const persistencePatches: Patch[] = affectedKeys.map((key) => ({
            op: "replace",
            path: [key],
            value: state[key],
          }));
          await idbWriteFn(persistencePatches, state);
        }
        return true;
      } catch (error) {
        console.error(
          `[local-first] failed to reconcile rejected "${actionName}" receipt`,
          error,
        );
        return false;
      }
    };

    const applyReceiptAcknowledgement = (
      actionName: string,
      envelope: ReceiptActionEnvelope,
      serverResult: unknown,
    ): boolean => {
      const continuation = durableCreateContinuation(
        actionName,
        envelope.localResult,
      );
      if (!continuation) return true;

      if (continuation.kind === "assignBucket") {
        const handler = get()?._handleReceiptAcknowledgement;
        if (
          !serverResult ||
          typeof serverResult !== "object" ||
          typeof (serverResult as { bucketId?: unknown }).bucketId !== "string" ||
          !(serverResult as { bucketId: string }).bucketId
        ) {
          throw new Error(
            "Acknowledged createBucket receipt is missing its bucket id",
          );
        }
        if (typeof handler !== "function") {
          throw new Error("Create-label continuation runtime is unavailable");
        }
        handler(
          actionName,
          continuation,
          serverResult,
          envelope.commandId,
        );
        return true;
      }

      const href = acknowledgedNavigationHref(actionName, serverResult);
      if (!href) {
        throw new Error(
          `Acknowledged ${actionName} receipt is missing its navigation id`,
        );
      }
      if (
        typeof window === "undefined" ||
        typeof window.location?.assign !== "function"
      ) {
        throw new Error("Create navigation runtime is unavailable");
      }
      if (window.location.pathname === href) return true;

      // This app is Vite + React Router (with tab-routing state), so bare
      // history.pushState changes the address bar without notifying the
      // rendered router. A full navigation is hook-free and works during boot
      // replay. Deliberately leave the row in place: the next runtime observes
      // the target pathname, then retires the intent. That also makes a crash
      // after navigation-before-cleanup exactly idempotent.
      window.location.assign(href);
      return false;
    };

    const assertDispatchCurrent = (captured: DispatchBinding) => {
      if (dispatchBinding !== captured || captured.epoch !== dispatchEpoch ||
        (captured.authorization &&
          !isPrincipalDispatchAuthorizationCurrent(captured.authorization))) {
        throw new StaleDispatchBindingError();
      }
    };

    function newOutboxId(): string {
      if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID();
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function nextOutboxTimestamp(): number {
      lastOutboxTs = Math.max(Date.now(), lastOutboxTs + 1);
      return lastOutboxTs;
    }

    let draining = false;
    let drainAgain = false;
    // Whether a drain pass has loaded the outbox and attempted every entry in it
    // (delivered, re-queued, or given up on). Consumers that must not act on a
    // PRE-REPLAY view of server state wait on this — the boot-eager hidden-set
    // crawls, whose CLEAR pass would otherwise un-hide a dismiss still parked here
    // (see bootEagerArmed in hooks/reconcileCrawl.ts). Stays false while the
    // outbox is unwired or a drain aborts on a rotated binding; those consumers
    // bound their own wait rather than blocking forever.
    let bootOutboxDrained = false;
    async function drainOutbox(countAttempts = true) {
      const captured = dispatchBinding;
      const capturedLoad = outboxLoadFn;
      const capturedRemove = outboxRemoveFn;
      const capturedEnqueue = outboxEnqueueFn;
      const capturedError = dispatchErrorFn;
      if (!captured || !capturedLoad) return;
      // One drain at a time. drainOutbox runs at boot AND on every reconnect /
      // tab-visible / interval tick, so overlapping passes are easy to trigger;
      // serializing them keeps a single in-flight entry from being dispatched
      // twice at once (redelivery is safe — dispatch.sendMessage dedups on
      // client_id — but pointless work isn't).
      if (draining) {
        drainAgain = true;
        return;
      }
      draining = true;
      try {
        const entries = await capturedLoad();
        assertDispatchCurrent(captured);
        // The outbox exists to survive a reload that lands in the middle of an
        // in-flight dispatch, AND to re-drive a send the live socket stranded:
        // a flaky connection can exhaust the in-session retry ladder and park
        // the write here with no boot in sight, so we also drain on reconnect.
        // A BOOT replay that fails counts an attempt (capped at
        // MAX_OUTBOX_BOOT_ATTEMPTS for low-stakes writes; user sends never drop
        // — see outboxFailureDisposition). OPPORTUNISTIC reconnect drains pass
        // countAttempts=false: a failure there leaves the entry exactly as-is,
        // so routine reconnect churn can't burn through a write's boot budget.
        for (const entry of entries) {
          try {
            assertSupportedOutboxOperationSchema(entry);
            const response = await dispatchWithRetry(
              captured.fn,
              entry.action,
              entry.args,
              stripStalePointerFromReplay(entry.patches),
              entry.result,
              capturedError,
              retryDelays,
              () => assertDispatchCurrent(captured),
            );
            assertDispatchCurrent(captured);
            if (isReceiptActionEnvelope(entry.result)) {
              try {
                const value = unwrapReceiptActionResponse(entry.result, response);
                const continuationComplete = applyReceiptAcknowledgement(
                  entry.action,
                  entry.result,
                  value,
                );
                if (!continuationComplete) return;
                resolveReceiptWaiter(entry.id, value);
              } catch (error) {
                capturedError?.(entry.action, error, entry.args);
                if (!(error instanceof CommandReceiptRejectedError)) throw error;
                if (!(await applyReceiptRejection(entry.action, entry.result.localResult))) {
                  throw new Error(
                    `Rejected "${entry.action}" receipt could not be reconciled locally`,
                  );
                }
                rejectReceiptWaiter(entry.id, error);
                await capturedRemove?.(entry.id);
                continue;
              }
            } else {
              try {
                unwrapLegacyReceiptActionResponse(entry.action, response);
              } catch (error) {
                capturedError?.(entry.action, error, entry.args);
                if (!(error instanceof CommandReceiptRejectedError)) throw error;
                if (!(await applyReceiptRejection(entry.action, entry.result))) {
                  throw new Error(
                    `Rejected "${entry.action}" receipt could not be reconciled locally`,
                  );
                }
                await capturedRemove?.(entry.id);
                continue;
              }
            }
            await capturedRemove?.(entry.id);
          } catch (e) {
            if (e instanceof StaleDispatchBindingError) return;
            assertDispatchCurrent(captured);
            if (e instanceof UnsupportedOutboxOperationSchemaError) {
              capturedError?.(entry.action, e, entry.args);
              // Explicit migration is required. Keep the row intact and do not
              // reinterpret, attempt-count, or dispatch it under this bundle.
              continue;
            }
            // Reported via dispatchErrorFn.
            // Receipt-backed writes are terminal ONLY when the server returns a
            // validated rejected receipt (handled above). A thrown "Uncaught",
            // missing-function/version-skew, or auth-transition error does not
            // prove that this exact command was durably rejected. Keep its
            // deduplicated row and waiter even when generic dispatch policy
            // classifies the transport error as permanent.
            if (isReceiptActionEnvelope(entry.result)) {
              if (!countAttempts) continue;
              const disposition = outboxFailureDisposition(entry);
              assertDispatchCurrent(captured);
              await capturedEnqueue?.(disposition.entry);
              continue;
            }
            // Legacy non-receipt actions still treat a permanent refusal as
            // delivery. Re-driving those forever can only repeat the refusal.
            if (isPermanentDispatchError(e)) {
              rejectReceiptWaiter(entry.id, e);
              await capturedRemove?.(entry.id);
              continue;
            }
            if (!countAttempts) continue;
            const disposition = outboxFailureDisposition(entry);
            assertDispatchCurrent(captured);
            if (disposition.keep) await capturedEnqueue?.(disposition.entry);
            else {
              rejectReceiptWaiter(entry.id, e);
              await capturedRemove?.(entry.id);
            }
          }
        }
        // Every parked entry has now been attempted — the replay is no longer
        // racing readers of server state. Set after the loop, so an abort partway
        // through leaves it false for the successor binding's drain to satisfy.
        bootOutboxDrained = true;
      } catch (e) {
        // A binding rotated mid-drain (page-load verification rebind, account
        // switch). Every drain call site is fire-and-forget, so letting this
        // escape becomes an unhandled rejection; the successor binding's own
        // boot drain owns the outbox now, and this pass simply ends.
        if (!(e instanceof StaleDispatchBindingError)) throw e;
      } finally {
        draining = false;
        if (drainAgain) {
          drainAgain = false;
          void drainOutbox(countAttempts);
        }
      }
    }

    const rawStore = config(set, get, api);

    const wrapped: Record<string, any> = {};

    for (const [key, val] of Object.entries(rawStore)) {
      const isAct = isAction(val);
      const isAsyncAct = isAsyncAction(val);
      const isReceiptAsyncAct = isReceiptAsyncAction(val);
      const isSyn = isSync(val);

      if (!isAct && !isAsyncAct && !isSyn) {
        wrapped[key] = val;
        continue;
      }

      wrapped[key] = (...args: any[]) => {
        const actionArgs = normalizeZeroArgumentEventCall(val as Function, args);
        const finalWrite = LOCAL_FIRST_WRITE_ACTIONS.has(key) &&
          localFirstWritesEnabled();
        if (finalWrite) assertDurableOfflineWriteCapability(online());
        const state = get();
        let returnValue: any;
        const [nextState, patches] = mutativeCreate(
          state,
          (draft: any) => {
            returnValue = (val as Function).apply(draft, actionArgs);
          },
          { enablePatches: { pathAsArray: true } }
        );

        // Auto-generate pending entries for synced collections so local-first
        // writes are protected from server sync overwrites.
        let finalState = nextState;
        let finalPatches: Patch[] = patches;
        if (isAct || isAsyncAct) {
          const newPending = generateAutoPending(patches, nextState.pending ?? {});
          if (newPending) {
            finalState = { ...nextState, pending: newPending };
            // Synthetic patch so IDB persists the updated pending
            finalPatches = [...patches, { op: "replace" as const, path: ["pending"] as (string | number)[], value: newPending }];
          }
        }

        // View-motion guard: an undeclared change of the visible conversation
        // is reverted before it ever renders (see viewNav.ts).
        const viewChanges = VIEW_FIELDS.filter(
          (f) => (state as any)[f] !== (finalState as any)[f],
        ).map((f) => ({ field: f, from: (state as any)[f] ?? null, to: (finalState as any)[f] ?? null }));
        const revertFields = auditViewWrites(viewChanges, key);
        if (revertFields.length > 0) {
          const reverted: Record<string, any> = {};
          for (const f of revertFields) reverted[f] = (state as any)[f];
          finalState = { ...finalState, ...reverted };
          finalPatches = finalPatches.filter((p) => !revertFields.includes(String(p.path[0]) as ViewField));
        }

        set(finalState, true);

        if (idbWriteFn && finalPatches.length > 0) {
          // Synchronous: Dexie's bulkPut/clear/put don't block the main thread,
          // and deferring via requestIdleCallback can lose writes if the user
          // reloads before idle (e.g. dismiss → reload race).
          void Promise.resolve(idbWriteFn(finalPatches, finalState)).catch((error) => {
            console.error(`[local-first] failed to persist legacy compatibility state (action=${key})`, error);
          });
        }

        if (isAct || isAsyncAct) {
          const grouped =
            patches.length > 0 ? groupPatchesByTable(patches, finalState) : undefined;
          const callerStableMessageId = key === "sendMessage" &&
            typeof actionArgs[3] === "string" && actionArgs[3].trim()
            ? actionArgs[3].trim()
            : null;
          const outboxId = finalWrite && callerStableMessageId
            ? callerStableMessageId
            : newOutboxId();
          const usesReceiptEnvelope = isReceiptAsyncAct &&
            (!FLAG_PROMOTED_RECEIPT_ACTIONS.has(key) || finalWrite);
          // A demoted promotion behaves exactly like its pre-release action():
          // fire-and-forget, no caller-facing promise, park-and-drain delivery.
          const demotedToLegacyAction = isReceiptAsyncAct && !usesReceiptEnvelope;
          const returnsPromise = isAsyncAct && !demotedToLegacyAction;
          const dispatchResult: unknown = usesReceiptEnvelope
            ? {
                receiptActionVersion: 1,
                commandId: outboxId,
                ...(returnValue !== undefined ? { localResult: returnValue } : {}),
              } satisfies ReceiptActionEnvelope
            : returnValue;
          // Persist the outbound dispatch *before* firing so it survives a
          // reload mid-flight. Removed only on server acknowledgment; failed
          // dispatches stay queued and re-fire on next hydrate via drainOutbox.
          // Enqueued even when dispatchFn isn't wired yet — drainOutbox picks
          // them up the moment _setDispatch runs.
          const entry = {
            id: outboxId,
            action: key,
            args: actionArgs,
            patches: grouped,
            result: dispatchResult,
            operationSchemaVersion: CURRENT_OUTBOX_OPERATION_SCHEMA_VERSION,
            // legacyOutbox replays by this index. Strict monotonicity preserves
            // causal call order even when several dependent actions (create →
            // delete, fork → send) are queued in the same millisecond.
            ts: nextOutboxTimestamp(),
          };
          // The server call is chained behind the durable enqueue. A storage
          // failure therefore cannot create an effect that has no replayable
          // local record. (`action()` remains memory-first only as a temporary
          // compatibility path; v2 materialized commands use LocalFirstEngine.)
          const capturedDispatch = dispatchBinding;
          const capturedRemove = outboxRemoveFn;
          const capturedError = dispatchErrorFn;
          const receiptWaiter = usesReceiptEnvelope ? receiptWaiterFor(outboxId) : null;
          let enqueueCompleted = false;
          // Parked unconditionally — a principal-runtime transition can clear
          // the binding while the page stays interactive, and an un-parked
          // action fired in that window would vanish with zero trace.
          const enqueued = outboxEnqueueFn
            ? Promise.resolve(outboxEnqueueFn(entry)).then(() => {
                enqueueCompleted = true;
              })
            : null;
          if (capturedDispatch) {
            const dispatchNow = () => dispatchWithRetry(
              capturedDispatch.fn,
              key,
              actionArgs,
              grouped,
              dispatchResult,
              capturedError,
              retryDelays,
              () => assertDispatchCurrent(capturedDispatch),
            );
            // The compatibility store historically invokes a wired dispatch
            // synchronously (up to its first await). Preserve that behavior
            // when no durable outbox is installed; callers and tests observe
            // the dispatch in the same turn. Once an outbox is installed,
            // dispatch stays strictly behind its durable enqueue.
            const dispatched = enqueued
              ? enqueued.then(dispatchNow)
              : dispatchNow();
            if (usesReceiptEnvelope && receiptWaiter) {
              void dispatched.then(async (response) => {
                assertDispatchCurrent(capturedDispatch);
                let completed = false;
                try {
                  const value = unwrapReceiptActionResponse(
                    dispatchResult as ReceiptActionEnvelope,
                    response,
                  );
                  const continuationComplete = applyReceiptAcknowledgement(
                    key,
                    dispatchResult as ReceiptActionEnvelope,
                    value,
                  );
                  if (!continuationComplete) return;
                  resolveReceiptWaiter(outboxId, value);
                  completed = true;
                } catch (error) {
                  capturedError?.(key, error, actionArgs);
                  if (error instanceof CommandReceiptRejectedError) {
                    const reconciled = await applyReceiptRejection(
                      key,
                      (dispatchResult as ReceiptActionEnvelope).localResult,
                    );
                    if (reconciled) {
                      completed = true;
                      rejectReceiptWaiter(outboxId, error);
                    }
                  } else if (!enqueueCompleted) {
                    // Without a committed outbox row there is no future replay
                    // that can resolve an ambiguous response.
                    rejectReceiptWaiter(outboxId, error);
                  }
                }
                // Acknowledgement (including its allowlisted continuation) or
                // a durable rejection is complete. A malformed response or an
                // unavailable navigation runtime is ambiguous, so retain the
                // deduplicated command for a later replay.
                if (completed) {
                  await capturedRemove?.(outboxId);
                }
              }, async (error) => {
                let current = true;
                try {
                  assertDispatchCurrent(capturedDispatch);
                } catch {
                  current = false;
                }
                // Once enqueue completed, ALL thrown receipt errors are
                // ambiguous. Only a validated rejected receipt is terminal;
                // the durable command row owns version-skew, auth-transition,
                // and transport recovery too.
                if (enqueueCompleted) {
                  if (!current && dispatchBinding) void drainOutbox(false);
                  return;
                }
                // Dispatch is chained behind enqueue, so reaching this branch
                // means durability itself failed (or no outbox was installed).
                // The command cannot honestly remain pending.
                rejectReceiptWaiter(outboxId, error);
              }).catch((error) => {
                if (error instanceof StaleDispatchBindingError) {
                  if (enqueueCompleted) {
                    if (dispatchBinding) void drainOutbox(false);
                  } else {
                    rejectReceiptWaiter(outboxId, error);
                  }
                  return;
                }
                // A removal/storage error after acknowledgement leaves the
                // receipt row replayable. The waiter may already be resolved;
                // never reinterpret this as a domain rejection.
                capturedError?.(key, error, actionArgs);
              });
              return receiptWaiter.promise;
            }
            const promise = dispatched.then(async (r) => {
              assertDispatchCurrent(capturedDispatch);
              await capturedRemove?.(outboxId);
              return r;
            }, async (e) => {
              if (e instanceof StaleDispatchBindingError) throw e;
              assertDispatchCurrent(capturedDispatch);
              // Permanent rejection: the server answered and said no — remove
              // the parked copy so the drain loops don't re-litigate it forever.
              if (isPermanentDispatchError(e)) await capturedRemove?.(outboxId);
              throw e;
            });
            if (returnsPromise) return promise;
            promise.catch(() => {});
          } else {
            // No live binding (boot, HMR rewire, account-switch window): the
            // entry is only "parked" after its enqueue promise fulfills.
            // `_setDispatch` can race that commit, so every successful enqueue
            // also rechecks for a newly-installed binding.
            console.warn(`[sync] dispatch not wired; ${enqueued ? `enqueueing "${key}" for later delivery` : `"${key}" was dropped (no outbox)`}`);
            // An asyncAction promises its caller the server result. Returning
            // the raw returnValue here (historically undefined) made callers'
            // `.then(...)` throw synchronously — the fork-create flow lost its
            // error handler that way and a fork could vanish with no toast and
            // no discard (ct-40175). Reject honestly instead: the caller's
            // catch runs now; a parked entry still delivers via drainOutbox.
            // A demoted promotion is not an asyncAction to its callers: it
            // parks fire-and-forget below, exactly like the action() it was.
            if (returnsPromise) {
              if (usesReceiptEnvelope && receiptWaiter && enqueued) {
                void enqueued.then(
                  () => {
                    // Wiring can race the IndexedDB commit: its boot drain may
                    // have loaded an empty outbox a moment before this row
                    // became visible. Recheck immediately once durability is
                    // confirmed so the modal does not wait for a heartbeat.
                    if (dispatchBinding) void drainOutbox(false);
                  },
                  (error) => {
                    rejectReceiptWaiter(outboxId, error);
                  },
                );
                return receiptWaiter.promise;
              }
              if (usesReceiptEnvelope) {
                rejectReceiptWaiter(
                  outboxId,
                  new DispatchNotWiredError(key, false),
                );
                return receiptWaiter?.promise;
              }
              if (enqueued) {
                return enqueued.then(() => {
                  if (dispatchBinding) void drainOutbox(false);
                  throw new DispatchNotWiredError(key, true);
                });
              }
              return Promise.reject(new DispatchNotWiredError(key, false));
            }
            if (enqueued) {
              void enqueued.then(
                () => {
                  if (dispatchBinding) void drainOutbox(false);
                },
                (error) => {
                  capturedError?.(key, error, actionArgs);
                  if (!capturedError) {
                    console.error(`[local-first] failed to park "${key}"`, error);
                  }
                },
              );
            }
          }
        }

        return returnValue;
      };
    }

    wrapped._setDispatch = (
      fn: DispatchFn | null,
      options?: { owner?: object; authorization?: DispatchAuthorizationCapture },
    ) => {
      dispatchEpoch++;
      dispatchBinding = fn
        ? { epoch: dispatchEpoch, fn, owner: options?.owner, authorization: options?.authorization }
        : null;
      // Drain any persisted outbox entries from a prior session.
      if (fn) drainOutbox();
    };

    wrapped._clearDispatch = (owner: object) => {
      if (dispatchBinding?.owner !== owner) return;
      dispatchEpoch++;
      dispatchBinding = null;
    };

    // Opportunistic re-drive: re-attempt every parked dispatch without counting
    // a boot attempt. Wired to reconnect / tab-visible / interval so a send the
    // live socket stranded reaches the server WITHOUT waiting for a reload.
    wrapped._drainOutbox = () => { drainOutbox(false); };

    // Whether the durable outbox has been replayed once since load — see
    // bootOutboxDrained. Polled by the boot-eager hidden-set crawls, which must
    // not run their un-hide CLEAR pass against a server that hasn't received the
    // hides still parked here.
    wrapped._hasBootOutboxDrained = () => bootOutboxDrained;

    // Whether a dispatch fired right now would actually reach the server: a
    // binding exists and its captured authorization is still current. A false
    // here is the only visible symptom of a binding stranded by a
    // principal-runtime transition — useEnsureDispatch's drain ticks poll it
    // and re-bind.
    wrapped._isDispatchWired = () => {
      const b = dispatchBinding;
      if (!b || b.epoch !== dispatchEpoch) return false;
      return !b.authorization || isPrincipalDispatchAuthorizationCurrent(b.authorization);
    };

    wrapped._setIDBWrite = (fn: IDBWriteFn | null) => {
      idbWriteFn = fn;
    };

    wrapped._setOutbox = (
      enqueue: OutboxEnqueueFn | null,
      remove: OutboxRemoveFn | null,
      load: OutboxLoadFn | null,
    ) => {
      outboxEnqueueFn = enqueue;
      outboxRemoveFn = remove;
      outboxLoadFn = load;
    };

    wrapped._clearRuntimeBindings = () => {
      dispatchEpoch++;
      dispatchBinding = null;
      idbWriteFn = null;
      outboxEnqueueFn = null;
      outboxRemoveFn = null;
      outboxLoadFn = null;
      // The drained flag described the OUTGOING principal's outbox. The successor
      // has its own principal-scoped rows and has replayed none of them, so
      // carrying the flag across would tell the boot-eager hidden-set crawls the
      // replay already happened and let them read the server before the new
      // account's parked hides ship — the exact race the flag exists to prevent.
      bootOutboxDrained = false;
      // Receipt waiters intentionally survive a runtime/auth rebind. Their
      // random entry ids can resolve only when that exact principal-scoped
      // outbox row drains again; another account cannot present the row. This
      // keeps a legitimately parked modal pending through token rotation.
    };

    wrapped._setDispatchError = (fn: (action: string, error: unknown, args?: unknown) => void) => {
      dispatchErrorFn = fn;
    };

    wrapped._dispatch = (action: string, args: any, patches?: any, result?: any) => {
      const captured = dispatchBinding;
      if (!captured) return Promise.reject(new Error("Dispatch not wired"));
      return dispatchWithRetry(
        captured.fn,
        action,
        args,
        patches,
        result,
        dispatchErrorFn,
        retryDelays,
        () => assertDispatchCurrent(captured),
      );
    };

    // Police raw setState (writes from outside action()/sync()): the view
    // fields obey the same declare-or-revert rule as store actions. The
    // middleware's internal `set` is the pre-wrap reference, so action writes
    // (already audited via patches above) are not double-counted. Functional
    // partials are exempt — none touch the view fields; object literals are
    // the only raw write shape for them in the codebase.
    const origSetState = api.setState;
    api.setState = (partial: any, replace?: boolean) => {
      if (partial && typeof partial === "object") {
        const prev = get();
        const touched = VIEW_FIELDS.filter((f) => f in partial && partial[f] !== prev[f]).map(
          (f) => ({ field: f, from: prev[f] ?? null, to: partial[f] ?? null }),
        );
        const revert = auditViewWrites(touched, "setState");
        if (revert.length > 0) {
          partial = { ...partial };
          for (const f of revert) delete partial[f];
        }
      }
      return origSetState(partial, replace);
    };

    return wrapped;
  };
}
