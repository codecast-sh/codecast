import { useCallback, useEffect } from "react";
import { useConvex, type ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { ingestChatPage } from "../lib/ingestChatPage";
import { isConvexId } from "../lib/entityLinks";
import { threadsMissingReplies } from "../lib/threadPrefetch";

// One-shot thread fetches (lib/threadPrefetch says which), shared by every
// caller: a root is asked for once at a time, and again only after its last
// answer has landed.

const inflight = new Map<string, Promise<void>>();
const queue: string[] = [];
const CONCURRENCY = 2;

function fetchThread(convex: ConvexReactClient, rootId: string): Promise<void> {
  const running = inflight.get(rootId);
  if (running) return running;
  const p = convex
    .query(api.chat.getThread, { root_id: rootId as any })
    .then((data) => { ingestChatPage(data, convex); })
    .catch(() => {})
    .finally(() => { inflight.delete(rootId); pump(convex); });
  inflight.set(rootId, p);
  return p;
}

function pump(convex: ConvexReactClient) {
  while (inflight.size < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    void fetchThread(convex, id);
  }
}

/** Fetch these threads' replies now, ahead of the queue (a finger is on the
 *  link). */
export function useOpenThreadPrefetch(): (rootId: string) => void {
  const convex = useConvex();
  return useCallback((rootId: string) => {
    if (isConvexId(rootId)) void fetchThread(convex, rootId);
  }, [convex]);
}

/** Keep the replies of these roots (newest first) in the store, so opening
 *  any of them paints the whole thread at once. A root's last reply time is
 *  part of the key, so a new reply fetches its thread again. */
export function useThreadPrefetch(roots: { id: string; lastReplyAt?: number }[]): void {
  const convex = useConvex();
  const key = roots.map((r) => `${r.id}:${r.lastReplyAt ?? 0}`).join(",");
  useEffect(() => {
    const rootIds = roots.map((r) => r.id);
    const s = useInboxStore.getState() as any;
    const missing = threadsMissingReplies(
      rootIds.filter(isConvexId),
      s.chatThreadSummaries ?? {},
      s.chatMessages ?? {},
    );
    for (const id of missing) if (!inflight.has(id) && !queue.includes(id)) queue.push(id);
    pump(convex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, key]);
}
