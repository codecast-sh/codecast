// An async feature (the language server, which waits on a process) must land
// in the editor that shows the file when it resolves, even when the editor it
// started in was destroyed meanwhile: React StrictMode mounts the editor twice
// in development, and a remount or split does it in production.

import { expect, it } from "bun:test";
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { EditorState, StateField } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { attachFeatureHost, featureBase, registerEditorFeature, syncEditorFeatures } = await import("../../features");

it("lands an async feature in the view that took the file over", async () => {
  const marker = StateField.define({ create: () => "landed", update: (v) => v });
  let resolve!: (ext: unknown) => void;
  let runs = 0;
  const off = registerEditorFeature("test.slow", () => {
    runs++;
    return new Promise((r) => (resolve = r)) as never;
  });
  const ctx = { vaultId: "v", path: "a.ts", languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false };
  const state = EditorState.create({ doc: "x", extensions: featureBase(ctx) });

  const first = new EditorView({ parent: document.body });
  const releaseFirst = attachFeatureHost(first);
  first.setState(state);
  syncEditorFeatures(first);
  releaseFirst();
  first.destroy();

  const second = new EditorView({ parent: document.body });
  const releaseSecond = attachFeatureHost(second);
  second.setState(state);
  syncEditorFeatures(second);
  expect(runs).toBe(1);

  resolve(marker);
  await new Promise((r) => setTimeout(r, 0));
  expect(second.state.field(marker, false)).toBe("landed");

  releaseSecond();
  second.destroy();
  off();
});

it("a feature that needs a vault never runs for a buffer that is not a vault file", () => {
  let runs = 0;
  let plain = 0;
  const offVault = registerEditorFeature("test.vault", () => (runs++, []), { needsVault: true });
  const offPlain = registerEditorFeature("test.plain", () => (plain++, []));
  const view = new EditorView({ parent: document.body });
  const release = attachFeatureHost(view);
  const base = { path: "vimrc", languageId: "vim", languageName: "Vim Script", sizeBytes: 1, largeFile: false };
  view.setState(EditorState.create({ doc: "x", extensions: featureBase({ ...base, vaultId: "codecast:overlay", isRealVault: false }) }));
  syncEditorFeatures(view);
  expect([runs, plain]).toEqual([0, 1]);
  view.setState(EditorState.create({ doc: "x", extensions: featureBase({ ...base, vaultId: "v" }) }));
  syncEditorFeatures(view);
  expect([runs, plain]).toEqual([1, 2]);
  release();
  view.destroy();
  offVault();
  offPlain();
});
