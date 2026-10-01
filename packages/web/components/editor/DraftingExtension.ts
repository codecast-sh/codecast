import { Extension, Mark, getMarkRange, mergeAttributes, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Mark as PMMark, MarkType, Node as PMNode } from "@tiptap/pm/model";
import {
  CLOSE_TAG,
  DRAFT_MARKS,
  FLAG_LABELS,
  TRIM_REASON,
  agreeArticle,
  altAttrsFor,
  draftMarkTag,
  fullAltList,
  normalizeAlts,
  type AltOption,
  type LabResult,
  wordCount,
} from "@codecast/shared/docs";

// Drafting in the editor (after Jason Fried's Write_On): alternatives you
// cycle in place, text ghosted back instead of deleted, and Lab findings.
// The three are marks whose markdown is the shared drafting markup
// (@codecast/shared/docs drafting), so the server's converters, `cast doc`
// verbs and agents read and write exactly what the editor shows. Ghosts always
// read dimmed; the alternatives' underline and dot pager and the Lab flags
// show only while drafting is on (the doc page's toggle), so a doc reads as
// plain prose until the writer asks for the affordances.

export type Range = { from: number; to: number };

// The markdown each mark writes is the shared opening tag plus </span>, the
// same bytes the server's toMarkdown and the CLI write.
const markdownStorage = {
  markdown: {
    serialize: {
      open: (_state: unknown, mark: PMMark) => draftMarkTag(mark.toJSON() as any),
      close: () => CLOSE_TAG,
    },
    parse: {},
  },
};

export const DraftAltsMark = Mark.create({
  name: DRAFT_MARKS.alts,
  inclusive: false,
  excludes: "",
  addAttributes() {
    return {
      alts: {
        default: [],
        parseHTML: (el) => {
          try {
            return normalizeAlts(JSON.parse(el.getAttribute("data-alts") || "[]"));
          } catch {
            return [];
          }
        },
        renderHTML: (a) => ({ "data-alts": JSON.stringify(normalizeAlts(a.alts)) }),
      },
      at: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute("data-alt-at")) || 0,
        renderHTML: (a) => ({ "data-alt-at": String(a.at ?? 0) }),
      },
      ai: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-alt-ai") === "1",
        renderHTML: (a) => (a.ai ? { "data-alt-ai": "1" } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-alts]" }];
  },
  renderHTML({ HTMLAttributes, mark }) {
    const varied = (mark.attrs.at ?? 0) > 0;
    return ["span", mergeAttributes(HTMLAttributes, { class: `draft-alt${varied ? " draft-alt--varied" : ""}` }), 0];
  },
  addStorage() {
    return markdownStorage;
  },
});

export const DraftGhostMark = Mark.create({
  name: DRAFT_MARKS.ghost,
  inclusive: false,
  excludes: "",
  addAttributes() {
    return {
      reason: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-ghost") ?? "",
        renderHTML: (a) => ({ "data-ghost": a.reason ?? "" }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-ghost]" }];
  },
  renderHTML({ HTMLAttributes, mark }) {
    const proposal = mark.attrs.reason === TRIM_REASON;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: `draft-ghost${proposal ? " draft-ghost--proposal" : ""}`,
        ...(proposal ? { title: "Proposed cut. Click to keep it." } : {}),
      }),
      0,
    ];
  },
  addStorage() {
    return markdownStorage;
  },
});

export const DraftFlagMark = Mark.create({
  name: DRAFT_MARKS.flag,
  inclusive: false,
  excludes: "",
  addAttributes() {
    return {
      flag: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-flag") ?? "",
        renderHTML: (a) => ({ "data-flag": a.flag ?? "" }),
      },
      note: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-note"),
        renderHTML: (a) => (a.note ? { "data-note": a.note } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-flag]" }];
  },
  renderHTML({ HTMLAttributes, mark }) {
    const label = FLAG_LABELS[mark.attrs.flag] ?? mark.attrs.flag;
    return ["span", mergeAttributes(HTMLAttributes, { class: "draft-flag", title: mark.attrs.note ? `${label}: ${mark.attrs.note}` : label }), 0];
  },
  addStorage() {
    return markdownStorage;
  },
});

// ── Plugin state ────────────────────────────────────────────────────

export interface DraftingPluginState {
  enabled: boolean;
  /** The stretch the alternatives panel is working on, mapped through every edit. */
  focus: Range | null;
  decorations: DecorationSet;
}

export const draftingKey = new PluginKey<DraftingPluginState>("drafting");

type DraftingMeta = { enabled?: boolean; focus?: Range | null };

export function draftingState(state: EditorState): DraftingPluginState | undefined {
  return draftingKey.getState(state);
}

/** Every contiguous run of an alternatives mark: its range, attrs and shown text. */
export function altRanges(doc: PMNode, type: MarkType): Array<Range & { mark: PMMark; text: string; block: PMNode; blockPos: number }> {
  const out: Array<Range & { mark: PMMark; text: string; block: PMNode; blockPos: number }> = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let current: (Range & { mark: PMMark; text: string; block: PMNode; blockPos: number }) | null = null;
    block.forEach((child, offset) => {
      const pos = blockPos + 1 + offset;
      const mark = child.marks.find((m) => m.type === type);
      if (mark && current && current.mark.eq(mark) && current.to === pos) {
        current.to = pos + child.nodeSize;
        current.text += child.text ?? "";
        return;
      }
      if (current) out.push(current);
      current = mark ? { from: pos, to: pos + child.nodeSize, mark, text: child.text ?? "", block, blockPos } : null;
    });
    if (current) out.push(current);
    return false;
  });
  return out;
}

function dots(view: EditorView, range: Range, full: AltOption[], at: number, vertical: boolean): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = `draft-dots${vertical ? " draft-dots--para" : ""}`;
  wrap.contentEditable = "false";
  const row = document.createElement("span");
  row.className = "draft-dots__row";
  full.forEach((opt, i) => {
    const dot = document.createElement("span");
    dot.className = `draft-dot${i === at ? " draft-dot--on" : ""}${i === 0 ? " draft-dot--original" : ""}${opt.ai ? " draft-dot--ai" : ""}`;
    dot.title = `${i === 0 ? "Original" : opt.ai ? "AI version" : "Version"} ${i + 1}: ${opt.t}`;
    dot.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pickAlternativeAt(view, range.from, i);
    });
    row.appendChild(dot);
  });
  wrap.appendChild(row);
  return wrap;
}

function buildDecorations(state: EditorState, enabled: boolean, focus: Range | null): DecorationSet {
  if (!enabled) return DecorationSet.empty;
  const type = state.schema.marks[DRAFT_MARKS.alts];
  const decos: Decoration[] = [];
  if (type) {
    for (const r of altRanges(state.doc, type)) {
      const full = fullAltList({ alts: normalizeAlts(r.mark.attrs.alts), at: r.mark.attrs.at, ai: r.mark.attrs.ai }, r.text);
      if (full.length < 2) continue;
      const at = Math.min(r.mark.attrs.at ?? 0, full.length - 1);
      // A paragraph-level set: the mark covers the whole block, so the pager
      // moves to a rule in the left gutter instead of sitting under the text.
      const whole = r.from === r.blockPos + 1 && r.to === r.blockPos + 1 + r.block.content.size;
      const isPara = whole && /[.!?]\s+\S/.test(r.text);
      if (isPara) {
        decos.push(Decoration.node(r.blockPos, r.blockPos + r.block.nodeSize, { class: "draft-alt-para" }));
        decos.push(Decoration.widget(r.from, (view) => dots(view, r, full, at, true), { side: -1, key: `pd:${r.from}:${at}:${full.length}`, ignoreSelection: true }));
      } else {
        decos.push(Decoration.widget(r.to, (view) => dots(view, r, full, at, false), { side: -1, key: `d:${r.from}:${at}:${full.length}`, ignoreSelection: true }));
      }
    }
  }
  if (focus && focus.to > focus.from) {
    decos.push(Decoration.inline(focus.from, focus.to, { class: "draft-lit" }));
    // The top-level block holding the stretch stays lit while the rest recedes.
    const $from = state.doc.resolve(focus.from);
    if ($from.depth >= 1) decos.push(Decoration.node($from.before(1), $from.after(1), { class: "draft-lit-block" }));
  }
  return DecorationSet.create(state.doc, decos);
}

// ── Commands (plain functions on a view, so panels and widgets share them) ──

function altMarkType(state: EditorState) {
  return state.schema.marks[DRAFT_MARKS.alts];
}

/** The alternatives run that covers `pos`, if any. */
export function altRangeAt(state: EditorState, pos: number) {
  const type = altMarkType(state);
  if (!type) return null;
  return altRanges(state.doc, type).find((r) => r.from <= pos && pos <= r.to && (pos < r.to || r.from === pos || pos === r.to)) ?? null;
}

/**
 * Show version `index` of the alternatives run at `pos`. The shown text is
 * replaced in place (other marks of its first character kept) and the article
 * before it agrees with the new word.
 */
export function pickAlternativeAt(view: EditorView, pos: number, index: number): boolean {
  const { state } = view;
  const r = altRangeAt(state, pos);
  if (!r) return false;
  const full = fullAltList({ alts: normalizeAlts(r.mark.attrs.alts), at: r.mark.attrs.at, ai: r.mark.attrs.ai }, r.text);
  if (index < 0 || index >= full.length || index === Math.min(r.mark.attrs.at, full.length - 1)) return false;
  const { attrs, shown } = altAttrsFor(full, index);
  const type = altMarkType(state);
  const others = (state.doc.nodeAt(r.from)?.marks ?? []).filter((m) => m.type !== type);
  const tr = state.tr;
  let from = r.from;
  // a/an agreement with the text right before the run, inside the same block.
  const before = state.doc.textBetween(Math.max(r.blockPos + 1, r.from - 4), r.from, undefined, "￼");
  const fixed = agreeArticle(before, shown);
  if (fixed !== before && fixed.length <= before.length + 1) {
    const start = r.from - before.length;
    tr.insertText(fixed, start, r.from);
    from = start + fixed.length;
  }
  const to = tr.mapping.map(r.to);
  tr.replaceWith(from, to, state.schema.text(shown, [...others, type.create(attrs)]));
  const sel = state.selection;
  if (sel.empty && sel.from >= r.from && sel.from <= r.to) {
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + shown.length)));
  }
  view.dispatch(tr.setMeta("addToHistory", true));
  return true;
}

/** Step the alternatives run at `pos` up or down its list, wrapping around. */
export function cycleAlternativeAt(view: EditorView, pos: number, dir: 1 | -1): boolean {
  const r = altRangeAt(view.state, pos);
  if (!r) return false;
  const n = normalizeAlts(r.mark.attrs.alts).length + 1;
  if (n < 2) return false;
  const at = Math.min(r.mark.attrs.at ?? 0, n - 1);
  return pickAlternativeAt(view, pos, (at + dir + n) % n);
}

/**
 * Add versions for a stretch. If the stretch is already an alternatives run
 * they join its list; otherwise the stretch becomes the original. `show`
 * switches to the first added version (adding one by hand shows it, as the
 * writer wants to read it in place).
 */
export function addAlternativesAt(view: EditorView, range: Range, options: string[], opts: { ai?: boolean; show?: boolean } = {}): boolean {
  const { state } = view;
  const type = altMarkType(state);
  const fresh = options.map((t) => t.trim()).filter(Boolean);
  if (!type || !fresh.length || range.to <= range.from) return false;
  const existing = altRangeAt(state, range.from);
  const tr = state.tr;
  let full: AltOption[];
  let at: number;
  let runFrom: number;
  let runTo: number;
  if (existing && existing.from === range.from && existing.to === range.to) {
    full = fullAltList({ alts: normalizeAlts(existing.mark.attrs.alts), at: existing.mark.attrs.at, ai: existing.mark.attrs.ai }, existing.text);
    at = Math.min(existing.mark.attrs.at ?? 0, full.length - 1);
    runFrom = existing.from;
    runTo = existing.to;
  } else {
    const text = state.doc.textBetween(range.from, range.to, " ");
    full = [{ t: text }];
    at = 0;
    runFrom = range.from;
    runTo = range.to;
  }
  const known = new Set(full.map((o) => o.t));
  const added = fresh.filter((t) => !known.has(t));
  if (!added.length) return false;
  full = [...full, ...added.map((t) => ({ t, ...(opts.ai ? { ai: true } : {}) }))];
  const { attrs } = altAttrsFor(full, at);
  tr.removeMark(runFrom, runTo, type).addMark(runFrom, runTo, type.create(attrs));
  view.dispatch(tr);
  if (opts.show) pickAlternativeAt(view, runFrom, full.length - added.length);
  return true;
}

/** Drop one version (never the one shown). With one version left the run settles into plain text. */
export function removeAlternativeAt(view: EditorView, pos: number, index: number): boolean {
  const { state } = view;
  const r = altRangeAt(state, pos);
  if (!r) return false;
  const full = fullAltList({ alts: normalizeAlts(r.mark.attrs.alts), at: r.mark.attrs.at, ai: r.mark.attrs.ai }, r.text);
  const at = Math.min(r.mark.attrs.at ?? 0, full.length - 1);
  if (index === at || index < 0 || index >= full.length) return false;
  const rest = full.filter((_, i) => i !== index);
  const type = altMarkType(state);
  const tr = state.tr.removeMark(r.from, r.to, type);
  if (rest.length > 1) tr.addMark(r.from, r.to, type.create(altAttrsFor(rest, index < at ? at - 1 : at).attrs));
  view.dispatch(tr);
  return true;
}

/** Ghost the selection, or revive it when it is already ghosted. */
export function toggleGhost(view: EditorView, reason = ""): boolean {
  const { state } = view;
  const type = state.schema.marks[DRAFT_MARKS.ghost];
  const { from, to, empty } = state.selection;
  if (!type) return false;
  if (empty) return reviveAt(view, from);
  const ghosted = state.doc.rangeHasMark(from, to, type);
  const tr = ghosted ? state.tr.removeMark(from, to, type) : state.tr.addMark(from, to, type.create({ reason }));
  view.dispatch(tr);
  return true;
}

/** Bring back the ghosted run at `pos`. */
export function reviveAt(view: EditorView, pos: number): boolean {
  const { state } = view;
  const type = state.schema.marks[DRAFT_MARKS.ghost];
  if (!type) return false;
  const $pos = state.doc.resolve(pos);
  const range = getMarkRange($pos, type) ?? (pos > 0 ? getMarkRange(state.doc.resolve(pos - 1), type) : undefined);
  if (!range) return false;
  view.dispatch(state.tr.removeMark(range.from, range.to, type));
  return true;
}

/** Every run carrying a ghost of `reason` (all ghosts when reason is "*"). */
export function ghostRanges(state: EditorState, reason: string): Range[] {
  const type = state.schema.marks[DRAFT_MARKS.ghost];
  const out: Range[] = [];
  if (!type) return out;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const m = node.marks.find((mk) => mk.type === type);
    if (!m || (reason !== "*" && m.attrs.reason !== reason)) return false;
    const last = out[out.length - 1];
    if (last && last.to === pos) last.to = pos + node.nodeSize;
    else out.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  return out;
}

/** Delete proposed cuts (or all ghosts with "*"), tidying the space each leaves. */
export function makeCuts(view: EditorView, reason: string = TRIM_REASON): number {
  return cutRanges(view, ghostRanges(view.state, reason));
}

/** Delete these ranges, tidying the doubled space or space-before-punctuation each leaves. */
export function cutRanges(view: EditorView, ranges: Range[]): number {
  if (!ranges.length) return 0;
  const tr = view.state.tr;
  for (const r of [...ranges].reverse()) {
    let { from, to } = r;
    const doc = tr.doc;
    const after = doc.textBetween(to, Math.min(to + 1, doc.content.size), undefined, "￼");
    const before = doc.textBetween(Math.max(0, from - 1), from, undefined, "￼");
    // "a  b" -> "a b", "a ." -> "a."
    if (before === " " && (after === " " || /^[,.;:!?]$/.test(after))) from -= 1;
    tr.delete(from, to);
  }
  view.dispatch(tr);
  return ranges.length;
}

/** Revive every ghost of `reason`. */
export function reviveAll(view: EditorView, reason: string = TRIM_REASON): number {
  const type = view.state.schema.marks[DRAFT_MARKS.ghost];
  const ranges = ghostRanges(view.state, reason);
  if (!ranges.length || !type) return 0;
  const tr = view.state.tr;
  for (const r of ranges) tr.removeMark(r.from, r.to, type);
  view.dispatch(tr);
  return ranges.length;
}

/** Remove Lab flags (one kind, or all). */
export function clearFlags(view: EditorView, flag?: string): void {
  const type = view.state.schema.marks[DRAFT_MARKS.flag];
  if (!type) return;
  const tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const m = node.marks.find((mk) => mk.type === type);
    if (m && (!flag || m.attrs.flag === flag)) tr.removeMark(pos, pos + node.nodeSize, m);
    return false;
  });
  if (tr.docChanged) view.dispatch(tr);
}

// ── Finding the writer's words in the doc ───────────────────────────

/** The doc as plain text, one block per paragraph, the same text the Lab's model reads. */
export function docPlainText(doc: PMNode): string {
  const blocks: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      blocks.push(node.textContent);
      return false;
    }
    return true;
  });
  return blocks.join("\n\n");
}

/** Words in the doc, leaving out ghosts of `reason` ("*" for every ghost): the length after the cuts. */
export function wordsWithout(state: EditorState, reason?: string): number {
  const type = state.schema.marks[DRAFT_MARKS.ghost];
  let text = "";
  state.doc.descendants((node) => {
    if (node.isTextblock) {
      node.forEach((child) => {
        const g = type && child.marks.find((m) => m.type === type);
        if (g && reason !== undefined && (reason === "*" || g.attrs.reason === reason)) return;
        text += child.text ?? " ";
      });
      text += "\n";
      return false;
    }
    return true;
  });
  return wordCount(text);
}

/** Ranges where `needle` appears inside one text block, in document order. */
export function findTextRanges(doc: PMNode, needle: string): Range[] {
  const out: Range[] = [];
  if (!needle) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Map each character of the block's text back to its doc position.
    const map: number[] = [];
    let text = "";
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) map.push(pos + 1 + offset + i);
        text += child.text;
      } else {
        map.push(-1);
        text += "￼";
      }
    });
    let at = text.indexOf(needle);
    while (at >= 0) {
      const from = map[at];
      const last = map[at + needle.length - 1];
      if (from >= 0 && last >= 0) out.push({ from, to: last + 1 });
      at = text.indexOf(needle, at + 1);
    }
    return false;
  });
  return out;
}

function freeRange(state: EditorState, needle: string, markName: string): Range | null {
  const type = state.schema.marks[markName];
  return findTextRanges(state.doc, needle).find((r) => !type || !state.doc.rangeHasMark(r.from, r.to, type)) ?? null;
}

/**
 * Land a Lab result in the live editor: the editor twin of the shared
 * applyLabResult (which lands it in stored markdown for `cast doc lab`). A new
 * trim replaces the previous one's proposals.
 */
export function applyLabResultInEditor(view: EditorView, result: LabResult, target?: Range): { applied: number; missed: string[] } {
  const missed: string[] = [];
  let applied = 0;
  if (result.tool === "alternatives") {
    if (target && addAlternativesAt(view, target, result.options, { ai: true })) applied = result.options.length;
    return { applied, missed };
  }
  if (result.tool === "trim") {
    reviveAll(view, TRIM_REASON);
    const type = view.state.schema.marks[DRAFT_MARKS.ghost];
    for (const cut of result.cuts) {
      const r = freeRange(view.state, cut, DRAFT_MARKS.ghost);
      if (!r) { missed.push(cut); continue; }
      view.dispatch(view.state.tr.addMark(r.from, r.to, type.create({ reason: TRIM_REASON })));
      applied++;
    }
    return { applied, missed };
  }
  if (result.tool === "flag") {
    clearFlags(view, result.flag);
    const type = view.state.schema.marks[DRAFT_MARKS.flag];
    for (const item of result.items) {
      const r = freeRange(view.state, item.text, DRAFT_MARKS.flag);
      if (!r) { missed.push(item.text); continue; }
      view.dispatch(view.state.tr.addMark(r.from, r.to, type.create({ flag: result.flag, note: item.note ?? null })));
      applied++;
    }
    return { applied, missed };
  }
  for (const fix of result.fixes) {
    const r = freeRange(view.state, fix.old, DRAFT_MARKS.alts);
    if (!r) { missed.push(fix.old); continue; }
    if (addAlternativesAt(view, r, [fix.new], { ai: true, show: true })) applied++;
  }
  return { applied, missed };
}

// ── Scopes for the alternatives panel ───────────────────────────────

export type AltScope = "word" | "sentence" | "paragraph";

/** The word, sentence or paragraph around `pos`, as a doc range inside its text block. */
export function scopeRange(state: EditorState, pos: number, scope: AltScope): Range | null {
  const $pos = state.doc.resolve(pos);
  const block = $pos.parent;
  if (!block.isTextblock || block.content.size === 0) return null;
  const start = $pos.start();
  const text = block.textBetween(0, block.content.size, undefined, "￼");
  const at = Math.min($pos.parentOffset, text.length);
  if (scope === "paragraph") return { from: start, to: start + text.length };
  if (scope === "word") {
    const isWord = (c: string) => /[\p{L}\p{N}'’-]/u.test(c);
    let a = at;
    let b = at;
    while (a > 0 && isWord(text[a - 1])) a--;
    while (b < text.length && isWord(text[b])) b++;
    return b > a ? { from: start + a, to: start + b } : null;
  }
  // Sentence: from after the previous terminator to through the next one.
  let a = at;
  while (a > 0 && !/[.!?]/.test(text[a - 1])) a--;
  while (a < text.length && /\s/.test(text[a])) a++;
  let b = at;
  while (b < text.length && !/[.!?]/.test(text[b])) b++;
  while (b < text.length && /[.!?"'”’)]/.test(text[b])) b++;
  return b > a ? { from: start + a, to: start + b } : null;
}

/** Which scope a stretch reads as: no space is a word, a whole multi-sentence block is a paragraph. */
export function scopeOf(state: EditorState, range: Range): AltScope {
  const text = state.doc.textBetween(range.from, range.to, " ");
  if (!/\s/.test(text.trim())) return "word";
  const $from = state.doc.resolve(range.from);
  const whole = range.from === $from.start() && range.to === $from.end();
  return whole && /[.!?]\s+\S/.test(text) ? "paragraph" : "sentence";
}

// ── The extension ───────────────────────────────────────────────────

export interface DraftingOptions {
  /** Open the alternatives panel on a stretch (Mod-Shift-O). */
  onOpenAlternatives?: (range: Range) => void;
  /** Ask the Lab for alternatives on a stretch (Mod-Shift-G). */
  onAiAlternatives?: (range: Range) => void;
  /** Move the selection into the Overflow (Mod-Shift-X). */
  onStash?: (text: string) => void;
}

export function setDraftingEnabled(editor: Editor, enabled: boolean) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(draftingKey, { enabled } satisfies DraftingMeta));
}

export function setDraftingFocus(editor: Editor, focus: Range | null) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(draftingKey, { focus } satisfies DraftingMeta));
}

/** Delete the selection and hand its text to `onStash`. */
export function stashSelection(view: EditorView, onStash: (text: string) => void): boolean {
  const { from, to, empty } = view.state.selection;
  if (empty) return false;
  const text = view.state.doc.textBetween(from, to, "\n\n");
  if (!text.trim()) return false;
  onStash(text);
  view.dispatch(view.state.tr.deleteSelection());
  return true;
}

/** The drafting marks every editor loads, so no editor drops drafting markup it opens. */
export const DRAFTING_MARKS = [DraftAltsMark, DraftGhostMark, DraftFlagMark];

/** The drafting behaviour (pager, cycling, shortcuts) the doc page's editor adds on top of the marks. */
export const DraftingExtension = Extension.create<DraftingOptions>({
  name: "drafting",

  addOptions() {
    return {};
  },

  addKeyboardShortcuts() {
    const selectionOrScope = (): Range | null => {
      const { state } = this.editor;
      const { from, to, empty } = state.selection;
      if (!empty) return { from, to };
      const run = altRangeAt(state, from);
      return run ? { from: run.from, to: run.to } : scopeRange(state, from, "word");
    };
    return {
      "Mod-Shift-o": () => {
        const r = selectionOrScope();
        if (!r || !this.options.onOpenAlternatives) return false;
        this.options.onOpenAlternatives(r);
        return true;
      },
      "Mod-Shift-g": () => {
        const r = selectionOrScope();
        if (!r || !this.options.onAiAlternatives) return false;
        this.options.onAiAlternatives(r);
        return true;
      },
      "Mod-Shift-.": () => toggleGhost(this.editor.view),
      "Mod-Shift-x": () => (this.options.onStash ? stashSelection(this.editor.view, this.options.onStash) : false),
      "Alt-ArrowUp": () => cycleAlternativeAt(this.editor.view, this.editor.state.selection.from, -1),
      "Alt-ArrowDown": () => cycleAlternativeAt(this.editor.view, this.editor.state.selection.from, 1),
    };
  },

  addProseMirrorPlugins() {
    // The alternatives run under the pointer: hover plus Up/Down cycles it in
    // place, the gesture from the video (no click, no selection).
    let hoverPos: number | null = null;
    return [
      new Plugin<DraftingPluginState>({
        key: draftingKey,
        state: {
          init: (_, state) => ({ enabled: false, focus: null, decorations: buildDecorations(state, false, null) }),
          apply(tr: Transaction, prev, _old, state) {
            const meta = tr.getMeta(draftingKey) as DraftingMeta | undefined;
            const enabled = meta?.enabled ?? prev.enabled;
            let focus = meta && "focus" in meta ? meta.focus ?? null : prev.focus;
            if (focus && tr.docChanged && !(meta && "focus" in meta)) {
              focus = { from: tr.mapping.map(focus.from, -1), to: tr.mapping.map(focus.to, 1) };
              if (focus.to <= focus.from) focus = null;
            }
            if (!meta && !tr.docChanged) return prev;
            return { enabled, focus, decorations: buildDecorations(state, enabled, focus) };
          },
        },
        props: {
          decorations: (state) => draftingKey.getState(state)?.decorations,
          attributes: (state): Record<string, string> => {
            const s = draftingKey.getState(state);
            const cls = [s?.enabled ? "drafting-on" : "", s?.focus ? "drafting-focus" : ""].filter(Boolean).join(" ");
            return cls ? { class: cls } : {};
          },
          handleDOMEvents: {
            mouseover: (view, event) => {
              const el = (event.target as HTMLElement | null)?.closest?.("span[data-alts]");
              hoverPos = el && view.dom.contains(el) ? view.posAtDOM(el, 0) : null;
              return false;
            },
            mouseleave: () => {
              hoverPos = null;
              return false;
            },
          },
          handleKeyDown: (view, event) => {
            if (hoverPos == null || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
            if (!draftingKey.getState(view.state)?.enabled) return false;
            const done = cycleAlternativeAt(view, hoverPos, event.key === "ArrowUp" ? -1 : 1);
            if (done) event.preventDefault();
            return done;
          },
          handleClick: (view, pos, event) => {
            // A proposed cut is kept by clicking it.
            const el = (event.target as HTMLElement | null)?.closest?.(`span[data-ghost="${TRIM_REASON}"]`);
            if (!el) return false;
            return reviveAt(view, pos);
          },
        },
      }),
    ];
  },
});
