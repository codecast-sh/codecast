import { create } from "zustand";

type MutationFn = (id: string, fields: Record<string, any>) => Promise<any>;

interface ConvexCacheState {
  _pending: Record<string, Record<string, any>>;
  _mutations: Record<string, MutationFn>;
}

export const useConvexCacheStore = create<ConvexCacheState>(() => ({
  _pending: {},
  _mutations: {},
}));

export function registerMutation(table: string, fn: MutationFn): void {
  useConvexCacheStore.getState()._mutations[table] = fn;
}

export function patch(table: string, id: string, fields: Record<string, any>): void {
  const store = useConvexCacheStore.getState();
  const prev = store._pending[id] || {};
  store._pending[id] = { ...prev, ...fields };

  const mutationFn = store._mutations[table];
  if (mutationFn) {
    mutationFn(id, fields).catch(() => {
      const current = useConvexCacheStore.getState()._pending[id];
      if (!current) return;
      const rolled: Record<string, any> = { ...current };
      for (const key of Object.keys(fields)) {
        if (prev[key] !== undefined) {
          rolled[key] = prev[key];
        } else {
          delete rolled[key];
        }
      }
      if (Object.keys(rolled).length === 0) {
        delete useConvexCacheStore.getState()._pending[id];
      } else {
        useConvexCacheStore.getState()._pending[id] = rolled;
      }
    });
  }
}

export function apply<T extends { _id: string }>(doc: T): T {
  const pending = useConvexCacheStore.getState()._pending[doc._id];
  if (!pending) return doc;
  return { ...doc, ...pending };
}

export function confirm(id: string): void {
  delete useConvexCacheStore.getState()._pending[id];
}
