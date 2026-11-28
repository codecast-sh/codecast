import { expect, test } from "bun:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { bufferKey, useCodeStore } from "../../../store/codeStore";
import { codeBuffers, currentState } from "../buffers";
import { featureBase } from "../features";
import { applyToBuffer, fileSyncExtensions, restoreHotExit } from "../fileSync";
import { _useHotExitDbForTests, flushHotExit, loadHotExit } from "../hotExit";
import { _reconcileForTests, _setRenameReaderForTests, _settleRenamesForTests, adoptMovedEdits, isFolderPath } from "./followFiles";
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

test("the person's own delete closes a clean tab; a dirty one stays", () => {
  let ws = openTab(emptyWorkspace(), "a.ts");
  ws = openTab(ws, "b.ts");
  useCodeStore.setState({ workspaces: { v: ws }, dirty: { "v\u0000b.ts": true } });
  const prev = { "a.ts": row("a.ts"), "b.ts": row("b.ts"), "c.ts": row("c.ts") };
  _reconcileForTests("v", { "c.ts": row("c.ts") }, prev, false, () => null, () => true);
  expect(useCodeStore.getState().workspaces.v.groups[0].tabs.map((t) => t.path)).toEqual(["b.ts"]);
});

test("a file leaving disk under the app keeps its tab, marked deleted, and the mark goes when it returns", () => {
  const W = "v-gone";
  const b = codeBuffers.open({
    vaultId: W,
    path: "a.ts",
    content: "one\n",
    etag: "e1",
    extensions: () => [featureBase({ vaultId: W, path: "a.ts", languageId: "typescript", languageName: "TypeScript", sizeBytes: 0, largeFile: false }), fileSyncExtensions()],
  });
  useCodeStore.setState({ workspaces: { [W]: openTab(emptyWorkspace(), "a.ts") }, dirty: {}, conflicts: {} });
  const both = { "a.ts": row("a.ts"), "c.ts": row("c.ts") };
  const after = { "c.ts": row("c.ts") };
  // An agent's `git stash`: the watcher reports the file removed.
  _reconcileForTests(W, after, both, false, () => null, () => false);
  expect(useCodeStore.getState().workspaces[W].groups[0].tabs.map((t) => t.path)).toEqual(["a.ts"]);
  expect(useCodeStore.getState().conflicts[b.key]).toEqual({ kind: "deleted" });
  // `git stash pop`: back into the same tab.
  _reconcileForTests(W, both, after, false, () => null, () => false);
  expect(useCodeStore.getState().conflicts[b.key]).toBeUndefined();
  codeBuffers.close(b.key);
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

test("a rename onto a path with a leftover buffer keeps the moved text the store holds there", async () => {
  const { useVaultStore } = await import("../../../store/vaultStore");
  const prevVault = useVaultStore.getState();
  reset(openTab(emptyWorkspace(), "a.ts"));
  const leftover = openOffscreen("b.ts", "an earlier file\n", "old");
  dirtyBuffer("a.ts");
  // The store already moved a.ts's body to b.ts (applyMoves).
  useVaultStore.setState({ activeVaultId: V, bodies: { ...prevVault.bodies, "b.ts": { content: "one\n", mtime: 2, etag: "moved" } } });
  try {
    // b.ts was deleted earlier; its clean buffer stayed in the cache.
    _reconcileForTests(V, { "b.ts": row("b.ts") }, { "a.ts": row("a.ts") }, false, (p) => (p === "a.ts" ? "b.ts" : null));
    expect(codeBuffers.get(leftover.key)).not.toBe(leftover);
    expect(useVaultStore.getState().bodies["b.ts"]?.etag).toBe("moved");
  } finally {
    useVaultStore.setState({ activeVaultId: prevVault.activeVaultId, bodies: prevVault.bodies });
  }
});

test("an agent's `git mv` (removed, then an add of the same bytes) moves the tab and the unsaved text", async () => {
  const W = "v-mv";
  const b = codeBuffers.open({
    vaultId: W,
    path: "old.ts",
    content: "one\n",
    etag: "e-one",
    extensions: () => [featureBase({ vaultId: W, path: "old.ts", languageId: "typescript", languageName: "TypeScript", sizeBytes: 0, largeFile: false }), fileSyncExtensions()],
  });
  useCodeStore.setState({ workspaces: { [W]: openTab(emptyWorkspace(), "old.ts") }, dirty: {}, conflicts: {} });
  applyToBuffer(b, { changes: { from: 0, insert: "edited " } });
  const reads: string[] = [];
  const restore = _setRenameReaderForTests(async (_v, p) => {
    reads.push(p);
    return p === "new.ts" ? "e-one" : "e-other";
  });
  try {
    const before = { "old.ts": row("old.ts"), "z.ts": row("z.ts") };
    const removed = { "z.ts": row("z.ts") };
    await _reconcileForTests(W, removed, before, false, () => null, () => false);
    expect(useCodeStore.getState().conflicts[b.key]).toEqual({ kind: "deleted" });
    // The add lands in the next batch; a file of another size is never read.
    const added = { "z.ts": row("z.ts"), "new.ts": { path: "new.ts", mtime: 2, size: 4 }, "other.ts": { path: "other.ts", mtime: 2, size: 9 } };
    await _reconcileForTests(W, added, removed, false, () => null, () => false);
    expect(reads).toEqual(["new.ts"]);
    expect(useCodeStore.getState().workspaces[W].groups[0].tabs.map((t) => t.path)).toEqual(["new.ts"]);
    expect(useCodeStore.getState().dirty[bufferKey(W, "new.ts")]).toBe(true);
    expect(useCodeStore.getState().conflicts[b.key]).toBeUndefined();
  } finally {
    restore();
    for (const x of codeBuffers.all()) if (x.vaultId === W) codeBuffers.close(x.key);
  }
});
