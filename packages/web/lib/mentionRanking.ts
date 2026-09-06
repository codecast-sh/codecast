import type { MentionItem } from "../components/editor/MentionList";
import type { RecentVisit } from "../store/inboxStore";

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

export function mergeMentionSuggestions(local: MentionItem[], remote: MentionItem[], times: Map<string, number>, perTypeLimit = Infinity): MentionItem[] {
  const byId = new Map<string, MentionItem>();
  for (const item of [...local, ...remote]) {
    const key = `${item.type}:${item.id}`;
    if (!byId.has(key)) byId.set(key, withMentionViewTime(item, times));
  }
  const counts = new Map<string, number>();
  return [...byId.values()].sort(compareMentionRecency).filter((item) => {
    const count = counts.get(item.type) ?? 0;
    counts.set(item.type, count + 1);
    return count < perTypeLimit;
  });
}
