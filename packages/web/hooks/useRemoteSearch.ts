// The server tier of every search surface (web's Cmd-K palette, the phone's
// search): after a short pause in typing, session content and title matches
// and chat message hits. It lands on top of the instant local tier
// (lib/universalSearch, lib/instantSessionSearch), never instead of it.
//
// Non-throwing: a broad term can blow the backend's query budget and return a
// terminal error; a bare useQuery re-throws that in render and unmounts the
// surface (ct-37627). The breaker unsubscribes a never-resolving search so its
// silent retry loop stops flapping the shared websocket (1011).

import { useMemo, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { parseSessionQuery, sessionQuerySearches } from "@codecast/shared/search";
import { rememberedResult, useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";
import { mergeSearchRows } from "../lib/instantSessionSearch";
import { useInboxStore } from "../store/inboxStore";

export function useRemoteSearch(query: string, opts: {
  enabled: boolean;
  /** The team whose chat to search; chat is skipped without one. */
  chatTeamId?: string | null;
  limit?: number;
  chatLimit?: number;
  /** Match only what the person wrote. Title rows have no author, so the
   *  title tier stands down. */
  userOnly?: boolean;
  /** Only the viewer's own sessions. */
  mineOnly?: boolean;
  /** Sessions active since this time. */
  since?: number;
  sort?: "recent" | "relevance";
  /** The team whose sessions to search; unset searches the active team (or
   *  the personal workspace when none is active). */
  activeTeamId?: string | null;
  /** Every team the viewer belongs to; each row carries its team. */
  allTeams?: boolean;
  debounceMs?: number;
}) {
  const { enabled, chatTeamId, limit = 10, chatLimit = 5, userOnly, mineOnly, since, sort, allTeams, debounceMs = 250 } = opts;
  // One workspace per search: the named team, else the one the viewer is in.
  const workspaceTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const teamId = allTeams ? null : (opts.activeTeamId ?? workspaceTeamId ?? null);
  const filters = { ...(mineOnly ? { mineOnly } : {}), ...(since ? { since } : {}), ...(teamId ? { activeTeamId: teamId as any } : {}), ...(allTeams ? { allTeams } : {}) };
  const contentArgs = (q: string) => ({ query: q, limit, ...filters, ...(userOnly ? { userOnly } : {}), ...(sort && sort !== "recent" ? { sort } : {}) });
  const titleArgs = (q: string) => ({ query: q, limit, ...filters });

  // A query answered before skips the pause: its remembered rows paint at
  // once and the live subscription refreshes them.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useWatchEffect(() => {
    if (!enabled) { setDebouncedQuery(""); return; }
    if (rememberedResult(api.conversations.searchConversations, contentArgs(query))) { setDebouncedQuery(query); return; }
    const timer = setTimeout(() => setDebouncedQuery(query), debounceMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, enabled, debounceMs]);

  // A lone operator being typed (`pr:`) searches nothing; its completions answer instead.
  const sessionSearchOn = useMemo(
    () => debouncedQuery.length >= 2 && sessionQuerySearches(parseSessionQuery(debouncedQuery)),
    [debouncedQuery],
  );
  const on = enabled && sessionSearchOn;
  const { data: contentResults, error: searchError } = useQueryNoThrow(
    api.conversations.searchConversations,
    on ? contentArgs(debouncedQuery) : "skip",
    { breakAfterMs: 15_000, remember: true },
  );
  // Cheap always-fast companion: title/subtitle/summary matches land while (or
  // even if never) the message content search resolves.
  const { data: titleResults } = useQueryNoThrow(
    api.conversations.searchConversationTitles,
    on && !userOnly ? titleArgs(debouncedQuery) : "skip",
    { remember: true },
  );
  const contentData = contentResults && "results" in contentResults ? contentResults : null;
  const titleData = titleResults && "results" in titleResults ? titleResults : null;
  const searchRows = useMemo(
    () => mergeSearchRows(contentData?.results as any, titleData?.results as any),
    [contentData, titleData],
  );
  const titlesLoaded = titleData != null || (on && !!userOnly);
  const contentLoaded = contentData != null;
  const searchAwaiting = query.trim().length >= 2 && searchRows.length === 0 && !(titlesLoaded && (contentLoaded || !!searchError));

  // Chat hits: the server re-checks room membership per hit, so private rooms never leak.
  const { data: chatSearchData } = useQueryNoThrow(
    api.chat.searchMessages,
    enabled && chatTeamId && debouncedQuery.length >= 2 ? { team_id: chatTeamId as any, q: debouncedQuery, limit: chatLimit } : "skip",
    { breakAfterMs: 15_000, remember: true },
  );
  const chatHits = (chatSearchData?.results ?? []) as any[];

  return { debouncedQuery, sessionSearchOn, searchRows, searchError, contentData, titleData, contentLoaded, titlesLoaded, searchAwaiting, chatHits };
}
