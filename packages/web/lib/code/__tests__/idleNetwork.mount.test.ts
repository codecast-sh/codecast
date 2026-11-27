// The editor's idle budget against a busy repo (docs/architecture/code-editor.md,
// perf/README.md "Editor"): agents save files all day, and an open Files page
// pays for each save in store writes and daemon requests. A burst of watcher
// events is one file-table write and one git status; a hidden page asks the
// daemon nothing until it is shown, and then asks once; a file no editor
// holds is never read again on a save.
import { afterAll, expect, mock, test } from "bun:test";
import { installEditorDom } from "../../../components/code/__tests__/editorDom";

installEditorDom();

const calls = { status: 0 };
const realClient = { ...(await import("../daemonClient")) };
mock.module("../daemonClient", () => ({
  ...realClient,
  fetchGitStatus: async () => {
    calls.status++;
    return { repo: true, branch: "main", head: "h1", ahead: 0, behind: 0, files: {} };
  },
}));

const reads: string[] = [];
const realVault = { ...(await import("../../vault/client")) };
mock.module("../../vault/client", () => ({
  ...realVault,
  readVaultFile: async (_ep: unknown, _v: string, path: string) => {
    reads.push(path);
    return { content: "new", mtime: 5000, etag: "e-new", size: 3 };
  },
  scanVault: async () => ({ files: Object.values(scanRows), scanned_at: Date.now(), repo: true }),
}));
/** What the next rescan (refresh) returns. */
let scanRows: Record<string, { path: string; mtime: number; size: number }> = {};

const { useVaultStore, _queueVaultWsEventForTests, _applyVaultWsEventForTests } = await import("../../../store/vaultStore");
const { codeBuffers } = await import("../buffers");
await import("../fileSync");
const { holdGitStatusFeed } = await import("../git/status");

const VAULT = "vault-idle";
const FILES = 20_000;
const files: Record<string, { path: string; mtime: number; size: number }> = {};
for (let i = 0; i < FILES; i++) files[`src/m${i % 97}/f${i}.ts`] = { path: `src/m${i % 97}/f${i}.ts`, mtime: 1, size: 10 };
useVaultStore.setState({
  activeVaultId: VAULT,
  isRemote: false,
  endpoint: { url: "http://127.0.0.1:1", token: "t" } as any,
  files: files as any,
  bodies: {},
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const release = holdGitStatusFeed();
afterAll(() => release());
await wait(20);
const save = (i: number) =>
  _queueVaultWsEventForTests({ type: "change", vault: VAULT, path: `src/m${i % 97}/f${i}.ts`, mtime: 1000 + i, size: 11 } as any);

test("a burst of 500 agent saves: one file-table write, one git status", async () => {
  let writes = 0;
  const off = useVaultStore.subscribe((s, p) => void (s.files !== p.files && writes++));
  const before = calls.status;
  for (let i = 0; i < 500; i++) save(i);
  expect(writes).toBe(0);
  await wait(800);
  off();
  expect(writes).toBe(1);
  expect(calls.status - before).toBe(1);
  expect(useVaultStore.getState().files["src/m3/f3.ts"].mtime).toBe(1003);
  expect(Object.keys(useVaultStore.getState().files).length).toBe(FILES);
});

test("a hidden page asks for no git status until it is shown, then once", async () => {
  let visibility = "hidden";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  try {
    const before = calls.status;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 20; i++) save(round * 100 + i);
      await wait(700);
    }
    expect(calls.status).toBe(before);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(20);
    expect(calls.status - before).toBe(1);
  } finally {
    delete (document as { visibilityState?: unknown }).visibilityState;
  }
});

test("a save to a file no editor holds drops its text; a held one is read once", async () => {
  const closed = "src/m1/f1.ts";
  const open = "src/m2/f2.ts";
  useVaultStore.setState((s) => ({ bodies: { ...s.bodies, [closed]: { content: "old", mtime: 1, etag: "a" }, [open]: { content: "old", mtime: 1, etag: "b" } } }));
  const buffer = codeBuffers.open({ vaultId: VAULT, path: open, content: "old", etag: "b", extensions: () => [] });
  reads.length = 0;
  _applyVaultWsEventForTests({ type: "change", vault: VAULT, path: closed, mtime: 4000, size: 3 } as any);
  _applyVaultWsEventForTests({ type: "change", vault: VAULT, path: open, mtime: 5000, size: 3 } as any);
  await wait(20);
  expect(reads).toEqual([open]);
  expect(useVaultStore.getState().bodies[closed]).toBeUndefined();
  expect(useVaultStore.getState().bodies[open]?.etag).toBe("e-new");
  // The buffer leaves the cache: the store lets go of its text too.
  codeBuffers.close(buffer.key);
  expect(useVaultStore.getState().bodies[open]).toBeUndefined();
});

test("a rescan after the socket was down reads an open file disk changed, and no other code", async () => {
  const open = "src/m4/f4.ts";
  const closed = "src/m5/f5.ts";
  useVaultStore.setState((s) => ({ bodies: { ...s.bodies, [open]: { content: "old", mtime: 1, etag: "b" } } }));
  const buffer = codeBuffers.open({ vaultId: VAULT, path: open, content: "old", etag: "b", extensions: () => [] });
  scanRows = { [open]: { path: open, mtime: 9000, size: 3 }, [closed]: { path: closed, mtime: 9000, size: 3 } };
  reads.length = 0;
  await useVaultStore.getState().refresh();
  expect(reads).toEqual([open]);
  expect(useVaultStore.getState().bodies[open]?.etag).toBe("e-new");
  // Unchanged since: nothing to read.
  reads.length = 0;
  useVaultStore.setState((s) => ({ bodies: { ...s.bodies, [open]: { ...s.bodies[open]!, mtime: 9000 } } }));
  await useVaultStore.getState().refresh();
  expect(reads).toEqual([]);
  codeBuffers.close(buffer.key);
});
