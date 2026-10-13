// The whole search, as every full search surface reads it (web's /search page
// and the phone's search): one query and its filters in, every kind of hit
// out. Conversations come in three tiers (the store's cached sessions on the
// first keystroke, then the server's title matches, then its message matches),
// the other objects from the local store (useObjectSearch), chat from the
// server. A surface draws these; it decides nothing about what matched.
//
// Imports stay relative and free of web-only modules: the phone bundles this.
import { useMemo, useState } from "react";
import { parseSessionQuery, sessionQuerySearches } from "@codecast/shared/search";
import { useWatchEffect } from "./useWatchEffect";
import { useRemoteSearch } from "./useRemoteSearch";
import { useObjectSearch, type ObjectGroup } from "./useObjectSearch";
import { useInstantSessionRows, mergeSearchRows, type SessionSearchRow } from "../lib/instantSessionSearch";
import { bySessionAgent, withinScope } from "../lib/assistantScope";

export type SearchRange = "all" | "7d" | "30d" | "90d";
export const SEARCH_RANGES: { key: SearchRange; label: string }[] = [
  { key: "all", label: "Any time" },
  { key: "7d", label: "Past week" },
  { key: "30d", label: "Past month" },
  { key: "90d", label: "Past 3 months" },
];
const DAY = 24 * 60 * 60 * 1000;
export const SEARCH_RANGE_MS: Record<Exclude<SearchRange, "all">, number> = { "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY };

export const SEARCH_PAGE_SIZE = 20;
/** Rows a kind lists at most; a count at the cap reads "50+". */
export const SEARCH_KIND_CAP = 50;

export type SearchFilters = {
  /** Only the viewer's own conversations. */
  mineOnly: boolean;
  /** Match only what the person wrote. */
  userOnly: boolean;
  range: SearchRange;
  sort: "recent" | "relevance";
};
export const NO_SEARCH_FILTERS: SearchFilters = { mineOnly: false, userOnly: false, range: "all", sort: "recent" };

/** How many of the filters narrow the results, for a control that counts them. */
export function activeFilterCount(f: SearchFilters): number {
  return Number(f.mineOnly) + Number(f.userOnly) + Number(f.range !== "all") + Number(f.sort !== "recent");
}

export function useUniversalSearch(query: string, filters: SearchFilters, opts: {
  /** Conversations asked of the server; a surface raises it to page. */
  limit: number;
  /** Hosted mode's Assistant scope holds. */
  scopeOnly: boolean;
  /** The team whose chat to search; none skips chat. */
  chatTeamId?: string | null;
  chatLimit?: number;
}) {
  const { mineOnly, userOnly, range, sort } = filters;
  const { limit, scopeOnly, chatTeamId, chatLimit = 10 } = opts;

  // Anchor "now" per range pick so the `since` arg is stable across renders:
  // a fresh Date.now() every render would churn the subscription.
  const sinceBase = useMemo(() => Date.now(), [range]);
  const since = range === "all" ? undefined : sinceBase - SEARCH_RANGE_MS[range];

  const remote = useRemoteSearch(query, {
    enabled: true, limit, userOnly, mineOnly, since, sort, debounceMs: 300,
    chatTeamId: scopeOnly ? null : chatTeamId, chatLimit,
  });
  const { debouncedQuery, contentData: freshData, titleData, searchError } = remote;

  // The same parser the server runs: its errors show before a round trip, and
  // its text (operators removed) is what gets marked in each hit.
  const parsedQuery = useMemo(() => parseSessionQuery(debouncedQuery), [debouncedQuery]);
  const liveQuery = useMemo(() => parseSessionQuery(query), [query]);
  const searchActive = debouncedQuery.length >= 2 && parsedQuery.errors.length === 0 && sessionQuerySearches(parsedQuery);

  // Stale-while-revalidate: keep the previous result set on screen while a new
  // query or filter loads. Skeletons only show on the very first search.
  const [lastData, setLastData] = useState<typeof freshData>(null);
  useWatchEffect(() => {
    if (freshData) setLastData(freshData);
  }, [freshData]);
  useWatchEffect(() => {
    if (!searchActive) setLastData(null);
  }, [searchActive]);
  const searchData = freshData ?? (searchActive ? lastData : null);

  const contentRows = (searchData?.results ?? []) as unknown as SessionSearchRow[];
  // Instant tier: sessions already in the store, matched off the RAW query, so
  // there are real rows before either server tier answers. "My prompts only"
  // filters by message role, which a cached row cannot judge, so the instant
  // tier stands down then, as the title tier does.
  const instantRows = useInstantSessionRows(userOnly ? "" : query, SEARCH_PAGE_SIZE, { mineOnly });
  const allSessions = useMemo(
    () => mergeSearchRows(contentRows, titleData?.results as any, instantRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchData, titleData, instantRows],
  );
  const sessionRows = useMemo(
    () => withinScope(allSessions, scopeOnly, (r) => bySessionAgent({ agent_type: r.agentType })) as SessionSearchRow[],
    [allSessions, scopeOnly],
  );

  // Every other kind, as the person types. An operator query (file:, pr:)
  // names conversations only. Time narrows objects as it narrows conversations.
  const objectQuery = query.trim().length >= 2 && liveQuery.errors.length === 0 && !liveQuery.hasFilters ? query : "";
  const allObjectGroups = useObjectSearch(objectQuery, { scopeOnly, cap: SEARCH_KIND_CAP });
  const objectGroups: ObjectGroup[] = useMemo(
    () => since == null ? allObjectGroups : allObjectGroups
      .map((g) => ({ ...g, hits: g.hits.filter((h) => h.at == null || h.at >= since) }))
      .filter((g) => g.hits.length > 0),
    [allObjectGroups, since],
  );
  const chatHits = useMemo(
    () => (since == null ? remote.chatHits : remote.chatHits.filter((h) => (h.created_at ?? 0) >= since)),
    [remote.chatHits, since],
  );

  const serverSessions = searchData?.totalSessions || 0;
  return {
    debouncedQuery,
    parsedQuery,
    /** The query is long enough and well formed: results are on their way or here. */
    searchActive,
    /** The server's content answer (the last one while a new one loads). */
    searchData,
    /** The content search timed out; name matches still show. */
    searchError,
    sessionRows,
    /** Conversations the Assistant scope left out. */
    hiddenByScope: allSessions.length - sessionRows.length,
    objectGroups,
    chatHits,
    // Instant rows match what is typed NOW; server rows the debounced term.
    // Marking against the live term lets a fresh keystroke mark its own hits.
    highlight: (query.trim().length >= 2 ? liveQuery : parsedQuery).text,
    totalMatches: searchData?.totalMatches || 0,
    totalSessions: Math.max(serverSessions, sessionRows.length),
    // Pagination is a content-search concept: title rows don't count against it.
    remaining: Math.max(0, serverSessions - contentRows.length),
    isLoading: searchActive && !searchError && (!freshData || query.trim() !== debouncedQuery.trim()),
    /** A value the parser could not read, or one the server could not resolve. */
    queryErrors: (parsedQuery.errors.length
      ? parsedQuery.errors
      : searchData && "error" in searchData && searchData.error ? [searchData.error as string] : []) as string[],
  };
}
