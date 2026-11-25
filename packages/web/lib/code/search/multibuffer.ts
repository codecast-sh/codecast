// The results editor: project search matches as one editable CodeMirror
// document, excerpts of every file stacked under their paths (excerpts.ts has
// the model). This is the state side: the region field, the guard that keeps
// edits inside excerpts, the decorations and line numbers, and the save that
// writes each touched file back through writeBack's compare-and-swap path.
//
// Loaded with the editor chunk, never with the Files page.

import { Annotation, Compartment, EditorState, StateEffect, StateField, Transaction, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { bufferFields, savedDocField, setSavedDoc } from "../buffers";
import { featureBase } from "../features";
import { runCodeCommand } from "../commands";
import { statusBar } from "../statusBar";
import { solCodeTheme } from "../theme";
import {
  changedExcerpts,
  clipChanges,
  fileExcerptTexts,
  layoutMultibuffer,
  mapRegions,
  rebaseSaved,
  regionAt,
  sourceEdits,
  sourceLineAt,
  type ExcerptSource,
  type MultibufferLayout,
  type RawChange,
  type Region,
} from "./excerpts";
import { editFiles, type FileEditOutcome, type WriteBackIO } from "./writeBack";

/** Replace the regions wholesale (a new layout). */
const setRegions = StateEffect.define<Region[]>();
/** A file's excerpts were written as `written`. */
const fileSaved = StateEffect.define<{ file: number; written: string[][] }>();
/** A transaction the guard lets through untouched (building the document). */
const internal = Annotation.define<true>();

export const regionsField = StateField.define<Region[]>({
  create: () => [],
  update: (regions, tr) => {
    let next = mapRegions(regions, tr.changes);
    for (const e of tr.effects) {
      if (e.is(setRegions)) next = e.value;
      else if (e.is(fileSaved)) next = rebaseSaved(next, e.value.file, e.value.written);
    }
    return next;
  },
});

/** The files the document shows, by region `file` index. */
const pathsField = StateField.define<string[]>({
  create: () => [],
  update: (v) => v,
});

/** The vault those files are in: a save writes there or nowhere. */
const vaultField = StateField.define<string | null>({
  create: () => null,
  update: (v) => v,
});

export const multibufferVault = (state: EditorState) => state.field(vaultField);

/** Keeps every change inside the excerpts (excerpts.clipChanges). */
const guard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(internal)) return tr;
  const raw: RawChange[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => raw.push({ fromA, toA, insert: inserted.toString() }));
  const clipped = clipChanges(tr.startState.field(regionsField), raw);
  if (!clipped) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  return { changes: clipped, effects: tr.effects, scrollIntoView: tr.scrollIntoView, ...(userEvent ? { userEvent } : {}) };
});

const headerLine = Decoration.line({ class: "cm-mb-header" });
const gapLine = Decoration.line({ class: "cm-mb-gap" });
const dirMark = Decoration.mark({ class: "cm-mb-dir" });

function regionDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const r of state.field(regionsField)) {
    if (r.kind === "header") {
      ranges.push(headerLine.range(r.from));
      const slash = state.sliceDoc(r.from, r.to).lastIndexOf("/");
      if (slash > 0) ranges.push(dirMark.range(r.from, r.from + slash + 1));
    } else if (r.kind === "gap") ranges.push(gapLine.range(r.from));
  }
  return Decoration.set(ranges, true);
}

/** Header and gap styling, built once per layout and mapped through edits
 *  (a keystroke never walks the regions). */
const decorationsField = StateField.define<DecorationSet>({
  create: regionDecorations,
  update: (deco, tr) => (tr.effects.some((e) => e.is(setRegions)) ? regionDecorations(tr.state) : deco.map(tr.changes)),
  provide: (f) => EditorView.decorations.from(f),
});

/** The match highlighted in every excerpt line on screen. */
function matchHighlighter(re: RegExp): Extension {
  const decorator = new MatchDecorator({
    regexp: re,
    decorate: (add, from, to, _m, view) => {
      if (regionAt(view.state.field(regionsField), from)?.kind === "excerpt") add(from, to, Decoration.mark({ class: "cm-mb-match" }));
    },
  });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Each excerpt line numbered by its line in the file; headers and gaps blank. */
const sourceLineNumbers = lineNumbers({
  formatNumber: (n, state) => {
    const line = state.doc.line(Math.min(n, state.doc.lines));
    return String(sourceLineAt(state.field(regionsField), state.doc, line.from)?.line ?? "");
  },
});

/** The model without a view: regions, paths, and the guard. */
export function multibufferCore(layout: MultibufferLayout, vaultId: string | null = null): Extension {
  return [regionsField.init(() => layout.regions), pathsField.init(() => layout.paths), vaultField.init(() => vaultId), guard];
}

/** The registry features a results editor takes: it is many files, not one,
 *  so nothing that acts on a file (git, LSP, autosave, workspace nav). */
const MULTIBUFFER_FEATURES: ReadonlySet<string> = new Set(["vim", "core.settings", "search.keys"]);

export interface SourceLocation {
  path: string;
  line: number;
  column: number;
}

/** The file location under a document position: an excerpt line, or a header
 *  or gap's next excerpt. */
export function locationAt(state: EditorState, pos: number): SourceLocation | null {
  const regions = state.field(regionsField);
  const paths = state.field(pathsField);
  const src = sourceLineAt(regions, state.doc, pos);
  if (src) return { path: paths[src.file], line: src.line, column: pos - state.doc.lineAt(pos).from + 1 };
  const r = regionAt(regions, pos);
  const next = r && regions.find((x) => x.kind === "excerpt" && x.from > r.from && x.file === r.file);
  return next && next.kind === "excerpt" ? { path: paths[next.file], line: next.srcStart, column: 1 } : null;
}

/** The app's code theme, reconfigured when the palette changes. */
const themeSlot = new Compartment();
export const refreshMultibufferTheme = () => themeSlot.reconfigure(solCodeTheme());

const multibufferTheme = EditorView.theme({
  ".cm-mb-header": {
    backgroundColor: "color-mix(in srgb, var(--sol-text) 6%, transparent)",
    color: "var(--sol-text)",
    fontWeight: "600",
    cursor: "pointer",
    borderTop: "1px solid color-mix(in srgb, var(--sol-border) 60%, transparent)",
  },
  ".cm-mb-header .cm-mb-dir": { color: "var(--sol-text-dim)", fontWeight: "400" },
  ".cm-mb-gap": { color: "var(--sol-text-dim)" },
  ".cm-mb-match": { backgroundColor: "color-mix(in srgb, var(--sol-yellow) 28%, transparent)", borderRadius: "2px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "5ch" },
  // Line ending, indent and language describe one file; this is many.
  ".cm-code-status-static": { display: "none" },
});

export interface MultibufferConfig {
  vaultId: string;
  /** Highlights the query's matches. */
  matcher?: RegExp | null;
  onOpen: (loc: SourceLocation) => void;
  /** View-bound extensions (the app's undo guard). */
  extensions?: Extension;
}

/** The state of a results editor over `sources`. */
export function multibufferState(sources: ExcerptSource[], config: MultibufferConfig, context = 2): EditorState {
  const layout = layoutMultibuffer(sources, context);
  const openAt = (view: EditorView) => {
    const loc = locationAt(view.state, view.state.selection.main.head);
    if (loc) config.onOpen(loc);
    return !!loc;
  };
  return EditorState.create({
    doc: layout.doc,
    extensions: [
      // The feature context lets vim and the person's settings attach as in
      // any editor, and nothing else (MULTIBUFFER_FEATURES).
      featureBase({
        vaultId: config.vaultId,
        path: "",
        languageId: "plaintext",
        languageName: null,
        sizeBytes: layout.doc.length,
        largeFile: false,
        only: MULTIBUFFER_FEATURES,
      }),
      bufferFields({ lineSeparator: "\n", bom: false, lossy: false }),
      multibufferCore(layout, config.vaultId),
      decorationsField,
      sourceLineNumbers,
      config.matcher ? matchHighlighter(config.matcher) : [],
      highlightSpecialChars(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      search({ top: true }),
      themeSlot.of(solCodeTheme()),
      multibufferTheme,
      EditorView.domEventHandlers({
        mousedown: (e, view) => {
          const header = (e.target as HTMLElement).closest(".cm-mb-header");
          if (!header && !(e.metaKey || e.ctrlKey)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          const loc = pos === null ? null : locationAt(view.state, pos);
          if (!loc) return false;
          e.preventDefault();
          config.onOpen(loc);
          return true;
        },
      }),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: (view) => runCodeCommand("file.save", undefined, { view, source: "keymap" }) },
        { key: "Mod-Enter", preventDefault: true, run: openAt },
        { key: "Alt-Enter", preventDefault: true, run: openAt },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
        { key: "Escape", run: () => true },
      ]),
      statusBar(),
      config.extensions ?? [],
    ],
  });
}

/** Whether the results editor holds edits not yet written. */
export function multibufferDirty(state: EditorState): boolean {
  return !state.doc.eq(state.field(savedDocField));
}

export interface MultibufferSaveResult {
  outcomes: FileEditOutcome[];
  /** Files written (or edited into their open buffer). */
  written: number;
}

/**
 * Write every file whose excerpts changed, in the vault they came from (never
 * whichever is active at save time). Each file is one compare-and-swap edit
 * (writeBack.editFile); a file that changed under its excerpts is refused
 * whole and reported, the others land.
 */
export async function saveMultibuffer(view: EditorView, io?: WriteBackIO): Promise<MultibufferSaveResult> {
  const state = view.state;
  const regions = state.field(regionsField);
  const paths = state.field(pathsField);
  const changed = changedExcerpts(regions, state.doc);
  const files = [...changed.keys()];
  const written = new Map(files.map((f) => [f, fileExcerptTexts(regions, f, state.doc)]));
  const outcomes = await editFiles(
    files.map((f) => ({ path: paths[f], compute: (text: string) => sourceEdits(text, changed.get(f)!) })),
    io ?? state.field(vaultField),
  );
  const landed = files.filter((_, i) => outcomes[i].status === "saved" || outcomes[i].status === "unsaved");
  const effects: StateEffect<unknown>[] = landed.map((f) => fileSaved.of({ file: f, written: written.get(f)! }));
  if (landed.length === files.length) effects.push(setSavedDoc.of(state.doc));
  if (effects.length) view.dispatch({ effects, annotations: internal.of(true) });
  return { outcomes, written: landed.length };
}

export { setRegions };
