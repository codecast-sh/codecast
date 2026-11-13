// The message feed — store-fed. The newest page is a live subscription; older
// pages are one-shot fetches. Every page overlays store.messageFeed (delta),
// and the continuation cursor per filter lives in feedCursors/feedHasMore
// (the same meta the team activity feed uses), so paging resumes across a
// reload instead of re-walking from the top.
import { useCallback, useMemo, useState } from "react";
import { useConvex } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;
const PAGE = 100;

const feedKey = (filter: "my" | "team", team: string | undefined) => `msg:${filter}:${team ?? "personal"}`;
const byTimestampDesc = (a: any, b: any) => (b.timestamp ?? 0) - (a.timestamp ?? 0);
const msgSig = (m: any) => `${m.content?.length ?? 0}|${m.conversation_title ?? ""}|${m.author_name ?? ""}`;

export function useMessageFeed(filter: "my" | "team"): {
  messages: any[];
  ready: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
} {
  // The workspace the feed reads: the subscription names it, so a switch is a
  // new query, and the paging cursor is kept per workspace.
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const teamArg = activeTeamId && isConvexId(activeTeamId) ? activeTeamId : undefined;
  const key = feedKey(filter, teamArg);
  const convex = useConvex();
  const setFeedCursor = useInboxStore((s) => s.setFeedCursor);
  const setFeedHasMore = useInboxStore((s) => s.setFeedHasMore);
  // feedCursors is stringly typed (the activity feed's cursors are strings);
  // this feed's cursor is a timestamp, stored as its decimal string.
  const cursorRaw = useInboxStore((s) => s.feedCursors[key]);
  const cursor: number | null | undefined = cursorRaw === undefined ? undefined : cursorRaw === null ? null : Number(cursorRaw);
  const hasMoreStored = useInboxStore((s) => s.feedHasMore[key]);

  // Newest page, live. Its nextCursor seeds the continuation only while no
  // page has been walked yet (a live re-push must not rewind the cursor).
  const select = useCallback(
    (data: any) => {
      if (data && cursor === undefined) {
        // Written from inside select (a sync-time hook) is fine: these are
        // sync() actions, no dispatch.
        setFeedCursor(key, data.nextCursor == null ? null : String(data.nextCursor));
        setFeedHasMore(key, !!data.nextCursor);
      }
      return data?.messages ?? [];
    },
    [cursor, key, setFeedCursor, setFeedHasMore],
  );
  const { ready } = useSyncCollection("messageFeed", api.conversations.getMessageFeed, { filter, limit: PAGE, activeTeamId: teamArg }, { select });

  const rows = useWorkspaceCollection<any>("messageFeed", msgSig);
  const messages = useMemo(
    () => (filter === "my" ? rows.filter((m) => m.is_own) : rows).sort(byTimestampDesc),
    [rows, filter],
  );

  const [isLoadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(() => {
    if (isLoadingMore || cursor === null) return;
    // No stored cursor yet (cold boot from cache): continue below the oldest
    // cached row rather than re-fetching the top.
    const from = cursor ?? messages[messages.length - 1]?.timestamp;
    if (!from) return;
    setLoadingMore(true);
    void convex
      .query(api.conversations.getMessageFeed, { filter, limit: PAGE, cursor: from, activeTeamId: teamArg })
      .then((page: any) => {
        useInboxStore.getState().syncTable("messageFeed", page?.messages ?? []);
        setFeedCursor(key, page?.nextCursor == null ? null : String(page.nextCursor));
        setFeedHasMore(key, !!page?.nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [convex, cursor, filter, isLoadingMore, key, messages, setFeedCursor, setFeedHasMore, teamArg]);

  return { messages, ready, hasMore: hasMoreStored !== false && cursor !== null, isLoadingMore, loadMore };
}
