import { describe, it, expect, beforeEach } from "bun:test";
import { EMPTY_PM_DOC, isFreshDoc, noteFreshDoc, writeDocSyncCache } from "../docSyncCache";

const store = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

describe("docSyncCache", () => {
  beforeEach(() => store.clear());

  it("writes the prosemirror-sync cache shape the library reads", () => {
    writeDocSyncCache("d1", { type: "doc" }, 7);
    expect(JSON.parse(store.get("convex-sync-d1")!)).toEqual({ content: { type: "doc" }, version: 7 });
  });

  it("seeds an empty v1 snapshot only for docs created empty, and marks both fresh", () => {
    noteFreshDoc("empty", { empty: true });
    noteFreshDoc("filled", { empty: false });
    expect(JSON.parse(store.get("convex-sync-empty")!)).toEqual({ content: EMPTY_PM_DOC, version: 1 });
    expect(store.has("convex-sync-filled")).toBe(false);
    expect(isFreshDoc("empty")).toBe(true);
    expect(isFreshDoc("filled")).toBe(true);
    expect(isFreshDoc("unknown")).toBe(false);
  });

  it("forgets freshness after the TTL", () => {
    store.set("fresh-doc-old", String(Date.now() - 11 * 60 * 1000));
    expect(isFreshDoc("old")).toBe(false);
  });
});
