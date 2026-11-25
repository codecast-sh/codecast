// A brief highlight over a run of lines: where an "Open in editor" from an
// agent's Edit card lands, so the eye finds what changed. The field joins a
// state only the first time it flashes (appendConfig), so editors that never
// flash carry nothing, and the class fades itself out in CSS; a timer then
// drops the decorations.

import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** Lines flashed at most; a whole-file write is not worth painting. */
const MAX_FLASH_LINES = 400;
export const FLASH_MS = 1600;

const setFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashLine = Decoration.line({ class: "cm-line-flash" });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFlash)) continue;
      if (!e.value) {
        next = Decoration.none;
        continue;
      }
      const doc = tr.state.doc;
      const first = Math.max(1, Math.min(e.value.from, doc.lines));
      const last = Math.min(doc.lines, e.value.to, first + MAX_FLASH_LINES - 1);
      const b = new RangeSetBuilder<Decoration>();
      for (let n = first; n <= last; n++) b.add(doc.line(n).from, doc.line(n).from, flashLine);
      next = b.finish();
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashTheme = EditorView.baseTheme({
  ".cm-line-flash": { animation: `cm-line-flash ${FLASH_MS}ms ease-out forwards` },
  "@keyframes cm-line-flash": {
    "0%, 40%": { backgroundColor: "color-mix(in srgb, var(--sol-yellow) 24%, transparent)" },
    "100%": { backgroundColor: "transparent" },
  },
});

const flashExtension: Extension = [flashField, flashTheme];

/** Flash lines `from`..`to` (1-based, inclusive) in this view's document. */
export function flashLines(view: EditorView, from: number, to: number): void {
  if (!view.state.field(flashField, false)) view.dispatch({ effects: StateEffect.appendConfig.of(flashExtension) });
  view.dispatch({ effects: setFlash.of({ from, to }) });
  setTimeout(() => {
    if (view.state.field(flashField, false)?.size) view.dispatch({ effects: setFlash.of(null) });
  }, FLASH_MS + 100);
}
