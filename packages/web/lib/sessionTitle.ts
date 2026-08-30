// A `cast send` wire tag carries only the sender's 7-char short id (the prefix
// of its conversation's Convex id). Resolve it to the session's title from the
// shared store when that session is synced; fall back to the short id. Lives
// beside messageNavigator.ts (which must stay store-free) so web and mobile
// inject the same resolver.
import { useInboxStore } from "../store/inboxStore";

export function resolveSessionTitle(shortId: string): string | null {
  const s = useInboxStore.getState();
  for (const coll of [s.sessions, s.conversations] as Record<string, { title?: string }>[]) {
    for (const key in coll) {
      if (key.startsWith(shortId) && coll[key].title) return coll[key].title!;
    }
  }
  return null;
}
