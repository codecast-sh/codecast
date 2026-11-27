// Syntax color for the results editor: each excerpt highlighted in its own
// file's language, as Zed's multibuffer does. The document is one plaintext
// buffer of many files, so no language is attached to it; instead this plugin
// parses each excerpt on screen with its file's Lezer parser and marks the
// tokens with the code theme's own highlighters (theme.ts CODE_HIGHLIGHTERS),
// whose classes that theme mounts.
//
// Off the keystroke path: work waits for idle, only excerpts in view are
// parsed, each language loads once (lazily, like an opened file's), and an
// excerpt is parsed again only when its own text changed. Context lines cut a
// construct in half can color a line wrong; the next excerpt starts clean.

import type { EditorState, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { LanguageSupport } from "@codemirror/language";
import { highlightTree, type Highlighter } from "@lezer/highlight";
import { describeLanguage, loadLanguage } from "../languages";
import { CODE_HIGHLIGHTERS } from "../theme";
import { whenIdle } from "../idle";
import type { ExcerptRegion, Region } from "./excerpts";

export interface ExcerptSourceAccess {
  regions(state: EditorState): Region[];
  paths(state: EditorState): string[];
}

/** Languages by name: the support once loaded, null for none. */
const languages = new Map<string, LanguageSupport | null | Promise<LanguageSupport | null>>();
/** Marks per excerpt text, offsets relative to the excerpt's start. */
type Marks = { from: number; to: number; cls: string }[];
const MAX_CACHED = 2000;

function languageFor(path: string, onLoad: () => void): LanguageSupport | null {
  const desc = describeLanguage(path);
  if (!desc) return null;
  const known = languages.get(desc.name);
  if (known === undefined) {
    const loading = loadLanguage(desc).then((support) => {
      languages.set(desc.name, support);
      return support;
    });
    languages.set(desc.name, loading);
    void loading.then((s) => s && onLoad());
    return null;
  }
  return known instanceof Promise ? null : known;
}

export function excerptHighlight(access: ExcerptSourceAccess) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private cache = new Map<string, Marks>();
      private pending = false;
      private destroyed = false;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        if (u.docChanged || u.viewportChanged) this.schedule();
      }
      schedule() {
        if (this.pending) return;
        this.pending = true;
        void whenIdle(() => {
          this.pending = false;
          if (!this.destroyed) this.recompute();
        }, 300);
      }
      recompute() {
        const { state } = this.view;
        const regions = access.regions(state);
        const paths = access.paths(state);
        const ranges: Range<Decoration>[] = [];
        for (const { from: vFrom, to: vTo } of this.view.visibleRanges) {
          for (const r of regions) {
            if (r.kind !== "excerpt" || r.to < vFrom || r.from > vTo) continue;
            const marks = this.marksFor(state, r, paths[r.file], CODE_HIGHLIGHTERS);
            for (const m of marks) ranges.push(Decoration.mark({ class: m.cls }).range(r.from + m.from, r.from + m.to));
          }
        }
        this.decorations = Decoration.set(ranges, true);
        // A decorations-only refresh: an empty transaction redraws the plugin.
        this.view.dispatch({});
      }
      marksFor(state: EditorState, r: ExcerptRegion, path: string | undefined, highlighter: readonly Highlighter[]): Marks {
        if (!path || r.to <= r.from) return [];
        const support = languageFor(path, () => !this.destroyed && this.schedule());
        if (!support) return [];
        const text = state.sliceDoc(r.from, r.to);
        const key = `${support.language.name}\0${text}`;
        let marks = this.cache.get(key);
        if (!marks) {
          marks = [];
          const out = marks;
          highlightTree(support.language.parser.parse(text), highlighter, (from, to, cls) => out.push({ from, to, cls }));
          if (this.cache.size >= MAX_CACHED) this.cache.clear();
          this.cache.set(key, marks);
        }
        return marks;
      }
      destroy() {
        this.destroyed = true;
      }
    },
    { decorations: (v) => v.decorations },
  );
}
