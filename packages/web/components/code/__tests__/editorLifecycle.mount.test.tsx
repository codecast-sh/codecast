// The editor as Files mounts it: one EditorView for the pane's life, even
// across a file whose text has not loaded yet (contract 2), and chrome that
// follows a save, which moves the saved version rather than the document.
import { afterAll, expect, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";

installEditorDom();

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { useVaultStore } = await import("../../../store/vaultStore");
const { bufferKey, codeBuffers } = await import("../../../lib/code/buffers");
const { _setDiskIOForTests, saveBuffer } = await import("../../../lib/code/fileSync");
const { CodeFileView } = await import("../CodeFileView");

const a = "export const a = 1;\n";
const b = "export const b = 2;\n";
useVaultStore.setState({
  activeVaultId: "vault-1",
  isRemote: false,
  files: {
    "src/a.ts": { path: "src/a.ts", mtime: 1, size: a.length },
    "src/b.ts": { path: "src/b.ts", mtime: 1, size: b.length },
  } as any,
  bodies: { "src/a.ts": { content: a, mtime: 1, etag: "ea" } },
});

let writes = 0;
afterAll(
  _setDiskIOForTests({
    write: async (_b, content) => ({ etag: `w${++writes}`, mtime: 2, size: content.length }),
    createEmpty: async () => {},
    read: async () => null,
    adopt: () => {},
  }),
);

async function mount(path: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (p: string) => act(async () => root.render(<CodeFileView path={p} />));
  await render(path);
  await act(settle);
  const view = () => EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement);
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, render, view, unmount };
}

test("a file whose text is still loading keeps the same view", async () => {
  const m = await mount("src/a.ts");
  const first = m.view();
  expect(first?.state.doc.toString()).toBe(a);

  await m.render("src/b.ts"); // no body yet
  expect(m.view()).toBe(first);
  expect(first!.state.doc.length).toBe(0);
  expect(m.host.textContent).toContain("Loading");

  await act(async () => {
    useVaultStore.setState((s) => ({ bodies: { ...s.bodies, "src/b.ts": { content: b, mtime: 1, etag: "eb" } } }));
  });
  expect(m.view()).toBe(first);
  expect(first!.state.doc.toString()).toBe(b);
  expect(m.host.textContent).not.toContain("Loading");

  await m.render("src/a.ts");
  expect(m.view()).toBe(first);
  expect(first!.state.doc.toString()).toBe(a);
  await m.unmount();
});

test("the unsaved dot clears when a save lands", async () => {
  const m = await mount("src/a.ts");
  const view = m.view()!;
  const dot = () => m.host.querySelector(".cm-code-status-dirty")?.textContent;
  await act(async () => view.dispatch({ changes: { from: 0, insert: "// x\n" }, userEvent: "input.type" }));
  expect(dot()).toBe("●");
  expect(await act(() => saveBuffer(codeBuffers.get(bufferKey("vault-1", "src/a.ts"))!))).toBe("saved");
  expect(dot()).toBe("");
  await m.unmount();
});
