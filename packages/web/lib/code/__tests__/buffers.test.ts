import { describe, expect, it } from "bun:test";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import {
  BufferCache,
  MAX_BUFFER_CHARS,
  MAX_CLEAN_BUFFERS,
  bufferKey,
  decodeFileText,
  utf8Length,
  encodeFileText,
  isDirty,
  savedDocField,
  setSavedDoc,
  updateBuffer,
} from "../buffers";

const open = (cache: BufferCache, path: string, content = `${path}\n`) =>
  cache.open({ vaultId: "v1", path, content, etag: `e-${path}`, extensions: () => history() });

describe("BufferCache", () => {
  it("returns the same buffer, state and all, for a file opened again", () => {
    const cache = new BufferCache();
    const a = open(cache, "a.ts");
    updateBuffer(a, { changes: { from: 0, insert: "x" }, selection: { anchor: 1 } });
    const again = open(cache, "a.ts", "ignored: the buffer exists");
    expect(again).toBe(a);
    expect(again.state.doc.toString()).toBe("xa.ts\n");
    expect(again.state.selection.main.head).toBe(1);
  });

  it("keeps undo history across a reopen", () => {
    const cache = new BufferCache();
    const a = open(cache, "a.ts", "hello");
    updateBuffer(a, { changes: { from: 5, insert: " world" } });
    let state = open(cache, "a.ts").state;
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.toString()).toBe("hello");
  });

  it("evicts the least recently used clean buffers past the limit", () => {
    const cache = new BufferCache(3);
    const a = open(cache, "a");
    const b = open(cache, "b");
    const c = open(cache, "c");
    cache.touch(a);
    open(cache, "d");
    expect(cache.get(b.key)).toBeUndefined();
    expect(cache.get(a.key)).toBe(a);
    expect(cache.get(c.key)).toBe(c);
  });

  it("30 tabs with three 12M-character files, then 40 more: both bounds hold and every eviction lets go", () => {
    const cache = new BufferCache();
    const dropped: string[] = [];
    cache.onDrop = (b) => dropped.push(b.path);
    const chars = () => cache.all().reduce((n, b) => n + b.state.doc.length, 0);
    const big = "x".repeat(120) + "\n";
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 30; i++) open(cache, `f${i}.ts`, i % 10 === 0 ? big.repeat(100_000) : "y".repeat(50_000));
    // 36M characters in 30 buffers: inside both limits, nothing goes.
    expect(cache.all().length).toBe(30);
    expect(dropped).toEqual([]);
    for (let i = 30; i < 70; i++) open(cache, `f${i}.ts`, i % 10 === 0 ? big.repeat(100_000) : "y".repeat(50_000));
    expect(cache.all().length).toBeLessThanOrEqual(MAX_CLEAN_BUFFERS);
    expect(chars()).toBeLessThanOrEqual(MAX_BUFFER_CHARS);
    expect(dropped.length).toBe(70 - cache.all().length);
    // The oldest went first.
    expect(dropped[0]).toBe("f0.ts");
    const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    console.log(`[buffers] ${cache.all().length} held, ${(chars() / 1e6).toFixed(1)}M chars, heap +${heapMb.toFixed(0)} MB`);
    cache.close("missing");
    expect(dropped.length).toBe(70 - cache.all().length);
  });

  it("evicts clean off-screen buffers past the total document size, oldest first", () => {
    const cache = new BufferCache(40, 100);
    const a = open(cache, "a", "x".repeat(40));
    const b = open(cache, "b", "x".repeat(40));
    a.dirty = true;
    const c = open(cache, "c", "x".repeat(30));
    // 110 characters: the oldest clean buffer goes, the unsaved one stays.
    expect(cache.get(b.key)).toBeUndefined();
    expect(cache.get(a.key)).toBe(a);
    expect(cache.get(c.key)).toBe(c);
    // Only unsaved and new text left over the bound: nothing more to drop.
    const d = open(cache, "d", "x".repeat(90));
    expect(cache.get(c.key)).toBeUndefined();
    expect([a, d].every((x) => cache.get(x.key) === x)).toBe(true);
  });

  it("never evicts a dirty, stale or on-screen buffer", () => {
    const cache = new BufferCache(2);
    const a = open(cache, "a");
    a.dirty = true;
    const b = open(cache, "b");
    b.view = { state: b.state } as never;
    const c = open(cache, "c");
    c.stale = { content: "", etag: "x", mtime: 0 };
    open(cache, "d");
    open(cache, "e");
    expect([a, b, c].every((x) => cache.get(x.key) === x)).toBe(true);
    expect(cache.get(bufferKey("v1", "d"))).toBeUndefined();
    expect(cache.dirty()).toEqual([a]);
  });
});

describe("dirty", () => {
  it("compares the document with the saved version, clean again after undo", () => {
    let state = EditorState.create({ doc: "abc", extensions: [savedDocField, history()] });
    expect(isDirty(state)).toBe(false);
    state = state.update({ changes: { from: 3, insert: "d" } }).state;
    expect(isDirty(state)).toBe(true);
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(isDirty(state)).toBe(false);
  });

  it("moves with setSavedDoc", () => {
    let state = EditorState.create({ doc: "abc", extensions: savedDocField });
    state = state.update({ changes: { from: 0, insert: "z" } }).state;
    state = state.update({ effects: setSavedDoc.of(state.doc) }).state;
    expect(isDirty(state)).toBe(false);
  });
});

describe("file text", () => {
  it("round-trips LF, CRLF, a byte order mark and an empty file byte for byte", () => {
    const cache = new BufferCache();
    for (const content of ["a\r\nb\r\n", "﻿a\nb", "only", "", "a\nb\n"]) {
      const b = cache.open({ vaultId: "v", path: JSON.stringify(content), content, etag: "e", extensions: () => [] });
      expect(encodeFileText(b.state)).toBe(content);
    }
  });

  it("writes new lines in a CRLF file as CRLF", () => {
    const cache = new BufferCache();
    const b = cache.open({ vaultId: "v", path: "w.txt", content: "a\r\nb\r\n", etag: "e", extensions: () => [] });
    updateBuffer(b, { changes: { from: 1, insert: "\nnew" } });
    expect(encodeFileText(b.state)).toBe("a\r\nnew\r\nb\r\n");
  });

  it("follows the majority separator in a mixed file", () => {
    expect(decodeFileText("a\r\nb\r\nc\n").format.lineSeparator).toBe("\r\n");
    expect(decodeFileText("a\nb\r\nc\n").format).toEqual({ lineSeparator: "\n", bom: false, lossy: false });
  });

  it("reads a dropped byte order mark and a foreign encoding off the file's size", () => {
    expect(decodeFileText("a\n", 5).format.bom).toBe(true);
    expect(decodeFileText("a\n", 2).format.bom).toBe(false);
    expect(decodeFileText("h\u00e9", 3).format).toMatchObject({ bom: false, lossy: false });
    // Latin-1 "café": 4 bytes, one of them undecodable.
    expect(decodeFileText("caf\uFFFD", 4).format.lossy).toBe(true);
    // A real U+FFFD in a UTF-8 file is 3 bytes, and the size says so.
    expect(decodeFileText("caf\uFFFD", 6).format.lossy).toBe(false);
    expect(decodeFileText("caf\uFFFD").format.lossy).toBe(true);
    expect(utf8Length("a\u00e9\u20ac\u{1F600}")).toBe(1 + 2 + 3 + 4);
  });
});
