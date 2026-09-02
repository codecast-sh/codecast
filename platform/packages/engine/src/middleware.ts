import { create as mutativeCreate, type Patch } from "mutative";
import { deriveRegistryMaps, type RegistryMaps } from "./registry";
import type {
  DispatchFn,
  IDBWriteFn,
  OutboxEnqueueFn,
  OutboxEntry,
  OutboxLoadFn,
  OutboxRemoveFn,
  PlatformConfig,
} from "./types";

type DispatchBinding = {
  epoch: number;
  fn: DispatchFn;
  owner?: object;
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

const SINGLETON_KEY = "_";

// Server document ids in the default shape are 32-char base32. Stub/local ids
// (a fresh row before server assignment) are shorter and would crash the
// server-side applyPatches.
const DEFAULT_SERVER_ID_RE = /^[a-z0-9]{32}$/;
export const defaultIsServerId = (id: string): boolean => DEFAULT_SERVER_ID_RE.test(id);

function setNested(obj: any, path: (string | number)[], value: any): any {
  if (path.length === 0) return value;
  const result = typeof obj === "object" && obj !== null ? { ...obj } : {};
  const [head, ...tail] = path;
  result[head] = setNested(result[head], tail, value);
  return result;
}

export type GroupPatchesContext = {
  tableMap: RegistryMaps["dispatchTableMap"];
  fieldToTable: RegistryMaps["dispatchFieldTableMap"];
  isServerId: (id: string) => boolean;
};

export function groupPatchesByTable(
  patches: Patch[],
  state: any,
  ctx: GroupPatchesContext,
): Record<string, Record<string, Record<string, any>>> {
  const result: Record<string, Record<string, Record<string, any>>> = {};
  const { tableMap: TABLE_MAP, fieldToTable: FIELD_TO_TABLE, isServerId } = ctx;

  for (const patch of patches) {
    if (patch.op !== "replace" && patch.op !== "add" && patch.op !== "remove") continue;
    const path = patch.path as (string | number)[];
    if (path.length < 1) continue;

    // A cleared field must reach the server as an explicit null tombstone:
    // mutative encodes `obj.f = undefined` as replace-with-undefined and
    // `delete obj.f` as a remove op, and the dispatch sanitizer drops undefined
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
      const rowId = String(path[1]);
      // Skip stub ids — server can't act on them. Once the row is rekeyed to
      // its real server id, subsequent patches will dispatch normally.
      if (!isServerId(rowId)) continue;
      const field = String(path[2]);
      if (mapping.fields && !mapping.fields.includes(field)) continue;
      const nested = path.slice(3);

      result[table][rowId] ??= {};
      if (nested.length === 0) {
        result[table][rowId][field] = value;
      } else {
        result[table][rowId][field] = setNested(
          result[table][rowId][field] ?? {},
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

const RETRY_DELAYS = [1000, 2000, 4000];

// A rejection from the server client means the backend ANSWERED — network drops
// never reject (a live socket client re-queues those internally across
// reconnects). Answers split two ways:
//  - the function itself threw ("Uncaught Error: …") or the args failed
//    validation ("ArgumentValidationError"): deterministic — replaying the
//    identical payload can only fail the identical way, so the retry ladder and
//    the outbox re-drives just multiply the same refusal.
//  - backend system errors ("Your request timed out…", "Try again later"):
//    transient overload, carry neither marker, and stay retryable.
export function isPermanentDispatchError(error: unknown): boolean {
  if (error instanceof CommandReceiptRejectedError) return true;
  // A backend that says "retryable" outranks the text match below. A thrown
  // application error reaches the client with its data attached, so a rate
  // limit — the one refusal that WILL accept the identical payload a moment
  // later — would otherwise be read as terminal and dropped from the outbox.
  // Only an explicit `true` counts; everything else keeps the old, stricter
  // reading.
  if ((error as { data?: { retryable?: unknown } })?.data?.retryable === true) return false;
  const msg = String((error as { message?: unknown })?.message ?? error ?? "");
  return /\bUncaught\b|ArgumentValidationError|Could not find public function/.test(msg);
}

// How many boots a failed outbox entry survives before it's given up on.
// Each boot attempt already runs the full in-page retry ladder, so this
// bounds permanently-broken dispatches (they'd otherwise slow every page
// load forever) while letting writes stranded by an outage outlive reloads
// that happen during that same outage.
export const MAX_OUTBOX_BOOT_ATTEMPTS = 5;

// Replay staleness ceiling. "Never drop user content" holds while delivery is
// still meaningful; replaying a message parked for over a week delivers it
// into a thread that has long moved on, which is its own kind of wrong.
// Dropped rows are logged with their content so nothing disappears silently.
export const OUTBOX_MAX_REPLAY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Actions carrying user-authored content that MUST reach the server — losing
// one silently drops something the user typed. These are never given up on:
// they ride the outbox until the server acknowledges them, however many
// reloads/outages that takes. The boot cap above only bounds low-stakes
// bookkeeping writes whose loss is recoverable and which must not slow every
// page load forever if permanently broken. A receipt-backed command is
// must-deliver by construction: the server dedups it on its command id, so
// unbounded retry is safe.
export function makeIsMustDeliverEntry(
  mustDeliverActions: ReadonlySet<string>,
  mustDeliverExtra?: (entry: OutboxEntry) => boolean,
): (entry: OutboxEntry) => boolean {
  return (entry: OutboxEntry) => {
    if (mustDeliverActions.has(entry.action)) return true;
    if (isReceiptActionEnvelope(entry.result)) return true;
    // Some must-deliver intents cannot be named by action alone (e.g. one
    // subcommand of a generic command action carries user-authored stakes);
    // the app supplies the predicate for those.
    return mustDeliverExtra ? mustDeliverExtra(entry) : false;
  };
}

// What to do with an outbox entry whose boot-time replay failed: keep it for
// the next boot with the attempt counted, or give up at the cap. Must-deliver
// entries are never dropped.
export function makeOutboxFailureDisposition(
  isMustDeliverEntry: (entry: OutboxEntry) => boolean,
): (entry: OutboxEntry) => { keep: boolean; entry: OutboxEntry } {
  return (entry: OutboxEntry) => {
    const attempts = (entry.attempts ?? 0) + 1;
    return {
      keep: isMustDeliverEntry(entry) || attempts < MAX_OUTBOX_BOOT_ATTEMPTS,
      entry: { ...entry, attempts },
    };
  };
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

export function outboxCoalesceKeyFor(
  action: string,
  args: any[],
  coalesceKeys: Record<string, (args: any[]) => string | null>,
): string | null {
  const derive = coalesceKeys[action];
  if (!derive) return null;
  try {
    return derive(args);
  } catch {
    return null;
  }
}

// How long a durable enqueue may stay uncommitted before storage is reported
// unhealthy. The dispatch path no longer waits on storage, so a slow or wedged
// IndexedDB degrades durability only — but silently degraded durability is how
// wedges go unnoticed for hours, so surface it. The target is multi-minute
// wedges, not transient contention (boot hydration, a large flush), so the
// deadline is generous — a stall that resolves inside it is not worth a banner.
export const STORAGE_WATCHDOG_MS = 10_000;

// When the watchdog timer fires far past its deadline, the event loop itself
// was paused (hidden/frozen tab, system sleep) — the measurement is the pause,
// not IndexedDB. Overshoot beyond this tolerance re-arms a short recheck
// instead of tripping; a genuinely stuck write still trips once the page is
// actually running.
export const STORAGE_WATCHDOG_MAX_TIMER_LAG_MS = 2_000;
export const STORAGE_WATCHDOG_RECHECK_MS = 1_000;

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

// Commands can predate the receipt envelope while their server still returns a
// receipt. Interpret a terminal rejection during replay so an upgraded client
// does not acknowledge it as success and leave the optimistic row protected
// forever.
function unwrapLegacyReceiptActionResponse(
  action: string,
  response: unknown,
  legacyReceiptActions: ReadonlySet<string>,
): unknown {
  if (!legacyReceiptActions.has(action) ||
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

// The server rejects `undefined` anywhere in the payload. Action functions are
// free to leave optional args/return values as `undefined`, so normalize at
// the dispatch boundary instead of forcing every call site to do it.
function sanitizeForTransport(value: any): any {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(sanitizeForTransport);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = sanitizeForTransport(v);
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
  const safeArgs = sanitizeForTransport(args);
  const safeGrouped = grouped !== undefined ? sanitizeForTransport(grouped) : undefined;
  const safeResult = result === undefined ? null : sanitizeForTransport(result);
  // Lifted out of the envelope here, in the one place every dispatch passes
  // through — the first send and every outbox replay. A transport that names
  // the command id as its own field can forward this argument without the app
  // having to remember that `result` also carries it.
  const commandId = isReceiptActionEnvelope(result) ? result.commandId : undefined;
  for (let attempt = 0; ; attempt++) {
    assertCurrent();
    try {
      const response = await fn(action, safeArgs, safeGrouped, safeResult, commandId);
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

/**
 * Scan mutative patches from an action() and auto-generate pending entries
 * for synced collections. Returns null if no pending changes needed.
 */
export function generateAutoPending(
  patches: Patch[],
  currentPending: Record<string, any>,
  isProtectedSyncCollection: (key: string) => boolean,
  hideAckFields: ReadonlySet<string>,
  isUnprotectedField?: (key: string, field: string) => boolean,
): Record<string, any> | null {
  let result: Record<string, any> | null = null;
  const now = Date.now();
  // The hide value is the server acknowledgement identity; `now` below is
  // merely this middleware pass's freshness stamp and need not equal it.
  const hideAcks = new Map<string, number>();
  if (hideAckFields.size > 0) {
    for (const patch of patches) {
      const path = patch.path as (string | number)[];
      if (path.length < 3) continue;
      const storeKey = String(path[0]);
      const field = String(path[2]);
      if (
        !isProtectedSyncCollection(storeKey) ||
        !hideAckFields.has(field) ||
        typeof patch.value !== "number"
      ) continue;
      hideAcks.set(`${storeKey}:${String(path[1])}`, patch.value);
    }
  }

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
    } else if ((patch.op === "replace" || patch.op === "add" || patch.op === "remove") && path.length === 3) {
      // Field modified (or cleared — remove op) on a collection record →
      // protect field value; a cleared field protects as undefined, which
      // matches the server echo once the null tombstone lands.
      //
      // Exactly depth 3, never deeper: a deeper patch's value is a LEAF of the
      // field (one pushed array element, one nested key), and recording it
      // under the field's pending key would re-assert that leaf AS the whole
      // field on every server push — an array field then degrades into a bare
      // element object, permanently (the mismatched shape never echoes, so the
      // lock never retires). Assigning the whole field is the protection
      // gesture; a deep mutation is an optimistic-only write the server's next
      // authoritative payload reconciles.
      const field = String(path[2]);
      if (isUnprotectedField?.(storeKey, field)) continue;
      if (!result) result = { ...currentPending };
      result[`${storeKey}:${recordId}:${field}`] = {
        type: "field",
        value: patch.value,
        ts: now,
        ...(hideAcks.has(`${storeKey}:${recordId}`) ? { hideAck: hideAcks.get(`${storeKey}:${recordId}`)! } : {}),
      };
    }
  }

  return result;
}

export type MiddlewareOptions = {
  retryDelays?: number[];
  // Test seams for the storage watchdog — production always uses the exported
  // constants; tests shrink them to avoid real multi-second sleeps.
  storageWatchdogMs?: number;
  storageWatchdogMaxLagMs?: number;
  storageWatchdogRecheckMs?: number;
  // Reuse maps already derived from the same registry.
  registryMaps?: RegistryMaps;
};

export function mutativeMiddleware(
  creator: any,
  platformConfig: PlatformConfig,
  opts?: MiddlewareOptions,
): any {
  const retryDelays = opts?.retryDelays ?? RETRY_DELAYS;
  const watchdogMs = opts?.storageWatchdogMs ?? STORAGE_WATCHDOG_MS;
  const watchdogMaxLagMs = opts?.storageWatchdogMaxLagMs ?? STORAGE_WATCHDOG_MAX_TIMER_LAG_MS;
  const watchdogRecheckMs = opts?.storageWatchdogRecheckMs ?? STORAGE_WATCHDOG_RECHECK_MS;
  const maps = opts?.registryMaps ?? deriveRegistryMaps(platformConfig.registry);
  const isServerId = platformConfig.isServerId ?? defaultIsServerId;
  const hideAckFields = platformConfig.hideAckFields ?? new Set<string>();
  const mustDeliverActions = platformConfig.mustDeliverActions ?? new Set<string>();
  const legacyReceiptActions = platformConfig.legacyReceiptActions ?? new Set<string>();
  const coalesceKeys = platformConfig.outboxCoalesceKeys ?? {};
  const transformReplayPatches = platformConfig.transformReplayPatches ?? ((p: any) => p);
  const storageWatchdogHint = platformConfig.storageWatchdogHint;
  const receiptContinuations = platformConfig.receiptContinuations;
  const viewGuard = platformConfig.viewGuard;
  const groupCtx: GroupPatchesContext = {
    tableMap: maps.dispatchTableMap,
    fieldToTable: maps.dispatchFieldTableMap,
    isServerId,
  };
  const isMustDeliverEntry = makeIsMustDeliverEntry(
    mustDeliverActions,
    platformConfig.mustDeliverExtra,
  );
  const outboxFailureDisposition = makeOutboxFailureDisposition(isMustDeliverEntry);

  return (set: any, get: any, api: any) => {
    let dispatchBinding: DispatchBinding | null = null;
    let dispatchEpoch = 0;
    let lastOutboxTs = 0;
    let idbWriteFn: IDBWriteFn | null = null;
    let dispatchErrorFn: ((action: string, error: unknown, args?: unknown) => void) | undefined;
    let outboxEnqueueFn: OutboxEnqueueFn | null = null;
    let outboxRemoveFn: OutboxRemoveFn | null = null;
    let outboxLoadFn: OutboxLoadFn | null = null;
    let storageHealthFn: ((healthy: boolean, elapsedMs: number) => void) | null = null;
    // Follower-mode replication tee: called with every action()'s patches (never
    // sync()'s), so a window that does not own persistence can still offer its
    // optimistic writes to the sync host. See replication.ts.
    let actionTeeFn: ((actionName: string, patches: Patch[], state: any) => void) | null = null;
    const receiptWaiters = new Map<string, ReceiptWaiter>();
    // Outbox ids whose server dispatch already settled the command (ack or
    // terminal rejection) — the row is garbage the moment it commits. Dispatch
    // runs in parallel with the durable enqueue, so the ack can win that race:
    // retirement waits for the enqueue to settle, then deletes the row. While
    // an id is in this set, drainOutbox must not re-dispatch it.
    const retiredOutboxIds = new Set<string>();
    // coalesceKey → newest enqueued row for that key (by entry ts — enqueue
    // COMPLETIONS can invert order under slow storage). A newer row retires
    // the older one; an older row that completes late retires itself.
    const coalescedOutboxIds = new Map<string, { id: string; ts: number }>();

    const retireOutboxEntry = async (
      id: string,
      enqueued: Promise<unknown> | null,
    ) => {
      retiredOutboxIds.add(id);
      try {
        // Wait for the row to exist (or for its write to have failed) before
        // deleting it, so the delete can't lose the race with its own commit.
        if (enqueued) await enqueued.catch(() => {});
        await outboxRemoveFn?.(id);
      } catch {
        // The id stays in retiredOutboxIds; the next drain skips dispatching
        // it and retries the removal there.
        return;
      }
      retiredOutboxIds.delete(id);
    };

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

    // Whether the acknowledgement (including any allowlisted continuation) is
    // complete. False deliberately retains the durable row so the next runtime
    // observes the finished world and retires the intent.
    const applyReceiptAcknowledgement = (
      actionName: string,
      envelope: ReceiptActionEnvelope,
      serverResult: unknown,
    ): boolean => {
      if (!receiptContinuations) return true;
      const continuation = receiptContinuations.resolve(actionName, envelope.localResult);
      if (!continuation) return true;
      return receiptContinuations.apply({
        actionName,
        continuation,
        serverResult,
        commandId: envelope.commandId,
        getState: get,
      });
    };

    const assertDispatchCurrent = (captured: DispatchBinding) => {
      if (dispatchBinding !== captured || captured.epoch !== dispatchEpoch) {
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
    // Consumers that must not act on a PRE-REPLAY view of server state wait for a
    // verified-empty durable outbox. A failed/re-queued entry is still a pending
    // server write, so merely attempting it cannot open this gate.
    let bootOutboxDrained = false;
    let outboxGeneration = 0;
    let pendingOutboxEnqueues = 0;
    // Enqueues currently outstanding past the watchdog deadline. The banner
    // reflects "a durable write is stuck RIGHT NOW": it trips when this rises
    // above zero and clears when the last overdue write settles — a commit at
    // any speed proves durability is intact, so a tripped write clears itself
    // instead of waiting for an unrelated later write to be fast.
    let overdueEnqueues = 0;
    const markOutboxDirty = () => {
      bootOutboxDrained = false;
      outboxGeneration++;
    };
    const enqueueOutbox = async (enqueue: OutboxEnqueueFn, entry: OutboxEntry) => {
      markOutboxDirty();
      pendingOutboxEnqueues++;
      // Storage watchdog: an enqueue that hasn't committed by the deadline
      // means IndexedDB is slow or wedged. Delivery no longer depends on it,
      // but durability does — report unhealthy so the UI can say so.
      const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
      const started = now();
      const elapsed = () => now() - started;
      let settled = false;
      let tripped = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = (delayMs: number) => {
        const armedAt = now();
        watchdog = setTimeout(() => {
          if (settled) return;
          // Only trip from a live, running page. A timer that fires far past
          // its deadline, or into a hidden tab, measured an event-loop pause
          // (throttled/frozen tab, system sleep) — not IndexedDB. Recheck on
          // a short leash: a genuinely stuck write still trips once the page
          // is actually running.
          const overshotMs = now() - armedAt - delayMs;
          const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
          if (hidden || overshotMs > watchdogMaxLagMs) {
            armWatchdog(watchdogRecheckMs);
            return;
          }
          tripped = true;
          overdueEnqueues++;
          console.error(
            `[store] durable enqueue for "${entry.action}" still uncommitted after ${Math.round(elapsed())}ms — IndexedDB is unhealthy; delivery continues, durability is degraded${storageWatchdogHint ? ` (${storageWatchdogHint})` : ""}`,
          );
          storageHealthFn?.(false, elapsed());
        }, delayMs);
      };
      armWatchdog(watchdogMs);
      try {
        await enqueue(entry);
        settled = true;
        if (tripped) {
          overdueEnqueues--;
          // Say so out loud: the trip above was an error line, and without a
          // matching commit line a long stall reads as a permanent wedge.
          console.warn(
            `[store] durable enqueue for "${entry.action}" committed after ${Math.round(elapsed())}ms — storage recovered`,
          );
        }
        // Committed — durability is intact, however long it took. Clear the
        // banner unless another write is still stuck past its deadline.
        if (overdueEnqueues === 0) storageHealthFn?.(true, elapsed());
      } catch (error) {
        settled = true;
        if (tripped) overdueEnqueues--;
        // A rejected durable write is the wedge the banner exists for — the
        // old fast-failure path cleared the watchdog and reported nothing.
        console.error(
          `[store] durable enqueue for "${entry.action}" failed after ${Math.round(elapsed())}ms — delivery continues, durability is degraded`,
          error,
        );
        storageHealthFn?.(false, elapsed());
        throw error;
      } finally {
        settled = true;
        if (watchdog !== undefined) clearTimeout(watchdog);
        pendingOutboxEnqueues--;
      }
      // Coalesce: keep only the newest row per key. Compared by entry ts, not
      // completion order — a stale row that commits late retires itself.
      if (entry.coalesceKey) {
        const prev = coalescedOutboxIds.get(entry.coalesceKey);
        if (prev && prev.id !== entry.id && prev.ts > entry.ts) {
          void retireOutboxEntry(entry.id, null);
        } else {
          coalescedOutboxIds.set(entry.coalesceKey, { id: entry.id, ts: entry.ts });
          if (prev && prev.id !== entry.id) void retireOutboxEntry(prev.id, null);
        }
      }
    };
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
      // twice at once (redelivery is safe — the server dedups — but pointless
      // work isn't).
      if (draining) {
        drainAgain = true;
        return;
      }
      draining = true;
      try {
        const drainGeneration = outboxGeneration;
        const loaded = await capturedLoad();
        assertDispatchCurrent(captured);
        // Coalesce across reloads: rows written by a previous page load can
        // hold several generations of the same key. Keep the newest per key,
        // delete the rest without dispatching them.
        const newestByKey = new Map<string, OutboxEntry>();
        for (const entry of loaded) {
          if (!entry.coalesceKey) continue;
          const cur = newestByKey.get(entry.coalesceKey);
          if (!cur || entry.ts > cur.ts) newestByKey.set(entry.coalesceKey, entry);
        }
        const entries = loaded.filter((entry) => {
          // A row whose command already settled (ack raced the enqueue commit)
          // must not re-dispatch; finish its deferred removal instead.
          if (retiredOutboxIds.has(entry.id)) {
            void retireOutboxEntry(entry.id, null);
            return false;
          }
          if (entry.coalesceKey && newestByKey.get(entry.coalesceKey)?.id !== entry.id) {
            void retireOutboxEntry(entry.id, null);
            return false;
          }
          if (typeof entry.ts === "number" && Date.now() - entry.ts > OUTBOX_MAX_REPLAY_AGE_MS) {
            console.error(
              `[store] dropping ${Math.round((Date.now() - entry.ts) / 86_400_000)}d-old parked "${entry.action}" — too stale to replay`,
              entry.args,
            );
            void retireOutboxEntry(entry.id, null);
            return false;
          }
          return true;
        });
        // The outbox exists to survive a reload that lands in the middle of an
        // in-flight dispatch, AND to re-drive a write the live socket stranded:
        // a flaky connection can exhaust the in-page retry ladder and park
        // the write here with no boot in sight, so we also drain on reconnect.
        // A BOOT replay that fails counts an attempt (capped at
        // MAX_OUTBOX_BOOT_ATTEMPTS for low-stakes writes; must-deliver writes
        // never drop). OPPORTUNISTIC reconnect drains pass countAttempts=false:
        // a failure there leaves the entry exactly as-is, so routine reconnect
        // churn can't burn through a write's boot budget.
        for (const entry of entries) {
          try {
            assertSupportedOutboxOperationSchema(entry);
            const response = await dispatchWithRetry(
              captured.fn,
              entry.action,
              entry.args,
              transformReplayPatches(entry.patches),
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
                unwrapLegacyReceiptActionResponse(entry.action, response, legacyReceiptActions);
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
              if (capturedEnqueue) await enqueueOutbox(capturedEnqueue, disposition.entry);
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
            if (disposition.keep) {
              if (capturedEnqueue) await enqueueOutbox(capturedEnqueue, disposition.entry);
            } else {
              rejectReceiptWaiter(entry.id, e);
              await capturedRemove?.(entry.id);
            }
          }
        }
        // Verify the durable queue after every mutation. The initial snapshot is
        // not sufficient: a failed entry can be re-queued, and a new action can
        // begin enqueueing while this drain is in flight.
        const remaining = await capturedLoad();
        assertDispatchCurrent(captured);
        bootOutboxDrained = remaining.length === 0 &&
          pendingOutboxEnqueues === 0 &&
          drainGeneration === outboxGeneration;
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

    // Wrapping one creator entry. Split out of the build loop so a re-evaluated
    // creator can be rebuilt against THIS closure — see _hotReplaceConfig.
    const wrapAction = (key: string, val: any): any => {
      const isAct = isAction(val);
      const isAsyncAct = isAsyncAction(val);
      const isReceiptAsyncAct = isReceiptAsyncAction(val);
      const isSyn = isSync(val);

      if (!isAct && !isAsyncAct && !isSyn) return val;

      return (...args: any[]) => {
        const actionArgs = normalizeZeroArgumentEventCall(val as Function, args);
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
          const newPending = generateAutoPending(
            patches,
            nextState.pending ?? {},
            maps.isProtectedSyncCollection,
            hideAckFields,
            maps.isUnprotectedField,
          );
          if (newPending) {
            finalState = { ...nextState, pending: newPending };
            // Synthetic patch so IDB persists the updated pending
            finalPatches = [...patches, { op: "replace" as const, path: ["pending"] as (string | number)[], value: newPending }];
          }
        }

        // View-motion guard: an undeclared change of the visible view is
        // reverted before it ever renders.
        if (viewGuard) {
          const viewChanges = viewGuard.fields
            .filter((f) => (state as any)[f] !== (finalState as any)[f])
            .map((f) => ({ field: f, from: (state as any)[f] ?? null, to: (finalState as any)[f] ?? null }));
          const revertFields = viewGuard.audit(viewChanges, key);
          if (revertFields.length > 0) {
            const reverted: Record<string, any> = {};
            for (const f of revertFields) reverted[f] = (state as any)[f];
            finalState = { ...finalState, ...reverted };
            finalPatches = finalPatches.filter((p) => !revertFields.includes(String(p.path[0])));
          }
        }

        set(finalState, true);

        if (idbWriteFn && finalPatches.length > 0) {
          // Synchronous: the storage engine's bulk writes don't block the main
          // thread, and deferring via requestIdleCallback can lose writes if the
          // user reloads before idle (e.g. gesture → reload race).
          void Promise.resolve(idbWriteFn(finalPatches, finalState)).catch((error) => {
            console.error(`[local-first] failed to persist state (action=${key})`, error);
          });
        }

        if ((isAct || isAsyncAct) && actionTeeFn && finalPatches.length > 0) {
          try {
            actionTeeFn(key, finalPatches, finalState);
          } catch (error) {
            console.error(`[local-first] replication tee failed (action=${key})`, error);
          }
        }

        if (isAct || isAsyncAct) {
          const grouped =
            patches.length > 0 ? groupPatchesByTable(patches, finalState, groupCtx) : undefined;
          const outboxId = newOutboxId();
          const usesReceiptEnvelope = isReceiptAsyncAct;
          const returnsPromise = isAsyncAct;
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
          const coalesceKey = outboxCoalesceKeyFor(key, actionArgs, coalesceKeys);
          const entry = {
            id: outboxId,
            action: key,
            args: actionArgs,
            patches: grouped,
            result: dispatchResult,
            operationSchemaVersion: CURRENT_OUTBOX_OPERATION_SCHEMA_VERSION,
            // The outbox replays by this index. Strict monotonicity preserves
            // causal call order even when several dependent actions (create →
            // delete, fork → send) are queued in the same millisecond.
            ts: nextOutboxTimestamp(),
            ...(coalesceKey ? { coalesceKey } : {}),
          };
          const capturedDispatch = dispatchBinding;
          const capturedError = dispatchErrorFn;
          const receiptWaiter = usesReceiptEnvelope ? receiptWaiterFor(outboxId) : null;
          let enqueueCompleted = false;
          // Parked unconditionally — a rewire window (boot, HMR, account
          // switch) can clear the binding while the page stays interactive,
          // and an un-parked action fired in that window would vanish with
          // zero trace.
          const enqueued = outboxEnqueueFn
            ? enqueueOutbox(outboxEnqueueFn, entry).then(() => {
                enqueueCompleted = true;
              })
            : null;
          // Mark handled: consumers below attach their own handlers, but none
          // may exist yet when a storage failure rejects this promise.
          enqueued?.catch(() => {});
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
            // Dispatch fires IMMEDIATELY — the durable enqueue runs in
            // parallel. The outbox is a crash-recovery journal, not a gate:
            // slow or wedged storage degrades durability (surfaced by the
            // enqueue watchdog) but must never delay or strand delivery. The
            // ack-vs-commit race is settled by retireOutboxEntry, which waits
            // for the enqueue before deleting the row; a crash in that window
            // merely replays a command the server dedups (client id for
            // content writes, commandId for receipt actions, LWW for patches).
            const dispatched = dispatchNow();
            const enqueueDurable = () =>
              enqueued ? enqueued.then(() => true, () => false) : Promise.resolve(false);
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
                  } else if (!(await enqueueDurable())) {
                    // Without a committed outbox row there is no future replay
                    // that can resolve an ambiguous response.
                    rejectReceiptWaiter(outboxId, error);
                  }
                }
                // Acknowledgement (including its allowlisted continuation) or
                // a durable rejection is complete. A malformed response or an
                // unavailable continuation runtime is ambiguous, so retain the
                // deduplicated command for a later replay.
                if (completed) {
                  await retireOutboxEntry(outboxId, enqueued);
                  void drainOutbox(false);
                }
              }, async (error) => {
                let current = true;
                try {
                  assertDispatchCurrent(capturedDispatch);
                } catch {
                  current = false;
                }
                // With a durable row, ALL thrown receipt errors are ambiguous.
                // Only a validated rejected receipt is terminal; the durable
                // command row owns version-skew, auth-transition, and
                // transport recovery too.
                if (await enqueueDurable()) {
                  if (!current && dispatchBinding) void drainOutbox(false);
                  return;
                }
                // Durability itself failed (or no outbox was installed). The
                // command cannot honestly remain pending.
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
              await retireOutboxEntry(outboxId, enqueued);
              void drainOutbox(false);
              return r;
            }, async (e) => {
              if (e instanceof StaleDispatchBindingError) throw e;
              assertDispatchCurrent(capturedDispatch);
              // Permanent rejection: the server answered and said no — remove
              // the parked copy so the drain loops don't re-litigate it forever.
              if (isPermanentDispatchError(e)) {
                await retireOutboxEntry(outboxId, enqueued);
                void drainOutbox(false);
              }
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
            // `.then(...)` throw synchronously — a create flow lost its error
            // handler that way and could vanish with no toast and no discard.
            // Reject honestly instead: the caller's catch runs now; a parked
            // entry still delivers via drainOutbox.
            if (returnsPromise) {
              if (usesReceiptEnvelope && receiptWaiter && enqueued) {
                void enqueued.then(
                  () => {
                    // Wiring can race the IndexedDB commit: its boot drain may
                    // have loaded an empty outbox a moment before this row
                    // became visible. Recheck immediately once durability is
                    // confirmed so the caller does not wait for a heartbeat.
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
    };

    const buildWrapped = (cfg: any): Record<string, any> => {
      const out: Record<string, any> = {};
      for (const [key, val] of Object.entries(cfg(set, get, api))) {
        out[key] = wrapAction(key, val);
      }
      return out;
    };

    const wrapped: Record<string, any> = buildWrapped(creator);

    wrapped._setDispatch = (
      fn: DispatchFn | null,
      options?: { owner?: object },
    ) => {
      dispatchEpoch++;
      dispatchBinding = fn
        ? { epoch: dispatchEpoch, fn, owner: options?.owner }
        : null;
      // Drain any persisted outbox entries left by a previous page load.
      if (fn) {
        markOutboxDirty();
        void drainOutbox();
      }
    };

    wrapped._clearDispatch = (owner: object) => {
      if (dispatchBinding?.owner !== owner) return;
      dispatchEpoch++;
      dispatchBinding = null;
    };

    // Opportunistic re-drive: re-attempt every parked dispatch without counting
    // a boot attempt. Wire to reconnect / tab-visible / interval so a write the
    // live socket stranded reaches the server WITHOUT waiting for a reload.
    wrapped._drainOutbox = () => { void drainOutbox(false); };

    // Whether the durable outbox has been replayed once since load — see
    // bootOutboxDrained. Polled by boot-eager reconcile passes, which must not
    // run against a server that hasn't received the writes still parked here.
    wrapped._hasBootOutboxDrained = () => bootOutboxDrained;

    // Whether a dispatch fired right now would actually reach the server.
    // Drain ticks poll it and re-bind when stranded.
    wrapped._isDispatchWired = () => {
      const b = dispatchBinding;
      return !!b && b.epoch === dispatchEpoch;
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
      markOutboxDirty();
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
      // carrying the flag across would tell boot-eager consumers the replay
      // already happened and let them read the server before the new account's
      // parked writes ship — the exact race the flag exists to prevent.
      bootOutboxDrained = false;
      // Receipt waiters intentionally survive a runtime/auth rebind. Their
      // random entry ids can resolve only when that exact principal-scoped
      // outbox row drains again; another account cannot present the row. This
      // keeps a legitimately parked caller pending through token rotation.
    };

    wrapped._setDispatchError = (fn: (action: string, error: unknown, args?: unknown) => void) => {
      dispatchErrorFn = fn;
    };

    // Storage-health signal from the enqueue watchdog: healthy=false while a
    // durable write is stuck past STORAGE_WATCHDOG_MS (or failed outright),
    // healthy=true when writes commit and none are overdue. Delivery is
    // unaffected either way.
    wrapped._setStorageHealth = (fn: ((healthy: boolean, elapsedMs: number) => void) | null) => {
      storageHealthFn = fn;
    };

    wrapped._setActionTee = (fn: ((actionName: string, patches: Patch[], state: any) => void) | null) => {
      actionTeeFn = fn;
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

    // Police raw setState (writes from outside action()/sync()): the guarded
    // fields obey the same declare-or-revert rule as store actions. The
    // middleware's internal `set` is the pre-wrap reference, so action writes
    // (already audited via patches above) are not double-counted. Functional
    // partials are exempt — object literals are the only raw write shape for
    // guarded fields.
    if (viewGuard) {
      const origSetState = api.setState;
      api.setState = (partial: any, replace?: boolean) => {
        if (partial && typeof partial === "object") {
          const prev = get();
          const touched = viewGuard.fields
            .filter((f) => f in partial && partial[f] !== prev[f])
            .map((f) => ({ field: f, from: prev[f] ?? null, to: partial[f] ?? null }));
          const revert = viewGuard.audit(touched, "setState");
          if (revert.length > 0) {
            partial = { ...partial };
            for (const f of revert) delete partial[f];
          }
        }
        return origSetState(partial, replace);
      };
    }

    // Dev hot swap: rebuild every action from a freshly evaluated creator
    // WITHOUT rebuilding this closure, so the dispatch binding, its epoch, IDB
    // write-through, the durable outbox and any pending receipt waiters all
    // survive the swap. Only functions and state keys that did not exist before
    // are applied — live data is left exactly as it is, so an edit to an action
    // costs no reload and no refetch.
    wrapped._hotReplaceConfig = (nextConfig: any) => {
      const next = buildWrapped(nextConfig);
      const current = get();
      const patch: Record<string, any> = {};
      for (const [key, val] of Object.entries(next)) {
        if (typeof val === "function" || !(key in current)) patch[key] = val;
      }
      set(patch);
    };

    return wrapped;
  };
}
