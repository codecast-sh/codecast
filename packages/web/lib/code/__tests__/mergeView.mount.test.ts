// The merge view tells the conflicts (both sides wrote the lines) apart from
// the person's clean edits: red-barred, stepped to first, and counted only
// while they still differ from disk.
import { installEditorDom } from "../../../components/code/__tests__/editorDom";

installEditorDom();

const { describe, expect, it } = await import("bun:test");
const { EditorSelection, EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const kit = await import("@codemirror/merge");
const { mergeChunkCount, mergeViewExtension, openConflicts, stepMerge, threeWayMerge } = await import("../merge");

const L = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");
const base = L("import a", "", "function one() {", "  return 1;", "}", "", "function two() {", "  return 2;", "}");
const disk = base.replace("return 1;", "return 'disk';");
const mine = base.replace("return 1;", "return 'mine';").replace("return 2;", "return 22;");

function mount() {
  const merged = threeWayMerge(kit, base, disk, mine);
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: merged.text, extensions: [mergeViewExtension(kit, disk, merged.regions)] }) });
  return view;
}

describe("the merge view's conflicts", () => {
  it("are marked apart from a clean edit, stepped to first, and resolved by taking a side", () => {
    const view = mount();
    expect(mergeChunkCount(kit, view.state)).toBe(2);
    expect(openConflicts(kit, view.state)).toHaveLength(1);
    const barred = [...view.dom.querySelectorAll(".cm-line")].filter((l) => l.classList.contains("cm-code-mergeConflict")).map((l) => l.textContent);
    expect(barred).toEqual(["  return 'mine';"]);

    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    expect(stepMerge(kit, view, 1)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("  return 'mine';");

    // Taking disk's side of the conflict: the clean edit still differs.
    const at = view.state.doc.toString().indexOf("return 'mine';");
    view.dispatch({ changes: { from: at, to: at + "return 'mine';".length, insert: "return 'disk';" } });
    expect(openConflicts(kit, view.state)).toEqual([]);
    expect(mergeChunkCount(kit, view.state)).toBe(1);
    expect(view.dom.querySelector(".cm-code-mergeConflict")).toBeNull();
    view.destroy();
  });
});
