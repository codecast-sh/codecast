// A rich editor (tiptap) as a dictation field. The controller thinks in one
// string with a cursor; a document is not one, so the field it sees is the
// paragraph around the cursor: the text before it, the words dictated so far,
// the text after it. Only the dictated range is ever rewritten, so formatting
// elsewhere (and in the rest of that paragraph) is never touched. The range
// follows every change to the document, and a change inside the paragraph
// reads to the controller as the person editing under it.
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Slice } from "@tiptap/pm/model";
import type { DictationFieldAdapter } from "./useDictation";

const LEAF = "￼";

export function editorField(getEditor: () => Editor | null): DictationFieldAdapter {
  let range: { from: number; to: number } | null = null;
  let original: { value: string; slice: Slice } | null = null;
  let unlisten: (() => void) | null = null;

  const parts = (ed: Editor) => {
    const doc = ed.state.doc;
    const r = range ?? { from: ed.state.selection.from, to: ed.state.selection.to };
    const $from = doc.resolve(r.from);
    const $to = doc.resolve(r.to);
    return {
      before: doc.textBetween($from.start(), r.from, "\n", LEAF),
      mid: doc.textBetween(r.from, r.to, "\n", LEAF),
      after: doc.textBetween(r.to, $to.end(), "\n", LEAF),
    };
  };

  return {
    begin() {
      const ed = getEditor();
      if (!ed) return;
      const { from, to } = ed.state.selection;
      range = { from, to };
      const p = parts(ed);
      original = { value: p.before + p.mid + p.after, slice: ed.state.doc.slice(from, to) };
      const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map(pos: number, assoc?: number): number } } }) => {
        if (!range || !transaction.docChanged) return;
        range = { from: transaction.mapping.map(range.from, -1), to: transaction.mapping.map(range.to, 1) };
      };
      ed.on("transaction", onTransaction);
      unlisten = () => ed.off("transaction", onTransaction);
    },
    end() {
      unlisten?.();
      unlisten = null;
      range = null;
      original = null;
    },
    getValue() {
      const ed = getEditor();
      if (!ed) return "";
      const p = parts(ed);
      return p.before + p.mid + p.after;
    },
    getSelection() {
      const ed = getEditor();
      if (!ed) return null;
      const p = parts(ed);
      return [p.before.length, p.before.length + p.mid.length];
    },
    setValue(value, caret) {
      const ed = getEditor();
      if (!ed || !range) return;
      const { before, after } = parts(ed);
      const { from, to } = range;
      let tr = ed.state.tr;
      if (original && value === original.value) {
        // Cancel: the selection that was there comes back as it was, marks included.
        tr = tr.replace(from, to, original.slice);
      } else {
        const words = value.slice(before.length, value.length - after.length);
        tr = words ? tr.insertText(words, from, to) : tr.delete(from, to);
      }
      const pos = Math.min(tr.doc.content.size, from + Math.max(0, caret - before.length));
      tr.setSelection(TextSelection.create(tr.doc, pos));
      ed.view.dispatch(tr);
    },
    focus() {
      const ed = getEditor();
      if (ed && !ed.isFocused) ed.commands.focus();
    },
  };
}
