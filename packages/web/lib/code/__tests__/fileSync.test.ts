// Saving, conflicts, external changes and hot exit, against a fake disk. The
// buffers here are off screen (no view), which runs the same bookkeeping the
// editor's update listener runs for a shown buffer.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { EditorState, type Transaction } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { VaultWriteConflict } from "../../vault/client";
import { useCodeStore } from "../../../store/codeStore";
import { codeBuffers, currentState, encodeFileText, fileFormatField, isDirty, type CodeBuffer } from "../buffers";
import { featureBase } from "../features";
import {
  _setDiskIOForTests,
  applyDiskVersion,
  applyToBuffer as updateBuffer,
  externalChange,
  fileSyncExtensions,
  recreateFile,
  restoreHotExit,
  revertBuffer,
  saveAllBuffers,
  saveBuffer,
  takeDisk,
  type DiskIO,
} from "../fileSync";
import { _useHotExitDbForTests, flushHotExit, loadHotExit } from "../hotExit";
import { isNewFile, markNewFile } from "../newFiles";

_useHotExitDbForTests({ indexedDB, IDBKeyRange });

interface Disk {
  content: string;
  etag: string;
  writes: string[];
  deleted?: boolean;
}
let disk: Disk;
let n = 0;
const conflict = () => new VaultWriteConflict({ content: disk.content, etag: disk.etag, mtime: 1, size: disk.content.length });
function land(content: string) {
  disk.content = content;
  disk.etag = `e${++n}`;
  disk.deleted = false;
  disk.writes.push(content);
  return { etag: disk.etag, mtime: n, size: content.length };
}
const fakeIO: DiskIO = {
  write: async (_b, content, baseEtag) => {
    // The daemon's answer for a guarded write to a file that is gone.
    if (disk.deleted) throw new VaultWriteConflict({ content: '{"error":"conflict"}', etag: "", mtime: 0, size: 0 });
    if (baseEtag !== disk.etag) throw conflict();
    return land(content);
  },
  // The daemon's create op: refused while the file exists, and its JSON body
  // is capped, which is why Recreate only ever asks it for an empty file.
  createEmpty: async () => {
    if (!disk.deleted) throw new Error("vault op create: 409 exists");
    land("");
  },
  read: async () => (disk.deleted ? null : { content: disk.content, etag: disk.etag, mtime: n }),
  adopt: () => {},
};
const restoreIO = _setDiskIOForTests(fakeIO);
afterAll(restoreIO);

/** Someone else writes the file. */
function agentWrites(content: string) {
  disk.content = content;
  disk.etag = `e${++n}`;
  disk.deleted = false;
  return { content, etag: disk.etag, mtime: n };
}

const external: Transaction[] = [];
let path = 0;

function openBuffer(content: string, sizeBytes?: number): CodeBuffer {
  disk = { content, etag: `e${++n}`, writes: [] };
  const p = `src/file${++path}.ts`;
  return codeBuffers.open({
    vaultId: "v",
    path: p,
    content,
    etag: disk.etag,
    sizeBytes,
    extensions: () => [
      history(),
      featureBase({ vaultId: "v", path: p, languageId: "typescript", languageName: "TypeScript", sizeBytes: 0, largeFile: false }),
      fileSyncExtensions(),
      EditorState.transactionExtender.of((tr) => {
        if (tr.annotation(externalChange)) external.push(tr);
        return null;
      }),
    ],
  });
}

const text = (b: CodeBuffer) => currentState(b).doc.toString();
const type = (b: CodeBuffer, at: number, insert: string) => updateBuffer(b, { changes: { from: at, insert } });
const base = "import a\n\nfunction one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n";

beforeEach(() => {
  external.length = 0;
});

describe("save", () => {
  it("writes nothing for an untouched buffer", async () => {
    const b = openBuffer(base);
    expect(await saveBuffer(b)).toBe("unchanged");
    expect(disk.writes).toEqual([]);
  });

  it("writes an edit with the buffer's etag and comes back clean", async () => {
    const b = openBuffer(base);
    const before = b.baseEtag;
    type(b, 0, "// hi\n");
    expect(b.dirty).toBe(true);
    expect(useCodeStore.getState().dirty[b.key]).toBe(true);
    expect(await saveBuffer(b)).toBe("saved");
    expect(disk.content).toBe(`// hi\n${base}`);
    expect(b.baseEtag).not.toBe(before);
    expect(b.dirty).toBe(false);
    expect(useCodeStore.getState().dirty[b.key]).toBeUndefined();
    expect(await saveBuffer(b)).toBe("unchanged");
    expect(disk.writes.length).toBe(1);
  });

  it("keeps CRLF and the byte order mark", async () => {
    const b = openBuffer("﻿a\r\nb\r\n");
    type(b, 1, "\nx");
    await saveBuffer(b);
    expect(disk.content).toBe("﻿a\r\nx\r\nb\r\n");
  });

  it("queues a second save behind the first", async () => {
    const b = openBuffer(base);
    type(b, 0, "x");
    const [first, second] = await Promise.all([saveBuffer(b), saveBuffer(b)]);
    expect([first, second]).toEqual(["saved", "unchanged"]);
    expect(disk.writes.length).toBe(1);
  });

  it("on a 409 merges disk's edit elsewhere and writes both", async () => {
    const b = openBuffer(base);
    agentWrites(base.replace("return 1;", "return 10;"));
    type(b, text(b).indexOf("return 2;") + 8, "0");
    expect(await saveBuffer(b)).toBe("saved");
    expect(disk.content).toBe(base.replace("return 1;", "return 10;").replace("return 2;", "return 20;"));
    expect(isDirty(currentState(b))).toBe(false);
  });

  it("on a conflicting 409 opens the merge and never overwrites", async () => {
    const b = openBuffer(base);
    const theirs = agentWrites(base.replace("return 1;", "return 'disk';"));
    updateBuffer(b, { changes: { from: base.indexOf("1;"), to: base.indexOf("1;") + 1, insert: "'mine'" } });
    expect(await saveBuffer(b)).toBe("merging");
    expect(disk.content).toBe(theirs.content);
    expect(b.merging?.etag).toBe(theirs.etag);
    expect(useCodeStore.getState().conflicts[b.key]).toMatchObject({ kind: "merge", conflicts: 1 });
    // Saving the merge writes what the editor shows, on top of disk's version.
    expect(await saveBuffer(b)).toBe("saved");
    expect(disk.content).toBe(base.replace("return 1;", "return 'mine';"));
    expect(b.merging).toBeNull();
    expect(useCodeStore.getState().conflicts[b.key]).toBeUndefined();
  });

  it("Save all leaves a buffer in an unresolved merge alone and saves the rest", async () => {
    for (const b of codeBuffers.all()) codeBuffers.close(b.key);
    const merging = openBuffer(base);
    const mergingDisk = disk;
    const theirs = agentWrites(base.replace("return 1;", "return 'disk';"));
    updateBuffer(merging, { changes: { from: base.indexOf("1;"), to: base.indexOf("1;") + 1, insert: "'mine'" } });
    expect(await saveBuffer(merging)).toBe("merging");
    const shown = text(merging);

    const other = openBuffer(base);
    type(other, 0, "// other\n");
    const outcomes = await saveAllBuffers();
    expect(outcomes).toContain("saved");
    expect(disk.content).toBe(`// other\n${base}`);
    // The merge is still the person's to resolve: nothing written, nothing taken.
    expect(mergingDisk.content).toBe(theirs.content);
    expect(merging.merging?.etag).toBe(theirs.etag);
    expect(text(merging)).toBe(shown);
    expect(useCodeStore.getState().conflicts[merging.key]).toMatchObject({ kind: "merge" });
    codeBuffers.close(merging.key);
  });

  it("takes disk wholesale out of a merge", async () => {
    const b = openBuffer(base);
    const theirs = agentWrites(base.replace("return 1;", "return 'disk';"));
    updateBuffer(b, { changes: { from: base.indexOf("1;"), to: base.indexOf("1;") + 1, insert: "'mine'" } });
    await saveBuffer(b);
    await takeDisk(b);
    expect(text(b)).toBe(theirs.content);
    expect(b.dirty).toBe(false);
    expect(b.baseEtag).toBe(theirs.etag);
    expect(disk.writes).toEqual([]);
  });

  it("treats a file deleted on disk as deleted, never as text to merge", async () => {
    const b = openBuffer(base);
    type(b, 0, "// mine\n");
    disk.deleted = true;
    expect(await saveBuffer(b)).toBe("deleted");
    expect(useCodeStore.getState().conflicts[b.key]).toEqual({ kind: "deleted" });
    expect(b.merging).toBeNull();
    expect(text(b)).toBe(`// mine\n${base}`);
    expect(disk.writes).toEqual([]);
    expect(await recreateFile(b)).toBe("saved");
    expect(disk.content).toBe(`// mine\n${base}`);
    expect(b.dirty).toBe(false);
    expect(useCodeStore.getState().conflicts[b.key]).toBeUndefined();
  });

  it("never overwrites a file that came back before Recreate", async () => {
    const b = openBuffer(base);
    updateBuffer(b, { changes: { from: base.indexOf("1;"), to: base.indexOf("1;") + 1, insert: "'mine'" } });
    disk.deleted = true;
    expect(await saveBuffer(b)).toBe("deleted");
    const back = agentWrites(base.replace("return 1;", "return 'restored';"));
    expect(await recreateFile(b)).toBe("merging");
    expect(disk.content).toBe(back.content);
    expect(disk.writes).toEqual([]);
    expect(b.merging?.etag).toBe(back.etag);
  });

  it("recreates a file far past the create op's body cap, and again after a failed write", async () => {
    const big = `${"x".repeat(80)}\n`.repeat(4000); // ~324 KB
    const b = openBuffer(base);
    type(b, 0, big);
    disk.deleted = true;
    expect(await saveBuffer(b)).toBe("deleted");
    // The path is claimed, then the PUT is lost: an empty file is left behind.
    _setDiskIOForTests({
      write: async () => {
        throw new Error("network");
      },
      createEmpty: async () => void land(""),
      read: async () => ({ content: disk.content, etag: disk.etag, mtime: n }),
      adopt: () => {},
    });
    expect(await recreateFile(b)).toBe("error");
    _setDiskIOForTests(fakeIO);
    expect(disk.content).toBe("");
    expect(await recreateFile(b)).toBe("saved");
    expect(disk.content).toBe(`${big}${base}`);
    expect(b.dirty).toBe(false);
  });

  it("creates a new file on its first save, even while empty, and saves normally after", async () => {
    const b = openBuffer("");
    disk.deleted = true;
    markNewFile(b.key);
    expect(await saveBuffer(b)).toBe("saved");
    expect(disk.writes).toEqual(["", ""]);
    expect(isNewFile(b.key)).toBe(false);
    type(b, 0, "export const x = 1;\n");
    expect(await saveBuffer(b)).toBe("saved");
    expect(disk.content).toBe("export const x = 1;\n");
  });

  it("a new file that appeared on disk before the save merges with it, never overwrites, and does not loop", async () => {
    const b = openBuffer("");
    disk.deleted = true;
    markNewFile(b.key);
    type(b, 0, "mine\n");
    agentWrites("theirs\n");
    expect(await saveBuffer(b)).toBe("merging");
    expect(isNewFile(b.key)).toBe(false);
    expect(disk.content).toBe("theirs\n");
  });

  it("refuses to save a file that did not decode as UTF-8", async () => {
    // Latin-1 "café" is 4 bytes; the browser's decode gives "caf\uFFFD".
    const b = openBuffer("caf\uFFFD\n", 5);
    expect(currentState(b).field(fileFormatField).lossy).toBe(true);
    type(b, 0, "x");
    expect(await saveBuffer(b)).toBe("readonly");
    expect(disk.writes).toEqual([]);
  });

  it("keeps a byte order mark the browser's decode dropped", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]);
    const content = await new Response(bytes).text();
    expect(content).toBe("a\n"); // what readVaultFile hands the editor
    const b = openBuffer(content, bytes.length);
    type(b, 1, "b");
    await saveBuffer(b);
    expect(disk.content).toBe("\uFEFFab\n");
  });

  it("keeps the byte order mark through an external change that carries no size", async () => {
    const b = openBuffer("a\n", 5); // EF BB BF 61 0A, BOM dropped by the decode
    await applyDiskVersion(b, agentWrites("ab\n"));
    expect(text(b)).toBe("ab\n");
    type(b, 2, "c");
    await saveBuffer(b);
    expect(disk.content).toBe("\uFEFFabc\n");
  });

  it("reverts to disk, undoably", async () => {
    const b = openBuffer(base);
    type(b, 0, "junk ");
    await revertBuffer(b);
    expect(text(b)).toBe(base);
    expect(b.dirty).toBe(false);
  });
});

describe("external change", () => {
  it("lands in a clean buffer as line edits, annotated, cursor kept", async () => {
    const b = openBuffer(base);
    const cursor = base.indexOf("return 2;");
    updateBuffer(b, { selection: { anchor: cursor } });
    const next = agentWrites(`// header\n${base.replace("import a", "import b")}`);
    await applyDiskVersion(b, next);
    expect(text(b)).toBe(next.content);
    expect(b.dirty).toBe(false);
    expect(b.baseEtag).toBe(next.etag);
    expect(external.length).toBe(1);
    expect(external[0].annotation(externalChange)).toEqual({ etag: next.etag });
    expect(currentState(b).selection.main.head).toBe(cursor + "// header\n".length);
  });

  it("ignores its own save coming back", async () => {
    const b = openBuffer(base);
    type(b, 0, "x");
    await saveBuffer(b);
    await applyDiskVersion(b, { content: disk.content, etag: disk.etag, mtime: n });
    expect(external.length).toBe(0);
  });

  it("marks a dirty buffer stale and merges at the save", async () => {
    const b = openBuffer(base);
    type(b, 0, "// mine\n");
    const theirs = agentWrites(base.replace("return 2;", "return 22;"));
    await applyDiskVersion(b, theirs);
    expect(text(b)).toBe(`// mine\n${base}`);
    expect(b.stale?.etag).toBe(theirs.etag);
    expect(useCodeStore.getState().conflicts[b.key]).toEqual({ kind: "stale" });
    expect(await saveBuffer(b)).toBe("saved");
    expect(disk.content).toBe(`// mine\n${base.replace("return 2;", "return 22;")}`);
  });
});

describe("hot exit", () => {
  it("holds unsaved text and brings it back over the same disk version", async () => {
    const b = openBuffer(base);
    type(b, 0, "// unsaved\n");
    await flushHotExit();
    const rec = await loadHotExit(b.key);
    expect(rec?.mine).toBe(`// unsaved\n${base}`);
    expect(rec?.base).toBe(base);

    codeBuffers.close(b.key); // the tab reloads
    const again = codeBuffers.open({ vaultId: "v", path: b.path, content: disk.content, etag: disk.etag, extensions: () => [history(), fileSyncExtensions()] });
    expect(await restoreHotExit(again)).toBe("restored");
    expect(text(again)).toBe(`// unsaved\n${base}`);
    expect(again.dirty).toBe(true);
  });

  it("merges the held text with a disk that moved meanwhile", async () => {
    const b = openBuffer(base);
    type(b, 0, "// unsaved\n");
    await flushHotExit();
    codeBuffers.close(b.key);
    const theirs = agentWrites(base.replace("return 2;", "return 22;"));
    const again = codeBuffers.open({ vaultId: "v", path: b.path, content: theirs.content, etag: theirs.etag, extensions: () => [history(), fileSyncExtensions()] });
    expect(await restoreHotExit(again)).toBe("restored");
    expect(text(again)).toBe(`// unsaved\n${theirs.content}`);
    expect(again.baseEtag).toBe(theirs.etag);
    expect(encodeFileText(currentState(again))).toBe(`// unsaved\n${theirs.content}`);
  });

  it("never lands held text over typing that happened while it loaded", async () => {
    const b = openBuffer(base);
    type(b, 0, "// unsaved\n");
    await flushHotExit();
    codeBuffers.close(b.key);
    const again = codeBuffers.open({ vaultId: "v", path: b.path, content: disk.content, etag: disk.etag, extensions: () => [history(), fileSyncExtensions()] });
    const restoring = restoreHotExit(again);
    type(again, base.length, "// typed now\n");
    expect(await restoring).toBe("none");
    expect(text(again)).toBe(`${base}// typed now\n`);
  });

  it("forgets the held text once the buffer is saved", async () => {
    const b = openBuffer(base);
    type(b, 0, "x");
    await flushHotExit();
    expect(await loadHotExit(b.key)).toBeDefined();
    await saveBuffer(b);
    await Bun.sleep(5);
    expect(await loadHotExit(b.key)).toBeUndefined();
  });
});

it("edits held outside the buffers (the results editor) count as unsaved for the close guard", async () => {
  const { hasUnsavedEdits, registerUnsavedCheck } = await import("../fileSync");
  const base = codeBuffers.dirty().length > 0;
  expect(hasUnsavedEdits()).toBe(base);
  let held = true;
  const off = registerUnsavedCheck(() => held);
  expect(hasUnsavedEdits()).toBe(true);
  held = false;
  expect(hasUnsavedEdits()).toBe(base);
  held = true;
  off();
  expect(hasUnsavedEdits()).toBe(base);
});
