// The read side of live artifacts: store rows grouped per doc, this tab's
// preview overlay (gesture and queued writes, never stored), the merged view
// a page paints, and the read hooks. useLiveArtifact.ts owns the feeders and
// the write path and re-exports the public readers from here.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { nanoid } from "nanoid";
import { fromElement, isPresenceLive, type ArtifactElement, type ArtifactPresence, type ElementState } from "@codecast/shared/artifacts";
import { useInboxStore } from "../../store/inboxStore";
import { liveRowId, type LiveLayer } from "../../store/liveArtifactsSlice";
import { useCoarseNow } from "../../hooks/useCoarseNow";

/** One tab's id, so one person in two tabs is two cursors and never sees their own. */
export const LIVE_TAB_ID = tabId();
/** One id per browser tab, kept across reloads (sessionStorage), so a reload is the same cursor, not a second one. */
function tabId(): string {
  try {
    const held = sessionStorage.getItem("live-tab-id");
    if (held) return held;
    const id = nanoid(8);
    sessionStorage.setItem("live-tab-id", id);
    return id;
  } catch {
    return nanoid(8);
  }
}

// ── Store readers ───────────────────────────────────────────────────────────

const ROW_META = new Set(["_id", "doc_id", "layer", "deleted", "dead"]);

// One element object per row object: a row the store did not change hands
// back the same element, so a per-element React.memo holds across recomputes.
const elementOfRow = new WeakMap<object, ArtifactElement>();

/**
 * An element as an overlay state shows it: the state's own fields, whole (a
 * field the write cleared is gone, never the row's old value showing through),
 * with the row's server stamps.
 */
function overlaid(key: string, row: Record<string, any> | undefined, o: ElementState): ArtifactElement {
  return { key, rev: row?.rev ?? 0, ...(row?.by ? { by: row.by } : {}), ...(row?.at ? { at: row.at } : {}), ...(o.fields as any), kind: o.kind } as ArtifactElement;
}

/** A store row as the element a product reads. */
function rowElement(row: Record<string, any>): ArtifactElement {
  const cached = elementOfRow.get(row);
  if (cached) return cached;
  const el: Record<string, any> = {};
  for (const f in row) if (!ROW_META.has(f)) el[f] = row[f];
  elementOfRow.set(row, el as ArtifactElement);
  return el as ArtifactElement;
}

export type DocRows = { main: Map<string, any>; draft: Map<string, any>; comments: Map<string, any> };
/** Per doc with a staged write: the rows the page reads until the write is all in the store (the send queue in useLiveArtifact fills it). */
export const heldRows = new Map<string, DocRows>();
const EMPTY_ROWS: DocRows = { main: new Map(), draft: new Map(), comments: new Map() };

// Rows grouped per doc, rebuilt only when the liveElements ref changes (any
// element write anywhere), and each doc's group reused when none of its rows
// changed, so a reader re-renders only for its own doc.
let groupedFrom: Record<string, any> | null = null;
let grouped = new Map<string, DocRows>();
function rowsByDoc(coll: Record<string, any> | undefined): Map<string, DocRows> {
  if (!coll) return grouped;
  if (coll === groupedFrom) return grouped;
  const next = new Map<string, DocRows>();
  for (const id in coll) {
    const row = coll[id];
    if (!row) continue;
    let g = next.get(row.doc_id);
    if (!g) next.set(row.doc_id, (g = { main: new Map(), draft: new Map(), comments: new Map() }));
    (g[row.layer as LiveLayer] ?? g.main).set(row.key, row);
  }
  for (const [docId, g] of next) {
    const prev = grouped.get(docId);
    if (prev && sameRows(prev, g)) next.set(docId, prev);
  }
  groupedFrom = coll;
  grouped = next;
  return next;
}
function sameRows(a: DocRows, b: DocRows): boolean {
  for (const l of ["main", "draft", "comments"] as const) {
    if (a[l].size !== b[l].size) return false;
    for (const [k, r] of b[l]) if (a[l].get(k) !== r) return false;
  }
  return true;
}
export const rowsOfDoc = (coll: Record<string, any> | undefined, docId: string): DocRows => rowsByDoc(coll).get(docId) ?? EMPTY_ROWS;

export function docRows(docId: string): DocRows {
  return rowsOfDoc((useInboxStore.getState() as any).liveElements, docId);
}

function useDocRows(docId: string): DocRows {
  // While a big write is staged, the page reads the rows it had when the write began (the overlay shows the
  // write itself): the store takes the write a batch at a time, and the page redraws once, at the end.
  return useInboxStore((s: any) => heldRows.get(docId) ?? rowsOfDoc(s.liveElements, docId));
}

/** A chunked restore that stopped partway (see liveArtifacts.restore), or null. */
export function useLiveRestoring(docId: string): { to: number; from: number; by_name: string; at: number } | null {
  return useInboxStore((s: any) => s.liveHeads?.[docId]?.restoring ?? null);
}

/** The doc's pending draft, or null. */
export function useLiveDraftState(docId: string): { by: string; by_name: string; at: number; label?: string } | null {
  return useInboxStore((s: any) => s.liveHeads?.[docId]?.draft ?? null);
}

// ── Preview overlay (gesture state, per tab, never stored) ──────────────────

export type Overlay = Map<string, ElementState>;
// What the page shows over the store, per doc: writes queued behind an
// in-flight send, then this tab's open gesture on top. `overlays` is the
// published merge of the two.
export const overlays = new Map<string, Overlay>();
export const gestureOverlays = new Map<string, Overlay>();
export const queuedOverlays = new Map<string, Overlay>();
// Comment writes queued behind a send: their own map, since a comment key is read from the comments layer.
export const queuedComments = new Map<string, Overlay>();
const overlayListeners = new Map<string, Set<() => void>>();
export function publishOverlay(docId: string) {
  const queued = queuedOverlays.get(docId);
  const gesture = gestureOverlays.get(docId);
  overlays.set(docId, !queued?.size ? gesture ?? new Map() : !gesture?.size ? queued : new Map([...queued, ...gesture]));
  for (const fn of overlayListeners.get(docId) ?? []) fn();
}
export function setOverlay(docId: string, next: Overlay) {
  gestureOverlays.set(docId, next);
  publishOverlay(docId);
}
function subscribeOverlay(docId: string, fn: () => void) {
  let set = overlayListeners.get(docId);
  if (!set) overlayListeners.set(docId, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}
export const EMPTY_OVERLAY: Overlay = new Map();
function useOverlay(docId: string, layer: "page" | "comments" = "page"): Overlay {
  const from = layer === "comments" ? queuedComments : overlays;
  return useSyncExternalStore(
    useCallback((fn) => subscribeOverlay(docId, fn), [docId]),
    () => from.get(docId) ?? EMPTY_OVERLAY,
    () => EMPTY_OVERLAY,
  );
}

// ── Merged view ─────────────────────────────────────────────────────────────

export type LiveReadLayer = "merged" | "main" | "draft" | "comments";

/** The visible state of one key: the gesture overlay, then the draft (when one is open), then main. */
export function visibleState(rows: DocRows, overlay: Overlay, key: string, draftOpen: boolean): ElementState | undefined {
  const o = overlay.get(key);
  if (o) return o;
  const d = draftOpen ? rows.draft.get(key) : undefined;
  if (d) return fromElement(d);
  const m = rows.main.get(key);
  return m ? fromElement(m) : undefined;
}

function mergedElements(rows: DocRows, overlay: Overlay, draftOpen: boolean): ArtifactElement[] {
  const out: ArtifactElement[] = [];
  const seen = new Set<string>();
  const take = (key: string, row: any | undefined) => {
    if (seen.has(key)) return;
    seen.add(key);
    const o = overlay.get(key);
    if (o) {
      if (!o.deleted) out.push(overlaid(key, row, o));
      return;
    }
    if (row && !row.deleted) out.push(rowElement(row));
  };
  if (draftOpen) for (const [k, r] of rows.draft) take(k, r);
  for (const [k, r] of rows.main) take(k, r);
  for (const k of overlay.keys()) if (!seen.has(k)) take(k, undefined);
  return out;
}

/**
 * The doc's elements. "merged" (default) is what the page shows: main with
 * the open draft and this tab's gesture laid over it.
 */
export function useLiveElements(docId: string, opts: { kinds?: readonly string[]; layer?: LiveReadLayer } = {}): ArtifactElement[] {
  const rows = useDocRows(docId);
  const overlay = useOverlay(docId);
  const commentsQueued = useOverlay(docId, "comments");
  const draftOpen = !!useLiveDraftState(docId);
  const layer = opts.layer ?? "merged";
  const kindsKey = opts.kinds?.join(",") ?? "";
  return useMemo(() => {
    let els: ArtifactElement[];
    if (layer === "merged") els = mergedElements(rows, overlay, draftOpen);
    else if (layer === "comments" && commentsQueued.size) els = layerElements(rows.comments, commentsQueued);
    else els = [...rows[layer].values()].filter((r) => !r.deleted).map(rowElement);
    if (!kindsKey) return els;
    const kinds = new Set(kindsKey.split(","));
    return els.filter((e) => kinds.has(e.kind));
  }, [rows, overlay, commentsQueued, draftOpen, layer, kindsKey]);
}

/** One layer's rows with queued writes laid over them. */
export function layerElements(layerRows: Map<string, any>, overlay: Overlay): ArtifactElement[] {
  const out: ArtifactElement[] = [];
  for (const [k, r] of layerRows) {
    const o = overlay.get(k);
    if (!o) { if (!r.deleted) out.push(rowElement(r)); continue; }
    if (!o.deleted) out.push(overlaid(k, r, o));
  }
  for (const [k, o] of overlay) if (!layerRows.has(k) && !o.deleted) out.push(overlaid(k, undefined, o));
  return out;
}

/** One element as the page shows it. */
export function useLiveElement(docId: string, key: string): ArtifactElement | undefined {
  const draftOpen = !!useLiveDraftState(docId);
  const row = useInboxStore((s: any) => {
    const coll = s.liveElements;
    return (draftOpen ? coll?.[liveRowId(docId, "draft", key)] : undefined) ?? coll?.[liveRowId(docId, "main", key)];
  });
  const o = useOverlay(docId).get(key);
  return useMemo(() => {
    if (o) return o.deleted ? undefined : overlaid(key, row, o);
    return row && !row.deleted ? rowElement(row) : undefined;
  }, [row, o, key]);
}

/** Everyone else in the artifact now (other tabs and agent sessions). */
export function useLivePresence(docId: string): ArtifactPresence[] {
  const now = useCoarseNow(5_000);
  const rows = useInboxStore((s: any) => s.livePresence);
  return useMemo(() => {
    const out: ArtifactPresence[] = [];
    const mine = `:${LIVE_TAB_ID}`;
    for (const id in rows ?? {}) {
      const p = rows[id];
      if (p?.doc_id !== docId || p.actor.endsWith(mine) || !isPresenceLive(p, now)) continue;
      out.push(p);
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "agent" ? 1 : -1));
  }, [rows, docId, now]);
}

export type LiveVersion = { _id: string; rev: number; label: string; reason: string; by: string; by_name: string; at: number; elements?: number };

export function useLiveVersions(docId: string): LiveVersion[] {
  // Wakes on this doc's versions only, never another doc's.
  const sig = useInboxStore((s: any) => {
    let out = "";
    for (const id in s.liveVersions ?? {}) { const r = s.liveVersions[id]; if (r?.doc_id === docId) out += `${id}:${r.label}:${r.at};`; }
    return out;
  });
  return useMemo(() => {
    const rows = (useInboxStore.getState() as any).liveVersions;
    const stubs = new Map<number, LiveVersion>();
    for (const id in rows ?? {}) if (rows[id]?.doc_id === docId && rows[id].stub) stubs.set(rows[id].rev, rows[id]);
    // A stub (a version just saved here) stands until the server's row for its revision arrives;
    // a save that renames the row already at this revision shows the new name until the echo carries it.
    const out: LiveVersion[] = [];
    const now = Date.now();
    for (const id in rows ?? {}) {
      const r = rows[id];
      if (r?.doc_id !== docId || r.stub) continue;
      const stub = stubs.get(r.rev);
      stubs.delete(r.rev);
      out.push(stub && stub.label !== r.label && now - stub.at < 60_000 ? { ...r, label: stub.label } : r);
    }
    out.push(...stubs.values());
    return out.sort((a, b) => b.rev - a.rev || b.at - a.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig is this doc's rows
  }, [sig, docId]);
}

/** Comment pins: the comments layer, roots and replies. */
export function useLiveComments(docId: string): ArtifactElement[] {
  return useLiveElements(docId, { layer: "comments" });
}
