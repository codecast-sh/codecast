import { useCallback, useMemo, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { Conversation } from "../lib/conversationRow";
import {
  useInboxStore, useTrackedStore, sessionsWakeSig, ownTeamRowsSig, isAgentActive, feedPagePersistence, isConvexId,
  type InboxSession,
} from "../store/inboxStore";
import { feedCoverMetaKey, newestTs, oldestTs, planFeedCatchup, walkStep, FEED_CATCHUP_PAGE_LIMIT, FEED_CATCHUP_MAX_PAGES } from "../lib/feedCatchup";
import { resolveSessionAuthor } from "../lib/liveEntities";
import { shouldShowSession, isWarmupSession } from "../lib/sessionFilters";
import { mergeOwnSessionsIntoTeamFeed, visibleTeamFeedRows } from "../lib/teamFeedRows";
import { useTeamFeature } from "../lib/teamFeatures";
import { useCoarseNow } from "./useCoarseNow";
import { useViewerIdentity } from "./useTeamRoster";
import { useWatchEffect } from "./useWatchEffect";

// The team feed's data, for web's ActivityFeed and the phone's Activity
// segment alike. listConversations(filter=team) unions what the team can see;
// every page lands in store.feedConversations (keyed by team+dir) and the rows
// are read back from there, so a cached feed paints at once.

// Server-side page size for listConversations (its default `limit`). A live page
// at least this long implies older pages exist.
const FEED_PAGE_SIZE = 20;

export function useTeamFeed({ directoryFilter, members }: {
  directoryFilter?: string | null;
  /** The active team's roster. Rows by anyone outside it stay out, and an
   *  unknown roster (undefined) shows nothing yet. */
  members: any[] | undefined;
}) {
  const convex = useConvex();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  // Keyed by team+dir so a team/filter switch never mixes the wrong rows.
  const key = `${activeTeamId ?? ""}|${directoryFilter ?? ""}`;
  const cached = useInboxStore((s) => s.feedConversations[key]) as Conversation[] | undefined;
  const knownHasMore = useInboxStore((s) => s.feedHasMore[key]);
  const knownCursor = useInboxStore((s) => s.feedCursors[key]);
  const mergeFeed = useInboxStore((s) => s.mergeFeedConversations);
  const setFeedHasMore = useInboxStore((s) => s.setFeedHasMore);
  const setFeedCursor = useInboxStore((s) => s.setFeedCursor);

  const queryArgs = useMemo(() => ({
    filter: "team" as const,
    include_message_previews: true,
    activeTeamId: activeTeamId || undefined,
    subagentFilter: "main" as const,
    directoryFilter: directoryFilter || undefined,
  }), [activeTeamId, directoryFilter]);

  // Live newest page (reactive). Dump every result into the store; read it back.
  // A just-created team holds an optimistic stub id until the server echoes;
  // a stub is not an Id<"teams">, so skip for that window (the new team has
  // no server rows yet anyway).
  const stubTeam = !!activeTeamId && !isConvexId(String(activeTeamId));
  const live = useQuery(api.conversations.listConversations, stubTeam ? "skip" : queryArgs);
  useWatchEffect(() => {
    if (live) mergeFeed(key, live.conversations);
  }, [live, key, mergeFeed]);

  // --- Absence-gap catch-up (lib/feedCatchup). The cache only ever grows at
  // its ends (live head + deep "Load more" cursor), so time away opens a hole
  // in the middle that no scroll can reach — the feed then shows "Today, then
  // July" and looks exhaustive while silently missing weeks. On each app run,
  // once per key: check the live page against the persisted covered watermark
  // and, if they don't connect, walk pages from the head until they do. ---
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const catchupState = useRef<Record<string, "pending" | "walking" | "contiguous">>({});
  useWatchEffect(() => {
    if (!hydrated || !live) return;
    const rows = (live.conversations ?? []) as Conversation[];
    // An empty live page is indistinguishable from an auth blip — decide
    // nothing from it (an empty team has no holes to miss).
    if (rows.length === 0) return;
    const top = newestTs(rows);
    const state = catchupState.current[key] ?? "pending";
    const stamp = () => {
      const st = useInboxStore.getState();
      const prev = st.syncMeta[feedCoverMetaKey(key)]?.cursor;
      if (top != null && (prev === undefined || top > prev)) st.recordSyncMeta(feedCoverMetaKey(key), { cursor: top });
    };
    if (state === "contiguous") {
      // The live subscription keeps the head covered while mounted — rows that
      // fall off the newest page are already cached — so every push advances
      // the watermark.
      stamp();
      return;
    }
    if (state === "walking") return;
    const coveredTo = useInboxStore.getState().syncMeta[feedCoverMetaKey(key)]?.cursor;
    const liveOldest = oldestTs(rows);
    const cachedRows = (useInboxStore.getState().feedConversations[key] ?? []) as Conversation[];
    const plan = planFeedCatchup({
      coveredTo,
      livePageFull: rows.length >= FEED_PAGE_SIZE || live.nextCursor != null,
      liveOldest,
      cacheHasRowsBelowLive: liveOldest != null && cachedRows.some((c) => (c.updated_at ?? 0) < liveOldest),
    });
    if (plan === "contiguous") {
      catchupState.current[key] = "contiguous";
      stamp();
      return;
    }
    catchupState.current[key] = "walking";
    (async () => {
      try {
        let cursor: string | null = live.nextCursor ?? null;
        let settled = cursor === null; // full page + no continuation = nothing below
        for (let hop = 0; hop < FEED_CATCHUP_MAX_PAGES && !settled && cursor !== null; hop++) {
          const page: { conversations?: unknown[]; nextCursor?: string | null } =
            await convex.query(api.conversations.listConversations, { ...queryArgs, cursor, limit: FEED_CATCHUP_PAGE_LIMIT });
          const pageRows = (page.conversations ?? []) as Conversation[];
          mergeFeed(key, pageRows);
          const step = walkStep({ coveredTo, pageOldest: oldestTs(pageRows), nextCursor: page.nextCursor ?? null });
          if (step === "abort") { catchupState.current[key] = "pending"; return; }
          if (step === "end") {
            // True end-of-history reached while filling the gap: the walk now
            // covers everything — record honest end for the scroll pagination.
            const persist = feedPagePersistence({ rowCount: pageRows.length, nextCursor: null });
            if (persist.cursor !== undefined) setFeedCursor(key, persist.cursor);
            setFeedHasMore(key, persist.hasMore);
          }
          if (step !== "continue") settled = true;
          else cursor = page.nextCursor ?? null;
        }
        if (!settled && cursor !== null) {
          // Budget spent above the covered band (giant gap, or a legacy cache
          // with no watermark): adopt the walk frontier as the new deep cursor.
          // Deeper cached rows stay visible, and scrolling re-examines
          // everything below the frontier (dupes merge), so nothing is skipped.
          setFeedCursor(key, cursor);
          setFeedHasMore(key, true);
        }
        catchupState.current[key] = "contiguous";
        stamp();
      } catch {
        catchupState.current[key] = "pending"; // transient — retry on the next live push
      }
    })();
  }, [live, key, hydrated, convex, queryArgs, mergeFeed, setFeedCursor, setFeedHasMore]);
  // Seed "older pages remain" once; afterwards loadMore maintains it. A full
  // first page (or a non-null cursor) means older pages exist; < a full page
  // means we already have everything.
  const liveHasMore = live != null && (((live.conversations?.length ?? 0) >= FEED_PAGE_SIZE) || live.nextCursor != null);
  useWatchEffect(() => {
    if (live && knownHasMore === undefined) setFeedHasMore(key, liveHasMore);
  }, [live, key, knownHasMore, liveHasMore, setFeedHasMore]);

  // Load older pages imperatively. Merges into the same accumulating store, so
  // a reload never forces a re-walk of cached pages. Two guarantees keep the
  // bottom of the feed alive:
  //   • Drain: a page can overlap rows the client already has (legacy-cursor
  //     resume, gap re-covers) — zero NEW rows renders zero new pixels, and a
  //     user parked at the bottom gets no further scroll events, so one dupe
  //     page used to read as "load more does nothing". Keep pulling (bounded)
  //     until something fresh lands or the continuation runs out.
  //   • Reconfirm: bypasses the persisted end-of-history and retries from the
  //     oldest cached row, so a latched null (auth-blip empty page, pre-fix
  //     poison) heals on the next bottom-scroll instead of stranding the feed.
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(async (opts?: { reconfirm?: boolean }) => {
    if (loadingMore) return;
    if (knownCursor === null && !opts?.reconfirm) return; // believed end-of-history
    const liveRows = (useInboxStore.getState().feedConversations[key] ?? []) as Conversation[];
    if (!liveRows.length) return;
    const oldest = liveRows[liveRows.length - 1]?.updated_at;
    const fallback = oldest != null ? String(oldest) : null;
    const start = opts?.reconfirm ? fallback : knownCursor ?? fallback;
    if (start == null) return;
    let cursor: string = start;
    setLoadingMore(true);
    try {
      const seen = new Set(liveRows.map((c) => c._id));
      for (let hop = 0; hop < 5; hop++) {
        // Bigger pages than the live query's 20: crossing a band the client
        // already has (per-member cursor re-serves) costs hops, not pixels.
        const page: { conversations?: unknown[]; nextCursor?: string | null } =
          await convex.query(api.conversations.listConversations, { ...queryArgs, cursor, limit: FEED_CATCHUP_PAGE_LIMIT });
        const rows = (page.conversations ?? []) as Conversation[];
        mergeFeed(key, rows);
        const next = page.nextCursor ?? null;
        const persist = feedPagePersistence({ rowCount: rows.length, nextCursor: next });
        if (persist.cursor !== undefined) setFeedCursor(key, persist.cursor);
        setFeedHasMore(key, persist.hasMore);
        const fresh = rows.some((c) => !seen.has(c._id));
        rows.forEach((c) => seen.add(c._id));
        if (fresh || next == null) break;
        cursor = next;
      }
    } catch {
      // Leave the cache + affordance intact; a transient failure can be retried.
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, knownCursor, convex, queryArgs, key, mergeFeed, setFeedCursor, setFeedHasMore]);

  // The cache only grows, so a row the viewer hid (from a card or the session
  // header) stays in it; the server's next page would not carry it, and
  // neither must the feed. A row of the viewer's own that was hidden stays too, and renders as
  // hidden: the feed is where they see which of their sessions the team can
  // open, and change it (FeedCard's share chip).
  const feedRows = useMemo(() => (cached ?? []).filter((c) => {
    if (c.visibility_mode === "summary" || c.visibility_mode === "minimal") return !isWarmupSession(c);
    return shouldShowSession(c, { excludeDefaultTitles: !c.is_own });
  }), [cached]);

  // The server sends only what the team can see, so the viewer's private
  // sessions for this team come from the inbox cache, which holds team_id and
  // is_private for every session of theirs. Woken by the same structural
  // signature the personal feed uses plus the sharing fields, refreshed on the
  // coarse clock for the time-driven fields, never by a heartbeat.
  const st = useTrackedStore([(x) => sessionsWakeSig(x.sessions), (x) => ownTeamRowsSig(x.sessions)]);
  const coarseNow = useCoarseNow(15_000);
  const viewer = useViewerIdentity();
  const orgEnabled = useTeamFeature("org");
  const memberIds = useMemo(() => members && new Set(members.map((m) => String(m._id))), [members]);
  const rows = useMemo(() => {
    if (!activeTeamId) return [];
    const dirLeaf = directoryFilter ? directoryFilter.split("/").filter(Boolean).pop() : null;
    return visibleTeamFeedRows(mergeOwnSessionsIntoTeamFeed({
      feedRows,
      sessions: st.sessions,
      teamId: String(activeTeamId),
      viewerId: viewer?._id,
      keep: (sess) => {
        if (sess.is_subagent) return false;
        if (dirLeaf) {
          const path = sess.git_root || sess.project_path;
          if (!path || !path.split("/").filter(Boolean).includes(dirLeaf)) return false;
        }
        return shouldShowSession(sess, { excludeDefaultTitles: false });
      },
      toConv: (sess) => {
        // A role seat the viewer hosts renders as its bot, like the server's
        // rows: the people pills key on acting_user_id, so the viewer's name
        // here would add one more chip of them per seat.
        const bot = sess.acting_user_id ? resolveSessionAuthor(sess, null, viewer, members) : null;
        return {
          ...inboxSessionToConv(sess),
          user_id: viewer?._id ?? "",
          author_name: bot ? bot.name : viewer?.name ?? viewer?.email ?? "",
          author_avatar: bot ? bot.avatar : viewer?.image ?? viewer?.github_avatar_url ?? null,
          is_private: sess.is_private ?? false,
          team_visibility: sess.team_visibility ?? null,
        };
      },
    }), memberIds, orgEnabled);
    // coarseNow: the mapped rows carry time-driven fields (duration, liveness).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedRows, st.sessions, activeTeamId, directoryFilter, viewer, coarseNow, members, memberIds, orgEnabled]);

  return {
    activeTeamId,
    stubTeam,
    rows,
    hasMore: knownCursor === null ? false : (knownHasMore ?? liveHasMore),
    loadMore,
    loadingMore,
    isLoading: memberIds === undefined || (!cached?.length && live === undefined),
  };
}

// Map an inbox session into the card shape: subtitle||idle_summary for the
// summary, derive liveness from agent_status, duration from started/updated.
export function inboxSessionToConv(s: InboxSession): Conversation {
  const started = s.started_at ?? s.updated_at;
  return {
    _id: s._id,
    user_id: "",
    acting_user_id: s.acting_user_id ?? null,
    title: s.title,
    subtitle: s.subtitle ?? s.idle_summary ?? null,
    image_preview_url: s.image_preview_url ?? null,
    project_path: s.project_path ?? null,
    git_root: s.git_root ?? null,
    git_branch: s.git_branch ?? null,
    agent_type: s.agent_type,
    message_count: s.message_count,
    started_at: started,
    updated_at: s.updated_at,
    duration_ms: Math.max(0, s.updated_at - started),
    is_active: isAgentActive(s),
    author_name: "",
    is_own: true,
    visibility_mode: "full",
  } as Conversation;
}
