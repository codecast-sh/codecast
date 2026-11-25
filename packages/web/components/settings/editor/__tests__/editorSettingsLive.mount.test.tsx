// Settings > Editor reaching real editors: choices apply live through the
// compartments, beat the vimrc, autosave writes through the core's save path,
// and the vimrc overlay editor saves through the daemon's overlay route.
import { afterAll, expect, mock, test } from "bun:test";
import { installEditorDom, settle } from "../../../code/__tests__/editorDom";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";

installEditorDom();

// Synthetic (the repo is public): a vimrc that sets relative numbers and nowrap.
const vimrc: CodeVimrcResponse = {
  sources: [{ path: "/home/test/.vimrc", content: "set relativenumber\nset nowrap\nset tabstop=8\n" }],
  overlay: null,
};
const overlayWrites: string[] = [];
const realClient = { ...(await import("../../../../lib/code/daemonClient")) };
mock.module("../../../../lib/code/daemonClient", () => ({
  ...realClient,
  fetchVimrcText: async () => JSON.stringify(vimrc),
  writeVimrcOverlay: async (_ep: unknown, content: string) => {
    overlayWrites.push(content);
    vimrc.overlay = { path: "/home/test/.codecast/editor/vimrc", content };
    return { path: "/home/test/.codecast/editor/vimrc", bytes: content.length };
  },
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { getCM, Vim } = await import("@replit/codemirror-vim");
const { useInboxStore } = await import("../../../../store/inboxStore");
const { useVaultStore } = await import("../../../../store/vaultStore");
const { useCodeStore } = await import("../../../../store/codeStore");
const { _setDiskIOForTests, revertBuffer, saveAllBuffers } = await import("../../../../lib/code/fileSync");
const { runCodeCommand } = await import("../../../../lib/code/commands");
const { setEditorSetting } = await import("../../../../lib/code/editorSettings");
const { codeBuffers, bufferKey } = await import("../../../../lib/code/buffers");
const { CodeFileView } = await import("../../../code/CodeFileView");
const { default: VimOverlayEditor } = await import("../VimOverlayEditor");
const { OVERLAY_VAULT } = await import("../overlaySave");

const originalUi = useInboxStore.getState().clientState;
useInboxStore.setState({ clientState: { ...originalUi, ui: {} } } as never);
afterAll(() => useInboxStore.setState({ clientState: originalUi } as never));

const text = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
useVaultStore.setState({
  activeVaultId: "vault-s",
  isRemote: false,
  endpoint: { port: 1, token: "t" } as never,
  files: { "src/a.ts": { path: "src/a.ts", mtime: 1, size: text.length } } as never,
  bodies: { "src/a.ts": { content: text, mtime: 1, etag: "ea" } },
});

const writes: string[] = [];
/** What a disk read answers; a read waits on `readGate` when one is set. */
let diskText: string | null = null;
let readGate: Promise<void> | null = null;
afterAll(
  _setDiskIOForTests({
    write: async (_b, content) => {
      writes.push(content);
      return { etag: `w${writes.length}`, mtime: 2, size: content.length };
    },
    createEmpty: async () => {},
    read: async () => {
      if (readGate) await readGate;
      return diskText === null ? null : { content: diskText, etag: `w${writes.length}`, mtime: 2, size: diskText.length };
    },
    adopt: () => {},
  }),
);

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
await act(async () => root.render(<CodeFileView path="src/a.ts" />));
const editorIn = (el: Element) => EditorView.findFromDOM(el.querySelector(".cm-editor") as HTMLElement)!;
for (let i = 0; i < 30 && !getCM(editorIn(host)); i++) await act(settle);
const view = editorIn(host);
// The wrap class on the content, which the soft wrap compartment sets (the
// view's own flag waits on a measure jsdom never runs).
const wraps = () => view.contentDOM.classList.contains("cm-lineWrapping");
const gutterNumbers = () =>
  [...host.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")].filter((e) => e.style.visibility !== "hidden").map((e) => e.textContent);

test("the vimrc decides what was not set", async () => {
  await act(settle);
  expect(gutterNumbers()).toEqual(["1", "1", "2", "3"]);
  expect(wraps()).toBe(false);
  expect(view.state.tabSize).toBe(8);
});

test("an explicit choice wins over the vimrc, live, without a new view", async () => {
  await act(async () => {
    setEditorSetting("softWrap", true);
    setEditorSetting("lineNumbers", "absolute");
    setEditorSetting("tabSize", 2);
  });
  await act(settle);
  expect(editorIn(host)).toBe(view);
  expect(wraps()).toBe(true);
  expect(gutterNumbers()).toEqual(["1", "2", "3", "4"]);
  expect(view.state.tabSize).toBe(2);
  await act(async () => setEditorSetting("lineNumbers", "off"));
  await act(settle);
  expect(host.querySelector(".cm-lineNumbers")).toBeNull();
});

test("a :set typed in the editor beats an explicit choice", async () => {
  await act(async () => {
    setEditorSetting("softWrap", false);
    setEditorSetting("tabSize", 2);
  });
  await act(settle);
  expect(wraps()).toBe(false);
  await act(async () => {
    Vim.handleEx(getCM(view) as never, "set wrap");
    Vim.handleEx(getCM(view) as never, "set ts=6");
  });
  await act(settle);
  expect(wraps()).toBe(true);
  expect(view.state.tabSize).toBe(6);
  // A new choice is newer than the :set, and wins again.
  await act(async () => setEditorSetting("softWrap", true));
  await act(async () => setEditorSetting("softWrap", false));
  await act(settle);
  expect(wraps()).toBe(false);
  await act(async () => setEditorSetting("lineNumbers", "absolute"));
  await act(settle);
  await act(async () => Vim.handleEx(getCM(view) as never, "set rnu"));
  await act(settle);
  expect(gutterNumbers()).toEqual(["1", "1", "2", "3"]);
});

test("clearing a choice hands it back to the vimrc", async () => {
  await act(async () => {
    setEditorSetting("softWrap", undefined);
    setEditorSetting("lineNumbers", undefined);
    setEditorSetting("tabSize", undefined);
  });
  await act(settle);
  expect(wraps()).toBe(false);
  expect(gutterNumbers()).toEqual(["1", "1", "2", "3"]);
  expect(view.state.tabSize).toBe(8);
});

test("font size and line height reach the editor", async () => {
  await act(async () => setEditorSetting("fontSize", 16));
  await act(settle);
  const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
  expect(css).toContain("font-size: 16px");
});

test("autosave off writes nothing; after a delay it writes once typing stops", async () => {
  view.dispatch({ changes: { from: 0, insert: "x" } });
  await act(() => new Promise((r) => setTimeout(r, 1200)));
  expect(writes).toEqual([]);
  await act(async () => setEditorSetting("autosave", "delay"));
  view.dispatch({ changes: { from: 0, insert: "y" } });
  await act(() => new Promise((r) => setTimeout(r, 500)));
  view.dispatch({ changes: { from: 0, insert: "z" } });
  await act(() => new Promise((r) => setTimeout(r, 500)));
  expect(writes).toEqual([]);
  await act(() => new Promise((r) => setTimeout(r, 700)));
  expect(writes).toEqual([`zyx${text}`]);
  expect(useCodeStore.getState().dirty[bufferKey("vault-s", "src/a.ts")]).toBeUndefined();
});

test("autosave on focus change writes when the editor loses focus", async () => {
  await act(async () => setEditorSetting("autosave", "focus"));
  view.focus();
  view.dispatch({ changes: { from: 0, insert: "w" } });
  await act(() => new Promise((r) => setTimeout(r, 1200)));
  expect(writes.length).toBe(1);
  // Vim's `:` prompt takes focus inside the editor: not a focus change.
  await act(async () => Vim.handleKey(getCM(view) as never, ":", "user"));
  await act(settle);
  const prompt = view.dom.ownerDocument.activeElement as HTMLInputElement;
  expect(prompt.tagName).toBe("INPUT");
  expect(view.dom.contains(prompt)).toBe(true);
  expect(writes.length).toBe(1);
  // A click away closes the prompt, and vim hands focus back to the editor:
  // still not a focus change.
  const outside = document.createElement("button");
  document.body.append(outside);
  await act(async () => outside.focus());
  await act(settle);
  expect(view.dom.contains(view.dom.ownerDocument.activeElement)).toBe(true);
  expect(writes.length).toBe(1);
  outside.remove();
  // Leaving the editor is.
  view.contentDOM.blur();
  await act(settle);
  expect(writes.length).toBe(2);
  expect(writes[1]).toBe(`wzyx${text}`);
  // Switching to another window or app: activeElement stays on the editor,
  // only the document loses focus. That saves too.
  view.focus();
  view.dispatch({ changes: { from: 0, insert: "v" } });
  await act(settle);
  expect(view.dom.contains(document.activeElement)).toBe(true);
  const hasFocus = document.hasFocus;
  document.hasFocus = () => false;
  try {
    view.contentDOM.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await act(settle);
  } finally {
    document.hasFocus = hasFocus;
  }
  expect(writes.length).toBe(3);
  expect(writes[2]).toBe(`vwzyx${text}`);
  await act(async () => setEditorSetting("autosave", undefined));
});

test("autosave never writes edits a revert is throwing away", async () => {
  await act(async () => setEditorSetting("autosave", "delay"));
  diskText = writes[writes.length - 1];
  const before = writes.length;
  let open!: () => void;
  readGate = new Promise((r) => (open = r));
  view.dispatch({ changes: { from: 0, insert: "DISCARD" } });
  const b = codeBuffers.get(bufferKey("vault-s", "src/a.ts"))!;
  const reverting = revertBuffer(b);
  // The delay passes while the revert waits on disk.
  await act(() => new Promise((r) => setTimeout(r, 1200)));
  expect(writes.length).toBe(before);
  open();
  readGate = null;
  await act(async () => reverting);
  await act(settle);
  expect(view.state.doc.toString()).toBe(diskText);
  await act(() => new Promise((r) => setTimeout(r, 1200)));
  expect(writes.length).toBe(before);
  await act(async () => setEditorSetting("autosave", undefined));
  await act(async () => root.unmount());
  host.remove();
});

test("the overlay editor runs vim and saves through the overlay route, then reloads", async () => {
  const ov = document.createElement("div");
  document.body.append(ov);
  const ovRoot = createRoot(ov);
  let reloads = 0;
  const path = "/home/test/.codecast/editor/vimrc";
  await act(async () =>
    ovRoot.render(<VimOverlayEditor ep={{ port: 1, token: "t" } as never} path={path} content="" reload={() => reloads++} onClose={() => {}} />),
  );
  for (let i = 0; i < 30 && !getCM(editorIn(ov)); i++) await act(settle);
  const ovView = editorIn(ov);
  // Vim always runs in the overlay, whatever the mode setting.
  expect(getCM(ovView)).not.toBeNull();
  ovView.dispatch({ changes: { from: 0, insert: "nnoremap ; :\n" } });
  await act(settle);
  expect(useCodeStore.getState().dirty[bufferKey(OVERLAY_VAULT, path)]).toBe(true);
  const vaultWritesBefore = writes.length;
  await act(async () => {
    runCodeCommand("file.save", undefined, { view: ovView, source: "vim" });
  });
  await act(settle);
  expect(overlayWrites).toEqual(["nnoremap ; :\n"]);
  expect(writes.length).toBe(vaultWritesBefore);
  expect(reloads).toBe(1);
  expect(useCodeStore.getState().dirty[bufferKey(OVERLAY_VAULT, path)]).toBeUndefined();
  expect(ov.textContent).toContain("applied");
  // Saving again with nothing new writes nothing.
  await act(async () => {
    runCodeCommand("file.save", undefined, { view: ovView, source: "keymap" });
  });
  await act(settle);
  expect(overlayWrites.length).toBe(1);
  // Save all (`:wa`, Mod-Alt-S, Files) writes the overlay through its route too.
  ovView.dispatch({ changes: { from: 0, insert: "set nu\n" } });
  await act(async () => {
    await saveAllBuffers();
  });
  await act(settle);
  expect(overlayWrites).toEqual(["nnoremap ; :\n", "set nu\nnnoremap ; :\n"]);
  expect(writes.length).toBe(vaultWritesBefore);
  expect(useCodeStore.getState().conflicts[bufferKey(OVERLAY_VAULT, path)]).toBeUndefined();
  expect(reloads).toBe(2);
  await act(async () => ovRoot.unmount());
  // A clean overlay buffer is dropped, so the next visit opens disk.
  expect(codeBuffers.get(bufferKey(OVERLAY_VAULT, path))).toBeUndefined();
  ov.remove();
  void EditorState;
});
