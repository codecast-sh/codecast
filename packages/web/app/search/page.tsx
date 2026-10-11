import { useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useDebounce } from "../../hooks/useDebounce";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import Link from "next/link";
import { KeyCap } from "../../components/KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";
import {
  Search,
  Loader2,
  CornerDownLeft,
  MessageSquare,
  FolderGit2,
  Sparkles,
  ExternalLink,
  Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator } from "../../components/ui/context-menu";
import { SessionMenuItems } from "../../components/menus/ObjectContextMenus";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { highlightMatch, getSnippet, stripSnippetMarkup } from "../../lib/searchHighlight";
import { ObjectMatches } from "../../components/search/ObjectMatches";
import { SearchOrigin } from "../../components/search/SearchOrigin";
import { searchedTermsText } from "@codecast/shared/search";
import { useInstantSessionRows, mergeSearchRows } from "../../lib/instantSessionSearch";
import { copyToClipboard, shareOrigin } from "../../lib/utils";
import { SessionGlyph } from "../../components/identity";
import { formatSearchTimestamp } from "../../lib/searchTimestamp";
import { parseSessionQuery, sessionQuerySearches, SESSION_QUERY_OPERATORS } from "@codecast/shared/search";
import { useSessionQueryAutocomplete } from "../../hooks/useSessionQuerySuggestions";
import { SessionQuerySuggestList } from "../../components/SessionQuerySuggestList";
import { FeatureUpsell } from "../../components/agentFeatures/FeatureUpsell";
import { useAssistantScope, useModeWords, useSurface } from "../../lib/surfaces";
import { bySessionAgent, withinScope } from "../../lib/assistantScope";
import { AssistantScopeSwitch, MoreInEverything } from "../../components/AssistantScopeSwitch";

// Right-click payloads: a session header row or one message match inside it.
type SearchCtxPayload =
  | { kind: "session"; result: any; session: InboxSession; isForeign: boolean }
  | { kind: "message"; result: any; messageId: string };

function projectName(p?: string | null): string | null {
  if (!p) return null;
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

const PAGE_SIZE = 20;

type RangeKey = "all" | "7d" | "30d" | "90d";
/** The time filter's words in hosted mode. */
const HOSTED_RANGES: { value: RangeKey; label: string }[] = [
  { value: "all", label: "Any time" },
  { value: "7d", label: "Past week" },
  { value: "30d", label: "Past month" },
  { value: "90d", label: "Past 3 months" },
];
const RANGE_MS: Record<Exclude<RangeKey, "all">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  plain = false,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  /** Hosted mode: the label in sentence case and the UI face, not a tracked cap. */
  plain?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={plain ? "text-[12px] text-sol-text-muted" : "text-[10px] font-semibold uppercase tracking-widest text-sol-text-dim/70"}>
        {label}
      </span>
      <div className="flex rounded-lg border border-sol-border/60 bg-sol-bg-alt/60 p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
              value === o.value
                ? "bg-sol-bg-highlight text-sol-text shadow-sm"
                : "text-sol-text-dim hover:text-sol-text-secondary"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="bg-sol-bg-alt border border-sol-border rounded-xl overflow-hidden animate-pulse"
          style={{ animationDelay: `${i * 120}ms` }}
        >
          <div className="px-4 py-3 border-b border-sol-border flex items-center gap-3">
            <div className="w-5 h-5 rounded-full bg-sol-bg-highlight" />
            <div className="h-4 bg-sol-bg-highlight rounded w-1/3" />
            <div className="ml-auto h-3 bg-sol-bg-highlight rounded w-16" />
          </div>
          <div className="px-4 py-3 space-y-2">
            <div className="h-3 bg-sol-bg-highlight rounded w-5/6" />
            <div className="h-3 bg-sol-bg-highlight rounded w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SearchPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [mineOnly, setMineOnly] = useState(searchParams.get("mine") === "1");
  // `userOnly=true` is the legacy param name for the same filter.
  const [userOnly, setUserOnly] = useState(
    searchParams.get("user") === "1" || searchParams.get("userOnly") === "true"
  );
  const [range, setRange] = useState<RangeKey>(
    (["7d", "30d", "90d"].includes(searchParams.get("range") || "") ? searchParams.get("range") : "all") as RangeKey
  );
  const [sort, setSort] = useState<"recent" | "relevance">(
    searchParams.get("sort") === "relevance" ? "relevance" : "recent"
  );
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  // Hosted mode searches the person's conversations in plain words: no
  // operators, no team or role scopes, and the Assistant scope holds here as
  // it does in the inbox and the palette.
  const internals = useSurface("search.internals");
  const words = useModeWords();
  const { only: scopeOnly } = useAssistantScope();
  const autocomplete = useSessionQueryAutocomplete(query, setQuery, inputRef, true);
  const resultRefs = useRef<Array<HTMLDivElement | null>>([]);
  const debouncedQuery = useDebounce(query, 300);

  useWatchEffect(() => {
    setLimit(PAGE_SIZE);
    setSelectedIdx(-1);
  }, [debouncedQuery, mineOnly, userOnly, range, sort]);

  const lastWrittenUrl = useRef<string | null>(null);
  useWatchEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    if (mineOnly) params.set("mine", "1");
    if (userOnly) params.set("user", "1");
    if (range !== "all") params.set("range", range);
    if (sort !== "recent") params.set("sort", sort);
    const url = `/search${params.toString() ? `?${params.toString()}` : ""}`;
    lastWrittenUrl.current = url;
    router.replace(url);
  }, [debouncedQuery, mineOnly, userOnly, range, sort, router]);

  // The tab shell keeps this page mounted across navigations, so a fresh
  // /search?q=… arriving from elsewhere (palette ⌘↵, a link) only changes the
  // URL — adopt it into local state unless it's our own write echoing back.
  const searchParamsKey = searchParams.toString();
  useWatchEffect(() => {
    const current = `/search${searchParamsKey ? `?${searchParamsKey}` : ""}`;
    if (lastWrittenUrl.current === current) return;
    setQuery(searchParams.get("q") || "");
    setMineOnly(searchParams.get("mine") === "1");
    setUserOnly(searchParams.get("user") === "1" || searchParams.get("userOnly") === "true");
    setRange(
      (["7d", "30d", "90d"].includes(searchParams.get("range") || "") ? searchParams.get("range") : "all") as RangeKey
    );
    setSort(searchParams.get("sort") === "relevance" ? "relevance" : "recent");
  }, [searchParamsKey]);

  // Anchor "now" per query/range pick so the `since` arg is stable across
  // renders — a fresh Date.now() every render would churn the subscription.
  const sinceBase = useMemo(() => Date.now(), [debouncedQuery, range]);
  const since = range === "all" ? undefined : sinceBase - RANGE_MS[range];

  // The same parser the server runs: its errors show under the input before a
  // round trip, and its text (operators removed) is what gets highlighted.
  const parsedQuery = useMemo(() => parseSessionQuery(debouncedQuery), [debouncedQuery]);
  const liveQuery = useMemo(() => parseSessionQuery(query), [query]);
  const searchActive = debouncedQuery.length >= 2 && parsedQuery.errors.length === 0 && sessionQuerySearches(parsedQuery);
  // Non-throwing: a broad term can exceed the backend's query budget and return
  // a terminal error — bare useQuery re-throws it in render (ct-37627). The
  // breaker unsubscribes a never-resolving search so its silent retry loop
  // stops flapping the shared websocket (1011) for the rest of the app.
  const { data: searchResults, error: searchError } = useQueryNoThrow(
    api.conversations.searchConversations,
    searchActive ? { query: debouncedQuery, limit, userOnly, mineOnly, since, sort } : "skip",
    { breakAfterMs: 15_000 }
  );

  const freshData = searchResults && "results" in searchResults ? searchResults : null;
  // Stale-while-revalidate: keep the previous result set on screen while a new
  // query/filter loads — the input spinner signals the refresh. Skeletons only
  // show on the very first search.
  const [lastData, setLastData] = useState<typeof freshData>(null);
  useWatchEffect(() => {
    if (freshData) setLastData(freshData);
  }, [freshData]);
  useWatchEffect(() => {
    if (!searchActive) setLastData(null);
  }, [searchActive]);

  const searchData = freshData ?? (searchActive ? lastData : null);

  // Cheap always-fast companion: title/subtitle/summary matches from the small
  // conversations table land even when the message content search times out on
  // a broad term (ct-37627). userOnly filters by message role — skip then.
  const { data: titleResults } = useQueryNoThrow(
    api.conversations.searchConversationTitles,
    searchActive && !userOnly ? { query: debouncedQuery, limit, mineOnly, since } : "skip"
  );
  const titleData = titleResults && "results" in titleResults ? titleResults : null;

  const contentRows: any[] = searchData?.results || [];
  // Instant tier: sessions already in the store, matched off the RAW query, so
  // the page has real rows before either server tier answers — the same rows
  // ⌘K shows. Server rows supersede them by conversation id as they land.
  // "My prompts only" filters by message role, which a cached session row has
  // no way to evaluate — the instant tier stands down rather than claim a hit
  // it cannot justify, exactly as the title tier does.
  const instantRows = useInstantSessionRows(userOnly ? "" : query, PAGE_SIZE, { mineOnly });
  // Content-match rows win; title-only rows next; cache rows fill the tail.
  const allResults: any[] = useMemo(
    () => mergeSearchRows(contentRows as any, titleData?.results as any, instantRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchData, titleData, instantRows]
  );
  const results: any[] = useMemo(
    () => withinScope(allResults, scopeOnly, (r: any) => bySessionAgent({ agent_type: r.agentType })) as any[],
    [allResults, scopeOnly]
  );
  const hiddenByScope = allResults.length - results.length;
  // Instant rows match what is typed NOW; server rows match the debounced term.
  // Highlight against the live term so a fresh keystroke marks its own hits.
  const hlQuery = (query.trim().length >= 2 ? liveQuery : parsedQuery).text;
  const totalMatches = searchData?.totalMatches || 0;
  const totalSessions = (searchData as any)?.totalSessions || 0;
  // Pagination is a content-search concept — title rows don't count against it.
  const hasMore = contentRows.length < totalSessions;
  const isLoading = searchActive && !searchError && (!freshData || query.trim() !== debouncedQuery.trim());
  // A value the parser could not read, or one the server could not resolve
  // (an author nobody matches, a label you do not have).
  const queryErrors: string[] = parsedQuery.errors.length
    ? parsedQuery.errors
    : searchData && "error" in searchData && searchData.error ? [searchData.error] : [];

  const hrefFor = (result: any, messageId?: string) =>
    `/conversation/${result.conversationId}${
      parsedQuery.text ? `?highlight=${encodeURIComponent(searchedTermsText(parsedQuery.text))}` : ""
    }${messageId ? `#msg-${messageId}` : ""}`;

  const openResult = (result: any, newTab = false) => {
    const href = hrefFor(result, result.matches?.[0]?.messageId);
    if (newTab) window.open(href, "_blank");
    else router.push(href);
  };

  // One menu instance for the whole result list; rows call open(e, payload).
  const ctxMenu = useContextMenu<SearchCtxPayload>();

  // The full triage menu (pin, label, stash…) mutates the inbox-store row, so
  // it needs both proof of ownership (server-computed isOwn: row user vs auth
  // user) AND the session present in the store. An own session outside the
  // inbox window falls back to the read-only foreign menu — honest, never
  // broken verbs.
  const openSessionMenu = (e: React.MouseEvent, result: any) => {
    const stored = useInboxStore.getState().sessions[result.conversationId];
    const isForeign = !(result.isOwn === true && stored);
    ctxMenu.open(e, {
      kind: "session",
      result,
      session: stored ?? ({ _id: result.conversationId, title: result.title } as InboxSession),
      isForeign,
    });
  };

  // Arrow keys drive selection while focus stays in the input — single-letter
  // keys never leave the field, so no global-shortcut leaks.
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (internals && autocomplete.onKeyDown(e as React.KeyboardEvent<HTMLInputElement>)) return;
    if (!results.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        e.key === "ArrowDown"
          ? Math.min(selectedIdx + 1, results.length - 1)
          : Math.max(selectedIdx - 1, -1);
      setSelectedIdx(next);
      if (next >= 0) resultRefs.current[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && selectedIdx >= 0 && results[selectedIdx]) {
      e.preventDefault();
      openResult(results[selectedIdx], e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
    }
  };

  const filterSummary = [
    mineOnly && "only my sessions",
    userOnly && "my prompts only",
    range !== "all" && `last ${range}`,
    sort === "relevance" && "by relevance",
  ].filter(Boolean) as string[];

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-3xl mx-auto space-y-5">
          <div className="space-y-3">
            <div className="relative group">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search data-cc-search-icon className={`w-5 h-5 text-sol-text-dim transition-colors ${internals ? "group-focus-within:text-amber-500" : "group-focus-within:text-sol-text"}`} />
              </div>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); autocomplete.trackCaret(e.target); }}
                {...autocomplete.inputHandlers}
                onKeyDown={handleInputKeyDown}
                placeholder={words.searchPagePlaceholder}
                data-cc-search-field
                // Hosted mode's focus is a hairline of ink and a soft glow of the
                // accent, the family's field, rather than a thick ring.
                className={`w-full pl-12 pr-12 py-3.5 bg-sol-bg-alt border border-sol-border rounded-xl text-[15px] text-sol-text placeholder-sol-text-dim focus:outline-none transition-all shadow-sm ${internals ? "focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/40" : "focus:ring-[3px] focus:ring-sol-orange/[0.08] focus:border-sol-text/60"}`}
                autoFocus
              />
              <div className="absolute inset-y-0 right-0 pr-4 flex items-center">
                {isLoading ? (
                  <Loader2 data-cc-search-icon className={`w-4 h-4 animate-spin ${internals ? "text-amber-500" : "text-sol-text-dim"}`} />
                ) : (
                  query && (
                    <button
                      onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                      aria-label="Clear the search"
                      className="text-sol-text-dim hover:text-sol-text"
                    >
                      <KeyCap size="xs">Esc</KeyCap>
                    </button>
                  )
                )}
              </div>
              {internals && autocomplete.open && <SessionQuerySuggestList {...autocomplete.listProps} />}
            </div>

            {queryErrors.length > 0 && (
              <div className="space-y-0.5 text-xs text-sol-red">
                {queryErrors.map((e) => <p key={e}>{e}</p>)}
              </div>
            )}

            <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
              <AssistantScopeSwitch label="Which conversations this searches" hidden={hiddenByScope} />
              {internals && <SegmentedControl
                label="Scope"
                value={mineOnly ? "mine" : "everyone"}
                options={[
                  { value: "everyone", label: "Everyone" },
                  { value: "mine", label: "Only mine" },
                ]}
                onChange={(v) => setMineOnly(v === "mine")}
              />}
              {internals && <SegmentedControl
                label="Match in"
                value={userOnly ? "prompts" : "everything"}
                options={[
                  { value: "everything", label: "Everything" },
                  { value: "prompts", label: "My prompts" },
                ]}
                onChange={(v) => setUserOnly(v === "prompts")}
              />}
              {internals ? <SegmentedControl
                label="Time"
                value={range}
                options={[
                  { value: "all", label: "All time" },
                  { value: "7d", label: "7d" },
                  { value: "30d", label: "30d" },
                  { value: "90d", label: "90d" },
                ]}
                onChange={setRange}
              /> : (
                // Hosted mode: one quiet menu in words, and newest first.
                <select
                  aria-label="Time"
                  value={range}
                  onChange={(e) => setRange(e.target.value as RangeKey)}
                  className="rounded-md border-0 bg-transparent py-1 pl-1 pr-6 text-[13px] text-sol-text-muted hover:text-sol-text focus:outline-none focus:ring-1 focus:ring-sol-text/30"
                >
                  {HOSTED_RANGES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                </select>
              )}
              {internals && <SegmentedControl
                label="Sort"
                value={sort}
                options={[
                  { value: "recent", label: "Recent" },
                  { value: "relevance", label: "Relevant" },
                ]}
                onChange={setSort}
              />}
            </div>
          </div>

          <FeatureUpsell
            slug="memory"
            reason="Your agents can run this same search themselves, so they start a task from what earlier sessions already decided."
          />

          {searchActive && searchData && (
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-sol-text-secondary">
                {/* Title matches count conversations but no message matches,
                    so the match count leads only when it covers them all. */}
                {internals && parsedQuery.text && totalMatches >= totalSessions && (
                  <>
                    <span className="text-sol-text font-medium tabular-nums">{totalMatches}</span> match{totalMatches !== 1 ? "es" : ""} in{" "}
                  </>
                )}
                {/* Hosted mode counts each group under its own heading, so a
                    page-level count never reads as the to-dos' count too. */}
                {internals && <><span className="text-sol-text font-medium tabular-nums">{totalSessions}</span> {(totalSessions !== 1 ? words.conversations : words.conversation).toLowerCase()}</>}
                {filterSummary.length > 0 && (
                  <span className="text-sol-text-dim"> · {filterSummary.join(" · ")}</span>
                )}
              </span>
              {results.length > 0 && (
                <span className="hidden sm:flex items-center gap-1 text-[10px] text-sol-text-dim">
                  <KeyCap size="xs">↑</KeyCap>
                  <KeyCap size="xs">↓</KeyCap>
                  select
                  <CornerDownLeft className="w-3 h-3 ml-1" />
                  open
                </span>
              )}
            </div>
          )}

          {searchActive && !searchData && results.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-sol-text-dim">
              {!searchError && <Loader2 className="w-3 h-3 animate-spin text-sol-cyan" />}
              {searchError
                ? `Content search timed out, so these are ${words.conversations.toLowerCase()} matched by name. Try a more specific word or a quoted phrase.`
                : `${words.conversations} matched by name. Still searching what was said…`}
            </div>
          )}

          {/* The recent tier bounds content matches to a trailing window;
              titles cover all time. Only worth saying when the selected range
              exceeds the window. */}
          {/* Hosted mode leaves the search window to the engine: the line
              reads as a developer's caveat. */}
          {internals && searchActive && parsedQuery.text && searchData?.contentTier === "recent" &&
            (range === "all" || RANGE_MS[range] > (searchData.contentWindowDays ?? 30) * 86_400_000) && (
            <div className="text-xs text-sol-text-dim">
              Content matches cover the last {searchData.contentWindowDays ?? 30} days. Older {words.conversations.toLowerCase()} match by title and summary.
            </div>
          )}

          {/* An operator walk that stopped at its read budget: the rows are
              the newest part of the answer, and each line says how to reach
              the rest. */}
          {searchActive && !!searchData?.truncated?.length && (
            <div className="space-y-0.5 text-xs text-sol-text-dim">
              {searchData.truncated.map((line) => (
                <p key={line}><span className="text-sol-yellow">Partial:</span> {line}</p>
              ))}
            </div>
          )}

          {searchActive && !searchData && results.length === 0 && (
            searchError ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-sol-text-secondary mb-2">Search timed out</p>
                <p className="text-xs text-sol-text-dim">
                  Broad terms scan your whole history and can time out. Try a more specific word, wrap an exact phrase in quotes, or narrow the time range.
                </p>
              </div>
            ) : (
              <ResultSkeleton />
            )
          )}

          {!internals && searchActive && <ObjectMatches query={debouncedQuery} scopeOnly={scopeOnly} />}

          {results.length > 0 && (
            <div className={internals ? "space-y-4" : "space-y-1.5"} data-search-conversations>
              {!internals && (
                <h2 className="mb-1 px-1 text-[12px] text-sol-text-muted">{words.conversations} <span className="ml-0.5 tabular-nums text-sol-text-dim">{totalSessions}</span></h2>
              )}
              {results.map((result: any, idx: number) => {
                const proj = projectName(result.projectPath);
                const isSelected = idx === selectedIdx;
                return (
                  <div
                    key={result.conversationId}
                    ref={(el) => { resultRefs.current[idx] = el; }}
                    data-cc-search-result={isSelected ? "selected" : ""}
                    className={`bg-sol-bg-alt border rounded-xl overflow-hidden transition-all ${
                      isSelected
                        ? internals ? "border-amber-500/60 ring-1 ring-amber-500/30 shadow-md" : "border-sol-text/30 ring-1 ring-sol-text/10 shadow-md"
                        : "border-sol-border hover:border-sol-border/80"
                    }`}
                  >
                    <Link
                      href={hrefFor(result)}
                      className="block px-4 py-3 hover:bg-sol-base02/30 transition-colors border-b border-sol-border"
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onContextMenu={(e) => openSessionMenu(e, result)}
                    >
                      <div className="flex items-center gap-3">
                        {/* Who the session is (session-characters.md S3); a
                            row nobody personified keeps its old mark. */}
                        <SessionGlyph
                          row={result.identity}
                          size={18}
                          className="flex-shrink-0"
                          fallback={!result.isOwn && result.authorAvatar ? (
                          <img
                            src={result.authorAvatar}
                            alt={result.authorName}
                            className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                          />
                        ) : !result.isOwn && result.authorName ? (
                          <div className="w-5 h-5 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[9px] font-medium text-sol-text-muted">
                            {result.authorName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                          </div>
                        ) : (
                          <MessageSquare className="w-4 h-4 text-sol-blue/70 flex-shrink-0" />
                        )}
                        />
                        <h3 className="text-[15px] font-medium text-sol-text truncate flex-1">
                          {highlightMatch(result.title, hlQuery)}
                        </h3>
                        <div className="flex items-center gap-2.5 text-[11px] text-sol-text-dim shrink-0 tabular-nums">
                          {internals && result.titleMatch && (
                            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                              <Sparkles className="w-3 h-3" />
                              title
                            </span>
                          )}
                          {internals && <span>{result.messageCount} msgs</span>}
                          <span>{formatSearchTimestamp(result.updatedAt)}</span>
                        </div>
                      </div>
                      {(proj || !result.isOwn) && (
                        <div className="flex items-center gap-2 mt-1 pl-8 text-[11px] text-sol-text-dim">
                          {!result.isOwn && <span>{result.authorName}</span>}
                          {proj && (
                            <span className="flex items-center gap-1 font-mono">
                              <FolderGit2 className="w-3 h-3" />
                              {proj}
                            </span>
                          )}
                        </div>
                      )}
                      <SearchOrigin row={result} query={hlQuery} className="mt-1.5 pl-8" />
                    </Link>
                    {result.matches.length === 0 && result.instantSnippet && (
                      <p className="px-4 py-2.5 text-[12px] text-sol-text-dim leading-relaxed">
                        {highlightMatch(getSnippet(result.instantSnippet, hlQuery, 220), hlQuery)}
                      </p>
                    )}
                    {result.matches.length > 0 && (
                      <div className="divide-y divide-sol-border/50">
                        {/* Hosted mode shows a hit as one row and its best
                            snippet; the selected hit opens the rest. */}
                        {(internals || isSelected ? result.matches : result.matches.slice(0, 1)).map((match: any, mIdx: number) => (
                          <Link
                            key={`${result.conversationId}-${mIdx}`}
                            href={hrefFor(result, match.messageId)}
                            className="block px-4 py-2.5 hover:bg-amber-100/20 dark:hover:bg-amber-900/10 transition-colors"
                            onContextMenu={(e) =>
                              ctxMenu.open(e, { kind: "message", result, messageId: match.messageId })
                            }
                          >
                            <div className="flex items-center gap-2 mb-1">
                              {/* Hosted mode names the speaker in words, quietly. */}
                              {internals ? (
                                <span
                                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
                                    match.role === "user"
                                      ? "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30"
                                      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                                  }`}
                                >
                                  {match.role}
                                </span>
                              ) : (
                                <span className="text-[11px] text-sol-text-muted">{match.role === "user" ? "You" : "Assistant"}</span>
                              )}
                              <span className="text-[10px] text-sol-text-dim tabular-nums">
                                {formatSearchTimestamp(match.timestamp)}
                              </span>
                            </div>
                            <p className={`text-[13px] text-sol-text-secondary leading-relaxed ${internals || isSelected ? "line-clamp-3" : "line-clamp-1"}`}>
                              {highlightMatch(stripSnippetMarkup(match.content ?? ""), hlQuery)}
                            </p>
                          </Link>
                        ))}
                        {(internals || isSelected) && result.matchCount > result.matches.length && (
                          <Link
                            href={hrefFor(result, result.matches[0]?.messageId)}
                            className="block px-4 py-2 text-[11px] text-sol-text-dim hover:text-sol-text-secondary transition-colors"
                          >
                            +{result.matchCount - result.matches.length} more match{result.matchCount - result.matches.length !== 1 ? "es" : ""} in this {words.conversation.toLowerCase()}
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {searchActive && <MoreInEverything hidden={hiddenByScope} centered />}

          {hasMore && (
            <button
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              className="w-full py-3 text-sm text-sol-text-secondary hover:text-sol-text bg-sol-bg-alt border border-sol-border rounded-xl hover:bg-sol-base02/30 transition-colors"
            >
              Show more ({totalSessions - contentRows.length} remaining)
            </button>
          )}

          {searchData && results.length === 0 && !isLoading && queryErrors.length === 0 && (
            <div className="text-center py-16 space-y-2">
              <p className="text-sol-text-secondary">No results for &ldquo;{debouncedQuery}&rdquo;</p>
              <p className="text-sm text-sol-text-dim">
                {filterSummary.length > 0
                  ? "Try widening the filters above, or different keywords."
                  : 'Try different keywords, or "quotes" for exact phrases.'}
              </p>
            </div>
          )}

          {!searchActive && queryErrors.length === 0 && (
            <div className="text-center py-16 space-y-3">
              <Search className="w-8 h-8 text-sol-text-dim/40 mx-auto" />
              <p className="text-sol-text-dim text-sm">
                {internals
                  ? <>Search titles and full message content across {mineOnly ? "your" : "your team's"} sessions.</>
                  : "Search the names and words of your conversations."}
              </p>
              <p className="text-[11px] text-sol-text-dim/70">
                Tip: open this page from anywhere with{" "}
                <span className="inline-flex items-center gap-0.5"><KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">K</KeyCap></span> then{" "}
                <span className="inline-flex items-center gap-0.5"><KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap></span>
              </p>
              {/* The operators `cast search` reads too; the URL keeps the
                  whole query, so a narrowed view is a link. */}
              {internals && <div className="flex flex-wrap justify-center gap-1.5 pt-2 max-w-lg mx-auto">
                {SESSION_QUERY_OPERATORS.map((o) => (
                  <button
                    key={o.op}
                    title={`${o.example}: ${o.hint}`}
                    onClick={() => {
                      setQuery((q) => `${q.trim() ? `${q.trim()} ` : ""}${o.op}`);
                      autocomplete.resetCaret();
                      inputRef.current?.focus();
                    }}
                    className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-sol-border/60 bg-sol-bg-alt text-sol-text-secondary hover:text-sol-text hover:border-amber-500/40 transition-colors"
                  >
                    {o.op}
                  </button>
                ))}
              </div>}
            </div>
          )}
        </div>

        <ContextMenu state={ctxMenu}>
          {(p) =>
            p.kind === "session" ? (
              <SessionMenuItems
                session={p.session}
                isForeign={p.isForeign}
                onOpen={() => openResult(p.result)}
              />
            ) : (
              <>
                <CtxHeader title={p.result.title || "Message"} />
                <CtxItem icon={ExternalLink} onSelect={() => router.push(hrefFor(p.result, p.messageId))}>
                  Open
                </CtxItem>
                <CtxItem
                  icon={ExternalLink}
                  onSelect={() => window.open(hrefFor(p.result, p.messageId), "_blank")}
                >
                  Open in new tab
                </CtxItem>
                <CtxSeparator />
                <CtxItem
                  icon={LinkIcon}
                  onSelect={() =>
                    copyToClipboard(
                      `${shareOrigin()}/conversation/${p.result.conversationId}#msg-${p.messageId}`
                    ).then(() => toast.success("Link copied"))
                  }
                >
                  Copy link
                </CtxItem>
              </>
            )
          }
        </ContextMenu>
      </DashboardLayout>
    </AuthGuard>
  );
}
