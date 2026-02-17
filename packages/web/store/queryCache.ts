import { create } from "zustand";

interface QueryCacheState {
  _data: Record<string, any>;
}

export const useQueryCacheStore = create<QueryCacheState>(() => ({
  _data: {},
}));

export function getCached<T = any>(key: string): T | undefined {
  return useQueryCacheStore.getState()._data[key];
}

export function setCached(key: string, value: any): void {
  useQueryCacheStore.getState()._data[key] = value;
}

export function invalidateCached(key: string): void {
  delete useQueryCacheStore.getState()._data[key];
}
