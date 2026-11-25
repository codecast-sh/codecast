// The side-by-side diff: @codemirror/merge's MergeView laid over the editor's
// scroller, the ref's text on the left (read-only) and the buffer on the
// right. The right side is a second view of the same document: each edit made
// there is applied to the buffer as it happens, and each change the buffer
// gets from elsewhere (disk, an agent) is applied there, so closing the split
// leaves the buffer exactly as edited, its undo history included.
//
// The right side carries the editor's own theme, language and vim (read out of
// their feature compartments), and Cmd-S or `:w` there saves the buffer.

import { Annotation, EditorSelection, EditorState, Transaction, type Extension, type Text } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { MergeView } from "@codemirror/merge";
import type { MergeKit } from "../merge";
import { editorFeatureCompartment } from "../features";
import { registerCodeCommand, runCodeCommand } from "../commands";
import { GIT_DIFF_CONFIG, hunkKind, revertChange } from "./hunks";

export interface SplitHandle {
  merge: MergeView;
  /** Chunks differing. */
  count(): number;
  step(dir: 1 | -1): boolean;
  revertAtCursor(): boolean;
  /** Forward the main editor's update (changes it got from elsewhere). */
  mainUpdated(u: ViewUpdate): void;
  /** Unmount. `restoreCursor` moves the editor's cursor to where it was on the
   *  right side: true when the diff closed, false when the editor is torn down
   *  or switches to another file's state (which keeps its own selection). */
  destroy(restoreCursor: boolean): void;
}

const fromMain = Annotation.define<true>();
const fromSplit = Annotation.define<true>();

function featureExtensions(view: EditorView, ids: string[]): Extension[] {
  const out: Extension[] = [];
  for (const id of ids) {
    const ext = editorFeatureCompartment(id)?.get(view.state);
    if (ext) out.push(ext);
  }
  return out;
}

const splitTheme = EditorView.theme({
  ".cm-git-split": { flex: "1 1 0", minHeight: "0", overflow: "auto" },
  ".cm-git-split .cm-mergeView": { minHeight: "100%" },
  ".cm-git-split .cm-editor": { height: "auto" },
  ".cm-git-split .cm-mergeViewEditor:first-child": { opacity: "0.92" },
  ".cm-git-split .cm-merge-revert": { width: "22px" },
  ".cm-git-split .cm-merge-revert button": {
    border: "none",
    background: "none",
    color: "var(--sol-text-dim)",
    cursor: "pointer",
    font: "inherit",
    fontSize: "12px",
    padding: "0",
  },
  ".cm-git-split .cm-merge-revert button:hover": { color: "var(--sol-cyan)" },
});

export function mountSplit(view: EditorView, kit: MergeKit, original: Text, onChange: () => void): SplitHandle {
  const container = document.createElement("div");
  container.className = "cm-git-split";
  const scroller = view.scrollDOM;
  // CodeMirror's base theme gives the scroller `display: flex !important`;
  // only an important inline value hides it.
  scroller.style.setProperty("display", "none", "important");
  scroller.after(container);

  const shared = featureExtensions(view, ["core.theme", "core.language"]);
  const common: Extension[] = [...shared, lineNumbers(), drawSelection(), highlightActiveLine(), EditorState.tabSize.of(view.state.tabSize)];
  const save = () => runCodeCommand("file.save", undefined, { view, source: "keymap" });

  const forward = EditorView.updateListener.of((u) => {
    let changed = false;
    for (const tr of u.transactions) {
      if (!tr.docChanged || tr.annotation(fromMain)) continue;
      view.dispatch({ changes: tr.changes, annotations: fromSplit.of(true), userEvent: tr.annotation(Transaction.userEvent) ?? "input" });
      changed = true;
    }
    if (changed || u.transactions.some((tr) => tr.docChanged)) onChange();
  });

  const merge: MergeView = new kit.MergeView({
    parent: container,
    a: { doc: original, extensions: [...common, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
    b: {
      doc: view.state.doc,
      selection: view.state.selection,
      extensions: [
        ...common,
        ...featureExtensions(view, ["vim"]),
        history(),
        EditorState.readOnly.of(view.state.readOnly),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => save() }, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        forward,
      ],
    },
    revertControls: "a-to-b",
    renderRevertControl: () => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = "Put the old lines back";
      b.textContent = "⇥";
      return b;
    },
    gutter: true,
    highlightChanges: true,
    diffConfig: GIT_DIFF_CONFIG,
  });
  // Save and other buffer commands issued on the right side (vim's `:w`) act
  // on the buffer it mirrors.
  const offSave = registerCodeCommand("file.save", (args, ctx) =>
    ctx.view === merge.b ? runCodeCommand("file.save", args, { ...ctx, view }) : false,
  );
  queueMicrotask(() => merge.b.focus());

  const chunkAtCursor = () => {
    const head = merge.b.state.selection.main.head;
    return merge.chunks.find((c) => head >= c.fromB && head <= Math.max(c.fromB, c.endB)) ?? null;
  };

  return {
    merge,
    count: () => merge.chunks.length,
    step(dir) {
      return (dir === 1 ? kit.goToNextChunk : kit.goToPreviousChunk)(merge.b);
    },
    revertAtCursor() {
      const c = chunkAtCursor();
      if (!c || merge.b.state.readOnly) return true;
      const h = { fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB, kind: hunkKind(c) };
      merge.b.dispatch({ changes: revertChange(h, merge.a.state.doc, merge.b.state.doc), userEvent: "revert.git" });
      return true;
    },
    mainUpdated(u) {
      for (const tr of u.transactions) {
        if (!tr.docChanged || tr.annotation(fromSplit)) continue;
        merge.b.dispatch({ changes: tr.changes, annotations: fromMain.of(true) });
      }
    },
    destroy(restoreCursor) {
      offSave();
      const head = merge.b.state.selection.main.head;
      const doc = merge.b.state.doc;
      merge.destroy();
      container.remove();
      scroller.style.removeProperty("display");
      if (!restoreCursor) return;
      // Called from inside the main editor's update: move its cursor after,
      // and only if the editor still shows the document the split mirrored.
      queueMicrotask(() => {
        if (!view.dom.isConnected || !view.state.doc.eq(doc)) return;
        const pos = Math.min(head, view.state.doc.length);
        view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      });
    },
  };
}

export { splitTheme };
