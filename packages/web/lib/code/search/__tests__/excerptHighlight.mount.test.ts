// Each excerpt of the results editor is colored in its own file's language.

import { expect, it } from "bun:test";
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { tags } = await import("@lezer/highlight");
const { CODE_HIGHLIGHT_STYLES } = await import("../../theme");
const { layoutMultibuffer } = await import("../excerpts");
const { multibufferCore, regionsField } = await import("../multibuffer");
const { excerptHighlight } = await import("../excerptHighlight");

it("marks keywords in a TypeScript excerpt and leaves a plain one alone", async () => {
  const layout = layoutMultibuffer([
    { path: "a.ts", text: "const x = 1;\nexport function f() {}\n", lines: [1] },
    { path: "notes.unknownext", text: "const y = 2\n", lines: [1] },
  ]);
  // The classes the code theme's styles give `const` and `export`.
  const keyword = new Set(CODE_HIGHLIGHT_STYLES.flatMap((s) => [s.style([tags.definitionKeyword]), s.style([tags.moduleKeyword])]).filter(Boolean));
  const isKeyword = (e: Element) => [...e.classList].some((c) => keyword.has(c));
  const paths = layout.paths;
  const state = EditorState.create({
    doc: layout.doc,
    extensions: [multibufferCore(layout), excerptHighlight({ regions: (s) => s.field(regionsField), paths: () => paths })],
  });
  const view = new EditorView({ state, parent: document.body });
  const marks = () => [...view.dom.querySelectorAll(".cm-line span")].filter(isKeyword).map((e) => e.textContent);
  for (let i = 0; i < 100 && !marks().length; i++) await new Promise((r) => setTimeout(r, 20));
  const marked = marks();
  expect(marked).toContain("const");
  expect(marked).toContain("export");
  // The unknown file's `const` stays plain.
  expect(marked.filter((t) => t === "const").length).toBe(1);
  view.destroy();
});
