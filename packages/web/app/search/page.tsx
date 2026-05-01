import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useDebounce } from "../../hooks/useDebounce";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import Link from "next/link";

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

const PAGE_SIZE = 20;

export default function SearchPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQuery = searchParams.get("q") || "";
  const initialUserOnly = searchParams.get("userOnly") === "true";
  const [query, setQuery] = useState(initialQuery);
  const [userOnly, setUserOnly] = useState(initialUserOnly);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const debouncedQuery = useDebounce(query, 300);

  useWatchEffect(() => {
    setLimit(PAGE_SIZE);
  }, [debouncedQuery]);

  useWatchEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (userOnly) params.set("userOnly", "true");
    const newUrl = `/search${params.toString() ? `?${params.toString()}` : ""}`;
    router.replace(newUrl);
  }, [debouncedQuery, userOnly, router]);

  const searchResults = useQuery(
    api.conversations.searchConversations,
    debouncedQuery.length >= 2 ? { query: debouncedQuery, limit, userOnly } : "skip"
  );

  const searchData = searchResults && "results" in searchResults ? searchResults : null;
  const totalMatches = searchData?.totalMatches || 0;
  const totalSessions = (searchData as any)?.totalSessions || 0;
  const sessionCount = searchData?.results?.length || 0;
  const hasMore = sessionCount < totalSessions;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold text-sol-text">Search</h1>
          </div>

          <div className="space-y-3">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <svg
                  className="w-5 h-5 text-sol-base00"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='Search conversations... use "quotes" for exact phrases'
                className="w-full pl-12 pr-4 py-3 bg-sol-bg-alt border border-sol-border rounded-lg text-sol-text placeholder-sol-text-dim focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-all"
                autoFocus
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={userOnly}
                onChange={(e) => setUserOnly(e.target.checked)}
                className="w-4 h-4 rounded border-sol-border bg-sol-bg-alt text-amber-500 focus:ring-amber-500/50 focus:ring-offset-0 cursor-pointer"
              />
              <span className="text-sm text-sol-text-secondary">User messages only</span>
            </label>
          </div>

          {debouncedQuery.length >= 2 && (
            <div className="text-sm text-sol-text-secondary">
              {!searchResults ? (
                <span>Searching...</span>
              ) : (
                <span>
                  {totalMatches} match{totalMatches !== 1 ? "es" : ""} in {totalSessions} conversation{totalSessions !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          )}

          {searchData?.results && searchData.results.length > 0 && (
            <div className="space-y-4">
              {searchData.results.map((result: any) => (
                <div
                  key={result.conversationId}
                  className="bg-sol-bg-alt border border-sol-border rounded-lg overflow-hidden"
                >
                  <Link
                    href={`/conversation/${result.conversationId}?highlight=${encodeURIComponent(query)}`}
                    className="block px-4 py-3 hover:bg-sol-base02/30 transition-colors border-b border-sol-border"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <h3 className="text-base font-medium text-sol-text">
                        {result.title}
                      </h3>
                      <div className="flex items-center gap-2 text-xs text-sol-text-dim shrink-0">
                        <span>{result.messageCount} msgs</span>
                        <span>{formatTimestamp(result.updatedAt)}</span>
                      </div>
                    </div>
                    {!result.isOwn && (
                      <span className="text-xs text-sol-text-dim">by {result.authorName}</span>
                    )}
                  </Link>
                  <div className="divide-y divide-sol-border/50">
                    {result.matches.map((match: any, idx: number) => (
                      <Link
                        key={`${result.conversationId}-${idx}`}
                        href={`/conversation/${result.conversationId}?highlight=${encodeURIComponent(query)}`}
                        className="block px-4 py-3 hover:bg-amber-100/20 dark:hover:bg-amber-900/10 transition-colors"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
                              match.role === "user"
                                ? "bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/30"
                                : "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                            }`}
                          >
                            {match.role}
                          </span>
                          <span className="text-[10px] text-sol-text-dim">
                            {formatTimestamp(match.timestamp)}
                          </span>
                        </div>
                        <p className="text-sm text-sol-text-secondary leading-relaxed">
                          {highlightMatch(match.content, query)}
                        </p>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {hasMore && (
            <button
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              className="w-full py-3 text-sm text-sol-text-secondary hover:text-sol-text bg-sol-bg-alt border border-sol-border rounded-lg hover:bg-sol-base02/30 transition-colors"
            >
              Show more ({totalSessions - sessionCount} remaining)
            </button>
          )}

          {searchData?.results && searchData.results.length === 0 && debouncedQuery.length >= 2 && (
            <div className="text-center py-12">
              <p className="text-sol-text-secondary">No results found for "{debouncedQuery}"</p>
              <p className="text-sm text-sol-text-dim mt-2">Try different keywords or use "quotes" for exact phrases</p>
            </div>
          )}

          {debouncedQuery.length < 2 && (
            <div className="text-center py-12">
              <p className="text-sol-text-dim">Enter at least 2 characters to search</p>
            </div>
          )}
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
