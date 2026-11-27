// A text file whose body can never arrive says so, rather than showing the
// editor's Loading forever: no daemon and none coming, or a remote vault that
// did not mirror the file. And unsaved edits stay on screen while their file
// leaves disk and comes back.
import { afterEach, expect, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";

installEditorDom();

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useVaultStore } = await import("../../../store/vaultStore");
const { VaultFileView } = await import("../../vault/VaultFileView");
const { bufferKey } = await import("../../../store/codeStore");
// The lazy editor chunk, loaded up front so it never resolves outside act().
await import("../CodeFileView");

const path = "src/a.ts";
const roots: { unmount(): void }[] = [];
afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));

async function render(file = path): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<VaultFileView path={file} />);
    await settle();
  });
  return host;
}

function setVault(state: Partial<ReturnType<typeof useVaultStore.getState>>) {
  useVaultStore.setState({
    activeVaultId: "vault-1",
    files: { [path]: { path, mtime: 1, size: 20 } } as any,
    bodies: {},
    loadingPaths: {},
    ...state,
  });
}

test("a cached boot waits for the daemon instead of claiming the read failed", async () => {
  setVault({ endpoint: null, isRemote: false, connection: "cached" });
  const host = await render();
  expect(host.textContent).not.toContain("Couldn't read");
  expect(host.querySelector(".cm-editor")).not.toBeNull();
  expect(host.textContent).toContain("Loading");
});

test("no daemon at all says the file could not be read", async () => {
  setVault({ endpoint: null, isRemote: false, connection: "no-daemon" });
  const host = await render();
  expect(host.textContent).toContain("Couldn't read");
});

test("a cached boot shows unsaved text held for hot exit, read-only, then loads the file", async () => {
  const { EditorView } = await import("@codemirror/view");
  const { scheduleHotExit, flushHotExit, clearHotExit, loadHotExit, _useHotExitDbForTests } = await import("../../../lib/code/hotExit");
  const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
  _useHotExitDbForTests({ indexedDB, IDBKeyRange });
  const file = "src/held.ts";
  const key = bufferKey("vault-1", file);
  scheduleHotExit(key, () => ({ key, vaultId: "vault-1", path: file, mine: "held text\n", base: () => "disk\n", baseEtag: "e0", savedAt: 1 }));
  await flushHotExit();
  setVault({ endpoint: null, isRemote: false, connection: "cached", files: { [file]: { path: file, mtime: 1, size: 5 } } as any });
  const host = await render(file);
  expect((await loadHotExit(key))?.mine).toBe("held text\n");
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  for (let i = 0; i < 20 && view.state.doc.length === 0; i++) await act(() => settle());
  expect(view.state.doc.toString()).toBe("held text\n");
  expect(view.state.readOnly).toBe(true);
  expect(host.textContent).not.toContain("Loading");
  // The daemon answers: the file opens as a buffer and the held text returns, editable.
  await act(async () => {
    useVaultStore.setState({ bodies: { [file]: { content: "disk\n", mtime: 1, etag: "e0" } } });
    await settle();
  });
  for (let i = 0; i < 20 && view.state.doc.toString() !== "held text\n"; i++) await act(() => settle());
  expect(view.state.doc.toString()).toBe("held text\n");
  expect(view.state.readOnly).toBe(false);
  await clearHotExit(key);
});

test("an open buffer follows the vault turning read-only and back", async () => {
  const { EditorView } = await import("@codemirror/view");
  const file = "src/ro.ts";
  setVault({
    endpoint: null,
    isRemote: false,
    connection: "discovering",
    files: { [file]: { path: file, mtime: 1, size: 4 } } as any,
    bodies: { [file]: { content: "abc\n", mtime: 1, etag: "e1" } },
  });
  const host = await render(file);
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  expect(view.state.readOnly).toBe(false);
  await act(async () => {
    useVaultStore.setState({ isRemote: true });
    await settle();
  });
  expect(view.state.readOnly).toBe(true);
  await act(async () => {
    useVaultStore.setState({ isRemote: false });
    await settle();
  });
  expect(view.state.readOnly).toBe(false);
});

test("a buffer opened read-only gets its hot-exit text back when it turns writable", async () => {
  const { EditorView } = await import("@codemirror/view");
  const { scheduleHotExit, flushHotExit, clearHotExit, _useHotExitDbForTests } = await import("../../../lib/code/hotExit");
  const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
  _useHotExitDbForTests({ indexedDB, IDBKeyRange });
  const file = "src/ro-held.ts";
  const key = bufferKey("vault-1", file);
  scheduleHotExit(key, () => ({ key, vaultId: "vault-1", path: file, mine: "held\n", base: () => "disk\n", baseEtag: "e1", savedAt: 1 }));
  await flushHotExit();
  setVault({
    endpoint: null,
    isRemote: true,
    connection: "discovering",
    files: { [file]: { path: file, mtime: 1, size: 5 } } as any,
    bodies: { [file]: { content: "disk\n", mtime: 1, etag: "e1" } },
  });
  const host = await render(file);
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  await act(() => settle());
  expect(view.state.doc.toString()).toBe("disk\n");
  expect(view.state.readOnly).toBe(true);
  await act(async () => {
    useVaultStore.setState({ isRemote: false });
    await settle();
  });
  for (let i = 0; i < 20 && view.state.doc.toString() !== "held\n"; i++) await act(() => settle());
  expect(view.state.doc.toString()).toBe("held\n");
  expect(view.state.readOnly).toBe(false);
  await clearHotExit(key);
});

test("a read that caught the disk before a newer write never replaces that write", async () => {
  const { EditorView } = await import("@codemirror/view");
  const { _applyVaultWsEventForTests } = await import("../../../store/vaultStore");
  const file = "src/recreated.ts";
  const text = "export const r = 1;\n";
  const realFetch = globalThis.fetch;
  // A recreate: the empty create's 'add' starts a read that sees the empty
  // file, and the guarded PUT of the content lands before that read answers.
  let release!: () => void;
  globalThis.fetch = (async (url: string) => {
    if (!String(url).includes("/vault/file")) return new Response("{}", { status: 404 });
    await new Promise<void>((r) => (release = r));
    return new Response("", { status: 200, headers: { "X-Vault-Mtime": "3", "X-Vault-Size": "0", ETag: "e-empty" } });
  }) as any;
  try {
    setVault({
      endpoint: { port: 1, token: "t" } as any,
      isRemote: false,
      connection: "connected",
      files: { [file]: { path: file, mtime: 1, size: text.length } } as any,
      bodies: { [file]: { content: text, mtime: 1, etag: "e1" } },
    });
    const host = await render(file);
    await act(async () => {
      _applyVaultWsEventForTests({ type: "removed", vault: "vault-1", path: file } as any);
      _applyVaultWsEventForTests({ type: "add", vault: "vault-1", path: file, mtime: 3, size: 0 } as any);
      await settle();
    });
    await act(async () => {
      useVaultStore.getState().adoptBody("vault-1", file, { content: text, mtime: 3, etag: "e-full", size: text.length });
      await settle();
    });
    await act(async () => {
      release();
      await settle();
    });
    expect(useVaultStore.getState().bodies[file]?.content).toBe(text);
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    expect(view.state.doc.toString()).toBe(text);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a clean file removed and restored on disk comes back in its editor", async () => {
  const { EditorView } = await import("@codemirror/view");
  const { _applyVaultWsEventForTests } = await import("../../../store/vaultStore");
  const file = "src/restored.ts";
  const text = "export const v = 1;\n";
  const back = "export const v = 2;\n";
  const realFetch = globalThis.fetch;
  // While the file is gone the editor's read answers 404, slowly enough that
  // the file is back before it lands; every read after that finds it.
  let reads = 0;
  globalThis.fetch = (async (url: string) => {
    if (!String(url).includes("/vault/file")) return new Response("{}", { status: 404 });
    if (reads++ === 0) {
      await new Promise((r) => setTimeout(r, 150));
      return new Response("not found", { status: 404 });
    }
    return new Response(back, { status: 200, headers: { "X-Vault-Mtime": "3", "X-Vault-Size": String(back.length), ETag: "e3" } });
  }) as any;
  try {
    setVault({
      endpoint: { port: 1, token: "t" } as any,
      isRemote: false,
      connection: "connected",
      files: { [file]: { path: file, mtime: 1, size: text.length } } as any,
      bodies: { [file]: { content: text, mtime: 1, etag: "e1" } },
    });
    const host = await render(file);
    expect(EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!.state.doc.toString()).toBe(text);

    // A checkout: the file goes, then returns with other text.
    await act(async () => {
      _applyVaultWsEventForTests({ type: "removed", vault: "vault-1", path: file } as any);
      await settle();
    });
    // The editor stays, saying so, with a way to write the file back.
    expect(host.textContent).not.toContain("Not on disk");
    expect(host.textContent).toContain("Deleted on disk");
    expect(host.textContent).toContain("Recreate");
    await act(async () => {
      _applyVaultWsEventForTests({ type: "add", vault: "vault-1", path: file, mtime: 3, size: back.length } as any);
      await settle();
    });
    for (let i = 0; i < 20 && !host.querySelector(".cm-editor"); i++) await act(() => settle());
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    for (let i = 0; i < 20 && view.state.doc.toString() !== back; i++) await act(() => settle());
    expect(view.state.doc.toString()).toBe(back);
    expect(host.textContent).not.toContain("Couldn't read");
    expect(host.textContent).not.toContain("Deleted on disk");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("while discovery runs it waits for the read instead", async () => {
  setVault({ endpoint: null, isRemote: false, connection: "discovering" });
  const host = await render();
  expect(host.textContent).not.toContain("Couldn't read");
});

test("a remote vault without the file's text says it could not be read", async () => {
  // No Convex client: the remote read returns without a body.
  setVault({ endpoint: null, isRemote: true, connection: "connected" });
  const host = await render();
  expect(host.textContent).toContain("Couldn't read");
});

test("unsaved edits outlive their file leaving disk and see it come back", async () => {
  const { EditorView } = await import("@codemirror/view");
  const file = "src/gone.ts";
  const text = "export const x = 1;\n";
  setVault({
    endpoint: null,
    isRemote: false,
    connection: "discovering",
    files: { [file]: { path: file, mtime: 1, size: text.length } } as any,
    bodies: { [file]: { content: text, mtime: 1, etag: "e1" } },
  });
  const host = await render(file);
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  act(() => view.dispatch({ changes: { from: 0, insert: "// mine\n" } }));

  // The watcher's 'removed': the row and the body go.
  await act(async () => {
    useVaultStore.setState({ files: {}, bodies: {} });
    await settle();
  });
  expect(host.querySelector(".cm-editor")).not.toBeNull();
  expect(host.textContent).toContain("Deleted on disk");
  expect(host.textContent).toContain("Recreate");
  expect(view.state.doc.toString()).toBe(`// mine\n${text}`);

  // An agent writes it again: the edits wait for a merge with what came back.
  const back = "export const x = 2;\n";
  await act(async () => {
    useVaultStore.setState({
      files: { [file]: { path: file, mtime: 2, size: back.length } } as any,
      bodies: { [file]: { content: back, mtime: 2, etag: "e2" } },
    });
    await settle();
  });
  expect(host.textContent).not.toContain("Deleted on disk");
  expect(host.textContent).toContain("Changed on disk");
  expect(view.state.doc.toString()).toBe(`// mine\n${text}`);
});

test("a failed read names why, keeps the file bar, and Retry reads again", async () => {
  const { EditorView } = await import("@codemirror/view");
  const file = "src/denied.ts";
  const text = "export const d = 1;\n";
  const realFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async (url: string) => {
    if (!String(url).includes("/vault/file")) return new Response("{}", { status: 404 });
    if (reads++ === 0) return new Response("no", { status: 403 });
    return new Response(text, { status: 200, headers: { "X-Vault-Mtime": "1", "X-Vault-Size": String(text.length), ETag: "e1" } });
  }) as any;
  try {
    setVault({ endpoint: { port: 1, token: "t" } as any, isRemote: false, connection: "connected", files: { [file]: { path: file, mtime: 1, size: text.length } } as any });
    const host = await render(file);
    for (let i = 0; i < 20 && !host.textContent?.includes("Couldn't read"); i++) await act(() => settle());
    expect(host.textContent).toContain("Couldn't read");
    expect(host.textContent).toContain("No permission");
    // The breadcrumbs row stays: the file's name is still on screen.
    expect(host.querySelector("nav")?.textContent).toContain("denied.ts");
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Retry"))!;
    await act(async () => {
      retry.click();
      await settle();
    });
    for (let i = 0; i < 20 && !host.querySelector(".cm-editor"); i++) await act(() => settle());
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    for (let i = 0; i < 20 && view.state.doc.toString() !== text; i++) await act(() => settle());
    expect(view.state.doc.toString()).toBe(text);
    expect(reads).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a cached boot that waits past a beat offers Retry, which reconnects", async () => {
  setVault({ endpoint: null, isRemote: false, connection: "cached", files: { "src/slow.ts": { path: "src/slow.ts", mtime: 1, size: 9 } } as any });
  let reconnects = 0;
  const realReconnect = useVaultStore.getState().reconnect;
  useVaultStore.setState({ reconnect: async () => void reconnects++ });
  try {
    const host = await render("src/slow.ts");
    expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Couldn't read");
    await act(() => new Promise((r) => setTimeout(r, 4100)));
    expect(host.textContent).toContain("Daemon reconnecting");
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Retry"))!;
    await act(async () => retry.click());
    expect(reconnects).toBe(1);
    expect(host.textContent).not.toContain("Daemon reconnecting");
  } finally {
    useVaultStore.setState({ reconnect: realReconnect });
  }
}, 10000);

test("a text file past the editor's limit says its size and the limit", async () => {
  setVault({ endpoint: null, isRemote: false, connection: "connected", files: { "big.log": { path: "big.log", mtime: 1, size: 40 * 1024 * 1024 } } as any });
  const host = await render("big.log");
  expect(host.textContent).toContain("Too large");
  expect(host.textContent).toContain("40 MB · limit");
  expect(host.querySelector("nav")?.textContent).toContain("big.log");
});
