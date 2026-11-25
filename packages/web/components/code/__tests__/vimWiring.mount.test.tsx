// Vim as Files mounts it: the daemon's vimrc reaches the editor through the
// vim feature, the status bar shows the mode, the person's maps and options
// work, Escape reaches vim ahead of the core keymap, and `:w` saves.
import { afterAll, expect, mock, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";

installEditorDom();

let vimrcReads = 0;
const vimrc: CodeVimrcResponse = {
  sources: [{ path: "/home/test/.vimrc", content: 'let mapleader=","\nnoremap H ^\nnoremap L $\nset relativenumber\nset nowrap\n' }],
  overlay: null,
};
const realClient = { ...(await import("../../../lib/code/daemonClient")) };
mock.module("../../../lib/code/daemonClient", () => ({
  ...realClient,
  fetchVimrcText: async () => {
    vimrcReads++;
    return JSON.stringify(vimrc);
  },
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { getCM, Vim } = await import("@replit/codemirror-vim");
const { useVaultStore } = await import("../../../store/vaultStore");
const { _setDiskIOForTests } = await import("../../../lib/code/fileSync");
const { runCodeCommand } = await import("../../../lib/code/commands");
const { editorSetting } = await import("../../../lib/code/editorSettings");
const { CodeFileView } = await import("../CodeFileView");

const text = "    const a = 1;\nconst b = 2;\nconst c = 3;\n";
useVaultStore.setState({
  activeVaultId: "vault-1",
  isRemote: false,
  endpoint: { port: 1, token: "t" } as any,
  files: { "src/a.ts": { path: "src/a.ts", mtime: 1, size: text.length } } as any,
  bodies: { "src/a.ts": { content: text, mtime: 1, etag: "ea" } },
});

const writes: string[] = [];
afterAll(
  _setDiskIOForTests({
    write: async (_b, content) => {
      writes.push(content);
      return { etag: `w${writes.length}`, mtime: 2, size: content.length };
    },
    createEmpty: async () => {},
    read: async () => null,
    adopt: () => {},
  }),
);

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
await act(async () => root.render(<CodeFileView path="src/a.ts" />));
// The vim feature waits on the vimrc read and the engine chunk.
for (let i = 0; i < 20 && !getCM(EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!); i++) await act(settle);
const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
const chip = () => host.querySelector<HTMLElement>(".cm-vim-mode")!;
const keys = (seq: string) => {
  for (const k of seq) Vim.handleKey(getCM(view) as never, k, "user");
};

test("a vimrc turns vim on, and the status bar shows its mode", () => {
  expect(vimrcReads).toBe(1);
  expect(getCM(view)).not.toBeNull();
  expect(chip().textContent).toBe("NORMAL");
  expect(chip().hidden).toBe(false);
});

test("the person's maps work", () => {
  keys("L");
  expect(view.state.selection.main.head).toBe(text.indexOf(";"));
  keys("H");
  expect(view.state.selection.main.head).toBe(4);
});

test("the vimrc's options reach the core's gutter and wrap", async () => {
  await act(settle);
  expect(view.lineWrapping).toBe(false);
  // Past the hidden width spacer, one per line: the cursor line absolute,
  // the rest by distance from it (`set relativenumber`).
  const numbers = [...host.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")].filter((e) => e.style.visibility !== "hidden");
  expect(numbers.map((e) => e.textContent)).toEqual(["1", "1", "2", "3"]);
});

test("a real Escape leaves insert mode ahead of the editor's own keymap", async () => {
  keys("i");
  expect(chip().textContent).toBe("INSERT");
  view.dispatch(view.state.replaceSelection("x"));
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(chip().textContent).toBe("NORMAL");
});

test("showcmd shows the keys vim holds, beside the mode, until the command runs", () => {
  const showcmd = () => host.querySelector<HTMLElement>(".cm-vim-showcmd")!;
  const press = (key: string) =>
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  expect(showcmd().hidden).toBe(true);
  press("2");
  expect(showcmd().textContent).toBe("2");
  expect(showcmd().hidden).toBe(false);
  press("d");
  expect(showcmd().textContent).toBe("2d");
  expect(chip().textContent).toBe("NORMAL");
  press("Escape");
  expect(showcmd().hidden).toBe(true);
  // `g` waits for its second key; `gg` runs and the column empties.
  press("g");
  expect(showcmd().textContent).toBe("g");
  press("g");
  expect(showcmd().hidden).toBe(true);
});

test(":w saves through the workspace command", async () => {
  Vim.handleEx(getCM(view) as never, "w");
  await act(settle);
  expect(writes).toEqual([`    x${text.slice(4)}`]);
});

test("vim.toggle turns it off and back on", async () => {
  runCodeCommand("vim.toggle");
  await act(settle);
  expect(getCM(view)).toBeNull();
  expect(chip().textContent).toBe("Vim");
  expect(chip().hidden).toBe(false);
  runCodeCommand("vim.toggle");
  for (let i = 0; i < 10 && !getCM(view); i++) await act(settle);
  expect(chip().textContent).toBe("NORMAL");
  // Back to following the vimrc: no stored choice.
  expect(editorSetting("vimMode")).toBe("auto");
  await act(async () => root.unmount());
  host.remove();
});
