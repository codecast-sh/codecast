import { create as mutativeCreate, type Patch } from "mutative";

type DispatchFn = (action: string, args: any, patches?: any, result?: any) => Promise<any>;
type IDBWriteFn = (patches: Patch[], state: any) => void;

const ACTION_FLAG = Symbol("action");
const SYNC_FLAG = Symbol("sync");

export function action<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ACTION_FLAG] = true;
  return fn;
}

export function sync<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[SYNC_FLAG] = true;
  return fn;
}

function isAction(fn: any): boolean {
  return typeof fn === "function" && fn[ACTION_FLAG] === true;
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

const SINGLETON_KEY = "_";

function setNested(obj: any, path: (string | number)[], value: any): any {
  if (path.length === 0) return value;
  const result = typeof obj === "object" && obj !== null ? { ...obj } : {};
  const [head, ...tail] = path;
  result[head] = setNested(result[head], tail, value);
  return result;
}

export function groupPatchesByTable(
  patches: Patch[]
): Record<string, Record<string, Record<string, any>>> {
  const result: Record<string, Record<string, Record<string, any>>> = {};

  for (const patch of patches) {
    if (patch.op !== "replace" && patch.op !== "add") continue;
    const path = patch.path as (string | number)[];
    if (path.length < 2) continue;

    const storeKey = String(path[0]);
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

export function mutativeMiddleware(config: any): any {
  return (set: any, get: any, api: any) => {
    let dispatchFn: DispatchFn | null = null;
    let idbWriteFn: IDBWriteFn | null = null;

    const rawStore = config(set, get, api);

    const wrapped: Record<string, any> = {};

    for (const [key, val] of Object.entries(rawStore)) {
      const isAct = isAction(val);
      const isSyn = isSync(val);

      if (!isAct && !isSyn) {
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
        set(nextState, true);

        if (idbWriteFn && patches.length > 0) {
          const fn = idbWriteFn;
          const p = patches;
          const s = nextState;
          (typeof requestIdleCallback === "function" ? requestIdleCallback : setTimeout)(() => fn(p, s));
        }

        if (isAct && dispatchFn) {
          const grouped =
            patches.length > 0 ? groupPatchesByTable(patches) : undefined;
          dispatchFn(key, args, grouped, returnValue).catch(() => {});
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

    wrapped._dispatch = (action: string, args: any, patches?: any, result?: any) => {
      if (!dispatchFn) return Promise.reject(new Error("Dispatch not wired"));
      const safeArgs = Array.isArray(args) ? args.map((a: any) => a === undefined ? null : a) : args;
      return dispatchFn(action, safeArgs, patches, result);
    };

    return wrapped;
  };
}
