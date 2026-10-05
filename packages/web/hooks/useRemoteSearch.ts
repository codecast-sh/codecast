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
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";
import { mergeSearchRows } from "../lib/instantSessionSearch";

export function useRemoteSearch(query: string, opts: {
  enabled: boolean;
  /** The team whose chat to search; chat is skipped without one. */
  chatTeamId?: string | null;
  limit?: number;
  chatLimit?: number;
  userOnly?: boolean;
}) {
  const { enabled, chatTeamId, limit = 10, chatLimit = 5, userOnly } = opts;
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useWatchEffect(() => {
    if (!enabled) { setDebouncedQuery(""); return; }
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query, enabled]);

  // A lone operator being typed (`pr:`) searches nothing; its completions answer instead.
  const sessionSearchOn = useMemo(
    () => debouncedQuery.length >= 2 && sessionQuerySearches(parseSessionQuery(debouncedQuery)),
    [debouncedQuery],
  );
  const args = enabled && sessionSearchOn ? { query: debouncedQuery, limit, ...(userOnly ? { userOnly } : {}) } : "skip";
  const { data: contentResults, error: searchError } = useQueryNoThrow(api.conversations.searchConversations, args as any, { breakAfterMs: 15_000 });
  // Cheap always-fast companion: title/subtitle/summary matches land while (or
  // even if never) the message content search resolves.
  const { data: titleResults } = useQueryNoThrow(api.conversations.searchConversationTitles, args as any);
  const contentData = contentResults && "results" in contentResults ? contentResults : null;
  const titleData = titleResults && "results" in titleResults ? titleResults : null;
  const searchRows = useMemo(
    () => mergeSearchRows(contentData?.results as any, titleData?.results as any),
    [contentData, titleData],
  );
  const titlesLoaded = titleData != null;
  const contentLoaded = contentData != null;
  const searchAwaiting = query.trim().length >= 2 && searchRows.length === 0 && !(titlesLoaded && (contentLoaded || !!searchError));

  // Chat hits: the server re-checks room membership per hit, so private rooms never leak.
  const { data: chatSearchData } = useQueryNoThrow(
    api.chat.searchMessages,
    enabled && chatTeamId && debouncedQuery.length >= 2 ? { team_id: chatTeamId as any, q: debouncedQuery, limit: chatLimit } : "skip",
    { breakAfterMs: 15_000 },
  );
  const chatHits = (chatSearchData?.results ?? []) as any[];

  return { debouncedQuery, sessionSearchOn, searchRows, searchError, contentLoaded, titlesLoaded, searchAwaiting, chatHits };
}
