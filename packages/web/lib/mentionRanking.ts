import type { MentionItem } from "./mentionItem";
import type { RecentVisit } from "../store/inboxStore";
import { identityLine } from "./sessionIdentity";
import { mentionContextPosition, type MentionContext } from "./mentionContext";

// How the @-mention dropdown decides what to show first.
//
// Two different kinds of thing share one list. Sessions, tasks, docs and plans
// are a large corpus where recency genuinely predicts what someone means. The
// roster — people and labels — is small, fixed, and carries no clock at all.
// Ordering the whole list by recency therefore buries every teammate beneath
// every session, which is what "@ash" used to do to Ashot Petrosian: he ranked
// 33rd, behind everything that merely contained "ash" somewhere and had been
// touched more recently than never.
//
// So: once the reader has typed, how directly the words NAME the item leads,
// and recency only breaks ties. With nothing typed there is no naming signal,
// recency alone orders the list, and the dropdown's "recently viewed" header
// tells the truth.

export function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  const idx = l.indexOf(q);
  return idx === -1 ? Infinity : 2 + idx;
}

// Multi-word query support. A single-word query falls straight through to
// score() so existing ranking is byte-for-byte unchanged. A query with spaces
// is split into words, and EVERY word must match some word in the text (as an
// exact/prefix/substring hit), order-independent — so "plain road" finds
// "...The Roadmap, in Plain Language". Returns Infinity when any required word
// is absent, so callers drop the candidate exactly as they do for score().
/** The words of a text as every ranker splits them. */
export function textWords(lower: string): string[] {
  return lower.split(/[\s\-—,.;:/\\]+/).filter(Boolean);
}

let previousQuery: string | undefined;
let normalizedQuery = "";
let queryTokens: string[] = [];

export function matchScore(text: string, query: string): number {
  if (query !== previousQuery) {
    previousQuery = query;
    normalizedQuery = query.trim().toLowerCase();
    queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  }
  const q = normalizedQuery;
  if (!q) return 0;
  const tokens = queryTokens;
  if (tokens.length <= 1) return score(text, q);
  const lower = text.toLowerCase();
  const words = textWords(lower);
  let total = 0;
  for (const tok of tokens) {
    let best = Infinity;
    for (const w of words) {
      if (w === tok) { best = 0; break; }
      if (w.startsWith(tok)) best = Math.min(best, 1);
      else if (w.includes(tok)) best = Math.min(best, 2);
    }
    if (best === Infinity) {
      if (lower.includes(tok)) best = 3; // spans a word boundary; still a hit
      else return Infinity; // a required word is absent → not a match
    }
    total += best;
  }
  return total;
}

/**
 * How directly the typed words name this item. Lower sorts first.
 *
 * The rungs, strongest first: the item's own name starts with what was typed;
 * its handle or short id does; its name contains it further in; only a
 * secondary field does (a session's idle summary, a plan's goal, a project
 * path). A person whose NAME leads gets the top rung, because a bare word
 * after "@" usually reaches for a teammate, and a person is the one candidate
 * that can never win a recency tie — nothing stamps a clock on a teammate.
 *
 * An empty query returns the same rung for everything, so recency alone
 * orders the list.
 */
export function mentionMatchRank(item: MentionItem, query: string, personifyAll = false): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  // A personified session is named twice over: the character's name the row
  // shows and the title behind it. Whichever the reader typed leads.
  const persona = item.identity ? identityLine(item.identity, item.label, personifyAll).name : null;
  const name = Math.min(matchScore(item.label, q), persona ? matchScore(persona, q) : Infinity);
  if (name <= 1) return item.type === "person" ? 0 : 1;
  // A session is named by any part of its title, as in ⌘K: "desk" finds
  // "Broker desk v3 build" as surely as "Desk v3 Polish".
  if (item.type === "session" && name !== Infinity) return 1;
  const handle = item.handle?.toLowerCase();
  const shortId = item.shortId?.toLowerCase().replace(/^@/, "");
  if (handle?.startsWith(q) || shortId?.startsWith(q)) return 2;
  return name === Infinity ? 4 : 3;
}

export function mentionViewTimes(state: {
  recentVisits?: RecentVisit[];
  _lastViewedAt?: Record<string, number>;
}): Map<string, number> {
  const times = new Map<string, number>();
  const add = (key: string, ts: number) => times.set(key, Math.max(times.get(key) ?? 0, ts));
  for (const [id, ts] of Object.entries(state._lastViewedAt ?? {})) add(`session:${id}`, ts);
  for (const visit of state.recentVisits ?? []) {
    if (visit.kind === "session") add(`session:${visit.key}`, visit.ts);
    else if (visit.kind === "view" && visit.key.startsWith("label:")) add(visit.key, visit.ts);
    else if (visit.kind === "page") {
      const match = (visit.path ?? visit.key.replace(/^page:/, "")).match(/^\/(tasks|docs|plans)\/([^/?#]+)/);
      if (match) add(`${match[1].slice(0, -1)}:${match[2]}`, visit.ts);
    }
  }
  return times;
}

export function withMentionViewTime(item: MentionItem, times: Map<string, number>): MentionItem {
  const viewedAt = Math.max(item.viewedAt ?? 0, times.get(`${item.type}:${item.id}`) ?? 0, times.get(`${item.type}:${item.shortId}`) ?? 0);
  return item.viewedAt === viewedAt ? item : { ...item, viewedAt };
}

// Among equally named candidates, the kinds come in ⌘K's order: the session
// someone is reaching for leads the tasks, docs and plans around it.
const TYPE_ORDER = ["person", "role", "session", "task", "plan", "doc"];
const typeOrder = (type: string) => {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
};

export function compareMentionRecency(a: MentionItem, b: MentionItem): number {
  return (b.viewedAt ?? 0) - (a.viewedAt ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

/** Keep the first row per title (rows arrive best-first), so one name minted
 *  many times (a workflow task re-filed every run, a worker spawned per round)
 *  reads as one row. A row with no title key is always kept. */
export function collapseSameTitle<T>(rows: Iterable<T>, keyOf: (row: T) => string | null | undefined, cap = Infinity): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row)?.trim().toLowerCase();
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(row);
    if (out.length >= cap) break;
  }
  return out;
}

// Something this conversation already names outranks a stranger that matches
// the typed words equally well, and even one rung better: a session the thread
// cites whose title starts with the query leads a teammate whose name does.
// It never climbs past a stronger rung than that, so a summary-only hit on a
// cited session still sits below a name hit on anything.
const CONTEXT_LIFT = 1.5;

export function mergeMentionSuggestions(local: MentionItem[], remote: MentionItem[], times: Map<string, number>, perTypeLimit = Infinity, query = "", personifyAll = false, context?: MentionContext): MentionItem[] {
  const byId = new Map<string, MentionItem>();
  for (const item of [...local, ...remote]) {
    const key = `${item.type}:${item.id}`;
    if (byId.has(key)) continue;
    const timed = withMentionViewTime(item, times);
    const contextAt = mentionContextPosition(item, context);
    byId.set(key, contextAt ? { ...timed, contextAt } : timed);
  }
  const ranked = [...byId.values()];
  const hasQuery = query.trim().length > 0;
  const ranks = hasQuery ? new Map<MentionItem, number>() : null;
  if (ranks) for (const item of ranked) ranks.set(item, mentionMatchRank(item, query, personifyAll) - (item.contextAt ? CONTEXT_LIFT : 0));
  const counts = new Map<string, number>();
  const sorted = ranked
    .sort((a, b) => (ranks ? ranks.get(a)! - ranks.get(b)! : Number(Boolean(b.contextAt)) - Number(Boolean(a.contextAt))) || (b.contextAt ?? 0) - (a.contextAt ?? 0)
      || (hasQuery ? typeOrder(a.type) - typeOrder(b.type) : 0) || compareMentionRecency(a, b));
  // Workers spawned round after round share their brief's title: offer the
  // freshest one, not a page of copies.
  return collapseSameTitle(sorted, (item) => (item.worker ? `worker:${item.label}` : null))
    .filter((item) => {
      const count = counts.get(item.type) ?? 0;
      counts.set(item.type, count + 1);
      return count < perTypeLimit;
    });
}

// The popup reads as sections: what this conversation already names, then one
// section per kind. Sections come in the order their best item ranked, and
// each keeps the ranked order inside it, so the top hit is still the first
// row and the keyboard walks the list exactly as it is drawn. Callers hand
// the popup the flattened order (orderMentionItems) so an index means the same
// row to both.
const GROUP_TITLES: Record<string, string> = {
  person: "People", role: "Roles", session: "Sessions", task: "Tasks", doc: "Docs",
  plan: "Plans", label: "Labels", file: "Files", skill: "Commands", channel: "Channels", date: "Dates",
};

export type MentionGroup<T> = { key: string; title: string; items: T[] };

export function groupMentionItems<T extends { type: string; contextAt?: number }>(items: T[], contextTitle = "Mentioned here"): MentionGroup<T>[] {
  const groups = new Map<string, MentionGroup<T>>();
  for (const item of items) {
    const key = item.contextAt ? "context" : item.type;
    let group = groups.get(key);
    if (!group) {
      group = { key, title: key === "context" ? contextTitle : GROUP_TITLES[item.type] ?? item.type, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

export function orderMentionItems<T extends { type: string; contextAt?: number }>(items: T[]): T[] {
  return groupMentionItems(items).flatMap((g) => g.items);
}
