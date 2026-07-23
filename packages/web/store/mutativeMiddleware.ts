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

type DispatchFn = (action: string, args: any, patches?: any, result?: any) => Promise<any>;
type MaybePromise<T> = T | Promise<T>;
type IDBWriteFn = (patches: Patch[], state: any) => MaybePromise<void>;
type OutboxEntry = { id: string; action: string; args: any; patches: any; result: any; ts: number; attempts?: number };
type OutboxEnqueueFn = (entry: OutboxEntry) => MaybePromise<void>;
type OutboxRemoveFn = (id: string) => MaybePromise<void>;
type OutboxLoadFn = () => Promise<OutboxEntry[]>;
type DispatchBinding = {
  epoch: number;
  fn: DispatchFn;
  owner?: object;
  authorization?: DispatchAuthorizationCapture;
};

export class StaleDispatchBindingError extends Error {
  constructor() {
    super("Dispatch binding changed while work was in flight");
    this.name = "StaleDispatchBindingError";
  }
}

const ACTION_FLAG = Symbol("action");
const ASYNC_ACTION_FLAG = Symbol("asyncAction");
const SYNC_FLAG = Symbol("sync");

export function action<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ACTION_FLAG] = true;
  return fn;
}

/** Like action(), but returns a Promise that resolves to the server dispatch result. */
export function asyncAction<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ASYNC_ACTION_FLAG] = true;
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
export const MUST_DELIVER_ACTIONS = new Set(["sendMessage"]);

// What to do with an outbox entry whose boot-time replay failed: keep it for
// the next boot with the attempt counted, or give up at the cap. User sends
// are never dropped — see MUST_DELIVER_ACTIONS.
export function outboxFailureDisposition(entry: OutboxEntry): { keep: boolean; entry: OutboxEntry } {
  const attempts = (entry.attempts ?? 0) + 1;
  const mustDeliver = MUST_DELIVER_ACTIONS.has(entry.action);
  return { keep: mustDeliver || attempts < MAX_OUTBOX_BOOT_ATTEMPTS, entry: { ...entry, attempts } };
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

export function mutativeMiddleware(config: any, opts?: { retryDelays?: number[] }): any {
  const retryDelays = opts?.retryDelays ?? RETRY_DELAYS;
  return (set: any, get: any, api: any) => {
    let dispatchBinding: DispatchBinding | null = null;
    let dispatchEpoch = 0;
    let idbWriteFn: IDBWriteFn | null = null;
    let dispatchErrorFn: ((action: string, error: unknown, args?: unknown) => void) | undefined;
    let outboxEnqueueFn: OutboxEnqueueFn | null = null;
    let outboxRemoveFn: OutboxRemoveFn | null = null;
    let outboxLoadFn: OutboxLoadFn | null = null;

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

    let draining = false;
    let drainAgain = false;
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
            await dispatchWithRetry(
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
            await capturedRemove?.(entry.id);
          } catch (e) {
            if (e instanceof StaleDispatchBindingError) return;
            assertDispatchCurrent(captured);
            // Reported via dispatchErrorFn.
            // A permanent rejection IS delivery — the server ran the write and
            // refused it. Re-driving it every boot/reconnect/interval tick can
            // only repeat the refusal (this loop hammered a "Not authorized"
            // setSessionModel 4× per 30s drain), so drop it regardless of the
            // must-deliver/boot-cap retention rules below, which exist for
            // writes the server never answered.
            if (isPermanentDispatchError(e)) {
              await capturedRemove?.(entry.id);
              continue;
            }
            if (!countAttempts) continue;
            const disposition = outboxFailureDisposition(entry);
            assertDispatchCurrent(captured);
            if (disposition.keep) await capturedEnqueue?.(disposition.entry);
            else await capturedRemove?.(entry.id);
          }
        }
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
      const isSyn = isSync(val);

      if (!isAct && !isAsyncAct && !isSyn) {
        wrapped[key] = val;
        continue;
      }

      wrapped[key] = (...args: any[]) => {
        const state = get();
        let returnValue: any;
        const [nextState, patches] = mutativeCreate(
          state,
          (draft: any) => {
            returnValue = (val as Function).apply(draft, args);
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
            console.error("[local-first] failed to persist legacy compatibility state", error);
          });
        }

        if (isAct || isAsyncAct) {
          const grouped =
            patches.length > 0 ? groupPatchesByTable(patches, finalState) : undefined;
          const outboxId = newOutboxId();
          // Persist the outbound dispatch *before* firing so it survives a
          // reload mid-flight. Removed only on server acknowledgment; failed
          // dispatches stay queued and re-fire on next hydrate via drainOutbox.
          // Enqueued even when dispatchFn isn't wired yet — drainOutbox picks
          // them up the moment _setDispatch runs.
          const entry = {
            id: outboxId,
            action: key,
            args,
            patches: grouped,
            result: returnValue,
            ts: Date.now(),
          };
          // The server call is chained behind the durable enqueue. A storage
          // failure therefore cannot create an effect that has no replayable
          // local record. (`action()` remains memory-first only as a temporary
          // compatibility path; v2 materialized commands use LocalFirstEngine.)
          const capturedDispatch = dispatchBinding;
          const capturedRemove = outboxRemoveFn;
          const capturedError = dispatchErrorFn;
          if (capturedDispatch) {
            const dispatchNow = () => dispatchWithRetry(
              capturedDispatch.fn,
              key,
              args,
              grouped,
              returnValue,
              capturedError,
              retryDelays,
              () => assertDispatchCurrent(capturedDispatch),
            );
            // The compatibility store historically invokes a wired dispatch
            // synchronously (up to its first await). Preserve that behavior
            // when no durable outbox is installed; callers and tests observe
            // the dispatch in the same turn. Once an outbox is installed,
            // dispatch stays strictly behind its durable enqueue.
            const dispatched = outboxEnqueueFn
              ? Promise.resolve(outboxEnqueueFn(entry)).then(dispatchNow)
              : dispatchNow();
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
            if (isAsyncAct) return promise;
            promise.catch(() => {});
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
