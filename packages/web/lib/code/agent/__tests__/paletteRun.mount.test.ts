// The command palette runs editor commands with no view in their context, after
// it has closed and focus has left the editor. The agent's verbs then act on
// the editor the person was last in (features.focusedEditorView), so "Instruct
// session here" opens its box even where a vimrc maps Cmd-K away.
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { afterAll, expect, it } = await import("bun:test");
const { EditorSelection } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { attachFeatureHost, featureBase, focusedEditorView, syncEditorFeatures } = await import("../../features");
const { useVaultStore } = await import("../../../../store/vaultStore");
const { useAgentStore } = await import("../agentStore");
const { registerAgentFeature } = await import("../feature");
const { runCodeCommand } = await import("../../commands");
const { agentMarks } = await import("../editorMarks");
const { codeBuffers } = await import("../../buffers");

const vaultBefore = useVaultStore.getState();
afterAll(() => useVaultStore.setState(vaultBefore as never, true));

function mount(path: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const ctx = { vaultId: "v", path, languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false };
  const buffer = codeBuffers.open({ vaultId: "v", path, content: "a\nb\nc\nd", etag: "e", extensions: () => [featureBase(ctx)] });
  const view = new EditorView({ parent, state: buffer.state });
  buffer.view = view;
  const release = attachFeatureHost(view);
  syncEditorFeatures(view);
  return { view, release };
}

it("a palette run with no view acts on the editor last focused", () => {
  useVaultStore.setState({ vaults: [{ id: "v", root: "/r/app", name: "app" }], endpoint: { url: "http://x", token: "t" } } as never);
  useAgentStore.setState({ links: {}, picker: null, inline: null });
  registerAgentFeature();
  const left = mount("src/left.ts");
  const right = mount("src/right.ts");

  right.view.contentDOM.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  expect(focusedEditorView()).toBe(right.view);
  right.view.dispatch({ selection: EditorSelection.range(right.view.state.doc.line(2).from, right.view.state.doc.line(3).to) });
  right.view.contentDOM.blur();

  expect(runCodeCommand("agent.inlineInstruction", undefined, { source: "palette" })).toBe(true);
  expect(agentMarks(right.view.state).inline).toMatchObject({ from: right.view.state.doc.line(2).from });
  expect(agentMarks(left.view.state).inline).toBeFalsy();
  expect(useAgentStore.getState().inline?.range.startLine).toBe(2);

  // A closed editor is never the target.
  right.release();
  right.view.destroy();
  expect(focusedEditorView()).not.toBe(right.view);
  left.release();
  left.view.destroy();
});
