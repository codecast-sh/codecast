import { expect, test } from "bun:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { bufferKey, useCodeStore } from "../../../store/codeStore";
import { codeBuffers, currentState } from "../buffers";
import { featureBase } from "../features";
import { applyToBuffer, fileSyncExtensions, restoreHotExit } from "../fileSync";
import { _useHotExitDbForTests, flushHotExit, loadHotExit } from "../hotExit";
import { _reconcileForTests, _settleRenamesForTests, adoptMovedEdits, isFolderPath } from "./followFiles";
import { emptyWorkspace, openTab, type Workspace } from "./model";

_useHotExitDbForTests({ indexedDB, IDBKeyRange });

const row = (path: string, dir = false) => ({ path, mtime: 1, size: 1, ...(dir ? { dir: true } : {}) });

test("a folder is a dir row or the prefix of any scanned path", () => {
  const files = { "src/a.ts": row("src/a.ts"), lib: row("lib", true) };
  expect(isFolderPath(files, "src")).toBe(true);
  expect(isFolderPath(files, "lib")).toBe(true);
  expect(isFolderPath(files, "src/a.ts")).toBe(false);
  expect(isFolderPath(files, "sr")).toBe(false);
});

test("a saved folder tab goes when the scan lands; a scan never closes a file it dropped", () => {
  let ws = openTab(emptyWorkspace(), "src");
  ws = openTab(ws, "big/past-the-cap.ts");
  useCodeStore.setState({ workspaces: { v: ws } });
  const files = { "src/a.ts": row("src/a.ts") };
  _reconcileForTests("v", files, { ...files, "big/past-the-cap.ts": row("big/past-the-cap.ts") }, true, () => null);
  expect(useCodeStore.getState().workspaces.v.groups[0].tabs.map((t) => t.path)).toEqual(["big/past-the-cap.ts"]);
});

test("outside a rescan, a row leaving is a delete: its clean tab closes, a dirty one stays", () => {
  let ws = openTab(emptyWorkspace(), "a.ts");
  ws = openTab(ws, "b.ts");
  useCodeStore.setState({ workspaces: { v: ws }, dirty: { "v\u0000b.ts": true } });
  const prev = { "a.ts": row("a.ts"), "b.ts": row("b.ts"), "c.ts": row("c.ts") };
  _reconcileForTests("v", { "c.ts": row("c.ts") }, prev, false, () => null);
  expect(useCodeStore.getState().workspaces.v.groups[0].tabs.map((t) => t.path)).toEqual(["b.ts"]);
});

// ── renames: unsaved text moves at once, and a refused rename moves back ─────

const V = "v-rename";
const key = (p: string) => bufferKey(V, p);

function openOffscreen(path: string, content: string, etag = "e1") {
  return codeBuffers.open({
    vaultId: V,
    path,
    content,
    etag,
    extensions: () => [
      featureBase({ vaultId: V, path, languageId: "typescript", languageName: "TypeScript", sizeBytes: 0, largeFile: false }),
      fileSyncExtensions(),
    ],
  });
}

function dirtyBuffer(path: string) {
  const b = openOffscreen(path, "one\n");
  applyToBuffer(b, { changes: { from: 0, insert: "edited " } });
  expect(useCodeStore.getState().dirty[key(path)]).toBe(true);
  return b;
}

const tabs = () => useCodeStore.getState().workspaces[V].groups[0].tabs.map((t) => t.path);

function reset(ws: Workspace) {
  for (const b of codeBuffers.all()) if (b.vaultId === V) codeBuffers.close(b.key);
  useCodeStore.setState({ workspaces: { [V]: ws }, dirty: {}, conflicts: {} });
}

test("a dirty background tab's text moves at rename: held for a reload, handed to the new buffer", async () => {
  reset(openTab(openTab(emptyWorkspace(), "a.ts"), "c.ts"));
  dirtyBuffer("a.ts");
  const prev = { "a.ts": row("a.ts"), "c.ts": row("c.ts") };
  _reconcileForTests(V, { "b.ts": row("b.ts"), "c.ts": row("c.ts") }, prev, false, (p) => (p === "a.ts" ? "b.ts" : null));
  expect(tabs()).toEqual(["b.ts", "c.ts"]);
  expect(useCodeStore.getState().dirty[key("b.ts")]).toBe(true);

  // A reload before the tab is shown: hot exit restores the text at the new path.
  await flushHotExit();
  expect((await loadHotExit(key("b.ts")))?.mine).toBe("edited one\n");
  const reloaded = openOffscreen("b.ts", "one\n");
  expect(await restoreHotExit(reloaded)).toBe("restored");
  expect(currentState(reloaded).doc.toString()).toBe("edited one\n");
  codeBuffers.close(reloaded.key);

  // In the same session, the new path's buffer takes the text when it opens.
  const fresh = openOffscreen("b.ts", "one\n");
  adoptMovedEdits(fresh);
  expect(currentState(fresh).doc.toString()).toBe("edited one\n");

  // The old buffer stays until the daemon's answer is final, then goes.
  expect(codeBuffers.get(key("a.ts"))).toBeDefined();
  _settleRenamesForTests();
  expect(codeBuffers.get(key("a.ts"))).toBeUndefined();
  expect(useCodeStore.getState().dirty[key("a.ts")]).toBeFalsy();
  await flushHotExit();
  expect(await loadHotExit(key("a.ts"))).toBeUndefined();
});

test("a refused rename onto a new path moves the tab and its text back", () => {
  reset(openTab(emptyWorkspace(), "a.ts"));
  const old = dirtyBuffer("a.ts");
  const before = { "a.ts": row("a.ts") };
  const moved = { "b.ts": row("b.ts") };
  _reconcileForTests(V, moved, before, false, (p) => (p === "a.ts" ? "b.ts" : null));
  expect(tabs()).toEqual(["b.ts"]);
  const shown = openOffscreen("b.ts", "one\n");
  adoptMovedEdits(shown);
  applyToBuffer(shown, { changes: { from: 0, insert: "more " } });

  // The daemon refused: the store forgot the move and put a.ts's row back.
  _reconcileForTests(V, before, moved, false, () => null);
  expect(tabs()).toEqual(["a.ts"]);
  expect(codeBuffers.get(key("a.ts"))).toBe(old);
  expect(currentState(old).doc.toString()).toBe("more edited one\n");
  expect(useCodeStore.getState().dirty[key("a.ts")]).toBe(true);
  expect(codeBuffers.get(key("b.ts"))).toBeUndefined();
  expect(useCodeStore.getState().dirty[key("b.ts")]).toBeFalsy();
});

test("a rename onto an existing file waits for the daemon; refused, nothing moved", () => {
  reset(openTab(openTab(emptyWorkspace(), "b.ts"), "a.ts"));
  const old = dirtyBuffer("a.ts");
  const before = { "a.ts": row("a.ts"), "b.ts": row("b.ts") };
  const optimistic = { "b.ts": row("b.ts") };
  _reconcileForTests(V, optimistic, before, false, (p) => (p === "a.ts" ? "b.ts" : null));
  expect(tabs()).toEqual(["b.ts", "a.ts"]);
  expect(useCodeStore.getState().dirty[key("b.ts")]).toBeFalsy();

  _reconcileForTests(V, before, optimistic, false, () => null);
  _settleRenamesForTests();
  expect(tabs()).toEqual(["b.ts", "a.ts"]);
  expect(codeBuffers.get(key("a.ts"))).toBe(old);
  expect(useCodeStore.getState().dirty[key("a.ts")]).toBe(true);
});

test("renaming straight back keeps the unsaved text; the first rename's settle drops nothing", async () => {
  reset(openTab(openTab(emptyWorkspace(), "a.ts"), "c.ts"));
  const old = dirtyBuffer("a.ts");
  const atA = { "a.ts": row("a.ts"), "c.ts": row("c.ts") };
  const atB = { "b.ts": row("b.ts"), "c.ts": row("c.ts") };
  _reconcileForTests(V, atB, atA, false, (p) => (p === "a.ts" ? "b.ts" : null));
  expect(tabs()).toEqual(["b.ts", "c.ts"]);
  // Undo the typo: the ledger still remembers a -> b, and now b -> a.
  _reconcileForTests(V, atA, atB, false, (p) => (p === "a.ts" ? "b.ts" : p === "b.ts" ? "a.ts" : null));
  expect(tabs()).toEqual(["a.ts", "c.ts"]);
  _settleRenamesForTests();
  expect(useCodeStore.getState().dirty[key("a.ts")]).toBe(true);
  expect(codeBuffers.get(key("a.ts"))).toBe(old);
  expect(currentState(old).doc.toString()).toBe("edited one\n");
  await flushHotExit();
  expect((await loadHotExit(key("a.ts")))?.mine).toBe("edited one\n");
  // The path it passed through is forgotten.
  expect(useCodeStore.getState().dirty[key("b.ts")]).toBeFalsy();
  expect(await loadHotExit(key("b.ts"))).toBeUndefined();
});

test("a new file at the old path gets its own buffer, and its edits survive the rename settling", async () => {
  reset(openTab(emptyWorkspace(), "a.ts"));
  dirtyBuffer("a.ts");
  const moved = { "b.ts": row("b.ts") };
  const ledger = (p: string) => (p === "a.ts" ? "b.ts" : null);
  _reconcileForTests(V, moved, { "a.ts": row("a.ts") }, false, ledger);
  expect(tabs()).toEqual(["b.ts"]);
  // A new a.ts is created while the rename is still in flight.
  const withNew = { "a.ts": row("a.ts"), "b.ts": row("b.ts") };
  _reconcileForTests(V, withNew, moved, false, ledger);
  expect(codeBuffers.get(key("a.ts"))).toBeUndefined();
  const fresh = openOffscreen("a.ts", "");
  applyToBuffer(fresh, { changes: { from: 0, insert: "new file\n" } });
  useCodeStore.getState().updateWorkspace(V, (w) => openTab(w, "a.ts"));
  _settleRenamesForTests();
  expect(codeBuffers.get(key("a.ts"))).toBe(fresh);
  expect(useCodeStore.getState().dirty[key("a.ts")]).toBe(true);
  expect(useCodeStore.getState().dirty[key("b.ts")]).toBe(true);
});

test("a refused rename back returns text that never reached a buffer", () => {
  reset(openTab(openTab(emptyWorkspace(), "a.ts"), "c.ts"));
  dirtyBuffer("a.ts");
  const atA = { "a.ts": row("a.ts"), "c.ts": row("c.ts") };
  const atB = { "b.ts": row("b.ts"), "c.ts": row("c.ts") };
  _reconcileForTests(V, atB, atA, false, (p) => (p === "a.ts" ? "b.ts" : null));
  _settleRenamesForTests();
  expect(codeBuffers.get(key("a.ts"))).toBeUndefined();
  // b.ts's text is still waiting for a buffer when b -> c is tried and refused.
  const atC = { "c2.ts": row("c2.ts"), "c.ts": row("c.ts") };
  _reconcileForTests(V, atC, atB, false, (p) => (p === "b.ts" ? "c2.ts" : null));
  expect(tabs()).toEqual(["c2.ts", "c.ts"]);
  _reconcileForTests(V, atB, atC, false, () => null);
  expect(tabs()).toEqual(["b.ts", "c.ts"]);
  expect(useCodeStore.getState().dirty[key("b.ts")]).toBe(true);
  const shown = openOffscreen("b.ts", "one\n");
  adoptMovedEdits(shown);
  expect(currentState(shown).doc.toString()).toBe("edited one\n");
});
