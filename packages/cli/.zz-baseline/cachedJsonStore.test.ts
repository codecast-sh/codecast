import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CachedJsonStore } from "./cachedJsonStore.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cjs-"));
  file = path.join(dir, "store.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (): Record<string, unknown> | null =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;

// A debounced flush is a timer plus an async write, so any fixed sleep races it
// on a loaded machine. Poll for the file instead and let the ceiling be generous:
// a real regression still fails, only the flake goes away.
const readFlushed = async (timeoutMs = 2000): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const disk = read();
    if (disk) return disk;
    if (Date.now() > deadline) throw new Error(`store never flushed to ${file}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("CachedJsonStore", () => {
  it("reads back values written in-memory without touching disk first", () => {
    const store = new CachedJsonStore<number>({ filePath: file, flushDelayMs: 10_000 });
    store.set("a", 1);
    store.set("b", 2);
    // Long debounce + no flush yet → disk untouched, but reads hit the cache.
    expect(read()).toBeNull();
    expect(store.get("a")).toBe(1);
    expect(store.get("b")).toBe(2);
    expect(store.has("a")).toBe(true);
    expect(store.has("z")).toBe(false);
  });

  it("does NOT rewrite the file synchronously on every mutation", async () => {
    const store = new CachedJsonStore<number>({ filePath: file, flushDelayMs: 5 });
    for (let i = 0; i < 100; i++) store.set(`k${i}`, i);
    // Still nothing on disk synchronously — the whole burst coalesces into one flush.
    expect(read()).toBeNull();
    const disk = await readFlushed();
    expect(Object.keys(disk).length).toBe(100);
    expect(disk.k42).toBe(42);
  });

  it("flushSync persists pending journal and reload sees it", () => {
    const store = new CachedJsonStore<number>({ filePath: file, flushDelayMs: 10_000 });
    store.set("a", 1);
    store.set("b", 2);
    store.flushSync();
    expect(read()).toEqual({ a: 1, b: 2 });

    const reloaded = new CachedJsonStore<number>({ filePath: file });
    expect(reloaded.get("a")).toBe(1);
    expect(reloaded.get("b")).toBe(2);
  });

  it("delete removes a key and the deletion persists", () => {
    fs.writeFileSync(file, JSON.stringify({ a: 1, b: 2 }));
    const store = new CachedJsonStore<number>({ filePath: file, flushDelayMs: 10_000 });
    expect(store.get("a")).toBe(1);
    store.delete("a");
    expect(store.has("a")).toBe(false);
    store.flushSync();
    expect(read()).toEqual({ b: 2 });
  });

  it("prunes entries rejected by keepOnLoad and persists the prune", () => {
    fs.writeFileSync(file, JSON.stringify({ live: 1, dead: 2, alsoDead: 3 }));
    const store = new CachedJsonStore<number>({
      filePath: file,
      flushDelayMs: 10_000,
      keepOnLoad: (k) => k === "live",
    });
    // Pruned immediately in memory…
    expect(store.has("dead")).toBe(false);
    expect(store.get("live")).toBe(1);
    // …and the prune is journaled, so flush writes the slim file.
    store.flushSync();
    expect(read()).toEqual({ live: 1 });
  });

  it("merge-on-flush preserves a concurrent external write to an untouched key", () => {
    fs.writeFileSync(file, JSON.stringify({ a: 1 }));
    const store = new CachedJsonStore<number>({ filePath: file, flushDelayMs: 10_000 });
    store.get("a"); // load
    store.set("b", 2); // our change

    // Another process appends key "c" to the same file before we flush.
    fs.writeFileSync(file, JSON.stringify({ a: 1, c: 99 }));

    store.flushSync();
    // Our "b" is written, the external "c" survives, and "a" is intact.
    expect(read()).toEqual({ a: 1, b: 2, c: 99 });
  });

  it("survives a corrupt file by starting empty", () => {
    fs.writeFileSync(file, "{ this is not json");
    const store = new CachedJsonStore<number>({ filePath: file, flushDelayMs: 10_000 });
    expect(store.get("a")).toBeUndefined();
    store.set("a", 1);
    store.flushSync();
    expect(read()).toEqual({ a: 1 });
  });

  it("async debounced flush coalesces a burst into a single durable write", async () => {
    const store = new CachedJsonStore<number>({ filePath: file, flushDelayMs: 5 });
    store.set("a", 1);
    await new Promise((r) => setTimeout(r, 20));
    store.set("b", 2);
    // Poll rather than sleep a fixed 20ms: the debounce timer competes with
    // suite load, and a fixed wait loses that race just often enough to flake
    // the deploy gate. The deadline is generous; the pass condition is exact.
    const deadline = Date.now() + 2000;
    let last: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      last = read();
      if (last && last.a === 1 && last.b === 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(last).toEqual({ a: 1, b: 2 });
  });
});

it("asynchronous pruning yields, bounds concurrency, and retains failed checks", async () => {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]))));
  let active = 0;
  let peak = 0;
  let checked = 0;
  const store = new CachedJsonStore<number>({
    filePath: file,
    flushDelayMs: 10000,
    keepOnLoadAsync: async (key) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => setImmediate(resolve));
      active--;
      checked++;
      if (key === "k1") throw new Error("transient I/O failure");
      return key === "k0";
    },
  });
  expect(store.get("k0")).toBe(0);
  expect(checked).toBe(0);
  await store.prune();
  expect(peak).toBeLessThanOrEqual(16);
  expect(checked).toBe(80);
  expect(store.getAll()).toEqual({ k0: 0, k1: 1 });
  store.flushSync();
  expect(read()).toEqual({ k0: 0, k1: 1 });
});

it("a delayed prune cannot delete a newer write, even after its journal flushed", async () => {
  fs.writeFileSync(file, JSON.stringify({ same: 1, changed: 2, deleted: 3, dead: 4 }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const store = new CachedJsonStore<number>({
    filePath: file,
    flushDelayMs: 10000,
    keepOnLoadAsync: async () => { started(); await gate; return false; },
  });
  store.getAll();
  await begun;
  store.set("same", 1);
  store.set("changed", 20);
  store.delete("deleted");
  store.set("added", 5);
  store.flushSync();
  release();
  await store.prune();
  store.flushSync();
  expect(read()).toEqual({ same: 1, changed: 20, added: 5 });
});
