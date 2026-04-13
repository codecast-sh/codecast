import { create as mutativeCreate, type Patch } from "mutative";

type DispatchFn = (action: string, args: any, patches?: any, result?: any) => Promise<any>;
type IDBWriteFn = (patches: Patch[], state: any) => void;

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

type TableKind = "collection" | "singleton";

interface TableMapping {
  table: string;
  kind: TableKind;
}

const TABLE_MAP: Record<string, TableMapping> = {
  conversations: { table: "conversations", kind: "collection" },
  clientState: { table: "client_state", kind: "singleton" },
};

// Top-level store keys that dispatch as fields within a singleton table.
// On patch, sends the full current value of the key (not granular sub-patches).
const FIELD_TO_TABLE: Record<string, { table: string }> = {
  tabs: { table: "client_state" },
  activeTabId: { table: "client_state" },
};

const SINGLETON_KEY = "_";

// Store keys that receive server sync data. The middleware auto-generates
// pending entries when action() modifies these collections, preventing
// server sync from overwriting local-first state.
const PROTECTED_COLLECTIONS = new Set([
  "sessions", "dismissedSessions", "conversations", "tasks",
]);

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
    if (storeKey === "pending" || !PROTECTED_COLLECTIONS.has(storeKey)) continue;

    const recordId = String(path[1]);

    if (patch.op === "remove" && path.length === 2) {
      // Record deleted from collection → exclude from server sync
      if (!result) result = { ...currentPending };
      result[`${storeKey}:${recordId}`] = { type: "exclude", ts: now };
    } else if (patch.op === "add" && path.length === 2) {
      // Record added to collection → include (keep until server acknowledges)
      if (!result) result = { ...currentPending };
      result[`${storeKey}:${recordId}`] = { type: "include", ts: now };
    } else if ((patch.op === "replace" || patch.op === "add") && path.length >= 3) {
      // Field modified on a collection record → protect field value
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
    if (patch.op !== "replace" && patch.op !== "add") continue;
    const path = patch.path as (string | number)[];
    if (path.length < 1) continue;

    const storeKey = String(path[0]);

    const fieldMapping = FIELD_TO_TABLE[storeKey];
    if (fieldMapping && state) {
      result[fieldMapping.table] ??= {};
      result[fieldMapping.table][SINGLETON_KEY] ??= {};
      result[fieldMapping.table][SINGLETON_KEY][storeKey] = state[storeKey];
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
      const field = String(path[2]);
      const nested = path.slice(3);

      result[table][docId] ??= {};
      if (nested.length === 0) {
        result[table][docId][field] = patch.value;
      } else {
        result[table][docId][field] = setNested(
          result[table][docId][field] ?? {},
          nested,
          patch.value
        );
      }
    } else {
      const field = String(path[1]);
      const nested = path.slice(2);

      result[table][SINGLETON_KEY] ??= {};
      if (nested.length === 0) {
        result[table][SINGLETON_KEY][field] = patch.value;
      } else {
        result[table][SINGLETON_KEY][field] = setNested(
          result[table][SINGLETON_KEY][field] ?? {},
          nested,
          patch.value
        );
      }
    }
  }

  return result;
}

const RETRY_DELAYS = [1000, 2000, 4000];

async function dispatchWithRetry(
  fn: DispatchFn,
  action: string,
  args: any,
  grouped: any,
  result: any,
  onError?: (action: string, error: unknown) => void,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(action, args, grouped, result);
    } catch (e) {
      if (attempt >= RETRY_DELAYS.length) {
        onError?.(action, e);
        throw e;
      }
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
}

export function mutativeMiddleware(config: any): any {
  return (set: any, get: any, api: any) => {
    let dispatchFn: DispatchFn | null = null;
    let idbWriteFn: IDBWriteFn | null = null;
    let dispatchErrorFn: ((action: string, error: unknown) => void) | undefined;

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

        set(finalState, true);

        if (idbWriteFn && finalPatches.length > 0) {
          const fn = idbWriteFn;
          const p = finalPatches;
          const s = finalState;
          (typeof requestIdleCallback === "function" ? requestIdleCallback : setTimeout)(() => fn(p, s));
        }

        if ((isAct || isAsyncAct) && dispatchFn) {
          const grouped =
            patches.length > 0 ? groupPatchesByTable(patches, finalState) : undefined;
          const promise = dispatchWithRetry(
            dispatchFn, key, args, grouped, returnValue, dispatchErrorFn,
          );
          if (isAsyncAct) return promise;
          promise.catch(() => {});
        }

        return returnValue;
      };
    }

    wrapped._setDispatch = (fn: DispatchFn) => {
      dispatchFn = fn;
    };

    wrapped._setIDBWrite = (fn: IDBWriteFn) => {
      idbWriteFn = fn;
    };

    wrapped._setDispatchError = (fn: (action: string, error: unknown) => void) => {
      dispatchErrorFn = fn;
    };

    wrapped._dispatch = (action: string, args: any, patches?: any, result?: any) => {
      if (!dispatchFn) return Promise.reject(new Error("Dispatch not wired"));
      const safeArgs = Array.isArray(args) ? args.map((a: any) => a === undefined ? null : a) : args;
      return dispatchWithRetry(dispatchFn, action, safeArgs, patches, result, dispatchErrorFn);
    };

    return wrapped;
  };
}
