import type { MentionItem } from "../components/editor/MentionList";
import type { RecentVisit } from "../store/inboxStore";

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
export function matchScore(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return score(text, q);
  const lower = text.toLowerCase();
  const words = lower.split(/[\s\-—,.;:/\\]+/).filter(Boolean);
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
export function mentionMatchRank(item: MentionItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = matchScore(item.label, q);
  if (name <= 1) return item.type === "person" ? 0 : 1;
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
  return {
    ...item,
    viewedAt: Math.max(item.viewedAt ?? 0, times.get(`${item.type}:${item.id}`) ?? 0, times.get(`${item.type}:${item.shortId}`) ?? 0),
  };
}

export function compareMentionRecency(a: MentionItem, b: MentionItem): number {
  return (b.viewedAt ?? 0) - (a.viewedAt ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

export function mergeMentionSuggestions(local: MentionItem[], remote: MentionItem[], times: Map<string, number>, perTypeLimit = Infinity, query = ""): MentionItem[] {
  const byId = new Map<string, MentionItem>();
  for (const item of [...local, ...remote]) {
    const key = `${item.type}:${item.id}`;
    if (!byId.has(key)) byId.set(key, withMentionViewTime(item, times));
  }
  const ranked = [...byId.values()];
  const ranks = new Map<MentionItem, number>();
  for (const item of ranked) ranks.set(item, mentionMatchRank(item, query));
  const counts = new Map<string, number>();
  return ranked
    .sort((a, b) => ranks.get(a)! - ranks.get(b)! || compareMentionRecency(a, b))
    .filter((item) => {
      const count = counts.get(item.type) ?? 0;
      counts.set(item.type, count + 1);
      return count < perTypeLimit;
    });
}
