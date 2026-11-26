// The git feature inside one editor: a change gutter against the file's base,
// an inline peek of a hunk's old lines, hunk steps and reverts, and the diff
// view (unified in the editor, or side by side) against HEAD or another ref.
// This module loads with @codemirror/merge, only for a file in a repository
// (index.ts imports it lazily).
//
// Typing costs a mapped range set and nothing else: the diff reruns on a
// 200 ms pause, incrementally around the edits (hunks.updateChunks).

import { Compartment, Facet, Prec, RangeSet, StateEffect, StateField, type ChangeSet, type EditorState, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  keymap,
  showPanel,
  type DecorationSet,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import type { Chunk } from "@codemirror/merge";
import { bufferKey, codeBuffers, savedDocField, textToDoc, decodeFileText } from "../buffers";
import type { MergeKit } from "../merge";
import { EDITOR_FONT } from "../theme";
import { GIT_GUTTER_COLUMN } from "../gutterSlots";
import { holdGitStatusFeed, requestGitStatusRefresh } from "./status";
import {
  GIT_DIFF_CONFIG,
  buildChunks,
  hunkAtLine,
  hunkLines,
  hunkOldText,
  hunkSize,
  liveHunks,
  revertChange,
  stepHunk,
  updateChunks,
  type Hunk,
} from "./hunks";
import { mountSplit, splitTheme, type SplitHandle } from "./split";

export interface GitDiffTarget {
  /** Anything `git rev-parse` takes that names a commit: HEAD, a sha, a branch. */
  ref: string;
  /** What the picker shows; the ref when absent. */
  label?: string;
}

export type DiffLayout = "unified" | "split";

export interface GitEditorConfig {
  kit: MergeKit;
  vaultId: string;
  path: string;
  /** The file at HEAD, decoded the way the buffer is. */
  base: Text;
  /** The file's text at a ref, null when it does not exist there. */
  fetchBase: (ref: string) => Promise<string | null>;
  /** Refs the picker offers besides HEAD. */
  targets: () => GitDiffTarget[];
}

const gitConfig = Facet.define<GitEditorConfig, GitEditorConfig | null>({ combine: (v) => v[0] ?? null });

interface DiffMode {
  ref: string;
  label: string;
  layout: DiffLayout;
  /** Null while the ref's text is on its way. */
  original: Text | null;
  /** Why the ref's text could not be read: a short state and the full message. */
  error: { state: string; message: string } | null;
}

/** The diff bar's state for a failed read, from the daemon's status code. */
export function diffErrorState(e: unknown): { state: string; message: string } {
  const status = (e as { status?: unknown } | null)?.status;
  const message = e instanceof Error ? e.message : String(e);
  const state = typeof status !== "number" ? "Offline" : status === 404 ? "Ref not found" : status === 413 ? "Too large" : "Unavailable";
  return { state, message };
}

interface GitDiffValue {
  chunks: readonly Chunk[];
  /** Edits since `chunks` were computed, composed. */
  pending: ChangeSet | null;
  markers: RangeSet<GutterMarker>;
  /** Start of the peeked hunk, mapped through edits. */
  peek: number | null;
  peekDeco: DecorationSet;
  diff: DiffMode | null;
}

const recomputed = StateEffect.define<readonly Chunk[]>();
const setPeek = StateEffect.define<number | null>();
const setDiff = StateEffect.define<DiffMode | null>();
/** The side-by-side view mounted or its chunks changed: the panel recounts. */
const splitTick = StateEffect.define<null>();
/** Open the diff bar's ref picker. */
const openPicker = StateEffect.define<null>();

// ── gutter markers ──────────────────────────────────────────────────────────

class HunkMarker extends GutterMarker {
  constructor(readonly kind: string) {
    super();
    this.elementClass = `cm-git-line cm-git-${kind}`;
  }
  eq(other: HunkMarker) {
    return other.kind === this.kind;
  }
}

const MARKERS = {
  added: new HunkMarker("added"),
  modified: new HunkMarker("modified"),
  deleted: new HunkMarker("deleted"),
  deletedEnd: new HunkMarker("deleted-end"),
};

function buildMarkers(hunks: readonly Hunk[], doc: Text): RangeSet<GutterMarker> {
  const ranges = [];
  for (const h of hunks) {
    const { first, last } = hunkLines(h, doc);
    if (h.kind === "deleted") {
      // Lines removed after the document's last line hang under it.
      const atEnd = h.fromB >= doc.length && doc.length > 0 && doc.line(first).from < h.fromB;
      ranges.push((atEnd ? MARKERS.deletedEnd : MARKERS.deleted).range(doc.line(first).from));
      continue;
    }
    const marker = MARKERS[h.kind];
    for (let n = first; n <= last; n++) ranges.push(marker.range(doc.line(n).from));
  }
  return RangeSet.of(ranges, true);
}

// ── peek ────────────────────────────────────────────────────────────────────

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function button(label: string, title: string, onPress: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", `cm-git-btn ${cls}`.trim(), label);
  b.type = "button";
  b.title = title;
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = (e) => {
    e.preventDefault();
    onPress();
  };
  return b;
}

class PeekWidget extends WidgetType {
  constructor(
    readonly hunk: Hunk,
    readonly old: string,
    readonly index: number,
    readonly count: number,
    readonly size: { added: number; removed: number },
  ) {
    super();
  }
  eq(o: PeekWidget) {
    return o.old === this.old && o.index === this.index && o.count === this.count && o.size.added === this.size.added && o.size.removed === this.size.removed && o.hunk.kind === this.hunk.kind;
  }
  toDOM(view: EditorView) {
    const box = el("div", `cm-git-peek cm-git-peek-${this.hunk.kind}`);
    const head = el("div", "cm-git-peek-head");
    head.append(el("span", "cm-git-peek-pos", `${this.index + 1}/${this.count}`));
    if (this.size.removed) head.append(el("span", "cm-git-peek-removed", `−${this.size.removed}`));
    if (this.size.added) head.append(el("span", "cm-git-peek-added", `+${this.size.added}`));
    // The actions sit beside the counts: the widget is as wide as the longest
    // line, so anything pushed to its right edge can land out of view.
    head.append(
      button("↑", "Previous change", () => stepGitHunk(view, -1, true)),
      button("↓", "Next change", () => stepGitHunk(view, 1, true)),
      button("Revert", "Put the old lines back", () => revertGitHunk(view)),
      button("Copy", "Copy the old lines", () => void navigator.clipboard?.writeText(this.old).catch(() => {})),
      button("×", "Close", () => {
        view.dispatch({ effects: setPeek.of(null) });
        view.focus();
      }, "cm-git-btn-icon"),
    );
    box.append(head);
    if (this.old) box.append(el("pre", "cm-git-peek-old", this.old));
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

function buildPeek(state: EditorState, value: Pick<GitDiffValue, "chunks" | "pending" | "peek" | "diff">): { peek: number | null; deco: DecorationSet } {
  const config = state.facet(gitConfig);
  if (value.peek === null || value.diff || !config) return { peek: null, deco: Decoration.none };
  const doc = state.doc;
  const hunks = liveHunks(value.chunks, value.pending, doc.length);
  const h = hunkAtLine(hunks, doc, doc.lineAt(Math.min(value.peek, doc.length)).number);
  if (!h) return { peek: null, deco: Decoration.none };
  const widget = new PeekWidget(h, hunkOldText(h, config.base), hunks.indexOf(h), hunks.length, hunkSize(h, config.base, doc));
  const { first, last } = hunkLines(h, doc);
  const deco =
    h.kind === "deleted"
      ? Decoration.widget({ widget, block: true, side: -1 }).range(doc.line(first).from)
      : Decoration.widget({ widget, block: true, side: 1 }).range(doc.line(last).to);
  return { peek: h.fromB, deco: Decoration.set([deco]) };
}

// ── the field ───────────────────────────────────────────────────────────────

function initialValue(state: EditorState): GitDiffValue {
  const config = state.facet(gitConfig);
  const chunks = config ? buildChunks(config.kit, config.base, state.doc) : [];
  return {
    chunks,
    pending: null,
    markers: buildMarkers(liveHunks(chunks, null, state.doc.length), state.doc),
    peek: null,
    peekDeco: Decoration.none,
    diff: null,
  };
}

const gitDiffField = StateField.define<GitDiffValue>({
  create: initialValue,
  update(value, tr) {
    // A field outlives a reconfiguration: a new base (HEAD moved) starts over.
    // The diff slot was rebuilt empty with it, so the diff closes too.
    if (tr.startState.facet(gitConfig) !== tr.state.facet(gitConfig)) return initialValue(tr.state);
    let next = value;
    if (tr.docChanged) {
      next = {
        ...next,
        pending: next.pending ? next.pending.compose(tr.changes) : tr.changes,
        markers: next.markers.map(tr.changes),
        peek: next.peek === null ? null : tr.changes.mapPos(next.peek, -1),
        peekDeco: next.peekDeco.map(tr.changes),
      };
    }
    let rebuild = false;
    for (const e of tr.effects) {
      if (e.is(recomputed)) {
        next = { ...next, chunks: e.value, pending: null };
        next.markers = buildMarkers(liveHunks(next.chunks, null, tr.state.doc.length), tr.state.doc);
        rebuild = next.peek !== null;
      } else if (e.is(setPeek)) {
        next = { ...next, peek: e.value };
        rebuild = true;
      } else if (e.is(setDiff)) {
        next = { ...next, diff: e.value, peek: e.value ? null : next.peek };
        rebuild = true;
      }
    }
    if (rebuild) {
      const { peek, deco } = buildPeek(tr.state, next);
      next = { ...next, peek, peekDeco: deco };
    }
    return next;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.peekDeco),
    showPanel.from(f, (v) => (v.diff ? createDiffPanel : null)),
  ],
});

/** Run the pending diff now, if any. */
function recompute(view: EditorView): void {
  const config = view.state.facet(gitConfig);
  const value = view.state.field(gitDiffField, false);
  if (!config || !value?.pending) return;
  const chunks = updateChunks(config.kit, value.chunks, config.base, view.state.doc, value.pending);
  view.dispatch({ effects: recomputed.of(chunks) });
}

// ── the diff view ───────────────────────────────────────────────────────────

/** Holds the unified merge view while the diff is open inline. */
const diffSlot = new Compartment();

function unifiedDiff(kit: MergeKit, original: Text): Extension {
  return kit.unifiedMergeView({
    original,
    gutter: true,
    highlightChanges: true,
    syntaxHighlightDeletions: true,
    diffConfig: GIT_DIFF_CONFIG,
    mergeControls: (type, action) => {
      const b = el("button", `cm-git-merge-${type}`, type === "accept" ? "Keep" : "Revert");
      b.type = "button";
      b.title = type === "accept" ? "Keep this change and hide it" : "Put the old lines back";
      b.onmousedown = action;
      return b;
    },
  });
}

function bufferMerging(state: EditorState): boolean {
  const config = state.facet(gitConfig);
  return !!config && !!codeBuffers.get(bufferKey(config.vaultId, config.path))?.merging;
}

/**
 * Open the diff against a ref (HEAD by default) in a layout. Declines (false)
 * while the buffer shows a merge against disk, which owns the merge view.
 */
export function openGitDiff(view: EditorView, target: GitDiffTarget = { ref: "HEAD" }, layout?: DiffLayout): boolean {
  const config = view.state.facet(gitConfig);
  const value = view.state.field(gitDiffField, false);
  if (!config || !value || bufferMerging(view.state)) return false;
  const nextLayout = layout ?? value.diff?.layout ?? "unified";
  const label = target.label ?? target.ref;
  const show = (original: Text | null, error: DiffMode["error"]) => {
    const mode: DiffMode = { ref: target.ref, label, layout: nextLayout, original, error };
    view.dispatch({
      effects: [setDiff.of(mode), diffSlot.reconfigure(original && nextLayout === "unified" ? unifiedDiff(config.kit, original) : [])],
    });
  };
  if (target.ref === "HEAD") {
    show(config.base, null);
    return true;
  }
  show(null, null);
  config.fetchBase(target.ref).then(
    (text) => {
      const cur = view.state.field(gitDiffField, false)?.diff;
      if (!cur || cur.ref !== target.ref || view.state.facet(gitConfig) !== config) return;
      // A file missing at the ref diffs against nothing: every line is new.
      show(textToDoc(decodeFileText(text ?? "").text), null);
    },
    (e: unknown) => {
      const cur = view.state.field(gitDiffField, false)?.diff;
      if (cur?.ref === target.ref) show(null, diffErrorState(e));
    },
  );
  return true;
}

export function closeGitDiff(view: EditorView): void {
  if (!view.state.field(gitDiffField, false)?.diff) return;
  view.dispatch({ effects: [setDiff.of(null), diffSlot.reconfigure([])] });
}

/** Open the diff against HEAD, or close whatever diff is open. */
export function toggleGitDiff(view: EditorView, target?: GitDiffTarget, layout?: DiffLayout): boolean {
  const diff = view.state.field(gitDiffField, false)?.diff;
  if (diff && (!target || target.ref === diff.ref) && (!layout || layout === diff.layout)) {
    closeGitDiff(view);
    return true;
  }
  return openGitDiff(view, target ?? (diff ? { ref: diff.ref, label: diff.label } : undefined), layout);
}

/** Open the ref picker, opening the diff against HEAD first when none is. */
export function openGitDiffPicker(view: EditorView): boolean {
  const value = view.state.field(gitDiffField, false);
  if (!value) return false;
  if (!value.diff && !openGitDiff(view)) return false;
  view.dispatch({ effects: openPicker.of(null) });
  return true;
}

export function setGitDiffLayout(view: EditorView, layout: DiffLayout): void {
  const diff = view.state.field(gitDiffField, false)?.diff;
  if (diff && diff.layout !== layout) openGitDiff(view, { ref: diff.ref, label: diff.label }, layout);
}

export function gitDiffState(state: EditorState): { ref: string; label: string; layout: DiffLayout } | null {
  const diff = state.field(gitDiffField, false)?.diff;
  return diff ? { ref: diff.ref, label: diff.label, layout: diff.layout } : null;
}

/** The gutter's marks as (line, kind) pairs, in document order. */
export function gitLineMarks(state: EditorState): { line: number; kind: string }[] {
  const value = state.field(gitDiffField, false);
  if (!value || value.diff) return [];
  const out: { line: number; kind: string }[] = [];
  for (const it = value.markers.iter(); it.value; it.next()) {
    out.push({ line: state.doc.lineAt(it.from).number, kind: (it.value as HunkMarker).kind });
  }
  return out;
}

// ── hunk commands ───────────────────────────────────────────────────────────

/** Whether the editor shows a git gutter (the file is tracked in a repository). */
export function hasGitGutter(state: EditorState): boolean {
  return !!state.field(gitDiffField, false);
}

/** Move to the next or previous change; `keepPeek` moves an open peek along. */
export function stepGitHunk(view: EditorView, dir: 1 | -1, keepPeek = false): boolean {
  const value = view.state.field(gitDiffField, false);
  const config = view.state.facet(gitConfig);
  if (!value || !config) return false;
  if (value.diff) {
    const split = view.plugin(splitPlugin)?.handle;
    if (split) return split.step(dir);
    return (dir === 1 ? config.kit.goToNextChunk : config.kit.goToPreviousChunk)(view);
  }
  const doc = view.state.doc;
  const hunks = liveHunks(value.chunks, value.pending, doc.length);
  const line = doc.lineAt(view.state.selection.main.head).number;
  const h = stepHunk(hunks, doc, line, dir);
  if (!h) return true;
  const pos = doc.line(hunkLines(h, doc).first).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: [EditorView.scrollIntoView(pos, { y: "center" }), ...(keepPeek || value.peek !== null ? [setPeek.of(pos)] : [])],
    userEvent: "select.git",
  });
  return true;
}

function hunkAtCursor(view: EditorView): Hunk | null {
  const value = view.state.field(gitDiffField, false);
  if (!value) return null;
  const doc = view.state.doc;
  const hunks = liveHunks(value.chunks, value.pending, doc.length);
  const at = value.peek ?? view.state.selection.main.head;
  return hunkAtLine(hunks, doc, doc.lineAt(Math.min(at, doc.length)).number);
}

/** Put the hunk under the cursor (or the peeked one) back to the base, as one
 *  undoable change. */
export function revertGitHunk(view: EditorView): boolean {
  const config = view.state.facet(gitConfig);
  const value = view.state.field(gitDiffField, false);
  if (!config || !value) return false;
  if (value.diff) {
    if (value.diff.layout === "split") return view.plugin(splitPlugin)?.handle?.revertAtCursor() ?? false;
    return config.kit.rejectChunk(view);
  }
  if (view.state.readOnly) return true;
  const h = hunkAtCursor(view);
  if (!h) return true;
  view.dispatch({ changes: revertChange(h, config.base, view.state.doc), userEvent: "revert.git", effects: setPeek.of(null) });
  // The reverted lines match the base now: show it at once, not on the pause.
  recompute(view);
  return true;
}

/** Show or hide the old lines of the hunk under the cursor. */
export function toggleGitPeek(view: EditorView, at?: number): boolean {
  const value = view.state.field(gitDiffField, false);
  if (!value || value.diff) return false;
  if (at === undefined && value.peek !== null) {
    view.dispatch({ effects: setPeek.of(null) });
    return true;
  }
  const doc = view.state.doc;
  const hunks = liveHunks(value.chunks, value.pending, doc.length);
  const line = doc.lineAt(Math.min(at ?? view.state.selection.main.head, doc.length)).number;
  const h = hunkAtLine(hunks, doc, line);
  if (!h) return true;
  view.dispatch({ effects: setPeek.of(value.peek === h.fromB && at !== undefined ? null : h.fromB) });
  return true;
}

// ── the diff panel ──────────────────────────────────────────────────────────

function createDiffPanel(view: EditorView): Panel {
  const dom = el("div", "cm-git-diffbar");
  const refButton = el("button", "cm-git-btn cm-git-ref");
  refButton.type = "button";
  refButton.title = "Compare against";
  const refLabel = el("span", "", "");
  refButton.append(el("span", "cm-git-dim", "vs"), refLabel, el("span", "cm-git-caret", "▾"));
  const count = el("span", "cm-git-count");
  const prev = button("↑", "Previous change", () => stepGitHunk(view, -1));
  const next = button("↓", "Next change", () => stepGitHunk(view, 1));
  const unified = button("Inline", "Inline diff", () => setGitDiffLayout(view, "unified"), "cm-git-seg");
  const split = button("Side by side", "Side by side", () => setGitDiffLayout(view, "split"), "cm-git-seg");
  const seg = el("span", "cm-git-segs");
  seg.append(unified, split);
  const close = button("×", "Close diff", () => {
    closeGitDiff(view);
    view.focus();
  }, "cm-git-btn-icon");
  dom.append(refButton, count, prev, next, el("span", "cm-git-peek-fill"), seg, close);

  let menu: HTMLElement | null = null;
  const closeMenu = () => {
    menu?.remove();
    menu = null;
    refButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onAway, true);
  };
  const onAway = (e: MouseEvent) => {
    if (menu && !menu.contains(e.target as Node) && !refButton.contains(e.target as Node)) closeMenu();
  };
  const pick = (target: GitDiffTarget) => {
    closeMenu();
    openGitDiff(view, target);
    view.focus();
  };
  const openMenu = () => {
    const config = view.state.facet(gitConfig);
    if (!config || menu) return;
    const current = view.state.field(gitDiffField, false)?.diff?.ref;
    const targets: GitDiffTarget[] = [{ ref: "HEAD" }, ...config.targets()];
    menu = el("div", "cm-git-menu");
    menu.setAttribute("role", "listbox");
    // Typing filters the listed refs; text matching none is taken as a ref.
    const input = el("input", "cm-git-menu-input");
    input.placeholder = "ref, branch or sha";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Compare against");
    const list = el("div", "cm-git-menu-list");
    menu.append(input, list);
    let shown: GitDiffTarget[] = [];
    let active = -1;
    const highlight = (i: number) => {
      active = i;
      list.querySelectorAll<HTMLElement>(".cm-git-menu-item").forEach((item, n) => {
        if (n === i) {
          item.setAttribute("aria-selected", "true");
          item.scrollIntoView({ block: "nearest" });
        } else item.removeAttribute("aria-selected");
      });
    };
    const fill = () => {
      const q = input.value.trim().toLowerCase();
      shown = q ? targets.filter((t) => t.ref.toLowerCase().includes(q) || (t.label ?? "").toLowerCase().includes(q)) : targets;
      list.replaceChildren();
      for (const t of shown) {
        const item = el("button", `cm-git-menu-item${t.ref === current ? " cm-git-menu-on" : ""}`);
        item.type = "button";
        item.tabIndex = -1;
        item.setAttribute("role", "option");
        item.append(el("span", "", t.label ?? t.ref));
        if (t.label && t.label !== t.ref) item.append(el("span", "cm-git-dim", t.ref));
        item.onmousedown = (e) => e.preventDefault();
        item.onclick = () => pick(t);
        list.append(item);
      }
      const on = shown.findIndex((t) => t.ref === current);
      highlight(q ? (shown.length ? 0 : -1) : on >= 0 ? on : 0);
    };
    input.oninput = fill;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (shown.length) highlight((active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const typed = input.value.trim();
        if (active >= 0 && shown[active]) pick(shown[active]);
        else if (typed) pick({ ref: typed });
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        view.focus();
      }
    };
    fill();
    dom.append(menu);
    refButton.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onAway, true);
    input.focus();
  };
  refButton.setAttribute("aria-haspopup", "listbox");
  refButton.onmousedown = (e) => e.preventDefault();
  refButton.onclick = () => (menu ? closeMenu() : openMenu());

  const render = (state: EditorState) => {
    const diff = state.field(gitDiffField, false)?.diff;
    if (!diff) return;
    refLabel.textContent = diff.label;
    unified.classList.toggle("cm-git-seg-on", diff.layout === "unified");
    split.classList.toggle("cm-git-seg-on", diff.layout === "split");
    const config = state.facet(gitConfig);
    let n: number | null = null;
    if (diff.layout === "split") n = view.plugin(splitPlugin)?.handle?.count() ?? null;
    else if (config && diff.original) n = config.kit.getChunks(state)?.chunks.length ?? null;
    count.textContent = diff.error ? diff.error.state : !diff.original ? "Loading…" : n === null ? "" : n === 0 ? "No changes" : n === 1 ? "1 change" : `${n} changes`;
    count.title = diff.error?.message ?? "";
    count.classList.toggle("cm-git-error", !!diff.error);
    prev.disabled = next.disabled = !n;
  };
  render(view.state);
  return {
    dom,
    top: true,
    update(u: ViewUpdate) {
      if (u.docChanged || u.transactions.some((tr) => tr.reconfigured || tr.effects.length)) render(u.state);
      if (u.transactions.some((tr) => tr.effects.some((e) => e.is(openPicker)))) openMenu();
    },
    destroy: closeMenu,
  };
}

// ── side by side ────────────────────────────────────────────────────────────

const splitPlugin = ViewPlugin.fromClass(
  class {
    handle: SplitHandle | null = null;
    private shown: Text | null = null;
    constructor(readonly view: EditorView) {
      this.sync();
    }
    update(u: ViewUpdate) {
      if (this.handle) this.handle.mainUpdated(u);
      if (u.startState.field(gitDiffField, false)?.diff !== u.state.field(gitDiffField, false)?.diff) this.sync();
    }
    sync() {
      const diff = this.view.state.field(gitDiffField, false)?.diff;
      const config = this.view.state.facet(gitConfig);
      const want = diff?.layout === "split" && diff.original && config ? diff.original : null;
      if (want === this.shown) return;
      this.handle?.destroy(true);
      this.handle = null;
      this.shown = want;
      if (want && config) {
        // Mounting reads layout: after this update.
        queueMicrotask(() => {
          if (this.shown !== want || this.handle) return;
          this.handle = mountSplit(this.view, config.kit, want, () => this.tick());
          this.tick();
        });
      }
    }
    /** The merge view measures its chunks after a frame: recount then. */
    tick() {
      requestAnimationFrame(() => {
        if (this.handle && this.view.dom.isConnected) this.view.dispatch({ effects: splitTick.of(null) });
      });
    }
    destroy() {
      // A teardown (another tab's state, the editor closing), not a close: the
      // state taking over keeps its own selection and scroll.
      this.handle?.destroy(false);
      this.handle = null;
      this.shown = null;
    }
  },
);

// ── the per-editor runner ───────────────────────────────────────────────────

const RECOMPUTE_MS = 200;

const runner = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly release = holdGitStatusFeed();
    constructor(readonly view: EditorView) {
      if (view.state.field(gitDiffField, false)?.pending) this.schedule();
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.schedule();
      const config = u.state.facet(gitConfig);
      if (config && u.startState.field(savedDocField, false) !== u.state.field(savedDocField, false)) {
        requestGitStatusRefresh(config.vaultId, { fresh: true, delayMs: 150 });
      }
      // A new base (HEAD moved): the field started over, the diff slot kept
      // the old merge view. Reopen the same diff against the new base.
      if (config && u.startState.facet(gitConfig) !== config) {
        const was = u.startState.field(gitDiffField, false)?.diff;
        if (was) {
          queueMicrotask(() => {
            if (!openGitDiff(this.view, { ref: was.ref, label: was.label }, was.layout)) this.view.dispatch({ effects: diffSlot.reconfigure([]) });
          });
        }
      }
      // A merge against disk takes the merge view; the diff steps aside.
      if (u.state.field(gitDiffField, false)?.diff && bufferMerging(u.state)) queueMicrotask(() => closeGitDiff(this.view));
    }
    schedule() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        recompute(this.view);
      }, RECOMPUTE_MS);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
      this.release();
    }
  },
);

const gitGutter = gutter({
  class: "cm-git-gutter",
  markers: (view) => {
    const value = view.state.field(gitDiffField, false);
    return !value || value.diff ? RangeSet.empty : value.markers;
  },
  domEventHandlers: {
    mousedown(view, line) {
      const value = view.state.field(gitDiffField, false);
      if (!value || value.diff) return false;
      const doc = view.state.doc;
      const hunk = hunkAtLine(liveHunks(value.chunks, value.pending, doc.length), doc, doc.lineAt(line.from).number);
      if (!hunk) return false;
      toggleGitPeek(view, line.from);
      return true;
    },
  },
});

const gitTheme = EditorView.theme({
  ".cm-git-gutter": { ...GIT_GUTTER_COLUMN, cursor: "default" },
  ".cm-git-gutter .cm-gutterElement": { position: "relative" },
  ".cm-git-gutter .cm-git-line": { cursor: "pointer" },
  ".cm-git-line::before": { content: '""', position: "absolute", left: "2px", top: "0", bottom: "0", width: "3px", borderRadius: "1px" },
  ".cm-git-line:hover::before": { width: "5px", left: "1px" },
  ".cm-git-added::before": { backgroundColor: "var(--sol-green)" },
  ".cm-git-modified::before": { backgroundColor: "var(--sol-blue)" },
  ".cm-git-deleted::before, .cm-git-deleted-end::before": {
    backgroundColor: "transparent",
    width: "0",
    height: "0",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid var(--sol-red)",
    borderRadius: "0",
  },
  ".cm-git-deleted::before": { top: "-4px", bottom: "auto" },
  ".cm-git-deleted-end::before": { top: "auto", bottom: "-4px" },
  ".cm-git-deleted:hover::before, .cm-git-deleted-end:hover::before": { width: "0", left: "1px", borderLeftWidth: "7px" },
  ".cm-git-peek": {
    margin: "2px 0 4px",
    borderTop: "1px solid color-mix(in srgb, var(--sol-border) 45%, transparent)",
    borderBottom: "1px solid color-mix(in srgb, var(--sol-border) 45%, transparent)",
    backgroundColor: "color-mix(in srgb, var(--sol-bg-alt) 70%, transparent)",
    fontFamily: EDITOR_FONT,
  },
  ".cm-git-peek-head, .cm-git-diffbar": {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    height: "24px",
    padding: "0 8px",
    fontSize: "11px",
    color: "var(--sol-text-dim)",
    userSelect: "none",
  },
  ".cm-git-peek-pos": { fontVariantNumeric: "tabular-nums" },
  ".cm-git-peek-removed": { color: "var(--sol-red)", fontVariantNumeric: "tabular-nums" },
  ".cm-git-peek-added": { color: "var(--sol-green)", fontVariantNumeric: "tabular-nums" },
  ".cm-git-peek-fill": { flex: "1" },
  ".cm-git-peek-old": {
    margin: "0",
    padding: "2px 16px 4px 6px",
    whiteSpace: "pre",
    overflowX: "auto",
    fontFamily: EDITOR_FONT,
    fontSize: "13px",
    lineHeight: "1.6",
    color: "var(--sol-text-muted)",
    backgroundColor: "color-mix(in srgb, var(--sol-red) 8%, transparent)",
    tabSize: "4",
  },
  ".cm-git-btn": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    height: "18px",
    padding: "0 6px",
    border: "1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)",
    borderRadius: "3px",
    background: "var(--sol-bg)",
    color: "var(--sol-text-muted)",
    font: "inherit",
    fontSize: "11px",
    cursor: "pointer",
  },
  ".cm-git-btn:hover:not(:disabled)": { color: "var(--sol-text)", borderColor: "var(--sol-cyan)" },
  ".cm-git-btn:disabled": { opacity: "0.4", cursor: "default" },
  ".cm-git-btn-icon": { border: "none", background: "none", padding: "0 4px", fontSize: "13px" },
  ".cm-git-diffbar": { fontFamily: EDITOR_FONT, height: "28px" },
  ".cm-git-ref": { color: "var(--sol-text)" },
  ".cm-git-dim": { color: "var(--sol-text-dim)" },
  ".cm-git-caret": { color: "var(--sol-text-dim)", fontSize: "9px" },
  ".cm-git-count": { fontVariantNumeric: "tabular-nums", padding: "0 4px" },
  ".cm-git-error": { color: "var(--sol-red)" },
  ".cm-git-segs": { display: "inline-flex" },
  ".cm-git-seg": { borderRadius: "0" },
  ".cm-git-seg:first-child": { borderRadius: "3px 0 0 3px" },
  ".cm-git-seg:last-child": { borderRadius: "0 3px 3px 0", marginLeft: "-1px" },
  ".cm-git-seg-on": { color: "var(--sol-text)", backgroundColor: "var(--sol-bg-alt)" },
  // The editor's own popup look (the completion list in theme.ts).
  ".cm-git-menu": {
    position: "absolute",
    top: "26px",
    left: "8px",
    zIndex: "20",
    display: "flex",
    flexDirection: "column",
    minWidth: "220px",
    padding: "4px",
    border: "1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)",
    borderRadius: "4px",
    backgroundColor: "var(--sol-bg)",
    boxShadow: "0 6px 20px rgb(0 0 0 / 0.18)",
    fontSize: "12px",
  },
  ".cm-git-menu-list": { display: "flex", flexDirection: "column", maxHeight: "16em", overflowY: "auto", marginTop: "4px" },
  ".cm-git-menu-item": {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    padding: "3px 8px",
    border: "none",
    borderRadius: "3px",
    background: "none",
    color: "var(--sol-text-muted)",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  ".cm-git-menu-item[aria-selected]": { backgroundColor: "color-mix(in srgb, var(--sol-cyan) 18%, transparent)", color: "var(--sol-text)" },
  ".cm-git-menu-on": { color: "var(--sol-text)" },
  ".cm-git-menu-input": {
    padding: "3px 6px",
    border: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)",
    borderRadius: "3px",
    background: "var(--sol-bg-alt)",
    color: "var(--sol-text)",
    font: "inherit",
    outline: "none",
  },
  ".cm-git-menu-input:focus": { borderColor: "var(--sol-cyan)" },
});

/** Escape closes an open peek before vim or the app see it. Hunk keys for
 *  everyone, not only vim's ]c and [c: Alt-F5 steps like VS Code, Mod-'
 *  peeks (revert is in the peek) like Zed. */
const peekKeys = Prec.high(
  keymap.of([
    { key: "Alt-F5", run: (view) => stepGitHunk(view, 1), preventDefault: true },
    { key: "Shift-Alt-F5", run: (view) => stepGitHunk(view, -1), preventDefault: true },
    { key: "Mod-'", run: (view) => toggleGitPeek(view), preventDefault: true },
    {
      key: "Escape",
      run: (view) => {
        if (view.state.field(gitDiffField, false)?.peek == null) return false;
        view.dispatch({ effects: setPeek.of(null) });
        return true;
      },
    },
  ]),
);

/** The git feature for one file. */
export function gitEditorExtension(config: GitEditorConfig): Extension {
  // Lowest precedence puts the change bars last among the gutters, against
  // the text, whichever feature (lint, folding) happened to load first.
  return [gitConfig.of(config), gitDiffField, diffSlot.of([]), runner, splitPlugin, Prec.lowest(gitGutter), peekKeys, gitTheme, splitTheme];
}
