// Contract 1 of docs/architecture/code-editor.md: typing commits React zero
// times and writes no store. The first keystroke flips the buffer dirty (one
// codeStore write, one commit for the chrome that shows it); the next 49 cost
// React and both stores nothing, while the status bar's text nodes still move.
//
// Keystrokes are dispatched as the transactions CodeMirror's input handling
// produces (userEvent "input.type"); jsdom has no layout or beforeinput to
// drive CodeMirror's DOM observer the way a browser does.
import { expect, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";

installEditorDom();

const React = await import("react");
const { act, Profiler } = React;
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { useVaultStore } = await import("../../../store/vaultStore");
const { useCodeStore } = await import("../../../store/codeStore");
const { CodeFileView } = await import("../CodeFileView");

const content = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
useVaultStore.setState({
  activeVaultId: "vault-1",
  isRemote: false,
  files: { "src/add.ts": { path: "src/add.ts", mtime: 1, size: content.length } } as any,
  bodies: { "src/add.ts": { content, mtime: 1, etag: "e1" } },
});

test("50 keystrokes: no React commit and no store write after the first dirty transition", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  let commits = 0;
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <Profiler id="code" onRender={() => commits++}>
        <CodeFileView path="src/add.ts" />
      </Profiler>,
    );
  });
  await act(async () => {
    await settle();
  });

  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  expect(view).toBeTruthy();
  expect(host.querySelector("[data-owns-keys]")).toBeTruthy();
  const status = () => host.querySelector(".cm-code-status")?.textContent ?? "";
  expect(status()).toContain("Ln 1, Col 1");
  expect(status()).toContain("Spaces: 2");
  expect(status()).toContain("TypeScript");

  let vaultWrites = 0;
  let codeWrites = 0;
  const offVault = useVaultStore.subscribe(() => vaultWrites++);
  const offCode = useCodeStore.subscribe(() => codeWrites++);

  const typeChar = (ch: string) => {
    const pos = view.state.selection.main.head;
    view.dispatch({ changes: { from: pos, insert: ch }, selection: { anchor: pos + 1 }, userEvent: "input.type" });
  };

  await act(async () => typeChar("/"));
  expect(codeWrites).toBe(1); // clean -> dirty
  const commitsAfterFirst = commits;
  const codeAfterFirst = codeWrites;

  await act(async () => {
    for (let i = 0; i < 49; i++) typeChar(String.fromCharCode(97 + (i % 26)));
  });

  expect(commits - commitsAfterFirst).toBe(0);
  expect(codeWrites - codeAfterFirst).toBe(0);
  expect(vaultWrites).toBe(0);
  expect(view.state.doc.line(1).text.length).toBe(50 + "export function add(a: number, b: number) {".length);
  expect(status()).toContain("Ln 1, Col 51");
  expect(host.querySelector(".cm-code-status-dirty")?.textContent).toBe("●");

  offVault();
  offCode();
  await act(async () => root.unmount());
  host.remove();
});
