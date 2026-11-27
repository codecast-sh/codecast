// Fold markers are the breadcrumbs' lucide chevrons, not text glyphs, and an
// open marker is told apart from a folded one so the theme can show open
// markers only on the cursor's line or a hovered gutter.
import { installEditorDom } from "../../../components/code/__tests__/editorDom";

installEditorDom();

const { expect, it } = await import("bun:test");
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { foldAll, foldService } = await import("@codemirror/language");
const { codeSetup, DEFAULT_EDITOR_OPTIONS } = await import("../setup");
const { bufferFields } = await import("../buffers");

// The first line folds the rest of the document.
const firstLineFolds = foldService.of((state, from, to) => (from === 0 ? { from: to, to: state.doc.length } : null));

it("draws open and folded markers as SVG chevrons with their state", () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const doc = "function a() {\n  return 1;\n}\n";
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [bufferFields({ lineSeparator: "\n", bom: false, lossy: false } as never), codeSetup({ options: DEFAULT_EDITOR_OPTIONS, indent: { unit: "  ", tabs: false, width: 2, detected: true }, readOnly: false, largeFile: false }), firstLineFolds],
    }),
  });
  const markers = () => [...view.dom.querySelectorAll(".cm-fold-marker")] as HTMLElement[];
  const open = markers().filter((m) => m.dataset.fold === "open");
  expect(open.length).toBeGreaterThan(0);
  expect(open[0].querySelector("svg")?.getAttribute("width")).toBe("12");
  expect(open[0].textContent).toBe("");
  foldAll(view);
  expect(markers().some((m) => m.dataset.fold === "folded")).toBe(true);
  view.destroy();
  parent.remove();
});
