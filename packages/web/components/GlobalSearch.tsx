"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

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

function getSnippet(content: string, query: string, maxLen = 400): string {
  const lowerContent = content.toLowerCase();
  const terms = parseSearchTerms(query);

  let bestIndex = -1;
  for (const term of terms) {
    const idx = lowerContent.indexOf(term);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
    }
  }

  if (bestIndex === -1) return content.slice(0, maxLen);

  const start = Math.max(0, bestIndex - 100);
  const end = Math.min(content.length, bestIndex + 300);
  let snippet = content.slice(start, end);

  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";

  return snippet;
}

export function GlobalSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [userOnly, setUserOnly] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<Id<"teams"> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const userTeams = useQuery(api.teams.getUserTeams);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const searchResults = useQuery(
    api.conversations.searchConversations,
    debouncedQuery.length >= 2
      ? { query: debouncedQuery, limit: 30, userOnly, activeTeamId: selectedTeamId ?? undefined }
      : "skip"
  );

  const searchData = searchResults && "results" in searchResults ? searchResults : null;

  const flatResults = searchData?.results?.flatMap((r: {
    conversationId: string;
    title: string;
    matches: Array<{ messageId: string; content: string; role: string; timestamp: number }>;
    updatedAt: number;
    authorName: string;
    isOwn: boolean;
    messageCount: number;
  }) =>
    r.matches.map((m: { messageId: string; content: string; role: string; timestamp: number }, i: number) => ({
      conversationId: r.conversationId,
      title: r.title,
      content: m.content,
      role: m.role,
      timestamp: m.timestamp,
      authorName: r.authorName,
      isOwn: r.isOwn,
      messageCount: r.messageCount,
      key: `${r.conversationId}-${i}`,
    }))
  ) || [];

  const totalMatches = searchData?.totalMatches || 0;
  const sessionCount = searchData?.results?.length || 0;

  const formatTimestamp = (ts: number) => {
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
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setIsOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      if (e.key === "Escape") {
        setIsOpen(false);
        setQuery("");
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchResults]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const results = searchData?.results || [];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey && results.length > 0) {
          router.push(`/search?q=${encodeURIComponent(query)}${userOnly ? "&userOnly=true" : ""}`);
        } else if (results[selectedIndex]) {
          const url = `/conversation/${results[selectedIndex].conversationId}?highlight=${encodeURIComponent(query)}`;
          router.push(url);
        }
        setIsOpen(false);
        setQuery("");
      }
    },
    [searchData?.results, selectedIndex, router, query, userOnly]
  );

  const handleResultClick = (conversationId: string) => {
    const url = `/conversation/${conversationId}?highlight=${encodeURIComponent(query)}`;
    router.push(url);
    setIsOpen(false);
    setQuery("");
  };

  // Group results by session for display
  const groupedResults = searchData?.results || [];

  return (
    <div className="relative flex-1 min-w-[500px] max-w-[800px] mx-8 z-[9999]">
      <div
        className={`relative transition-all duration-200 ${
          isOpen ? "scale-105" : ""
        }`}
      >
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <svg
            className="w-4 h-4 text-sol-base00"
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
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!isOpen) setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search conversations..."
          className="w-full pl-10 pr-16 py-2 bg-sol-base02/60 bg-sol-bg-alt border border-sol-base01/60 border-sol-border rounded-lg text-sm text-sol-base2 text-sol-text placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500/50 focus:border-amber-500/50 transition-all"
        />
        <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
          <kbd className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-sol-base00 bg-sol-base02 bg-sol-bg-alt rounded border border-sol-base01 border-sol-border">
            <span className="text-xs">&#8984;</span>/
          </kbd>
        </div>
      </div>

      {isOpen && query.length >= 2 && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 w-[900px] mt-2 bg-sol-bg border border-sol-border rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
            {!searchResults ? (
              <div className="px-4 py-8 text-center">
                <div className="inline-block w-5 h-5 border-2 border-sol-base01 border-t-amber-500 rounded-full animate-spin" />
              </div>
            ) : groupedResults.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-sol-text-secondary mb-2">No conversations match</p>
                <p className="text-xs text-sol-text-dim">Try different keywords</p>
              </div>
            ) : (
              <div className="max-h-[600px] overflow-y-auto">
                <div className="px-4 py-2 border-b border-sol-border text-xs text-sol-text-secondary">
                  {totalMatches} match{totalMatches !== 1 ? "es" : ""} in {sessionCount} session{sessionCount !== 1 ? "s" : ""}
                </div>
                <div className="space-y-1 py-1">
                {groupedResults.map((session: any, sessionIndex: number) => (
                  <button
                    key={session.conversationId}
                    onClick={() => handleResultClick(session.conversationId)}
                    className={`w-full text-left mx-1 rounded-lg transition-colors ${
                      sessionIndex === selectedIndex
                        ? "bg-amber-200/60 dark:bg-amber-900/40"
                        : "hover:bg-amber-100/30 dark:hover:bg-amber-900/20"
                    }`}
                  >
                    <div className="px-3 py-2 flex items-center gap-2">
                      <span className="text-sm font-semibold text-sol-text truncate max-w-[600px]">
                        {session.title}
                      </span>
                      {!session.isOwn && (
                        <span className="text-[10px] text-sol-text-dim px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border">
                          {session.authorName}
                        </span>
                      )}
                      <span className="text-[10px] text-sol-text-dim px-1.5 py-0.5 bg-sol-bg rounded">
                        {session.messageCount} msgs
                      </span>
                      <span className="text-[10px] text-sol-text-dim ml-auto whitespace-nowrap">
                        {formatTimestamp(session.updatedAt)}
                      </span>
                    </div>
                    <div className="ml-4 pb-2 space-y-1 border-l-2 border-sol-border/40 pl-3">
                      {session.matches.slice(0, 3).map((match: any, matchIndex: number) => (
                        <div
                          key={`${session.conversationId}-${matchIndex}`}
                          className="px-2 py-1"
                        >
                          <div className="flex items-center gap-2 mb-0.5">
                            <span
                              className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                match.role === "user"
                                  ? "bg-blue-500/20 text-blue-700 dark:text-blue-300"
                                  : "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                              }`}
                            >
                              {match.role}
                            </span>
                            <span className="text-[10px] text-sol-text-dim">
                              {formatTimestamp(match.timestamp)}
                            </span>
                          </div>
                          <p className="text-sm text-sol-text-secondary leading-relaxed line-clamp-3">
                            {highlightMatch(getSnippet(match.content, query), query)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </button>
                ))}
                </div>
              </div>
            )}
            <div className="px-3 py-2 bg-sol-bg-alt/80 border-t border-sol-border flex items-center justify-between text-[10px] text-sol-text-dim">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 cursor-pointer select-none text-sol-text-secondary hover:text-sol-text transition-colors">
                  <input
                    type="checkbox"
                    checked={userOnly}
                    onChange={(e) => setUserOnly(e.target.checked)}
                    className="w-3 h-3 rounded border-sol-border bg-sol-bg text-amber-500 focus:ring-amber-500/50 focus:ring-offset-0 cursor-pointer"
                  />
                  user only
                </label>
                {userTeams && userTeams.length > 1 && (
                  <>
                    <span className="text-sol-border">|</span>
                    <select
                      value={selectedTeamId ?? ""}
                      onChange={(e) => setSelectedTeamId(e.target.value ? e.target.value as Id<"teams"> : null)}
                      className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border text-sol-text-secondary cursor-pointer focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                    >
                      <option value="">All teams</option>
                      {userTeams.map((team) => (
                        <option key={team?._id} value={team?._id}>
                          {team?.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <span className="text-sol-border">|</span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border text-sol-text-secondary">&#8593;</kbd>
                  <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border text-sol-text-secondary">&#8595;</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border text-sol-text-secondary">&#9166;</kbd>
                  open
                </span>
              </div>
              <div className="flex items-center gap-3">
                {groupedResults.length > 0 && (
                  <span
                    onClick={() => {
                      router.push(`/search?q=${encodeURIComponent(query)}${userOnly ? "&userOnly=true" : ""}`);
                      setIsOpen(false);
                      setQuery("");
                    }}
                    className="flex items-center gap-1 cursor-pointer text-sol-text-secondary hover:text-sol-text transition-colors"
                  >
                    <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border text-sol-text-secondary">⇧↵</kbd>
                    see all
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border text-sol-text-secondary">esc</kbd>
                  close
                </span>
              </div>
            </div>
        </div>
      )}
    </div>
  );
}
