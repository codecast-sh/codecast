// Writing replace and results-editor edits back: every outcome of the
// compare-and-swap path, for files open in a buffer and files only on disk.
import { afterAll, describe, expect, test } from "bun:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { VaultWriteConflict } from "../../../vault/client";
import { codeBuffers, currentState, isDirty, utf8Length, type CodeBuffer, type DiskVersion } from "../../buffers";
import { featureBase } from "../../features";
import { _setDiskIOForTests, applyToBuffer, fileSyncExtensions, saveBuffer, type DiskIO } from "../../fileSync";
import { _useHotExitDbForTests } from "../../hotExit";
import { compileQuery } from "../query";
import { planReplace } from "../replace";
import { editFile, editFiles, type ComputeEdits, type WriteBackIO } from "../writeBack";

_useHotExitDbForTests({ indexedDB, IDBKeyRange });

interface FakeFile {
  content: string;
  etag: string;
  size?: number;
}
const disk = new Map<string, FakeFile>();
const writes: { path: string; content: string; ifMatch: string }[] = [];
let n = 0;

function put(path: string, content: string, size?: number) {
  disk.set(path, { content, etag: `e${++n}`, size });
}

/** The editor's own disk (fileSync), for buffers saved through saveBuffer. */
const bufferDisk: DiskIO = {
  write: async (b, content, baseEtag) => {
    const f = disk.get(b.path)!;
    if (f.etag !== baseEtag) throw new VaultWriteConflict({ content: f.content, etag: f.etag, mtime: 1, size: f.content.length });
    writes.push({ path: b.path, content, ifMatch: baseEtag });
    put(b.path, content);
    return { etag: disk.get(b.path)!.etag, mtime: n, size: content.length };
  },
  createEmpty: async () => {},
  read: async (b) => {
    const f = disk.get(b.path);
    return f ? { content: f.content, etag: f.etag, mtime: 1 } : null;
  },
  adopt: () => {},
};
afterAll(_setDiskIOForTests(bufferDisk));

const adopted: string[] = [];
const io: WriteBackIO = {
  buffer: (path) => codeBuffers.get(`v\u0000${path}`),
  read: async (path): Promise<DiskVersion | null> => {
    const f = disk.get(path);
    return f ? { content: f.content, etag: f.etag, mtime: 1, size: f.size } : null;
  },
  write: async (path, content, etag) => {
    const f = disk.get(path)!;
    if (f.etag !== etag) throw new VaultWriteConflict({ content: f.content, etag: f.etag, mtime: 1, size: f.content.length });
    writes.push({ path, content, ifMatch: etag });
    put(path, content);
    return { etag: disk.get(path)!.etag, mtime: n, size: content.length };
  },
  adopt: (path) => adopted.push(path),
  save: (b) => saveBuffer(b),
};

function open(path: string, content: string): CodeBuffer {
  put(path, content);
  return codeBuffers.open({
    vaultId: "v",
    path,
    content,
    etag: disk.get(path)!.etag,
    extensions: () => [history(), featureBase({ vaultId: "v", path, languageId: "plaintext", languageName: null, sizeBytes: 0, largeFile: false }), fileSyncExtensions()],
  });
}

/** Replace `find` with `by` at the given targets (all when null). */
function replacing(find: string, by: string, targets: { line: number; column: number }[] | null = null): ComputeEdits {
  const re = compileQuery({ text: find, regex: false, caseSensitive: true, word: false }).re!;
  return (text) => {
    const plan = planReplace(text, re, by, { regex: false, preserveCase: false }, targets);
    return plan.missing.length ? { refuse: "Changed since the search" } : plan.edits;
  };
}

describe("a file only on disk", () => {
  test("is written with If-Match on the version read, CRLF kept", async () => {
    put("a.txt", "foo\r\nbar foo\r\n");
    const etag = disk.get("a.txt")!.etag;
    const out = await editFile("a.txt", replacing("foo", "baz"), io);
    expect(out.status).toBe("saved");
    expect(writes.at(-1)).toEqual({ path: "a.txt", content: "baz\r\nbar baz\r\n", ifMatch: etag });
    expect(adopted).toContain("a.txt");
  });

  test("a byte order mark the browser dropped is written back", async () => {
    const text = "foo\n";
    put("bom.txt", text, utf8Length(text) + 3);
    await editFile("bom.txt", replacing("foo", "bar"), io);
    expect(disk.get("bom.txt")!.content).toBe("﻿bar\n");
  });

  test("a 409 is a conflict and writes nothing", async () => {
    put("c.txt", "foo");
    const racing: WriteBackIO = {
      ...io,
      read: async (p) => {
        const v = await io.read(p);
        put(p, "foo, edited meanwhile");
        return v;
      },
    };
    const before = writes.length;
    const out = await editFile("c.txt", replacing("foo", "bar"), racing);
    expect(out.status).toBe("conflict");
    expect(writes.length).toBe(before);
    expect(disk.get("c.txt")!.content).toBe("foo, edited meanwhile");
  });

  test("a target the text lost refuses the whole file", async () => {
    put("d.txt", "foo foo");
    const before = writes.length;
    const out = await editFile("d.txt", replacing("foo", "x", [{ line: 1, column: 0 }, { line: 1, column: 9 }]), io);
    expect(out).toMatchObject({ status: "changed", detail: "Changed since the search" });
    expect(writes.length).toBe(before);
  });

  test("text that did not decode is not written", async () => {
    put("latin1.txt", "caf� foo", 9);
    expect((await editFile("latin1.txt", replacing("foo", "x"), io)).status).toBe("readonly");
  });

  test("a deleted file is an error", async () => {
    expect((await editFile("gone.txt", replacing("foo", "x"), io)).status).toBe("error");
  });
});

describe("bound to a vault", () => {
  test("edits for a vault Files no longer shows write nothing", async () => {
    const { useVaultStore } = await import("../../../../store/vaultStore");
    const prev = useVaultStore.getState();
    useVaultStore.setState({ endpoint: { port: 1, token: "t", deviceId: "d", tmux: false } as never, activeVaultId: "worktree-b", isRemote: false });
    try {
      const out = await editFiles([{ path: "x.txt", compute: () => [{ from: 0, to: 0, insert: "!" }] }], "worktree-a");
      expect(out).toEqual([{ path: "x.txt", status: "error", detail: "From another folder: open it in Files to save" }]);
    } finally {
      useVaultStore.setState({ endpoint: prev.endpoint, activeVaultId: prev.activeVaultId, isRemote: prev.isRemote });
    }
  });
});

describe("a file open in a buffer", () => {
  test("clean, but its save fails: reported unsaved with the reason, never as not written", async () => {
    const b = open("open-savefail.ts", "foo\n");
    const failing: WriteBackIO = { ...io, save: async () => "error" };
    const out = await editFile("open-savefail.ts", replacing("foo", "bar"), failing);
    expect(out.status).toBe("unsaved");
    expect(out.detail).toContain("Save failed");
    expect(out.edits?.length).toBe(1);
    expect(currentState(b).doc.toString()).toBe("bar\n");
  });

  test("clean: edited in its state, saved through the editor's CAS, one undo step", async () => {
    const b = open("open-clean.ts", "foo\nfoo\n");
    const out = await editFile("open-clean.ts", replacing("foo", "bar"), io);
    expect(out.status).toBe("saved");
    expect(disk.get("open-clean.ts")!.content).toBe("bar\nbar\n");
    expect(isDirty(currentState(b))).toBe(false);
    let state = currentState(b);
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.toString()).toBe("foo\nfoo\n");
  });

  test("dirty: edited in its state, disk untouched, unsaved typing kept", async () => {
    const b = open("open-dirty.ts", "foo\nbar\n");
    applyToBuffer(b, { changes: { from: 8, insert: "typed\n" } });
    const before = writes.length;
    const out = await editFile("open-dirty.ts", replacing("foo", "baz"), io);
    expect(out.status).toBe("unsaved");
    expect(writes.length).toBe(before);
    expect(currentState(b).doc.toString()).toBe("baz\nbar\ntyped\n");
    expect(disk.get("open-dirty.ts")!.content).toBe("foo\nbar\n");
  });

  test("clean, but disk moved elsewhere in the file: merged and saved, nothing lost", async () => {
    open("open-moved.ts", "foo\nmiddle\nend\n");
    put("open-moved.ts", "foo\nmiddle\nend, by an agent\n");
    const out = await editFile("open-moved.ts", replacing("foo", "bar"), io);
    expect(out.status).toBe("saved");
    expect(disk.get("open-moved.ts")!.content).toBe("bar\nmiddle\nend, by an agent\n");
  });

  test("clean, disk changed the same line: the merge view opens, reported as a conflict", async () => {
    open("open-clash.ts", "foo\n");
    put("open-clash.ts", "foo by an agent\n");
    const out = await editFile("open-clash.ts", replacing("foo", "bar"), io);
    expect(out.status).toBe("conflict");
    expect(disk.get("open-clash.ts")!.content).toBe("foo by an agent\n");
  });

  test("read-only buffers are left alone", async () => {
    codeBuffers.open({
      vaultId: "v",
      path: "ro2.ts",
      content: "foo",
      etag: "x",
      extensions: () => [EditorState.readOnly.of(true), featureBase({ vaultId: "v", path: "ro2.ts", languageId: "plaintext", languageName: null, sizeBytes: 0, largeFile: false })],
    });
    expect((await editFile("ro2.ts", replacing("foo", "x"), io)).status).toBe("readonly");
  });
});

test("many files: each succeeds or fails on its own, in the order given", async () => {
  put("m1", "foo");
  put("m2", "nothing here");
  put("m3", "foo");
  const out = await editFiles(
    ["m1", "m2", "m3", "missing"].map((path) => ({ path, compute: replacing("foo", "x", path === "m2" ? [{ line: 1, column: 0 }] : null) })),
    io,
  );
  expect(out.map((o) => o.status)).toEqual(["saved", "changed", "saved", "error"]);
  expect(disk.get("m1")!.content).toBe("x");
  expect(disk.get("m2")!.content).toBe("nothing here");
});
