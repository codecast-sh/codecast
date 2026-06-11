import { useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useDebounce } from "../../hooks/useDebounce";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import Link from "next/link";
import {
  Search,
  Loader2,
  CornerDownLeft,
  MessageSquare,
  FolderGit2,
  Sparkles,
} from "lucide-react";

function parseSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const term = match[1] || match[2];
    if (term) terms.push(term.toLowerCase());
  }
  return terms;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;

  const terms = parseSearchTerms(query);
  if (terms.length === 0) return text;

  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  if (parts.length === 1) return text;

  return (
    <>
      {parts.map((part, i) => {
        const isMatch = terms.some((t) => part.toLowerCase() === t);
        return isMatch ? (
          <mark
            key={i}
            className="bg-amber-300/40 text-amber-900 dark:text-amber-200 rounded px-0.5 font-medium"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return timeStr;
  if (isYesterday) return `Yesterday ${timeStr}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + ` ${timeStr}`;
}

function projectName(p?: string | null): string | null {
  if (!p) return null;
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

const PAGE_SIZE = 20;

type RangeKey = "all" | "7d" | "30d" | "90d";
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
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-sol-text-dim/70">
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
  const resultRefs = useRef<Array<HTMLDivElement | null>>([]);
  const debouncedQuery = useDebounce(query, 300);

  useWatchEffect(() => {
    setLimit(PAGE_SIZE);
    setSelectedIdx(-1);
  }, [debouncedQuery, mineOnly, userOnly, range, sort]);

  const lastWrittenUrl = useRef<string | null>(null);
  useWatchEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
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

  const searchActive = debouncedQuery.length >= 2;
  const searchResults = useQuery(
    api.conversations.searchConversations,
    searchActive ? { query: debouncedQuery, limit, userOnly, mineOnly, since, sort } : "skip"
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
  const results: any[] = searchData?.results || [];
  const totalMatches = searchData?.totalMatches || 0;
  const totalSessions = (searchData as any)?.totalSessions || 0;
  const hasMore = results.length < totalSessions;
  const isLoading = searchActive && (!freshData || query.trim() !== debouncedQuery.trim());

  const hrefFor = (result: any, messageId?: string) =>
    `/conversation/${result.conversationId}?highlight=${encodeURIComponent(debouncedQuery)}${
      messageId ? `#msg-${messageId}` : ""
    }`;

  const openResult = (result: any, newTab = false) => {
    const href = hrefFor(result, result.matches?.[0]?.messageId);
    if (newTab) window.open(href, "_blank");
    else router.push(href);
  };

  // Arrow keys drive selection while focus stays in the input — single-letter
  // keys never leave the field, so no global-shortcut leaks.
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
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
                <Search className="w-5 h-5 text-sol-text-dim group-focus-within:text-amber-500 transition-colors" />
              </div>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder='Search every session... use "quotes" for exact phrases'
                className="w-full pl-12 pr-12 py-3.5 bg-sol-bg-alt border border-sol-border rounded-xl text-[15px] text-sol-text placeholder-sol-text-dim focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/40 transition-all shadow-sm"
                autoFocus
              />
              <div className="absolute inset-y-0 right-0 pr-4 flex items-center">
                {isLoading ? (
                  <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
                ) : (
                  query && (
                    <button
                      onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                      className="text-sol-text-dim hover:text-sol-text text-xs px-1.5 py-0.5 rounded border border-sol-border/60 bg-sol-bg"
                    >
                      esc
                    </button>
                  )
                )}
              </div>
            </div>

            <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
              <SegmentedControl
                label="Scope"
                value={mineOnly ? "mine" : "everyone"}
                options={[
                  { value: "everyone", label: "Everyone" },
                  { value: "mine", label: "Only mine" },
                ]}
                onChange={(v) => setMineOnly(v === "mine")}
              />
              <SegmentedControl
                label="Match in"
                value={userOnly ? "prompts" : "everything"}
                options={[
                  { value: "everything", label: "Everything" },
                  { value: "prompts", label: "My prompts" },
                ]}
                onChange={(v) => setUserOnly(v === "prompts")}
              />
              <SegmentedControl
                label="Time"
                value={range}
                options={[
                  { value: "all", label: "All time" },
                  { value: "7d", label: "7d" },
                  { value: "30d", label: "30d" },
                  { value: "90d", label: "90d" },
                ]}
                onChange={setRange}
              />
              <SegmentedControl
                label="Sort"
                value={sort}
                options={[
                  { value: "recent", label: "Recent" },
                  { value: "relevance", label: "Relevant" },
                ]}
                onChange={setSort}
              />
            </div>
          </div>

          {searchActive && searchData && (
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-sol-text-secondary">
                <span className="text-sol-text font-medium tabular-nums">{totalMatches}</span> match{totalMatches !== 1 ? "es" : ""} in{" "}
                <span className="text-sol-text font-medium tabular-nums">{totalSessions}</span> session{totalSessions !== 1 ? "s" : ""}
                {filterSummary.length > 0 && (
                  <span className="text-sol-text-dim"> · {filterSummary.join(" · ")}</span>
                )}
              </span>
              {results.length > 0 && (
                <span className="hidden sm:flex items-center gap-1 text-[10px] text-sol-text-dim">
                  <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50">&#8593;&#8595;</kbd>
                  select
                  <CornerDownLeft className="w-3 h-3 ml-1" />
                  open
                </span>
              )}
            </div>
          )}

          {searchActive && !searchData && <ResultSkeleton />}

          {results.length > 0 && (
            <div className="space-y-4">
              {results.map((result: any, idx: number) => {
                const proj = projectName(result.projectPath);
                const isSelected = idx === selectedIdx;
                return (
                  <div
                    key={result.conversationId}
                    ref={(el) => { resultRefs.current[idx] = el; }}
                    className={`bg-sol-bg-alt border rounded-xl overflow-hidden transition-all ${
                      isSelected
                        ? "border-amber-500/60 ring-1 ring-amber-500/30 shadow-md"
                        : "border-sol-border hover:border-sol-border/80"
                    }`}
                  >
                    <Link
                      href={hrefFor(result)}
                      className="block px-4 py-3 hover:bg-sol-base02/30 transition-colors border-b border-sol-border"
                      onMouseEnter={() => setSelectedIdx(idx)}
                    >
                      <div className="flex items-center gap-3">
                        {!result.isOwn && result.authorAvatar ? (
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
                        <h3 className="text-[15px] font-medium text-sol-text truncate flex-1">
                          {highlightMatch(result.title, debouncedQuery)}
                        </h3>
                        <div className="flex items-center gap-2.5 text-[11px] text-sol-text-dim shrink-0 tabular-nums">
                          {result.titleMatch && (
                            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                              <Sparkles className="w-3 h-3" />
                              title
                            </span>
                          )}
                          <span>{result.messageCount} msgs</span>
                          <span>{formatTimestamp(result.updatedAt)}</span>
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
                    </Link>
                    {result.matches.length > 0 && (
                      <div className="divide-y divide-sol-border/50">
                        {result.matches.map((match: any, mIdx: number) => (
                          <Link
                            key={`${result.conversationId}-${mIdx}`}
                            href={hrefFor(result, match.messageId)}
                            className="block px-4 py-2.5 hover:bg-amber-100/20 dark:hover:bg-amber-900/10 transition-colors"
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span
                                className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
                                  match.role === "user"
                                    ? "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30"
                                    : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                                }`}
                              >
                                {match.role}
                              </span>
                              <span className="text-[10px] text-sol-text-dim tabular-nums">
                                {formatTimestamp(match.timestamp)}
                              </span>
                            </div>
                            <p className="text-[13px] text-sol-text-secondary leading-relaxed line-clamp-3">
                              {highlightMatch(match.content, debouncedQuery)}
                            </p>
                          </Link>
                        ))}
                        {result.matchCount > result.matches.length && (
                          <Link
                            href={hrefFor(result, result.matches[0]?.messageId)}
                            className="block px-4 py-2 text-[11px] text-sol-text-dim hover:text-sol-text-secondary transition-colors"
                          >
                            +{result.matchCount - result.matches.length} more match{result.matchCount - result.matches.length !== 1 ? "es" : ""} in this session
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {hasMore && (
            <button
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              className="w-full py-3 text-sm text-sol-text-secondary hover:text-sol-text bg-sol-bg-alt border border-sol-border rounded-xl hover:bg-sol-base02/30 transition-colors"
            >
              Show more ({totalSessions - results.length} remaining)
            </button>
          )}

          {searchData && results.length === 0 && !isLoading && (
            <div className="text-center py-16 space-y-2">
              <p className="text-sol-text-secondary">No results for &ldquo;{debouncedQuery}&rdquo;</p>
              <p className="text-sm text-sol-text-dim">
                {filterSummary.length > 0
                  ? "Try widening the filters above, or different keywords."
                  : 'Try different keywords, or "quotes" for exact phrases.'}
              </p>
            </div>
          )}

          {!searchActive && (
            <div className="text-center py-16 space-y-3">
              <Search className="w-8 h-8 text-sol-text-dim/40 mx-auto" />
              <p className="text-sol-text-dim text-sm">
                Search titles and full message content across {mineOnly ? "your" : "your team's"} sessions.
              </p>
              <p className="text-[11px] text-sol-text-dim/70">
                Tip: open this page from anywhere with <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50">&#8984;K</kbd> then <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50">&#8984;&#9166;</kbd>
              </p>
            </div>
          )}
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
