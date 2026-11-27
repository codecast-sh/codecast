// Cmd-click (Ctrl-click off the Mac) on a word goes to its definition, and
// while the modifier is held the word under the pointer underlines as a link,
// as in VS Code and Zed. Part of the extension a buffer gets while its server
// is attached. All of it runs on pointer events: a keystroke costs nothing
// here beyond a key-up check while a link is drawn.

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modHeld = (e: MouseEvent | KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;

type Span = { from: number; to: number };
const setLink = StateEffect.define<Span | null>();
const linkMark = Decoration.mark({ class: "cm-lsp-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setLink)) value = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const drawn = new WeakMap<EditorView, Span>();

function wordUnder(view: EditorView, e: MouseEvent): (Span & { pos: number }) | null {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
  if (pos === null) return null;
  const word = view.state.wordAt(pos);
  return word ? { from: word.from, to: word.to, pos } : null;
}

function draw(view: EditorView, span: Span | null): void {
  const cur = drawn.get(view);
  if (cur?.from === span?.from && cur?.to === span?.to) return;
  if (span) drawn.set(view, span);
  else drawn.delete(view);
  view.dispatch({ effects: setLink.of(span) });
}

/** The gesture, running `goToDefinition` for the word clicked. */
export function definitionClick(goToDefinition: (view: EditorView) => boolean): Extension {
  return [
    linkField,
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (e.button !== 0 || !modHeld(e)) return false;
        const word = wordUnder(view, e);
        // Off a word, the click keeps CodeMirror's meaning (another cursor).
        if (!word) return false;
        e.preventDefault();
        draw(view, null);
        view.dispatch({ selection: { anchor: word.pos } });
        view.focus();
        goToDefinition(view);
        return true;
      },
      mousemove(e, view) {
        if (!modHeld(e)) {
          if (drawn.has(view)) draw(view, null);
          return false;
        }
        const word = wordUnder(view, e);
        draw(view, word && { from: word.from, to: word.to });
        return false;
      },
      mouseleave(_e, view) {
        if (drawn.has(view)) draw(view, null);
        return false;
      },
      keyup(e, view) {
        if (drawn.has(view) && (e.key === "Meta" || e.key === "Control")) draw(view, null);
        return false;
      },
    }),
    EditorView.baseTheme({ ".cm-lsp-link": { textDecoration: "underline", textUnderlineOffset: "2px", cursor: "pointer" } }),
  ];
}
