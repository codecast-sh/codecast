// The undo timeline's model (docs/architecture/undo-history.md S8): the
// engine's history snapshot turned into the rows the card paints. Pure: it
// reads the snapshot, a store state (for live object titles) and a clock, and
// owns no subscription, so the card, the DEV preview and the tests all draw
// the same rows.
//
// Where the rows come from:
// - The snapshot is newest first. An entry that was undone stays where it was
//   recorded, so undone rows sit above the head and done rows below it; the
//   "now" rule goes between them. What a click walks (its count, and whether
//   it can act at all) comes from the snapshot's stack order, which a toast's
//   out-of-turn undo can make differ from history order.
// - Dropped redo branches fold into one struck line under the entry that set
//   them aside.
// - Expiry is not stored: a done entry is past ⌘Z's reach once it is older
//   than the engine's keyboard window. A generic entry stays reachable from the
//   timeline (the guard makes that safe); a manual one is closed for good.
import { DEFAULT_UNDO_KEYBOARD_WINDOW_MS, type UndoHistoryItem, type UndoHistorySnapshot } from "@platform/engine";
import type { RecentVisit } from "../store/inboxStore";
import { resolveVisit, type ResolvedVisit, type VisitResolveMemo } from "./recentVisits";
import { visitDetailParts } from "./recentVisitDetails";
import { paletteObjectPath } from "./paletteActions";
import { initiativeHref } from "./initiatives";
import { checkMilestone } from "../tips/useTips";
import { isOpen as isUndoTimelineOpen } from "./undoTimelineOpen";

// The tier lives with the open/close store so the toast notifier can read it
// without pulling the row model into the store's import graph.
export { UNDO_HISTORY_TIER } from "./undoTimelineOpen";

/** Where an org row's "Open in org record" goes: the org page with its
 *  History panel open. */
export const ORG_RECORD_PATH = "/org?panel=history";

export type UndoRowState = "done" | "undone" | "partial" | "conflict" | "refused" | "dropped" | "external";

/** What the row's one button does: walk back or forward to it, or open the
 *  org record. null = the row is inert. */
export type UndoRowAct = { kind: "back" | "forward"; steps: number } | { kind: "org" } | null;

export type UndoTimelineRow = {
  id: string;
  item: UndoHistoryItem;
  state: UndoRowState;
  label: string;
  ts: number;
  act: UndoRowAct;
  /** Done and older than the keyboard window: ⌘Z no longer reaches it. */
  expired: boolean;
  /** Seconds of keyboard reach left, in 10s steps, during the window's last minute. */
  secondsLeft: number | null;
  /** The live objects the entry changed, resolved like a recent visit. */
  visits: ResolvedVisit[];
  /** The second line, by state. */
  detail: string;
  /** A group's members behind its fold. */
  fold: { label: string; children: UndoHistoryItem[] } | null;
  /** The redo branch this entry's recording set aside, as one struck line. */
  setAside: { count: number; labels: string[] } | null;
};

export type UndoTimelineModel = {
  rows: UndoTimelineRow[];
  /** Index of the row the "now" rule sits above; rows.length = under the last row. */
  headIndex: number;
  headId: string | null;
  windowMs: number;
};

// ---------------------------------------------------------------- objects

const SESSION_STORES = new Set(["sessions", "conversations"]);
const PAGE_TYPES: Record<string, "task" | "doc" | "plan" | "project" | "trigger"> = {
  tasks: "task",
  docs: "doc",
  docDetails: "doc",
  plans: "plan",
  projects: "project",
  triggers: "trigger",
};

const rowName = (row: any): string | undefined => row?.title ?? row?.display_title ?? row?.name ?? undefined;

/**
 * One object an entry changed, as the recent-visit shape, so `resolveVisit`
 * names it live (and hides what this workspace cannot reach) and
 * `useOpenRecentVisit` opens it. null = a store with nowhere to go.
 */
export function describeUndoObject(state: any, store: string, id: string, ts = 0): RecentVisit | null {
  if (SESSION_STORES.has(store)) return { kind: "session", key: id, ts };
  if (store === "bucketAssignments") {
    const conv = state.bucketAssignments?.[id]?.conversation_id;
    return conv ? { kind: "session", key: conv, ts } : null;
  }
  if (store === "buckets") return { kind: "view", key: `label:${id}`, ts, label: state.buckets?.[id]?.name };
  const row = state[store]?.[id];
  const label = rowName(row);
  if (store === "chatChannels") return { kind: "page", key: `page:/chat/${id}`, ts, path: `/chat/${id}`, label };
  if (store === "initiatives") {
    const path = initiativeHref({ _id: id, short_id: row?.short_id });
    return { kind: "page", key: `page:${path}`, ts, path, label };
  }
  const type = PAGE_TYPES[store];
  if (!type) return null;
  const path = paletteObjectPath(type, { _id: id });
  return { kind: "page", key: `page:${path}`, ts, path, label };
}

function objectsOf(item: UndoHistoryItem): Array<{ store: string; id: string }> {
  if (item.objects?.length) return item.objects;
  return (item.children ?? []).flatMap((c) => c.objects ?? []);
}

/** The entry's objects, resolved live and deduplicated by destination. */
export function undoRowVisits(state: any, item: UndoHistoryItem, memo: VisitResolveMemo = {}): ResolvedVisit[] {
  const out: ResolvedVisit[] = [];
  const seen = new Set<string>();
  for (const { store, id } of objectsOf(item)) {
    const visit = describeUndoObject(state, store, id, item.ts);
    if (!visit || seen.has(visit.key)) continue;
    seen.add(visit.key);
    const resolved = resolveVisit(state, visit, undefined, memo);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** A cheap signature of the store facts the rows paint (each object's
 *  presence and name), so the card wakes on a rename and not on a heartbeat. */
export function undoObjectsSig(state: any, snapshot: UndoHistorySnapshot): string {
  let sig = "";
  for (const item of snapshot.items) {
    for (const { store, id } of objectsOf(item)) {
      const row = state[store]?.[id];
      sig += `${row ? rowName(row) ?? "1" : ""}|`;
    }
  }
  return sig;
}

// ---------------------------------------------------------------- words

const NOUN: Record<string, string> = {
  sessions: "session",
  conversations: "session",
  bucketAssignments: "session",
  tasks: "task",
  docs: "doc",
  plans: "plan",
  projects: "project",
  buckets: "label",
  triggers: "trigger",
};

/** A group's fold words: "5 sessions" when every member is one kind of thing. */
export function undoFoldLabel(item: UndoHistoryItem): string {
  const children = item.children ?? [];
  const objects = objectsOf(item);
  const nouns = new Set(objects.map((o) => NOUN[o.store] ?? "change"));
  const ids = new Set(objects.map((o) => `${NOUN[o.store] ?? o.store}:${o.id}`));
  if (nouns.size === 1 && ids.size > 1) {
    const noun = [...nouns][0];
    return `${ids.size} ${noun}s`;
  }
  return `${children.length} changes`;
}

/** "just now", "3m ago", "2h ago": line two's clock, read against `now`. */
export function undoAgo(ts: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** The keyboard window in words ("5 minutes"), for the copy that names ⌘Z's reach. */
export function undoWindowWords(windowMs: number): string {
  const n = windowMs < 60_000 ? Math.round(windowMs / 1000) : Math.round(windowMs / 60_000);
  return `${n} ${windowMs < 60_000 ? "second" : "minute"}${n === 1 ? "" : "s"}`;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The struck line under the entry that set a redo branch aside. */
export function undoSetAsideLine(count: number, label: string): string {
  return `${count} undone ${count === 1 ? "step" : "steps"} set aside when you ${lowerFirst(label)}`;
}

/** The button's words for a row's act. */
export function undoActLabel(act: UndoRowAct): string | null {
  if (!act) return null;
  if (act.kind === "org") return "Open in org record";
  if (act.kind === "forward") return "Forward to here";
  return act.steps > 1 ? `Back ${act.steps}` : "Back to here";
}

// ---------------------------------------------------------------- rows

function stateOf(item: UndoHistoryItem): UndoRowState {
  if (item.status === "undone" && (item.skipped?.length ?? 0) > 0) return "partial";
  return item.status;
}

function keyboardLeft(item: UndoHistoryItem, now: number, windowMs: number): number {
  return windowMs - (now - item.ts);
}

/** Seconds left in 10s steps during the window's last minute, else null. */
function secondsLeftOf(left: number): number | null {
  if (left <= 0 || left > 60_000) return null;
  return Math.ceil(left / 10_000) * 10;
}

/** The clock projection the card renders from: the minute (relative times)
 *  and each done row's expiry step. useNowWhen re-renders only when it moves. */
export function undoTimelineNowSig(snapshot: UndoHistorySnapshot, windowMs = DEFAULT_UNDO_KEYBOARD_WINDOW_MS): (now: number) => string {
  return (now) => {
    let sig = String(Math.floor(now / 60_000));
    for (const item of snapshot.items) {
      if (item.status !== "done") continue;
      const left = keyboardLeft(item, now, windowMs);
      sig += left <= 0 ? "x" : (secondsLeftOf(left) ?? "-");
    }
    return sig;
  };
}

function detailOf(row: Omit<UndoTimelineRow, "detail">, item: UndoHistoryItem, now: number, teams: any[], windowMs: number): string {
  switch (row.state) {
    case "undone":
      return `undone ${undoAgo(item.undoneAt ?? item.ts, now)}`;
    case "partial": {
      const n = item.skipped?.length ?? 0;
      return `${n} ${n === 1 ? "row" : "rows"} changed since, left as ${n === 1 ? "it is" : "they are"}`;
    }
    case "conflict":
      return "changed since, can't be taken back";
    case "refused":
      return "the server refused this change";
    case "external":
      return "org change · opens the org record";
    case "dropped":
      return "set aside by a later change";
    case "done": {
      if (row.secondsLeft !== null) return `can undo for ${row.secondsLeft}s more`;
      if (row.expired && item.mode === "manual") return "too old to take back";
      const where = row.visits[0] ? visitDetailParts(row.visits[0], teams).join(" · ") : "";
      if (!row.expired) return where;
      // Past the keyboard window: only a row that still has its button is reachable.
      const older = `older than ${undoWindowWords(windowMs)}`;
      if (where) return `${where} · ${older}`;
      return row.act ? `${older}, still reachable from here` : older;
    }
  }
}

/**
 * The rows the card paints, newest first, with the head placement and each
 * row's one act. Counts and reach come from the engine's stack order
 * (`undoOrder` / `redoOrder`), not history order: a toast's out-of-turn undo
 * followed by a redo puts an old entry on top of the stack, and an entry
 * trimmed past the stack limit stays in the history with nothing to walk to.
 */
export function undoTimelineRows(
  snapshot: UndoHistorySnapshot,
  state: any,
  now: number,
  windowMs = DEFAULT_UNDO_KEYBOARD_WINDOW_MS,
): UndoTimelineModel {
  const ids = new Set(snapshot.items.map((i) => i.id));
  // A dropped entry folds under the entry that set it aside; one whose cause
  // has left the history stands as its own inert row.
  const setAside = new Map<string, UndoHistoryItem[]>();
  const items: UndoHistoryItem[] = [];
  for (const item of snapshot.items) {
    if (item.status === "dropped" && item.droppedBy && ids.has(item.droppedBy)) {
      const list = setAside.get(item.droppedBy) ?? [];
      list.push(item);
      setAside.set(item.droppedBy, list);
    } else items.push(item);
  }

  const memo: VisitResolveMemo = {};
  const teams = state?.teams ?? [];
  const base = items.map((item) => {
    const state_ = stateOf(item);
    const left = keyboardLeft(item, now, windowMs);
    const expired = state_ === "done" && left <= 0;
    const branch = setAside.get(item.id);
    return {
      id: item.id,
      item,
      state: state_,
      label: item.label,
      ts: item.ts,
      act: null as UndoRowAct,
      expired,
      secondsLeft: state_ === "done" ? secondsLeftOf(left) : null,
      visits: state ? undoRowVisits(state, item, memo) : [],
      fold: item.children?.length ? { label: undoFoldLabel(item), children: item.children } : null,
      setAside: branch ? { count: branch.length, labels: branch.map((b) => b.label) } : null,
    };
  });

  // A row acts only while its entry is on a stack, and its count is its
  // depth there: undoTo / redoTo pop from the top until they reach it.
  const undoDepth = new Map(snapshot.undoOrder.map((id, i) => [id, i + 1]));
  const redoDepth = new Map(snapshot.redoOrder.map((id, i) => [id, i + 1]));
  // A manual entry past the window is about to be pruned from the stacks.
  const reachable = (r: (typeof base)[number]) =>
    r.item.mode !== "manual" || (r.state === "done" ? !r.expired : now - (r.item.undoneAt ?? r.ts) <= windowMs);
  for (const r of base) {
    if (r.state === "external") r.act = { kind: "org" };
    else if (!reachable(r)) continue;
    else if (undoDepth.has(r.id)) r.act = { kind: "back", steps: undoDepth.get(r.id)! };
    else if (redoDepth.has(r.id)) r.act = { kind: "forward", steps: redoDepth.get(r.id)! };
  }

  // The rule sits under the undone rows that lead the list: under the lowest
  // redo-stack row above the newest undo-stack row (any redo-stack row when
  // nothing is left to undo). A newer row on no stack (a conflict, a refusal,
  // an org change) is still applied, so with no undone row above it the rule
  // goes over it, at the top.
  const firstUndo = base.findIndex((r) => undoDepth.has(r.id));
  let lastRedo = -1;
  base.forEach((r, i) => { if (redoDepth.has(r.id) && (firstUndo === -1 || i < firstUndo)) lastRedo = i; });
  const headIndex = lastRedo + 1;

  const rows = base.map((r) => ({ ...r, detail: detailOf(r, r.item, now, teams, windowMs) }));
  return { rows, headIndex, headId: snapshot.head ?? rows[headIndex]?.id ?? null, windowMs };
}

// ---------------------------------------------------------------- fixture

/** A state the fixture's objects resolve against: sessions as conversations
 *  (no inbox scope to pass), one task, one doc. */
function fixtureState() {
  const conv = (id: string, title: string, project: string) => ({ _id: id, title, message_count: 12, agent_type: "claude_code", project_path: `/Users/you/src/${project}` });
  return {
    teams: [],
    conversations: {
      "fx-auth": conv("fx-auth", "Fix the auth race on sign-in", "codecast"),
      "fx-changes": conv("fx-changes", "Ship the changes page", "codecast"),
      "fx-billing": conv("fx-billing", "Billing migration to usage pricing", "billing"),
      "fx-a": conv("fx-a", "Triage the flaky e2e run", "codecast"),
      "fx-b": conv("fx-b", "Draft the release notes", "codecast"),
      "fx-c": conv("fx-c", "Answer the Linear sync question", "codecast"),
    },
    tasks: { "fx-task": { _id: "fx-task", short_id: "ct-4102", title: "Undo history timeline", status: "in_review", priority: "high" } },
    docs: { "fx-doc": { _id: "fx-doc", title: "Q3 plan", doc_type: "plan" } },
  };
}

/**
 * Every row state at `now`, for the DEV preview (`?preview=1`) and the tests:
 * two undone rows above the head (one partial), the head, an org row, a done
 * row in its last 40 seconds with a set-aside branch under it, a conflict, a
 * refusal, a generic row past the window and a manual one closed for good.
 */
export function undoHistoryFixture(now: number): { snapshot: UndoHistorySnapshot; state: ReturnType<typeof fixtureState> } {
  const S = 1000;
  const M = 60 * S;
  const base = { mode: "generic" as const };
  const conv = (id: string) => [{ store: "conversations", id }];
  const child = (id: string, conv_: string, ts: number): UndoHistoryItem => ({ ...base, id, label: "Filed as Done", ts, status: "undone", objects: conv(conv_) });
  const items: UndoHistoryItem[] = [
    { ...base, id: "fx-pin", label: "Pinned “Fix the auth race on sign-in”", ts: now - 50 * S, status: "undone", undoneAt: now - 10 * S, objects: conv("fx-auth") },
    {
      ...base, id: "fx-file", label: "Filed 3 sessions as Done", ts: now - 80 * S, status: "undone", undoneAt: now - 20 * S,
      skipped: [{ store: "conversations", id: "fx-a" }, { store: "conversations", id: "fx-b" }],
      children: [child("fx-file-a", "fx-a", now - 80 * S), child("fx-file-b", "fx-b", now - 80 * S), child("fx-file-c", "fx-c", now - 80 * S)],
    },
    { ...base, id: "fx-status", label: "Moved ct-4102 to In review", ts: now - 2 * M, status: "done", objects: [{ store: "tasks", id: "fx-task" }] },
    { ...base, id: "fx-org", label: "Hired a Growth lead", ts: now - 3 * M, status: "external", external: "org" },
    { ...base, id: "fx-defer", label: "Deferred “Ship the changes page”", ts: now - 4 * M - 20 * S, status: "done", objects: conv("fx-changes") },
    { ...base, id: "fx-drop-1", label: "Renamed “Ship it” to “Ship the changes page”", ts: now - 4 * M - 40 * S, status: "dropped", droppedBy: "fx-defer", objects: conv("fx-changes") },
    { ...base, id: "fx-drop-2", label: "Labeled “Ship the changes page” Review", ts: now - 4 * M - 50 * S, status: "dropped", droppedBy: "fx-defer", objects: conv("fx-changes") },
    { ...base, id: "fx-conflict", label: "Renamed “Auth race” to “Fix the auth race on sign-in”", ts: now - 6 * M, status: "conflict", objects: conv("fx-auth") },
    { ...base, id: "fx-refused", label: "Archived “Q3 plan”", ts: now - 8 * M, status: "refused", objects: [{ store: "docs", id: "fx-doc" }] },
    { ...base, id: "fx-old", label: "Stashed “Billing migration to usage pricing”", ts: now - 20 * M, status: "done", objects: conv("fx-billing") },
    { id: "fx-manual", label: "Moved 2 sessions to Billing", ts: now - 30 * M, status: "done", mode: "manual" },
  ];
  return { snapshot: undoFixtureWalk(items, "fx-status", now), state: fixtureState() };
}

/**
 * The fixture's history with the head moved to `head`, the way the engine's
 * stacks would hold it: walkable rows (done or undone, and not a manual entry
 * past the window) above the head are undone, at or below it done; the stack
 * orders follow history order. The DEV preview walks through this.
 */
export function undoFixtureWalk(
  items: readonly UndoHistoryItem[],
  head: string | null,
  now: number,
  windowMs = DEFAULT_UNDO_KEYBOARD_WINDOW_MS,
): UndoHistorySnapshot {
  const walkable = (i: UndoHistoryItem) =>
    (i.status === "done" || i.status === "undone") && !(i.mode === "manual" && now - i.ts > windowMs);
  const at = head ? items.findIndex((i) => i.id === head) : items.length;
  const walked = items.map((item, i) => {
    if (!walkable(item)) return item;
    const status: UndoHistoryItem["status"] = i < at ? "undone" : "done";
    return status === item.status ? item : { ...item, status, undoneAt: status === "undone" ? item.undoneAt ?? now : undefined };
  });
  const onStack = walked.filter(walkable);
  return {
    version: 1,
    items: walked,
    head: onStack.find((i) => i.status === "done")?.id ?? null,
    undoOrder: onStack.filter((i) => i.status === "done").map((i) => i.id),
    redoOrder: onStack.filter((i) => i.status === "undone").map((i) => i.id).reverse(),
  };
}

// ---------------------------------------------------------------- milestone

/** The milestone tip that names the timeline's chord (S9, doorway 5). The
 *  held-undo walk calls it on the second undo within 10s; checkMilestone
 *  shows it once and honours tips-off. It points at the timeline, so it
 *  stays quiet while the card is showing (or about to, `cardOpening`): it
 *  would cover the rows the card narrates, as the notifier would. */
export function fireUndoHistoryMilestone(cardOpening = false): void {
  if (cardOpening || isUndoTimelineOpen()) return;
  checkMilestone("m-undo-history");
}
