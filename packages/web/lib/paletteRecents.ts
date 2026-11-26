// The command palette's session pool: the server's recents, the scoped local
// cache and the session index, merged into one list newest first.
//
// The palette mounts on every open, but a row it has merged before comes back
// as the same object while its sources are unchanged. Session search caches
// each row's haystack by object (lib/instantSessionSearch), so stable rows
// keep that cache warm across opens instead of rebuilding tens of thousands
// of haystacks on the first key.
import { filterInboxScopeFromState } from "../store/inboxStore";
import { warmSessionSearch } from "./instantSessionSearch";
import { searchIndexOf } from "./universalSearch";

type Row = { _id: string; updated_at?: number; first_prompt?: string | null; [key: string]: any };

// A row overlaid on another, kept while both halves are the same objects.
const overlaid = new WeakMap<object, { under: object; row: Row }>();
function overlay(under: Row, over: Row): Row {
  const hit = overlaid.get(over);
  if (hit?.under === under) return hit.row;
  const row = { ...under, ...over };
  overlaid.set(over, { under, row });
  return row;
}

// A live row that learns what its session began as from the index row.
const withOrigin = new WeakMap<object, { index: object; row: Row }>();
function learnOrigin(held: Row, index: Row): Row {
  if (held.first_prompt != null || index.first_prompt == null) return held;
  const hit = withOrigin.get(held);
  if (hit?.index === index) return hit.row;
  const row = { ...held, first_prompt: index.first_prompt };
  withOrigin.set(held, { index, row });
  return row;
}

// An index row is the viewer's own session (the index holds only those).
const owned = new WeakMap<object, Row>();
function ownIndexRow(index: Row, meId: unknown): Row {
  let row = owned.get(index);
  if (!row || row.user_id !== meId) owned.set(index, (row = { ...index, user_id: meId }));
  return row;
}

// The last merge's order. The next merge starts from it, so the sort meets an
// almost sorted list (a few rows moved by a heartbeat), which TimSort orders
// in one pass instead of sorting tens of thousands of rows from scratch.
let lastSorted: Row[] = [];

type Inputs = { scoped: Record<string, Row>; index: unknown; serverRows: unknown; meId: unknown };
let lastInputs: Inputs | null = null;
// The scope filter hands back a fresh object each call, so it compares by
// its rows.
function sameInputs(a: Inputs, b: Inputs): boolean {
  if (a.index !== b.index || a.serverRows !== b.serverRows || a.meId !== b.meId) return false;
  if (a.scoped === b.scoped) return true;
  let n = 0;
  for (const id in b.scoped) { if (a.scoped[id] !== b.scoped[id]) return false; n++; }
  return n === Object.keys(a.scoped).length;
}

/** Every session the palette can offer, newest first. Workers stay in: the
 *  ranking sinks them below the sessions they serve. */
export function paletteSessionPool(state: Parameters<typeof filterInboxScopeFromState>[0] & { sessionIndex?: Record<string, Row>; currentUser?: { _id: unknown } | null }, serverRows: readonly Row[] | undefined): Row[] {
  // Scoped like the inbox panel: the store caches sessions across scopes, and
  // an unfiltered merge would resurface a previously viewed scope's rows.
  const scoped = filterInboxScopeFromState(state) as Record<string, Row>;
  const meId = state.currentUser?._id;
  // The same sources as the last merge (reopening the palette with nothing
  // new): the last pool is still the answer.
  const inputs = { scoped, index: state.sessionIndex, serverRows, meId };
  if (lastInputs && sameInputs(lastInputs, inputs)) return lastSorted;
  // Some rows moved (heartbeats, a new session, the server's recents landing,
  // an index sync): patch those rows into the last pool rather than merging
  // every source again.
  if (lastInputs && lastInputs.meId === meId) {
    const patched = patchPool(lastInputs, inputs);
    lastInputs = inputs;
    return patched;
  }
  lastInputs = inputs;
  const byId = new Map<string, Row>();
  for (const c of serverRows ?? []) byId.set(c._id, c);
  for (const s of Object.values(scoped)) {
    const server = byId.get(s._id);
    byId.set(s._id, server ? overlay(server, s) : s);
  }
  // The index (hooks/useSyncSessionIndex) reaches past the month the sessions
  // cache keeps. A row held above stays the live one and only learns what it
  // began as; the index's own rows fill in the rest.
  for (const row of Object.values(state.sessionIndex ?? {})) {
    const held = byId.get(row._id);
    byId.set(row._id, held ? learnOrigin(held, row) : ownIndexRow(row, meId));
  }
  const rows: Row[] = [];
  let changed = false;
  for (const prev of lastSorted) {
    const row = byId.get(prev._id);
    if (!row) { changed = true; continue; }
    if (row !== prev) changed = true;
    rows.push(row);
    byId.delete(prev._id);
  }
  // What is left was not in the last pool.
  for (const row of byId.values()) { rows.push(row); changed = true; }
  if (!changed) return lastSorted;
  rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  lastSorted = rows;
  return rows;
}

// The pool after some source rows changed: each id whose live, index or
// server row is a different object is merged again by the same rules (server
// row under the live one, the index's origin over it, the index row alone
// once the live one is gone) and set in place; the rest keep their objects
// and order.
function patchPool(prev: Inputs, next: Inputs): Row[] {
  const index = (next.index ?? {}) as Record<string, Row>;
  const prevIndex = (prev.index ?? {}) as Record<string, Row>;
  const serverOf = (rows: unknown) => new Map(((rows as Row[] | undefined) ?? []).map((r) => [r._id, r]));
  const server = serverOf(next.serverRows);
  const prevServer = prev.serverRows === next.serverRows ? server : serverOf(prev.serverRows);
  const changed = new Map<string, Row | undefined>();
  const rowFor = (id: string): Row | undefined => {
    const live = next.scoped[id];
    const fromServer = server.get(id);
    const held = live ? (fromServer ? overlay(fromServer, live) : live) : fromServer;
    const indexed = index[id];
    return held ? (indexed ? learnOrigin(held, indexed) : held) : indexed ? ownIndexRow(indexed, next.meId) : undefined;
  };
  const touch = (id: string) => { if (!changed.has(id)) changed.set(id, rowFor(id)); };
  if (prev.scoped !== next.scoped) {
    for (const id in next.scoped) if (prev.scoped[id] !== next.scoped[id]) touch(id);
    for (const id in prev.scoped) if (!(id in next.scoped)) touch(id);
  }
  if (prevIndex !== index) {
    for (const id in index) if (prevIndex[id] !== index[id]) touch(id);
    for (const id in prevIndex) if (!(id in index)) touch(id);
  }
  if (prevServer !== server) {
    for (const [id, row] of server) if (prevServer.get(id) !== row) touch(id);
    for (const id of prevServer.keys()) if (!server.has(id)) touch(id);
  }
  if (!changed.size) return lastSorted;
  const rows: Row[] = [];
  for (const prevRow of lastSorted) {
    if (!changed.has(prevRow._id)) { rows.push(prevRow); continue; }
    const row = changed.get(prevRow._id);
    if (row) rows.push(row);
    changed.delete(prevRow._id);
  }
  for (const row of changed.values()) if (row) rows.push(row);
  rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  lastSorted = rows;
  return rows;
}

/** Readies the palette's search while the app is idle: merges the session
 *  pool, builds each row's search entry a slice per idle period, and merges
 *  the task, doc and plan index, so the first open and the first typed key
 *  find them built. */
export function warmPaletteSearch(state: () => Parameters<typeof paletteSessionPool>[0]): () => void {
  let cancelled = false;
  let pool: Row[] | null = null;
  let at = 0;
  let entities = false;
  const step = (deadline: IdleDeadline) => {
    if (cancelled) return;
    const hasTime = () => deadline.timeRemaining() > 2;
    // The task, doc and plan index the first typed key searches.
    if (!entities) { entities = true; searchIndexOf(state() as any); if (!hasTime()) { requestIdleCallback(step, { timeout: 5000 }); return; } }
    pool ??= paletteSessionPool(state(), undefined);
    at = warmSessionSearch(pool, at, hasTime);
    if (at < pool.length) requestIdleCallback(step, { timeout: 5000 });
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(step, { timeout: 5000 });
  return () => { cancelled = true; };
}
