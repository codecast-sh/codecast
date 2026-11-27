// A card's subagents and workers, kept out of inboxStore: the children a
// session owns under the owners model and where they are drawn (nested under
// that card in placement, the flat views and the keyboard order), the person's
// "Subagents on cards" prefs and filter, and the header counts that leave
// nested rows out. The status of each one is the store's (subagentStatusOf).
// The phone bundle reaches this file: relative imports only, and only types
// from the store, which imports this module.
import { isClosedSession, ridesParentCard, underOwnersModel } from "@codecast/shared/contracts";
import { sessionLiveAt } from "../lib/liveness";
import type { SessionStatus } from "../lib/sessionStatus";
import type { InboxSectionKey, InboxSession, PlacedInbox } from "./inboxStore";
import { inboxNestParentOf } from "./inboxNesting";

// Rows a session owns under the owners model (owner_session_id), read once
// per sessions object and viewer: the rail nests them under that session's
// card even though they are in nobody's inbox, and the team board gives them
// no card of their own. Only what the inbox read sends with the parent (its
// newest OWNED_CHILD_HORIZON children by creation, and past them up to
// ADOPTED_CHILD_CAP sessions a person dragged under it, enrichInboxSessionRow;
// the cache keeps older ones), and never a killed, closed or stashed one. A
// snoozed one is skipped where it nests (placeInboxRows), since snoozing ends
// on a clock.
const OWNED_CHILD_HORIZON = 20;
const ADOPTED_CHILD_CAP = 50;
type OwnedChildren = { list: InboxSession[]; ids: ReadonlySet<string> };
const ownedChildrenCache = new WeakMap<object, Map<string, OwnedChildren>>();
/** A row its session owns rather than the viewer (owners model): it rides
 *  that session's card, never a card of its own. The server's rule for the
 *  slim child row (shared ridesParentCard): no role took it, nobody released
 *  it, and it is none of the viewer's inbox rows (an owner seat, or a wait
 *  that reached them). */
export function isOwnedChildRow(s: InboxSession, meId: string | null | undefined): boolean {
  return ridesParentCard(s, meId);
}
export function ownedChildrenOf(sessions: Record<string, InboxSession>, meId: string | null | undefined): OwnedChildren {
  const key = meId ?? "";
  const hit = ownedChildrenCache.get(sessions)?.get(key);
  if (hit) return hit;
  const byParent = new Map<string, InboxSession[]>();
  for (const id in sessions) {
    if (!Object.hasOwn(sessions, id)) continue;
    const s = sessions[id];
    const parent = s.parent_conversation_id ? String(s.parent_conversation_id) : "";
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(s);
  }
  const list: InboxSession[] = [];
  const created = (s: InboxSession) => s.started_at ?? s.updated_at ?? 0;
  for (const [parent, kids] of byParent) {
    let sent = kids;
    if (kids.length > OWNED_CHILD_HORIZON) {
      kids.sort((a, b) => created(b) - created(a));
      const newest = kids.slice(0, OWNED_CHILD_HORIZON);
      const adopted = kids.slice(OWNED_CHILD_HORIZON).filter((s) => s.adopted_at != null)
        .sort((a, b) => (b.adopted_at ?? 0) - (a.adopted_at ?? 0)).slice(0, ADOPTED_CHILD_CAP);
      sent = adopted.length ? [...newest, ...adopted] : newest;
    }
    for (const s of sent) {
      // Only a child nested under its owner: the inbox sends those with their
      // parent; a spawned worker reaches the store only as a stale crawl row.
      if (String(s.owner_session_id ?? "") !== parent || !isOwnedChildRow(s, meId)) continue;
      if (s.inbox_killed_at || s.inbox_stashed_at || isClosedSession(s)) continue;
      list.push(s);
    }
  }
  const out = { list, ids: new Set(list.map((s) => s._id)) };
  let byViewer = ownedChildrenCache.get(sessions);
  if (!byViewer) ownedChildrenCache.set(sessions, (byViewer = new Map()));
  byViewer.set(key, out);
  return out;
}

// How a card shows its subagents. A person who had the old Subagents toggle
// on keeps their nested cards; everyone else starts folded.
export type SubagentRowsMode = "folded" | "compact" | "full" | "hidden";
type SubagentPrefs = { show_subagents?: boolean; subagent_rows?: SubagentRowsMode; subagent_filter?: SubagentFilter };
export function resolveSubagentRows(ui: SubagentPrefs | undefined): SubagentRowsMode {
  return ui?.subagent_rows ?? (ui?.show_subagents ? "full" : "folded");
}

// Subagents drawn as their own cards (Full rows): what placement, nav and the
// flat views key on.
export function resolveShowSubagents(ui: SubagentPrefs | undefined): boolean {
  return resolveSubagentRows(ui) === "full";
}

// Which of a card's subagents it shows; the working or waiting ones by default.
export type SubagentFilter = "active" | "active_done" | "all";
export function resolveSubagentFilter(ui: SubagentPrefs | undefined): SubagentFilter {
  return ui?.subagent_filter ?? "active";
}

// Which of a card's subagents and spawned workers the person's filter keeps,
// judged by each one's state (the store's subagentStatusOf), so the keyboard
// order (computeVisualOrder) keeps the rows the rail draws; the web rail and
// the phone read the same.

/** The states each filter level keeps; "all" keeps every state. */
export const SUBAGENT_FILTER_STATES: Record<Exclude<SubagentFilter, "all">, ReadonlySet<SessionStatus>> = {
  active: new Set<SessionStatus>(["needs_you", "error", "working", "starting"]),
  active_done: new Set<SessionStatus>(["needs_you", "error", "working", "starting", "done"]),
};

export function subagentPasses(status: SessionStatus, filter: SubagentFilter): boolean {
  return filter === "all" || SUBAGENT_FILTER_STATES[filter].has(status);
}

const SET_ASIDE_STATUSES = new Set<SessionStatus>(["stashed", "killed"]);

/** Whether the filter keeps a child. A stashed or killed child still reads
 *  Stashed or Killed, as its card does, but the filter judges it by its own
 *  activity, the test the bucket's "running" count uses: running, it counts
 *  as working. */
export function subagentKept(session: InboxSession, status: SessionStatus, now: number, filter: SubagentFilter): boolean {
  if (subagentPasses(status, filter)) return true;
  return SET_ASIDE_STATUSES.has(status) && subagentPasses("working", filter) && sessionLiveAt(session, now);
}

/** The section header counts under Full rows: placeInboxRows counts every
 *  nested row it placed, and Full rows draw only those `keep` passes (the
 *  filter's, the open one), so the rest come off. Web and the phone read it. */
export function fullRowsCounts(placed: Pick<PlacedInbox, "counts" | "nestedSectionOf" | "subsByParent">, keep: (s: InboxSession) => boolean): Record<InboxSectionKey, number> {
  let counts = placed.counts;
  if (placed.nestedSectionOf.size === 0) return counts;
  const subs = new Map<string, InboxSession>();
  for (const list of placed.subsByParent.values()) for (const sub of list) subs.set(sub._id, sub);
  for (const [id, k] of placed.nestedSectionOf) {
    const sub = subs.get(id);
    if (!sub || keep(sub)) continue;
    if (counts === placed.counts) counts = { ...counts };
    counts[k]--;
  }
  return counts;
}

export type SubagentRow = { session: InboxSession; status: SessionStatus };

/** The rows of a flat list (flatViewSessions) drawn under their parent's card,
 *  exactly where the list puts them: nested under a card (subsByParent) the
 *  list also holds, or hoisted under a listed parent by the nest rule
 *  (hoistNestedUnderParent), whichever section each was placed in, so a
 *  teammate pinned on its own still reads as drawn under its lead. Pass the
 *  list's own `nestWorkers`. The rest stand as cards of their own. */
export function drawnUnderParentIds(list: readonly InboxSession[], subsByParent: ReadonlyMap<string, readonly InboxSession[]>, nestWorkers = false): Set<string> {
  const present = new Set(list.map((s) => s._id));
  const out = new Set<string>();
  for (const [parent, subs] of subsByParent) if (present.has(parent)) for (const sub of subs) if (present.has(sub._id)) out.add(sub._id);
  const nestParentOf = inboxNestParentOf(list, nestWorkers);
  for (const s of list) {
    const p = nestParentOf(s);
    if (p && p !== s._id && present.has(p)) out.add(s._id);
  }
  return out;
}

/** The flat "All" header's number on web and the phone: the rows the list
 *  draws, less the children their sessions own drawn under that card
 *  (`underParent`, drawnUnderParentIds), which add to no count, as the
 *  grouped headers leave them out (placeInboxRows ownedNested). */
export function flatHeaderCount(list: readonly InboxSession[], underParent: ReadonlySet<string>, meId: string | null | undefined): number {
  let n = 0;
  for (const s of list) if (!(underParent.has(s._id) && isOwnedChildRow(s, meId))) n++;
  return n;
}

// A child its session owns (owners model) is in nobody's inbox, so the list
// holds at most the open one, at its own slot; placeInboxRows nests every one
// under its owner's card (subsByParent). Each one `keep` passes goes directly
// under that card, the open one moved there. With the card absent the open one
// keeps its own row, so it never vanishes.
export function nestOwnedChildren(list: InboxSession[], subsByParent: Map<string, InboxSession[]>, keep: (s: InboxSession) => boolean): InboxSession[] {
  const parentOf = new Map<string, string>();
  for (const [parent, subs] of subsByParent) for (const sub of subs) if (underOwnersModel(sub)) parentOf.set(sub._id, parent);
  if (parentOf.size === 0) return list;
  const present = new Set(list.map((s) => s._id));
  const kidsOf = new Map<string, InboxSession[]>();
  for (const [parent, subs] of subsByParent) {
    if (!present.has(parent)) continue;
    const kids = subs.filter((sub) => parentOf.get(sub._id) === parent && keep(sub));
    if (kids.length) kidsOf.set(parent, kids);
  }
  const out: InboxSession[] = [];
  for (const s of list) {
    const parent = parentOf.get(s._id);
    if (parent && present.has(parent)) continue;
    out.push(s);
    for (const kid of kidsOf.get(s._id) ?? []) out.push(kid);
  }
  return out;
}

// The open subagent its session owns rides that session's card (placeInboxRows
// ownedNested), so no section lists it; the flat views list it under the card
// (nestOwnedChildren). Every other order puts it right after its card, so
// Ctrl+J/K from it walks on from where it is drawn instead of the first row.
export function withOpenOwnedChild(order: InboxSession[], subsByParent: Map<string, InboxSession[]>, focusedId: string | null): InboxSession[] {
  if (!focusedId || order.some((s) => s._id === focusedId)) return order;
  const parent = cardOfNested(subsByParent, focusedId);
  const open = parent ? subsByParent.get(parent)?.find((sub) => sub._id === focusedId) : undefined;
  const at = open && underOwnersModel(open) ? order.findIndex((s) => s._id === parent) : -1;
  return at < 0 ? order : [...order.slice(0, at + 1), open!, ...order.slice(at + 1)];
}

/** The card a nested row is drawn under (PlacedInbox.subsByParent), or null. */
export function cardOfNested(subsByParent: ReadonlyMap<string, readonly InboxSession[]>, id: string): string | null {
  for (const [parent, subs] of subsByParent) if (subs.some((sub) => sub._id === id)) return parent;
  return null;
}
