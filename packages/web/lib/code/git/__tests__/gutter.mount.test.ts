import { beforeAll, describe, expect, it } from "bun:test";
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { EditorState, Text } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { history, undo } = await import("@codemirror/commands");
const kit = await import("@codemirror/merge");
const git = await import("../gutter");

const L = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");
const BASE = L("one", "two", "three", "four", "five", "six");
const DOC = L("one", "TWO", "three", "inserted", "four", "six");

let parent: HTMLElement;
beforeAll(() => {
  parent = document.createElement("div");
  document.body.append(parent);
});

function mount(doc = DOC, base = BASE, targets: { ref: string; label?: string }[] = []) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        git.gitEditorExtension({
          kit,
          vaultId: "v",
          path: "a.ts",
          base: Text.of(base.split("\n")),
          fetchBase: async () => "other\n",
          targets: () => targets,
        }),
      ],
    }),
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("gutter", () => {
  it("marks added, modified and deleted lines", () => {
    const view = mount();
    expect(git.gitLineMarks(view.state)).toEqual([
      { line: 2, kind: "modified" },
      { line: 4, kind: "added" },
      // "five" was removed above "six".
      { line: 6, kind: "deleted" },
    ]);
    view.destroy();
  });

  it("maps marks on a keystroke and rediffs only after a pause", async () => {
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "zero\n" } });
    // Shifted, not yet rediffed: the new line has no mark of its own.
    expect(git.gitLineMarks(view.state).map((m) => m.line)).toEqual([3, 5, 7]);
    await wait(260);
    expect(git.gitLineMarks(view.state)).toEqual([
      { line: 1, kind: "added" },
      { line: 3, kind: "modified" },
      { line: 5, kind: "added" },
      { line: 7, kind: "deleted" },
    ]);
    view.destroy();
  });
});

describe("hunk actions", () => {
  it("steps between hunks", () => {
    const view = mount();
    git.stepGitHunk(view, 1);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    git.stepGitHunk(view, 1);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    git.stepGitHunk(view, -1);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    view.destroy();
  });

  it("reverts a hunk as one undoable change and updates the gutter at once", () => {
    const view = mount();
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    git.revertGitHunk(view);
    expect(view.state.doc.toString()).toBe(L("one", "two", "three", "inserted", "four", "six"));
    expect(git.gitLineMarks(view.state).map((m) => m.kind)).toEqual(["added", "deleted"]);
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("puts a deleted line back", () => {
    const view = mount();
    view.dispatch({ selection: { anchor: view.state.doc.line(6).from } });
    git.revertGitHunk(view);
    expect(view.state.doc.toString()).toBe(L("one", "TWO", "three", "inserted", "four", "five", "six"));
    view.destroy();
  });

  it("peeks a hunk's old lines inline, and reverts from the peek", () => {
    const view = mount();
    git.toggleGitPeek(view, view.state.doc.line(2).from);
    const peek = view.dom.querySelector(".cm-git-peek");
    expect(peek).not.toBeNull();
    expect(peek!.querySelector(".cm-git-peek-old")!.textContent).toBe("two");
    expect(peek!.querySelector(".cm-git-peek-pos")!.textContent).toBe("1/3");
    const revert = [...peek!.querySelectorAll("button")].find((b) => b.textContent === "Revert")!;
    revert.click();
    expect(view.state.doc.line(2).text).toBe("two");
    expect(view.dom.querySelector(".cm-git-peek")).toBeNull();
    view.destroy();
  });
});

describe("peek colors", () => {
  it("paints the old lines with the buffer's own language", async () => {
    const { StreamLanguage, syntaxHighlighting, defaultHighlightStyle } = await import("@codemirror/language");
    const { javascript } = await import("@codemirror/legacy-modes/mode/javascript");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "const a = 2;\n",
        extensions: [
          StreamLanguage.define(javascript),
          syntaxHighlighting(defaultHighlightStyle),
          git.gitEditorExtension({ kit, vaultId: "v", path: "a.js", base: Text.of(["const a = 1;", ""]), fetchBase: async () => null, targets: () => [] }),
        ],
      }),
    });
    git.toggleGitPeek(view, 0);
    const old = view.dom.querySelector(".cm-git-peek-old")!;
    expect(old.textContent).toBe("const a = 1;");
    // The keyword and the number each carry a highlight class.
    expect(old.querySelectorAll("span").length).toBeGreaterThanOrEqual(2);
    view.destroy();
  });
});

describe("diff view", () => {
  it("opens an inline diff against HEAD that stays editable, then closes", () => {
    const view = mount();
    expect(git.openGitDiff(view)).toBe(true);
    expect(git.gitDiffState(view.state)).toEqual({ ref: "HEAD", label: "HEAD", layout: "unified" });
    expect(kit.getChunks(view.state)?.chunks.length).toBe(3);
    expect(view.dom.querySelector(".cm-git-diffbar")?.textContent).toContain("3 changes");
    // The gutter steps aside for the merge view's own.
    expect(git.gitLineMarks(view.state)).toEqual([]);
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(view.state.doc.line(1).text).toBe("xone");
    git.closeGitDiff(view);
    expect(kit.getChunks(view.state)).toBeNull();
    expect(view.dom.querySelector(".cm-git-diffbar")).toBeNull();
    view.destroy();
  });

  it("diffs against another ref once its text arrives", async () => {
    const view = mount();
    git.openGitDiff(view, { ref: "HEAD~1", label: "Previous commit" });
    expect(view.dom.querySelector(".cm-git-count")?.textContent).toBe("Loading…");
    await wait(10);
    expect(git.gitDiffState(view.state)?.label).toBe("Previous commit");
    expect(kit.getChunks(view.state)?.chunks.length).toBeGreaterThan(0);
    view.destroy();
  });

  it("names a failed read by its status code, never by its message", () => {
    const err = (status: number | undefined, message: string) => Object.assign(new Error(message), { status });
    expect(git.diffErrorState(err(404, "git base: 404 unknown ref")).state).toBe("Ref not found");
    expect(git.diffErrorState(err(413, "git base: 413 too large")).state).toBe("Too large");
    expect(git.diffErrorState(err(500, "connection refused")).state).toBe("Unavailable");
    expect(git.diffErrorState(new TypeError("Failed to fetch")).state).toBe("Offline");
  });

  it("toggles off with the same command", () => {
    const view = mount();
    git.toggleGitDiff(view);
    expect(git.gitDiffState(view.state)).not.toBeNull();
    git.toggleGitDiff(view);
    expect(git.gitDiffState(view.state)).toBeNull();
    view.destroy();
  });
});

describe("ref picker", () => {
  const key = (input: HTMLElement, k: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("opens from the keyboard, focused, and picks with the arrows and Enter", async () => {
    const view = mount(DOC, BASE, [{ ref: "HEAD~1", label: "Previous commit" }]);
    expect(git.openGitDiffPicker(view)).toBe(true);
    // No diff was open: the picker opens it against HEAD first.
    expect(git.gitDiffState(view.state)?.ref).toBe("HEAD");
    const input = view.dom.querySelector<HTMLInputElement>(".cm-git-menu-input")!;
    expect(document.activeElement).toBe(input);
    const items = () => [...view.dom.querySelectorAll(".cm-git-menu-item")];
    expect(items().map((i) => i.textContent)).toEqual(["HEAD", "Previous commitHEAD~1"]);
    expect(items()[0].hasAttribute("aria-selected")).toBe(true);
    key(input, "ArrowDown");
    expect(items()[1].hasAttribute("aria-selected")).toBe(true);
    key(input, "Enter");
    expect(view.dom.querySelector(".cm-git-menu")).toBeNull();
    expect(git.gitDiffState(view.state)?.ref).toBe("HEAD~1");
    view.destroy();
  });

  it("filters by typed text and takes text matching nothing as a ref", () => {
    const view = mount(DOC, BASE, [{ ref: "HEAD~1", label: "Previous commit" }]);
    git.openGitDiffPicker(view);
    const input = view.dom.querySelector<HTMLInputElement>(".cm-git-menu-input")!;
    input.value = "prev";
    input.dispatchEvent(new Event("input"));
    expect([...view.dom.querySelectorAll(".cm-git-menu-item")].map((i) => i.textContent)).toEqual(["Previous commitHEAD~1"]);
    input.value = "feature/x";
    input.dispatchEvent(new Event("input"));
    expect(view.dom.querySelectorAll(".cm-git-menu-item").length).toBe(0);
    key(input, "Enter");
    expect(git.gitDiffState(view.state)?.ref).toBe("feature/x");
    view.destroy();
  });
});

describe("side by side", () => {
  const settle = async () => {
    await wait(0);
    await wait(0);
  };
  /** The split's editable right side. */
  const rightSide = (view: InstanceType<typeof EditorView>) => {
    const editors = view.dom.querySelectorAll(".cm-git-split .cm-mergeViewEditor .cm-editor");
    return editors.length === 2 ? EditorView.findFromDOM(editors[1] as HTMLElement) : null;
  };

  it("mirrors edits both ways, reverts, and closes back to the editor", async () => {
    const view = mount();
    git.openGitDiff(view, { ref: "HEAD" }, "split");
    await settle();
    const b = rightSide(view)!;
    expect(b).not.toBeNull();
    expect(view.scrollDOM.style.display).toBe("none");
    b.dispatch({ changes: { from: 0, insert: "a" } });
    expect(view.state.doc.line(1).text).toBe("aone");
    view.dispatch({ changes: { from: 0, to: 1 } });
    expect(b.state.doc.toString()).toBe(DOC);
    // Revert the modified second line from the right side.
    b.dispatch({ selection: { anchor: b.state.doc.line(2).from } });
    expect(git.revertGitHunk(view)).toBe(true);
    expect(view.state.doc.line(2).text).toBe("two");
    expect(b.state.doc.toString()).toBe(view.state.doc.toString());
    b.dispatch({ selection: { anchor: b.state.doc.line(3).from + 2 } });
    git.closeGitDiff(view);
    await settle();
    expect(view.dom.querySelector(".cm-git-split")).toBeNull();
    expect(view.scrollDOM.style.display).toBe("");
    // The cursor lands where it was on the right side.
    expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from + 2);
    view.destroy();
  });

  it("knows the editor its right side mirrors, so hunk keys there act on the diff", async () => {
    const view = mount();
    git.openGitDiff(view, { ref: "HEAD" }, "split");
    await settle();
    const b = rightSide(view)!;
    expect(git.splitOwner(b)).toBe(view);
    expect(git.splitOwner(view)).toBe(view);
    git.closeGitDiff(view);
    await settle();
    expect(git.splitOwner(b)).toBe(b);
    view.destroy();
  });

  it("offers Revert as the inline diff's one per-hunk action", async () => {
    const view = mount();
    git.openGitDiff(view, { ref: "HEAD" });
    await settle();
    expect(view.dom.querySelectorAll(".cm-git-merge-reject").length).toBeGreaterThan(0);
    expect(view.dom.querySelector("[class*='cm-git-merge-accept']")).toBeNull();
    expect([...view.dom.querySelectorAll(".cm-chunkButtons button, .cm-chunkButtons span:not([hidden])")].map((e) => e.textContent).filter(Boolean)).not.toContain("Keep");
    view.destroy();
  });

  it("puts back the base's unterminated last line exactly", async () => {
    const view = mount("x\nY\nz\n", "x\ny");
    git.openGitDiff(view, { ref: "HEAD" }, "split");
    await settle();
    const b = rightSide(view)!;
    b.dispatch({ selection: { anchor: b.state.doc.line(2).from } });
    git.revertGitHunk(view);
    expect(view.state.doc.toString()).toBe("x\ny");
    view.destroy();
  });

  it("leaves another tab's selection alone when the state switches under it", async () => {
    const view = mount();
    git.openGitDiff(view, { ref: "HEAD" }, "split");
    await settle();
    expect(rightSide(view)).not.toBeNull();
    view.setState(EditorState.create({ doc: "a\nb\nc\n", selection: { anchor: 2 } }));
    await settle();
    expect(view.state.selection.main.head).toBe(2);
    expect(view.dom.querySelector(".cm-git-split")).toBeNull();
    expect(view.scrollDOM.style.display).toBe("");
    view.destroy();
  });
});
