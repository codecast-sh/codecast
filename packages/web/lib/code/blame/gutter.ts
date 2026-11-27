// The session blame gutter, inline blame and the fetch behind them, as one
// CodeMirror extension. Loaded only when blame turns on (index.ts).
//
// The blame lives in a StateField inside each buffer's state, so a tab that
// comes back keeps its gutter and a split showing the same document shares
// it. Markers are a RangeSet built once per fetch; a keystroke maps them and
// redraws only the lines it touched (as uncommitted), and the labels settle
// a moment after typing stops. React hears none of it.

import { ChangeSet, Facet, Prec, RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { CodeBlameHunk, CodeBlameResponse } from "@codecast/shared/contracts";
import { useVaultStore } from "../../../store/vaultStore";
import { bufferKey, codeBuffers, savedDocField } from "../buffers";
import { featureContext } from "../features";
import { lineChanges, loadMergeKit } from "../merge";
import { BLAME_GUTTER_COLUMN } from "../gutterSlots";
import { ensureGitStatus, useGitStatusStore } from "../git/status";
import { NOT_CONNECTED, blameAvailability, blameFailure, blameKey, forgetBlame, loadBlame } from "./data";
import { closeBlameHover, hoverBlameRun, hoverStays, leaveBlameHover, pinBlameRun } from "./hover";
import { openBlameSession } from "./actions";
import {
  NEUTRAL_HUE,
  blameRuns,
  hueOf,
  inlineText,
  mapHunks,
  mergeSpans,
  originAt,
  placeHunks,
  runAtLine,
  runLabel,
  sessionHues,
  touchedSpans,
  updateEdits,
  type BlameRun,
  type LineSpan,
  type PlacedHunk,
  type RunKind,
} from "./model";

export type BlameStatus = "idle" | "loading" | "ready" | "unavailable";

export interface BlameValue {
  status: BlameStatus;
  /** The file version the hunks were fetched for (data.blameKey). */
  key: string | null;
  /** Why blame is unavailable, for the toggle's tooltip. */
  reason?: string;
  /** The failure may pass (the daemon away, a timeout): the runner asks
   *  again on its own, and the toggle stays usable. */
  transient?: boolean;
  /** A refetch failed for a passing reason while hunks stay drawn. */
  retry?: string;
  /** When the runs (and their ages) were last built. */
  derivedAt: number;
  hunks: readonly CodeBlameHunk[];
  placed: readonly PlacedHunk[];
  edits: readonly LineSpan[];
  runs: readonly BlameRun[];
  hues: ReadonlyMap<string, string>;
  markers: RangeSet<GutterMarker>;
  /** Edits since the runs were built: labels settle on the next derive. */
  stale: boolean;
}

const EMPTY: BlameValue = {
  status: "idle",
  key: null,
  hunks: [],
  placed: [],
  edits: [],
  runs: [],
  hues: new Map(),
  markers: RangeSet.empty,
  stale: false,
  derivedAt: 0,
};

// ── markers ─────────────────────────────────────────────────────────────────

class BlameMarker extends GutterMarker {
  constructor(
    readonly kind: RunKind,
    readonly hue: string,
    readonly label: { name: string; age: string } | null,
  ) {
    super();
    this.elementClass = label ? "cm-blame-line cm-blame-start" : "cm-blame-line";
  }
  eq(o: BlameMarker): boolean {
    return o.kind === this.kind && o.hue === this.hue && o.label?.name === this.label?.name && o.label?.age === this.label?.age;
  }
  toDOM(): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "cm-blame-cell";
    cell.dataset.kind = this.kind;
    cell.style.setProperty("--blame-hue", this.hue);
    if (this.label) {
      const name = document.createElement("span");
      name.className = "cm-blame-name";
      name.textContent = this.label.name;
      const age = document.createElement("span");
      age.className = "cm-blame-age";
      age.textContent = this.label.age;
      cell.append(name, age);
    }
    return cell;
  }
}

const bars = new Map<string, BlameMarker>();
function bar(kind: RunKind, hue: string): BlameMarker {
  const k = `${kind}|${hue}`;
  let m = bars.get(k);
  if (!m) bars.set(k, (m = new BlameMarker(kind, hue, null)));
  return m;
}

/** Who a run reads as in the gutter: two runs back to back with the same one
 *  share the first's label (two commits of one session, one session's lines
 *  split around an edit that was since undone). */
function runOwner(run: BlameRun): string {
  const s = run.hunk?.session;
  if (s) return `s:${s.conversation_id ?? s.id}`;
  if (run.kind === "commit") return `a:${run.hunk?.author ?? run.hunk?.sha ?? ""}`;
  return run.kind;
}

/** The gutter's markers: a bar on every line of a run, the label on the
 *  first line of a run whose owner differs from the run right above. */
export function buildMarkers(runs: readonly BlameRun[], hues: ReadonlyMap<string, string>, doc: Text, now: number): RangeSet<GutterMarker> {
  const b = new RangeSetBuilder<GutterMarker>();
  let prev: BlameRun | null = null;
  for (const run of runs) {
    const hue = hueOf(run.hunk, hues);
    const body = bar(run.kind, hue);
    let line = doc.line(run.fromLine);
    const continues = prev !== null && prev.toLine + 1 === run.fromLine && prev.kind === run.kind && runOwner(prev) === runOwner(run);
    prev = run;
    b.add(line.from, line.from, continues ? body : new BlameMarker(run.kind, hue, runLabel(run.kind, run.hunk, now)));
    for (let n = run.fromLine + 1; n <= run.toLine; n++) {
      line = doc.line(n);
      b.add(line.from, line.from, body);
    }
  }
  return b.finish();
}

/** Runs and markers from placed hunks and edits: what lands after a fetch and
 *  after typing pauses. Exported for the frame-budget measurement. */
export function deriveBlame(value: BlameValue, doc: Text, now = Date.now()): BlameValue {
  const runs = blameRuns(value.placed, value.edits, doc);
  return { ...value, runs, markers: buildMarkers(runs, value.hues, doc, now), stale: false, derivedAt: now };
}

/** Markers after an edit, without a rebuild: lines deleted lose theirs, the
 *  rest move with the text, and every touched line becomes uncommitted. */
function patchMarkers(markers: RangeSet<GutterMarker>, changes: ChangeSet, touched: readonly LineSpan[], doc: Text): RangeSet<GutterMarker> {
  let m = markers;
  changes.iterChangedRanges((fromA, toA) => {
    if (toA > fromA) m = m.update({ filterFrom: fromA, filterTo: toA - 1, filter: (from) => from < fromA || from >= toA });
  });
  m = m.map(changes);
  const edited = bar("edited", NEUTRAL_HUE);
  for (const span of touched) {
    const add = [];
    const last = doc.lineAt(Math.max(span.from, span.to - 1)).number;
    for (let n = doc.lineAt(span.from).number; n <= last; n++) add.push(edited.range(doc.line(n).from));
    m = m.update({ filterFrom: span.from, filterTo: Math.max(span.from, span.to - 1), filter: () => false, add });
  }
  return m;
}

// ── state ───────────────────────────────────────────────────────────────────

const setLoading = StateEffect.define<string>();
const setUnavailable = StateEffect.define<{ key: string | null; reason: string; transient?: boolean }>();
const setData = StateEffect.define<{ key: string; hunks: readonly CodeBlameHunk[]; placed: PlacedHunk[]; edits: LineSpan[] }>();
/** Build the runs again: after typing settles, or (forced) to refresh ages. */
const rederive = StateEffect.define<{ force: boolean }>();

/** Exported for the frame-budget measurement. */
export const blameDataEffect = setData;

export const blameField = StateField.define<BlameValue>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.status === "ready") {
      const touched = touchedSpans(tr.changes, tr.startState.doc, tr.state.doc);
      next = {
        ...value,
        placed: mapHunks(value.placed, tr.changes),
        edits: updateEdits(value.edits, tr.changes, tr.startState.doc, tr.state.doc),
        markers: patchMarkers(value.markers, tr.changes, touched, tr.state.doc),
        stale: true,
      };
    }
    for (const e of tr.effects) {
      // A new version on its way: what is drawn stays (mapped through the
      // edits since) until it lands, so a save never blinks the gutter.
      if (e.is(setLoading)) next = next.status === "ready" ? { ...next, key: e.value } : { ...EMPTY, status: "loading", key: e.value };
      else if (e.is(setUnavailable)) {
        // A passing failure keeps what is drawn; the key clears so the next
        // kick asks again.
        next =
          e.value.transient && next.status === "ready"
            ? { ...next, key: null, retry: e.value.reason }
            : { ...EMPTY, status: "unavailable", key: e.value.key, reason: e.value.reason, transient: e.value.transient };
      }
      else if (e.is(setData)) {
        next = deriveBlame(
          { ...EMPTY, status: "ready", key: e.value.key, hunks: e.value.hunks, placed: e.value.placed, edits: e.value.edits, hues: sessionHues(e.value.hunks) },
          tr.state.doc,
        );
      } else if (e.is(rederive) && (next.stale || (e.value.force && next.status === "ready"))) next = deriveBlame(next, tr.state.doc);
    }
    return next;
  },
});

export function blameValue(state: EditorState): BlameValue | null {
  return state.field(blameField, false) ?? null;
}

/** What the toggle and the tests read. */
export function blameLineRuns(state: EditorState): readonly BlameRun[] {
  return blameValue(state)?.runs ?? [];
}

// ── placing a fetch on the document ─────────────────────────────────────────

/**
 * The hunks as ranges of the buffer. The daemon blamed what disk holds; a
 * buffer with unsaved edits is the saved text plus a line diff, and the lines
 * that diff changes start out uncommitted.
 */
async function placeOnBuffer(state: () => EditorState, hunks: readonly CodeBlameHunk[]): Promise<{ placed: PlacedHunk[]; edits: LineSpan[] } | null> {
  const s = state();
  const saved = s.field(savedDocField, false);
  if (!saved || s.doc.eq(saved)) return { placed: placeHunks(hunks, s.doc), edits: [] };
  const kit = await loadMergeKit();
  const now = state();
  const savedNow = now.field(savedDocField, false);
  if (!savedNow) return null;
  const changes = ChangeSet.of(lineChanges(kit, savedNow.toString(), now.doc.toString()), savedNow.length);
  return {
    placed: mapHunks(placeHunks(hunks, savedNow), changes),
    edits: mergeSpans(touchedSpans(changes, savedNow, now.doc)),
  };
}

// ── options ─────────────────────────────────────────────────────────────────

export interface BlameOptions {
  gutter: boolean;
  inline: boolean;
}

const blameOptions = Facet.define<BlameOptions, BlameOptions>({
  combine: (v) => v[0] ?? { gutter: false, inline: false },
});

// ── the fetch ───────────────────────────────────────────────────────────────

const REFETCH_MS = 400;
const SETTLE_MS = 250;
/** A passing failure asks again after 5s, doubling to a minute. */
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** Ages ("3h") read again when the editor regains focus after this long. */
const AGE_REFRESH_MS = 10 * 60_000;

const runner = ViewPlugin.fromClass(
  class {
    private refetchTimer: ReturnType<typeof setTimeout> | null = null;
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private failures = 0;
    /** One git status read at a time, so a daemon that is down is asked on
     *  the retry clock, never in a loop. */
    private awaitingStatus = false;
    private readonly offGit: () => void;
    private readonly offVault: () => void;
    private destroyed = false;
    private readonly onScroll = () => closeBlameHover(this.view);

    constructor(readonly view: EditorView) {
      const vaultId = view.state.facet(featureContext)?.vaultId;
      this.offGit = useGitStatusStore.subscribe((s, prev) => {
        if (!vaultId) return;
        const a = s.byVault[vaultId];
        const b = prev.byVault[vaultId];
        if (a !== b && (!b || a?.head !== b.head || a?.repo !== b.repo)) this.kick();
      });
      this.offVault = useVaultStore.subscribe((s, prev) => {
        if (s.endpoint !== prev.endpoint || s.isRemote !== prev.isRemote || s.activeVaultId !== prev.activeVaultId) this.kick();
      });
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      this.kick();
    }

    update(u: ViewUpdate) {
      // A save, or disk taken in while clean: the version moved, ask again.
      if (u.startState.field(savedDocField, false) !== u.state.field(savedDocField, false)) this.refetchSoon();
      if (u.docChanged) {
        closeBlameHover(this.view);
        if (u.state.field(blameField).stale) this.settleSoon();
      }
      if (u.focusChanged && u.view.hasFocus) {
        const v = u.state.field(blameField);
        if (v.status === "ready" && Date.now() - v.derivedAt > AGE_REFRESH_MS) this.dispatchSoon(rederive.of({ force: true }));
      }
    }

    private dispatchSoon(effects: StateEffect<unknown>) {
      queueMicrotask(() => {
        if (!this.destroyed) this.view.dispatch({ effects });
      });
    }

    private refetchSoon() {
      if (this.refetchTimer) clearTimeout(this.refetchTimer);
      this.refetchTimer = setTimeout(() => {
        this.refetchTimer = null;
        this.kick(true);
      }, REFETCH_MS);
    }

    private settleSoon() {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        if (!this.destroyed && this.view.state.field(blameField).stale) this.view.dispatch({ effects: rederive.of({ force: false }) });
      }, SETTLE_MS);
    }

    /** A failure that may pass: say so, and ask again on a backing-off clock. */
    private failSoftly(key: string | null, reason: string) {
      this.dispatchSoon(setUnavailable.of({ key, reason, transient: true }));
      if (this.retryTimer) clearTimeout(this.retryTimer);
      const delay = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** this.failures++);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.kick(true);
      }, delay);
    }

    /** Fetch for the file's current version unless the field already holds it. */
    kick(fresh = false) {
      const ctx = this.view.state.facet(featureContext);
      if (!ctx || this.destroyed) return;
      const avail = blameAvailability(ctx.vaultId);
      if (avail.ok === "pending") {
        if (this.awaitingStatus) return;
        this.awaitingStatus = true;
        // A status read that fails resolves empty: the daemon is away. The
        // git status subscription kicks when a status does arrive.
        const failed = () => {
          this.awaitingStatus = false;
          if (!this.destroyed) this.failSoftly(null, NOT_CONNECTED);
        };
        void ensureGitStatus(ctx.vaultId).then((st) => {
          if (!st) return failed();
          this.awaitingStatus = false;
          this.kick(fresh);
        }, failed);
        return;
      }
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      if (avail.ok === false) {
        const v = this.view.state.field(blameField);
        if (v.status !== "unavailable" || v.reason !== avail.reason) this.dispatchSoon(setUnavailable.of({ key: null, reason: avail.reason }));
        return;
      }
      const etag = codeBuffers.get(bufferKey(ctx.vaultId, ctx.path))?.baseEtag ?? "";
      const head = useGitStatusStore.getState().byVault[ctx.vaultId]?.head ?? null;
      const key = blameKey(ctx.vaultId, ctx.path, etag, head);
      const v = this.view.state.field(blameField);
      if (v.key === key && (v.status === "ready" || v.status === "loading") && !fresh) return;
      if (fresh) forgetBlame(key);
      if (v.key !== key || v.status !== "ready") this.dispatchSoon(setLoading.of(key));
      loadBlame(key, ctx.vaultId, ctx.path).then(
        (res) => void this.land(key, res),
        (e: unknown) => {
          if (!this.current(key)) return;
          const { reason, transient } = blameFailure(e);
          if (transient) this.failSoftly(null, reason);
          else this.dispatchSoon(setUnavailable.of({ key, reason }));
        },
      );
    }

    /** Still showing the file version `key` names. */
    private current(key: string): boolean {
      if (this.destroyed) return false;
      const ctx = this.view.state.facet(featureContext);
      if (!ctx) return false;
      const etag = codeBuffers.get(bufferKey(ctx.vaultId, ctx.path))?.baseEtag ?? "";
      const head = useGitStatusStore.getState().byVault[ctx.vaultId]?.head ?? null;
      return blameKey(ctx.vaultId, ctx.path, etag, head) === key;
    }

    private async land(key: string, res: CodeBlameResponse) {
      if (!this.current(key)) return;
      const placed = await placeOnBuffer(() => this.view.state, res.hunks).catch(() => null);
      if (!placed || !this.current(key)) return;
      this.failures = 0;
      // Synchronously after placing: the document is the one placed against.
      this.view.dispatch({ effects: setData.of({ key, hunks: res.hunks, ...placed }) });
    }

    destroy() {
      this.destroyed = true;
      if (this.refetchTimer) clearTimeout(this.refetchTimer);
      if (this.settleTimer) clearTimeout(this.settleTimer);
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.offGit();
      this.offVault();
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      closeBlameHover(this.view);
    }
  },
);

// ── gutter ──────────────────────────────────────────────────────────────────

function runAt(view: EditorView, lineFrom: number): BlameRun | null {
  const value = view.state.field(blameField, false);
  if (!value || value.status !== "ready") return null;
  return runAtLine(value.runs, view.state.doc.lineAt(lineFrom).number);
}

/** The card's target: reads the cell's box, so only when the run changes. */
function hoverTarget(view: EditorView, run: BlameRun, event: Event) {
  const cell = (event.target as HTMLElement | null)?.closest?.(".cm-gutterElement");
  if (!cell) return null;
  const r = cell.getBoundingClientRect();
  return { view, run, hue: hueOf(run.hunk, view.state.field(blameField).hues), rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
}

const blameGutter = gutter({
  class: "cm-blame-gutter",
  markers: (view) => view.state.field(blameField, false)?.markers ?? RangeSet.empty,
  domEventHandlers: {
    mousemove(view, line, event) {
      const run = runAt(view, line.from);
      if (run && hoverStays(view, run)) return false;
      const t = run && hoverTarget(view, run, event);
      if (t) hoverBlameRun(t);
      else leaveBlameHover();
      return false;
    },
    mouseleave() {
      leaveBlameHover();
      return false;
    },
    mousedown(view, line, event) {
      if ((event as MouseEvent).button !== 0) return false;
      const run = runAt(view, line.from);
      const t = run && hoverTarget(view, run, event);
      if (!t) return false;
      // The bar's primary action is the card's: the conversation, beside.
      if (!openBlameSession(t.run.hunk?.session)) pinBlameRun(t);
      else closeBlameHover();
      return true;
    },
  },
});

// ── inline blame ────────────────────────────────────────────────────────────

class InlineWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: InlineWidget) {
    return o.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-blame-inline";
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

/** The text inline blame shows for the cursor line, or null. */
export function inlineBlameText(state: EditorState, now = Date.now()): string | null {
  const value = state.field(blameField, false);
  if (!value || value.status !== "ready") return null;
  const head = state.selection.main.head;
  const origin = originAt(value.placed, value.edits, state.doc.lineAt(head).from);
  return origin ? inlineText(origin.kind, origin.hunk, now) : null;
}

function inlineDecorations(state: EditorState): DecorationSet {
  const text = inlineBlameText(state);
  if (!text) return Decoration.none;
  const line = state.doc.lineAt(state.selection.main.head);
  return Decoration.set([Decoration.widget({ widget: new InlineWidget(text), side: 1 }).range(line.to)]);
}

const inlineBlame = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = inlineDecorations(view.state);
    }
    update(u: ViewUpdate) {
      const before = u.startState.field(blameField, false);
      const after = u.state.field(blameField, false);
      const lineMoved = u.selectionSet && u.startState.doc.lineAt(u.startState.selection.main.head).number !== u.state.doc.lineAt(u.state.selection.main.head).number;
      if (u.docChanged || lineMoved || before?.status !== after?.status || before?.key !== after?.key || before?.stale !== after?.stale) {
        this.decorations = inlineDecorations(u.state);
      }
    }
  },
  { decorations: (p) => p.decorations },
);

// ── theme ───────────────────────────────────────────────────────────────────

const HATCH = "repeating-linear-gradient(-45deg, var(--blame-hue) 0 1.5px, transparent 1.5px 3.5px)";

const blameTheme = EditorView.theme({
  // A fixed column: labels truncate inside it, so nothing moves as lines
  // with longer or shorter names scroll past.
  ".cm-blame-gutter": { ...BLAME_GUTTER_COLUMN, cursor: "default" },
  ".cm-blame-gutter .cm-gutterElement": { position: "relative", overflow: "hidden", padding: "0" },
  ".cm-blame-line": { cursor: "pointer" },
  ".cm-blame-cell": {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "0 10px 0 11px",
    color: "var(--sol-text-muted)",
    whiteSpace: "nowrap",
  },
  ".cm-blame-cell::before": { content: '""', position: "absolute", left: "3px", top: "0", bottom: "0", width: "3px", background: "var(--blame-hue)" },
  ".cm-blame-start .cm-blame-cell::before": { top: "2px", borderTopLeftRadius: "1px", borderTopRightRadius: "1px" },
  ".cm-blame-cell[data-kind=commit]::before": { opacity: "0.45" },
  ".cm-blame-cell[data-kind=uncommitted]::before, .cm-blame-cell[data-kind=edited]::before": { background: HATCH, width: "4px" },
  ".cm-blame-line:hover .cm-blame-cell::before": { width: "5px", left: "2px" },
  ".cm-blame-name": { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-blame-cell[data-kind=commit] .cm-blame-name, .cm-blame-cell[data-kind=uncommitted] .cm-blame-name, .cm-blame-cell[data-kind=edited] .cm-blame-name": {
    color: "var(--sol-text-dim)",
  },
  ".cm-blame-age": { marginLeft: "auto", flexShrink: "0", color: "var(--sol-text-dim)", fontVariantNumeric: "tabular-nums" },
  ".cm-blame-inline": {
    paddingLeft: "3em",
    color: "var(--sol-text-dim)",
    opacity: "0.75",
    fontStyle: "normal",
    pointerEvents: "none",
    userSelect: "none",
    whiteSpace: "pre",
  },
});

/** The blame feature for one file. The field and runner always ride along;
 *  the gutter and inline text as the person has them. */
export function blameExtension(opts: BlameOptions): Extension {
  return [blameOptions.of(opts), blameField, runner, opts.gutter ? Prec.high(blameGutter) : [], opts.inline ? inlineBlame : [], blameTheme];
}

export function blameOptionsOf(state: EditorState): BlameOptions {
  return state.facet(blameOptions);
}
