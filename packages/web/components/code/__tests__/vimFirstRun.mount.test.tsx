// A person with no vimrc: vim stays off, and the status bar still offers it
// (a dim "Vim" chip that turns it on), and the palette names what its command
// would do now.
import { expect, mock, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";

installEditorDom();
localStorage.clear();

const empty: CodeVimrcResponse = { sources: [], overlay: null };
const realClient = { ...(await import("../../../lib/code/daemonClient")) };
mock.module("../../../lib/code/daemonClient", () => ({
  ...realClient,
  fetchVimrcText: async () => JSON.stringify(empty),
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { getCM } = await import("@replit/codemirror-vim");
const { useVaultStore } = await import("../../../store/vaultStore");
const { codeCommandLabel } = await import("../../../lib/code/commands");
const { editorSetting } = await import("../../../lib/code/editorSettings");
const { CodeFileView } = await import("../CodeFileView");

const text = "const a = 1;\n";
useVaultStore.setState({
  activeVaultId: "vault-1",
  isRemote: false,
  endpoint: { port: 1, token: "t" } as any,
  files: { "src/a.ts": { path: "src/a.ts", mtime: 1, size: text.length } } as any,
  bodies: { "src/a.ts": { content: text, mtime: 1, etag: "ea" } },
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
await act(async () => root.render(<CodeFileView path="src/a.ts" />));
for (let i = 0; i < 10; i++) await act(settle);
const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
const chip = () => host.querySelector<HTMLButtonElement>(".cm-vim-mode")!;

test("no vimrc: vim is off and the chip offers it", () => {
  expect(editorSetting("vimMode")).toBe("auto");
  expect(getCM(view)).toBeNull();
  expect(chip().hidden).toBe(false);
  expect(chip().textContent).toBe("Vim");
  expect(chip().dataset.mode).toBe("off");
  expect(chip().title).toBe("Turn vim on");
  expect(codeCommandLabel("vim.toggle")).toBe("Vim: turn on");
});

test("clicking the chip turns vim on, and the palette's name follows", async () => {
  await act(async () => chip().click());
  for (let i = 0; i < 20 && !getCM(view); i++) await act(settle);
  expect(getCM(view)).not.toBeNull();
  expect(chip().textContent).toBe("NORMAL");
  expect(editorSetting("vimMode")).toBe("on");
  expect(codeCommandLabel("vim.toggle")).toBe("Vim: turn off");
  await act(async () => root.unmount());
  host.remove();
});
