"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) return text;

  const before = text.slice(0, index);
  const match = text.slice(index, index + query.length);
  const after = text.slice(index + query.length);

  return (
    <>
      {before}
      <mark className="bg-amber-400/30 text-amber-200 rounded px-0.5">{match}</mark>
      {after}
    </>
  );
}

function getSnippet(content: string, query: string, maxLen = 120): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerContent.indexOf(lowerQuery);

  if (index === -1) return content.slice(0, maxLen);

  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + query.length + 80);
  let snippet = content.slice(start, end);

  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";

  return snippet;
}

export function GlobalSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const searchResults = useQuery(
    api.conversations.searchConversations,
    query.length >= 2 ? { query, limit: 10 } : "skip"
  );

  const flatResults = searchResults?.flatMap((r) =>
    r.matches.map((m, i) => ({
      conversationId: r.conversationId,
      title: r.title,
      content: m.content,
      role: m.role,
      authorName: r.authorName,
      isOwn: r.isOwn,
      key: `${r.conversationId}-${i}`,
    }))
  ) || [];

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
    <div className="relative flex-1 max-w-md mx-4">
      <div
        className={`relative transition-all duration-200 ${
          isOpen ? "scale-105" : ""
        }`}
      >
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <svg
            className="w-4 h-4 text-slate-500"
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
          className="w-full pl-10 pr-16 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500/50 focus:border-amber-500/50 transition-all"
        />
        <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
          <kbd className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 bg-slate-800 rounded border border-slate-700">
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
          <div className="absolute top-full left-0 right-0 mt-2 z-50 bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl shadow-black/40 overflow-hidden">
            {!searchResults ? (
              <div className="px-4 py-8 text-center">
                <div className="inline-block w-5 h-5 border-2 border-slate-600 border-t-amber-500 rounded-full animate-spin" />
              </div>
            ) : flatResults.length === 0 ? (
              <div className="px-4 py-8 text-center text-slate-500 text-sm">
                No results for "{query}"
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto">
                {flatResults.map((result, index) => (
                  <button
                    key={result.key}
                    onClick={() => handleResultClick(result.conversationId)}
                    className={`w-full text-left px-4 py-3 border-b border-slate-800/50 last:border-0 transition-colors ${
                      index === selectedIndex
                        ? "bg-slate-800/80"
                        : "hover:bg-slate-800/40"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-slate-400 truncate max-w-[200px]">
                        {result.title}
                      </span>
                      {!result.isOwn && (
                        <span className="text-[10px] text-slate-500 px-1.5 py-0.5 bg-slate-800 rounded">
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
                    </div>
                    <p className="text-sm text-slate-300 leading-relaxed">
                      {highlightMatch(getSnippet(result.content, query), query)}
                    </p>
                  </button>
                ))}
              </div>
            )}
            <div className="px-3 py-2 bg-slate-800/50 border-t border-slate-700/50 flex items-center justify-between text-[10px] text-slate-500">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-700 rounded text-slate-400">&#8593;</kbd>
                  <kbd className="px-1 py-0.5 bg-slate-700 rounded text-slate-400">&#8595;</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-slate-700 rounded text-slate-400">&#9166;</kbd>
                  open
                </span>
              </div>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-slate-700 rounded text-slate-400">esc</kbd>
                close
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
