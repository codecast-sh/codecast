// Lazy gutters (blame, lint, git) arrive one by one after the file paints.
// Each holds its column from the first frame through a placeholder in its own
// slot, so the text never shifts sideways as features land.

import { expect, it } from "bun:test";
import { installEditorDom } from "../../../components/code/__tests__/editorDom";

installEditorDom();

const { EditorState, Prec } = await import("@codemirror/state");
const { EditorView, gutter } = await import("@codemirror/view");
const { attachFeatureHost, featureBase, registerEditorFeature, syncEditorFeatures } = await import("../features");
const { blameGutterStandIn, gitGutterStandIn, lintGutterStandIn } = await import("../gutterSlots");

const ctx = { vaultId: "v", path: "a.ts", languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false };
const columns = (view: InstanceType<typeof EditorView>) =>
  [...view.dom.querySelectorAll(".cm-gutters > .cm-gutter")].map((g) => g.className.replace("cm-gutter", "").trim());
const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

it("each stand-in holds its column in the real gutter's order from the first frame", async () => {
  const git = deferred();
  const blame = deferred();
  const lint = deferred();
  const offs = [
    registerEditorFeature("t.git", () => git.promise as never, { placeholder: () => gitGutterStandIn }),
    registerEditorFeature("t.blame", () => blame.promise as never, { placeholder: () => blameGutterStandIn }),
    registerEditorFeature("t.lint", () => lint.promise as never, { placeholder: () => lintGutterStandIn }),
  ];
  const view = new EditorView({ parent: document.body });
  const release = attachFeatureHost(view);
  view.setState(EditorState.create({ doc: "x", extensions: featureBase(ctx) }));
  syncEditorFeatures(view);
  const first = columns(view);
  expect(first).toEqual(["cm-blame-gutter", "cm-gutter-lint", "cm-git-gutter"]);

  // The real gutters land in the same slots: the columns stay put.
  git.resolve(Prec.lowest(gutter({ class: "cm-git-gutter" })));
  lint.resolve(gutter({ class: "cm-gutter-lint" }));
  blame.resolve(Prec.high(gutter({ class: "cm-blame-gutter" })));
  await tick();
  expect(columns(view)).toEqual(first);

  release();
  view.destroy();
  offs.forEach((off) => off());
});

it("a feature that fails gives its column back, and one that draws nothing drops it", async () => {
  const failing = deferred();
  const empty = deferred();
  const offs = [
    registerEditorFeature("t.fail", () => failing.promise as never, { placeholder: () => lintGutterStandIn }),
    registerEditorFeature("t.empty", () => empty.promise as never, { placeholder: () => gitGutterStandIn }),
  ];
  const view = new EditorView({ parent: document.body });
  const release = attachFeatureHost(view);
  view.setState(EditorState.create({ doc: "x", extensions: featureBase(ctx) }));
  syncEditorFeatures(view);
  expect(columns(view)).toEqual(["cm-gutter-lint", "cm-git-gutter"]);

  const error = console.error;
  console.error = () => {};
  failing.reject(new Error("no server"));
  empty.resolve(null);
  await tick();
  console.error = error;
  expect(columns(view)).toEqual([]);

  release();
  view.destroy();
  offs.forEach((off) => off());
});
