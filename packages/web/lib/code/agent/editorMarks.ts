// What the agent integration draws inside the editor, all as CodeMirror state
// (never React, never a store write on a keystroke):
//
//   - agent edits: ranges a session wrote while the file was open, in that
//     session's color. A soft background fades over ~2 s; a gutter bar stays
//     until the cursor enters the range (a click on the bar or Escape
//     dismisses too). ]a / [a step between them.
//   - quote flash: the range Cmd-L just quoted, pulsing once.
//   - sent marker: the range a Cmd-K instruction went out about, with a quiet
//     "sent to <session>" note, until the file changes under it or the
//     session's turn ends.
//   - the inline instruction's host: a block widget under the selection that
//     the React layer portals the input into.
//
// Everything maps through later edits, so a mark stays on its text while the
// person types above it.

import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, type ChangeDesc, type Extension, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { externalChange } from "../fileSync";
import { featureContext } from "../features";

// ── hooks the feature fills in ─────────────────────────────────────────────

export interface AgentMarkHooks {
  /** The session most likely behind a change to this file now, or null. */
  writerOf(vaultId: string, path: string): string | null;
  colorOf(sessionId: string | null): string;
  labelOf(sessionId: string | null): string;
  /** The inline instruction widget's host element came or went. */
  mountInline(id: number, host: HTMLElement | null): void;
}

const NEUTRAL = "var(--sol-text-muted)";

let hooks: AgentMarkHooks = {
  writerOf: () => null,
  colorOf: () => NEUTRAL,
  labelOf: (id) => (id ? "a session" : "an agent"),
  mountInline: () => {},
};

export function setAgentMarkHooks(next: Partial<AgentMarkHooks>): () => void {
  const prev = hooks;
  hooks = { ...hooks, ...next };
  return () => {
    hooks = prev;
  };
}

// ── state ──────────────────────────────────────────────────────────────────

export interface AgentEdit {
  from: number;
  to: number;
  sessionId: string | null;
  color: string;
}

export interface Flash {
  from: number;
  to: number;
  color: string;
  kind: "edit" | "quote";
  /** Epoch ms after which the flash is dropped. */
  until: number;
}

export interface SentMark {
  from: number;
  to: number;
  /** The sent message's client id: the marker ends with that message's turn. */
  key: string;
  sessionId: string;
  color: string;
  label: string;
}

export interface InlineSpot {
  id: number;
  /** End of the selection's last line: the widget sits below it. */
  pos: number;
  from: number;
  to: number;
}

export interface AgentMarksState {
  edits: AgentEdit[];
  flashes: Flash[];
  sent: SentMark[];
  inline: InlineSpot | null;
}

export const EDIT_FLASH_MS = 2000;
export const QUOTE_FLASH_MS = 900;

export const addAgentEdits = StateEffect.define<{ edits: AgentEdit[]; flashUntil: number }>();
export const dismissAgentEdits = StateEffect.define<"all" | number[]>();
export const dropFlashes = StateEffect.define<number>(); // drop those due by this time
export const addFlash = StateEffect.define<Flash>();
export const addSentMark = StateEffect.define<SentMark>();
/** Clears the marker of one sent message (its client id), or all. */
export const clearSentMarks = StateEffect.define<string | "all">();
export const setInlineSpot = StateEffect.define<InlineSpot | null>();

/** Marks a selection move made by ]a / [a, which visits an edit without
 *  dismissing it. */
export const agentNav = Annotation.define<boolean>();

const EMPTY: AgentMarksState = { edits: [], flashes: [], sent: [], inline: null };

function mapRange<T extends { from: number; to: number }>(r: T, changes: ChangeDesc): T {
  const from = changes.mapPos(r.from, 1);
  const to = Math.max(from, changes.mapPos(r.to, -1));
  return from === r.from && to === r.to ? r : { ...r, from, to };
}

const lineSpan = (doc: Text, r: { from: number; to: number }) => {
  const a = doc.lineAt(Math.min(r.from, doc.length)).number;
  const b = doc.lineAt(Math.min(Math.max(r.to, r.from), doc.length)).number;
  return [a, b] as const;
};

const onLine = (doc: Text, r: { from: number; to: number }, line: number) => {
  const [a, b] = lineSpan(doc, r);
  return line >= a && line <= b;
};

/** Ranges a transaction changed, in the new document. A deletion is a point. */
export function changedRanges(tr: Transaction): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    const last = out[out.length - 1];
    if (last && fromB <= last.to + 1) last.to = Math.max(last.to, toB);
    else out.push({ from: fromB, to: toB });
  });
  return out;
}

export const agentMarksField = StateField.define<AgentMarksState>({
  create: () => EMPTY,
  update(value, tr) {
    let { edits, flashes, sent, inline } = value;
    if (tr.docChanged) {
      edits = edits.map((e) => mapRange(e, tr.changes));
      flashes = flashes.map((f) => mapRange(f, tr.changes));
      if (tr.annotation(externalChange)) sent = [];
      else if (sent.length) {
        // The person editing the quoted text ends the marker for that range.
        const touched = changedRanges(tr);
        sent = sent.map((s) => mapRange(s, tr.changes)).filter((s) => !touched.some((c) => c.from <= s.to && c.to >= s.from));
      }
      if (inline) {
        const pos = tr.changes.mapPos(inline.pos, 1);
        inline = { ...inline, pos: tr.state.doc.lineAt(pos).to, from: tr.changes.mapPos(inline.from, 1), to: tr.changes.mapPos(inline.to, -1) };
      }
    }
    for (const e of tr.effects) {
      if (e.is(addAgentEdits)) {
        edits = [...edits, ...e.value.edits].sort((a, b) => a.from - b.from);
        flashes = [...flashes, ...e.value.edits.map((x) => ({ from: x.from, to: x.to, color: x.color, kind: "edit" as const, until: e.value.flashUntil }))];
      } else if (e.is(dismissAgentEdits)) {
        const drop = e.value;
        edits = drop === "all" ? [] : edits.filter((_x, i) => !drop.includes(i));
      } else if (e.is(dropFlashes)) {
        flashes = flashes.filter((f) => f.until > e.value);
      } else if (e.is(addFlash)) {
        flashes = [...flashes, e.value];
      } else if (e.is(addSentMark)) {
        sent = [...sent.filter((s) => s.to < e.value.from || s.from > e.value.to), e.value];
      } else if (e.is(clearSentMarks)) {
        sent = e.value === "all" ? [] : sent.filter((s) => s.key !== e.value);
      } else if (e.is(setInlineSpot)) {
        inline = e.value;
      }
    }
    // Moving the cursor into an edit (from outside it) says it was seen.
    if (tr.selection && edits.length && !tr.annotation(agentNav) && !tr.annotation(externalChange)) {
      const doc = tr.state.doc;
      const line = doc.lineAt(tr.newSelection.main.head).number;
      const before = tr.startState.selection.main.head;
      const prevLine = doc.lineAt(Math.min(tr.changes.mapPos(before), doc.length)).number;
      const kept = edits.filter((e) => !onLine(doc, e, line) || onLine(doc, e, prevLine));
      if (kept.length !== edits.length) edits = kept;
    }
    if (edits === value.edits && flashes === value.flashes && sent === value.sent && inline === value.inline) return value;
    return { edits, flashes, sent, inline };
  },
});

/** Holds the agent gutter only while the buffer has agent edits, so a file no
 *  agent touched carries no empty strip beside the git gutter. */
const gutterSlot = new Compartment();

/** An external change (fileSync's adopt) gets its ranges marked as one agent
 *  edit per changed run, colored for the session most likely behind it. The
 *  first edit in a buffer brings the gutter in with it. */
const markExternalChanges = EditorState.transactionExtender.of((tr) => {
  const effects: StateEffect<unknown>[] = [];
  let adding = tr.effects.some((e) => e.is(addAgentEdits));
  if (tr.docChanged && tr.annotation(externalChange)) {
    const ctx = tr.startState.facet(featureContext);
    const sessionId = ctx ? hooks.writerOf(ctx.vaultId, ctx.path) : null;
    const color = hooks.colorOf(sessionId);
    const edits = changedRanges(tr).map((r) => ({ ...r, sessionId, color }));
    if (edits.length) {
      effects.push(addAgentEdits.of({ edits, flashUntil: Date.now() + EDIT_FLASH_MS }));
      adding = true;
    }
  }
  if (adding && gutterSlot.get(tr.startState) !== editGutter) effects.push(gutterSlot.reconfigure(editGutter));
  return effects.length ? { effects } : null;
});

// ── drawing ────────────────────────────────────────────────────────────────

class SentNote extends WidgetType {
  constructor(
    readonly label: string,
    readonly color: string,
  ) {
    super();
  }
  eq(other: SentNote) {
    return other.label === this.label && other.color === this.color;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-agentSentNote";
    el.style.setProperty("--agent-c", this.color);
    el.textContent = `sent to ${this.label}`;
    el.title = `Instruction sent to ${this.label}`;
    return el;
  }
}

class InlineHost extends WidgetType {
  constructor(readonly id: number) {
    super();
  }
  eq(other: InlineHost) {
    return other.id === this.id;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-agentInline";
    el.dataset.agentInline = String(this.id);
    // Mounted after CodeMirror attaches the element.
    queueMicrotask(() => el.isConnected && hooks.mountInline(this.id, el));
    return el;
  }
  destroy(dom: HTMLElement) {
    hooks.mountInline(this.id, null);
    void dom;
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return 64;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const { flashes, sent, inline } = state.field(agentMarksField);
  if (!flashes.length && !sent.length && !inline) return Decoration.none;
  const doc = state.doc;
  const items: Array<{ from: number; to: number; deco: Decoration }> = [];
  for (const f of flashes) {
    const [a, b] = lineSpan(doc, f);
    const cls = f.kind === "quote" ? "cm-agentQuoted" : "cm-agentFlash";
    const deco = Decoration.line({ class: cls, attributes: { style: `--agent-c: ${f.color}` } });
    for (let n = a; n <= b; n++) {
      const p = doc.line(n).from;
      items.push({ from: p, to: p, deco });
    }
  }
  for (const s of sent) {
    if (s.to > s.from) items.push({ from: s.from, to: s.to, deco: Decoration.mark({ class: "cm-agentSent", attributes: { style: `--agent-c: ${s.color}` } }) });
    const end = doc.lineAt(Math.min(s.to, doc.length)).to;
    items.push({ from: end, to: end, deco: Decoration.widget({ widget: new SentNote(s.label, s.color), side: 2 }) });
  }
  if (inline) {
    const pos = Math.min(inline.pos, doc.length);
    items.push({ from: pos, to: pos, deco: Decoration.widget({ widget: new InlineHost(inline.id), block: true, side: 1 }) });
  }
  return Decoration.set(
    items.map((it) => it.deco.range(it.from, it.to)),
    true,
  );
}

const decorations = EditorView.decorations.compute([agentMarksField], buildDecorations);

class EditBar extends GutterMarker {
  constructor(
    readonly color: string,
    readonly title: string,
  ) {
    super();
  }
  eq(other: EditBar) {
    return other.color === this.color && other.title === this.title;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-agentBar";
    el.style.setProperty("--agent-c", this.color);
    el.title = this.title;
    return el;
  }
}

const editsOnLine = (state: EditorState, line: number) => {
  const { edits } = state.field(agentMarksField);
  const out: number[] = [];
  edits.forEach((e, i) => onLine(state.doc, e, line) && out.push(i));
  return out;
};

const editGutter = gutter({
  class: "cm-agentGutter",
  lineMarker(view, block) {
    const { edits } = view.state.field(agentMarksField);
    if (!edits.length) return null;
    const line = view.state.doc.lineAt(block.from).number;
    const hit = edits.find((e) => onLine(view.state.doc, e, line));
    if (!hit) return null;
    return new EditBar(hit.color, `Edited by ${hooks.labelOf(hit.sessionId)}. Click to dismiss`);
  },
  lineMarkerChange: (u) => u.startState.field(agentMarksField).edits !== u.state.field(agentMarksField).edits,
  domEventHandlers: {
    mousedown(view, block) {
      const hits = editsOnLine(view.state, view.state.doc.lineAt(block.from).number);
      if (!hits.length) return false;
      view.dispatch({ effects: dismissAgentEdits.of(hits) });
      return true;
    },
  },
});

/** Drops flashes once they have faded, so a line scrolled back into view does
 *  not replay its fade. */
const flashTimer = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;
    constructor(readonly view: EditorView) {
      this.schedule();
    }
    update(u: ViewUpdate) {
      if (u.startState.field(agentMarksField).flashes !== u.state.field(agentMarksField).flashes) this.schedule();
    }
    schedule() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      const { flashes } = this.view.state.field(agentMarksField);
      if (!flashes.length) return;
      const due = Math.min(...flashes.map((f) => f.until));
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.view.dispatch({ effects: dropFlashes.of(Date.now()) });
        },
        Math.max(0, due - Date.now()) + 50,
      );
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

/** Takes the gutter out once the last edit is dismissed. A microtask later,
 *  because a view update cannot dispatch. */
const gutterHider = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.check();
    }
    update(u: ViewUpdate) {
      if (u.startState.field(agentMarksField).edits !== u.state.field(agentMarksField).edits) this.check();
    }
    check() {
      const idle = (st: EditorState) => !st.field(agentMarksField).edits.length && gutterSlot.get(st) === editGutter;
      if (!idle(this.view.state)) return;
      queueMicrotask(() => {
        if (this.view.dom.isConnected && idle(this.view.state)) this.view.dispatch({ effects: gutterSlot.reconfigure([]) });
      });
    }
  },
);

const escapeDismisses = EditorView.domEventHandlers({
  keydown(e, view) {
    if (e.key !== "Escape" || e.defaultPrevented) return false;
    const st = view.state.field(agentMarksField);
    if (st.edits.length) view.dispatch({ effects: dismissAgentEdits.of("all") });
    // Escape still does what it does (vim's normal mode, closing a panel).
    return false;
  },
});

const theme = EditorView.baseTheme({
  "@keyframes cm-agent-fade": {
    from: { backgroundColor: "color-mix(in srgb, var(--agent-c) 26%, transparent)" },
    to: { backgroundColor: "transparent" },
  },
  ".cm-agentFlash": { animation: `cm-agent-fade ${EDIT_FLASH_MS}ms ease-out forwards` },
  ".cm-agentQuoted": { animation: `cm-agent-fade ${QUOTE_FLASH_MS}ms ease-out forwards` },
  ".cm-agentGutter": { width: "3px", minWidth: "3px" },
  ".cm-agentGutter .cm-gutterElement": { padding: "0 !important", cursor: "pointer" },
  ".cm-agentBar": { width: "3px", height: "100%", backgroundColor: "var(--agent-c)", borderRadius: "1px" },
  ".cm-agentSent": { backgroundColor: "color-mix(in srgb, var(--agent-c) 9%, transparent)" },
  ".cm-agentSentNote": {
    marginLeft: "1.5em",
    fontSize: "0.85em",
    color: "color-mix(in srgb, var(--agent-c) 70%, var(--sol-text-dim))",
    fontFamily: "inherit",
    userSelect: "none",
    pointerEvents: "auto",
  },
  ".cm-agentInline": { padding: "4px 0 6px" },
});

export function agentMarksExtension(): Extension {
  return [agentMarksField, markExternalChanges, decorations, gutterSlot.of([]), gutterHider, flashTimer, escapeDismisses, theme];
}

// ── verbs ──────────────────────────────────────────────────────────────────

export function hasAgentMarks(state: EditorState): boolean {
  return state.field(agentMarksField, false) !== undefined;
}

/** Move to the next (dir 1) or previous agent edit, wrapping. */
export function stepAgentEdit(view: EditorView, dir: 1 | -1): boolean {
  const st = view.state.field(agentMarksField, false);
  if (!st?.edits.length) return false;
  const doc = view.state.doc;
  const cur = doc.lineAt(view.state.selection.main.head).number;
  const starts = [...new Set(st.edits.map((e) => lineSpan(doc, e)[0]))].sort((a, b) => a - b);
  const target = dir === 1 ? (starts.find((n) => n > cur) ?? starts[0]) : ([...starts].reverse().find((n) => n < cur) ?? starts[starts.length - 1]);
  const line = doc.line(target);
  const pos = line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0);
  view.dispatch({ selection: EditorSelection.cursor(pos), annotations: agentNav.of(true), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  return true;
}

export function agentMarks(state: EditorState): AgentMarksState {
  return state.field(agentMarksField, false) ?? EMPTY;
}
