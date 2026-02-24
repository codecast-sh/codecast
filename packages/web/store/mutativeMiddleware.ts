import { create as mutativeCreate, apply, type Patch } from "mutative";

type DispatchFn = (action: string, args: any, patches?: any) => Promise<any>;

const ACTION_FLAG = Symbol("action");

export function action<T extends (...args: any[]) => any>(fn: T): T {
  (fn as any)[ACTION_FLAG] = true;
  return fn;
}

function isAction(fn: any): boolean {
  return typeof fn === "function" && fn[ACTION_FLAG] === true;
}

const TABLE_KEY_MAP: Record<string, string> = {
  conversations: "conversations",
  clientState: "client_state",
};

function groupPatchesByTable(
  patches: Patch[]
): Record<string, Record<string, Record<string, any>>> {
  const result: Record<string, Record<string, Record<string, any>>> = {};
  for (const patch of patches) {
    if (patch.op !== "replace" && patch.op !== "add") continue;
    const path = patch.path as (string | number)[];
    const [storeKey, docId, field, ...rest] = path;
    if (typeof storeKey !== "string" || !docId || !field || rest.length > 0)
      continue;
    const table = TABLE_KEY_MAP[storeKey];
    if (!table) continue;
    result[table] ??= {};
    result[table][String(docId)] ??= {};
    result[table][String(docId)][String(field)] = patch.value;
  }
  return result;
}

export function mutativeMiddleware(config: any): any {
  return (set: any, get: any, api: any) => {
    let dispatchFn: DispatchFn | null = null;

    const rawStore = config(set, get, api);

    const wrapped: Record<string, any> = {};

    for (const [key, val] of Object.entries(rawStore)) {
      if (!isAction(val)) {
        wrapped[key] = val;
        continue;
      }

      wrapped[key] = (...args: any[]) => {
        const state = get();
        const [nextState, patches, inversePatches] = mutativeCreate(
          state,
          (draft: any) => {
            (val as Function).apply(draft, args);
          },
          { enablePatches: { pathAsArray: true } }
        );
        set(nextState, true);

        if (!dispatchFn) return;

        const grouped =
          patches.length > 0 ? groupPatchesByTable(patches) : undefined;
        return dispatchFn(key, args, grouped).catch(() => {
          set(apply(get(), inversePatches), true);
        });
      };
    }

    wrapped._setDispatch = (fn: DispatchFn) => {
      dispatchFn = fn;
    };

    wrapped._dispatch = (action: string, args: any, patches?: any) => {
      if (!dispatchFn) return Promise.reject(new Error("Dispatch not wired"));
      return dispatchFn(action, args, patches);
    };

    return wrapped;
  };
}
