// An explicit jump (definition, symbol, crumb, `:line`) is a back/forward stop
// however near it lands, with vim on or off, and even while a picker holds focus.

import { expect, it } from "bun:test";
import { installEditorDom } from "../../../components/code/__tests__/editorDom";

installEditorDom();

const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { attachFeatureHost, featureBase, syncEditorFeatures } = await import("../features");
const { registerWorkspaceEditorFeatures } = await import("../workspace/editorWorkspace");
const { _resetNavHistory, stepHistory } = await import("../workspace/navHistory");
const { jumpTo } = await import("../jump");

const ctx = { vaultId: "v", path: "a.ts", languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false };
const tick = () => new Promise((r) => setTimeout(r, 0));

for (const vim of [false, true]) {
  it(`a jump five lines away is a stop (${vim ? "vim" : "no vim"})`, async () => {
    _resetNavHistory();
    registerWorkspaceEditorFeatures();
    const view = new EditorView({ parent: document.body });
    const release = attachFeatureHost(view);
    view.setState(EditorState.create({ doc: Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"), extensions: featureBase(ctx) }));
    syncEditorFeatures(view);
    await tick();
    if (vim) view.scrollDOM.classList.add("cm-vimMode");
    jumpTo(view, view.state.doc.line(100).from);
    jumpTo(view, view.state.doc.line(95).from);
    expect(stepHistory(-1)?.line).toBe(100);
    release();
    view.destroy();
  });
}
