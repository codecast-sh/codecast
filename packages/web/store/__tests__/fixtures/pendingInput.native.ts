import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
const disk = new Map<string, string>();
(globalThis as any).__CODECAST_TEST_KV_STORAGE__ = {
  getItem: async (key: string) => disk.get(key) ?? null,
  setItem: async (key: string, value: string) => { disk.set(key, value); },
  removeItem: async (key: string) => { disk.delete(key); },
  multiGet: async (keys: string[]) => keys.map(key => [key, disk.get(key) ?? null]),
  getItemSync: (key: string) => disk.get(key) ?? null,
  setItemSync: (key: string, value: string) => { disk.set(key, value); },
  getAllKeysSync: () => [...disk.keys()],
  removeItemSync: (key: string) => { disk.delete(key); },
};
const { persistPendingMessageChanges, loadCache } = await import("../../idbCache.native");
const input = { c: [{ _id: "input", _clientId: "input", role: "user", content: "retain on native restart", timestamp: 1 }] };
persistPendingMessageChanges({}, input, "owner");
expect(disk.size).toBe(1);
expect((await loadCache(["pendingMessages"], { currentUser: { _id: "owner" } }))?.pendingMessages).toEqual(input);
expect((await loadCache(["pendingMessages"], { currentUser: { _id: "other" } }))?.pendingMessages).toEqual({});
persistPendingMessageChanges(input, {}, "owner");
persistPendingMessageChanges(input, { c: [{ ...input.c[0], _isQueued: true }] }, "owner");
expect((await loadCache(["pendingMessages"], { currentUser: { _id: "owner" } }))?.pendingMessages).toEqual({});
if (process.argv[2]) writeFileSync(process.argv[2], "native storage assertions completed");
console.log("native synchronous persistence, restart, account isolation and stale replay verified");
