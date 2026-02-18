import { create } from "zustand";

type MutationFn = (id: string, fields: Record<string, any>) => Promise<any>;

interface ConvexCacheState {
  _pending: Record<string, Record<string, any>>;
  _mutations: Record<string, MutationFn>;
  _drafts: Record<string, Record<string, any>>;
}

export const useConvexCacheStore = create<ConvexCacheState>(() => ({
  _pending: {},
  _mutations: {},
  _drafts: {},
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

export function setDraft(id: string, fields: Record<string, any>): void {
  console.log('[DRAFT] setDraft', id.slice(-8), fields);
  useConvexCacheStore.getState()._drafts[id] = fields;
}

export function getDraft(id: string): Record<string, any> | undefined {
  const val = useConvexCacheStore.getState()._drafts[id];
  console.log('[DRAFT] getDraft', id.slice(-8), val ? 'HIT' : 'MISS', val);
  return val;
}

export function clearDraft(id: string): void {
  console.log('[DRAFT] clearDraft', id.slice(-8));
  delete useConvexCacheStore.getState()._drafts[id];
}

export function apply<T extends { _id: string }>(doc: T): T {
  const pending = useConvexCacheStore.getState()._pending[doc._id];
  if (!pending) return doc;
  return { ...doc, ...pending };
}

export function confirm(id: string): void {
  delete useConvexCacheStore.getState()._pending[id];
}
