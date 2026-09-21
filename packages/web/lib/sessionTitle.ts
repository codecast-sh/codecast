// A `cast send` wire tag carries only the sender's 7-char short id (the prefix
// of its conversation's Convex id). Resolve it to the session's title from the
// shared store when that session is synced; fall back to the short id. Lives
// beside messageNavigator.ts (which must stay store-free) so web and mobile
// inject the same resolver.
import { useInboxStore } from "../store/inboxStore";
import { LRUCache } from "./lruCache";

const titlesByCollection = new WeakMap<object, LRUCache<string, string | null>>();

export function resolveSessionTitle(shortId: string): string | null {
  const s = useInboxStore.getState();
  for (const coll of [s.sessions, s.conversations] as Record<string, { title?: string }>[]) {
    let titles = titlesByCollection.get(coll);
    if (!titles) titlesByCollection.set(coll, titles = new LRUCache(512));
    const cached = titles.get(shortId);
    if (cached !== undefined) {
      if (cached !== null) return cached;
      continue;
    }
    let title: string | null = null;
    for (const key in coll) {
      if (key.startsWith(shortId) && coll[key].title) {
        title = coll[key].title!;
        break;
      }
    }
    titles.set(shortId, title);
    if (title !== null) return title;
  }
  return null;
}
