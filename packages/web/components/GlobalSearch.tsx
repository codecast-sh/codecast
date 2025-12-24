"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return text;

  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  if (parts.length === 1) return text;

  return (
    <>
      {parts.map((part, i) => {
        const isMatch = words.some((w) => part.toLowerCase() === w);
        return isMatch ? (
          <mark
            key={i}
            className="bg-amber-500/40 dark:bg-amber-400/30 text-amber-900 dark:text-amber-200 rounded px-0.5"
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

function getSnippet(content: string, query: string, maxLen = 120): string {
  const lowerContent = content.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  let bestIndex = -1;
  for (const word of words) {
    const idx = lowerContent.indexOf(word);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
    }
  }

  if (bestIndex === -1) return content.slice(0, maxLen);

  const start = Math.max(0, bestIndex - 40);
  const end = Math.min(content.length, bestIndex + 80);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const searchResults = useQuery(
    api.conversations.searchConversations,
    debouncedQuery.length >= 2 ? { query: debouncedQuery, limit: 15 } : "skip"
  );

  const flatResults = searchResults?.flatMap((r) =>
    r.matches.map((m, i) => ({
      conversationId: r.conversationId,
      title: r.title,
      content: m.content,
      role: m.role,
      timestamp: m.timestamp,
      authorName: r.authorName,
      isOwn: r.isOwn,
      key: `${r.conversationId}-${i}`,
    }))
  ) || [];

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
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
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
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatResults.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && flatResults[selectedIndex]) {
        e.preventDefault();
        router.push(`/conversation/${flatResults[selectedIndex].conversationId}`);
        setIsOpen(false);
        setQuery("");
      }
    },
    [flatResults, selectedIndex, router]
  );

  const handleResultClick = (conversationId: string) => {
    router.push(`/conversation/${conversationId}`);
    setIsOpen(false);
    setQuery("");
  };

  return (
    <div className="relative flex-1 max-w-2xl mx-8">
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
            <span className="text-xs">&#8984;</span>K
          </kbd>
        </div>
      </div>

      {isOpen && query.length >= 2 && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => {
              setIsOpen(false);
              setQuery("");
            }}
          />
          <div className="absolute top-full left-0 right-0 mt-2 z-50 bg-sol-base02 bg-sol-bg border border-sol-base01/80 border-sol-border rounded-xl shadow-2xl shadow-black/40 overflow-hidden">
            {!searchResults ? (
              <div className="px-4 py-8 text-center">
                <div className="inline-block w-5 h-5 border-2 border-sol-base01 border-t-amber-500 rounded-full animate-spin" />
              </div>
            ) : flatResults.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-sol-base0 mb-2">No conversations match</p>
                <p className="text-xs text-sol-base00">Try different keywords</p>
              </div>
            ) : (
              <div className="max-h-[600px] overflow-y-auto">
                {flatResults.map((result, index) => (
                  <button
                    key={result.key}
                    onClick={() => handleResultClick(result.conversationId)}
                    className={`w-full text-left px-4 py-3 border-b border-sol-base02/50 last:border-0 transition-colors ${
                      index === selectedIndex
                        ? "bg-sol-base02/80"
                        : "hover:bg-sol-base02/40"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-sol-base0 truncate max-w-[200px]">
                        {result.title}
                      </span>
                      {!result.isOwn && (
                        <span className="text-[10px] text-sol-base00 px-1.5 py-0.5 bg-sol-base02 rounded">
                          {result.authorName}
                        </span>
                      )}
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          result.role === "user"
                            ? "bg-blue-900/40 text-blue-400"
                            : "bg-emerald-900/40 text-emerald-400"
                        }`}
                      >
                        {result.role}
                      </span>
                      <span className="text-[10px] text-sol-base00 ml-auto">
                        {formatTimestamp(result.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-sol-base1 leading-relaxed">
                      {highlightMatch(getSnippet(result.content, query), query)}
                    </p>
                  </button>
                ))}
              </div>
            )}
            <div className="px-3 py-2 bg-sol-base02/50 border-t border-sol-base01/50 flex items-center justify-between text-[10px] text-sol-base00">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-700 rounded text-sol-base0">&#8593;</kbd>
                  <kbd className="px-1 py-0.5 bg-slate-700 rounded text-sol-base0">&#8595;</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-700 rounded text-sol-base0">&#9166;</kbd>
                  open
                </span>
              </div>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-slate-700 rounded text-sol-base0">esc</kbd>
                close
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
