import { TopbarButton } from "./TopbarButton";
import { useState, useRef, useCallback, useLayoutEffect, useMemo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useShortcutAction } from "../shortcuts";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { AppLoader } from "./AppLoader";
import { api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, type InboxSession } from "../store/inboxStore";
import { ContextMenu, useContextMenu } from "./ui/context-menu";
import { SessionMenuItems } from "./menus/ObjectContextMenus";
import { highlightMatch, getSnippet, parseSearchTerms } from "../lib/searchHighlight";
import { searchedTermsText } from "@codecast/shared/search";
import { useInstantSessionRows, mergeSearchRows } from "../lib/instantSessionSearch";
import { SessionQuerySuggestList } from "./SessionQuerySuggestList";
import { useSessionQueryAutocomplete } from "../hooks/useSessionQuerySuggestions";
import { SearchField, SearchGlyph } from "./search/SearchField";
import { SearchResultRow } from "./search/SearchResultRow";

export { parseSearchTerms, highlightMatch, getSnippet };

export function GlobalSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  // Narrow top bar: the field collapses to a lone icon button. The input is
  // display:none until expanded, so it can't take focus on the same tick the
  // icon is clicked — this flag flips the expanded classes on first, then the
  // focus lands. Cleared on blur/escape like the focus flag.
  const [iconOpen, setIconOpen] = useState(false);
  // Measured collapse, not a media query: how much room the header gives the
  // search depends on platform and content (desktop back/forward + traffic
  // lights, team size, which status chips render), so a fixed viewport
  // breakpoint either folds the field while there's still space or lets it
  // get crushed. The search's flex slot is basis-0, so its width is exactly
  // the header's leftover space and never feeds back from what we render in
  // it. As the slot tightens the field sheds the ⌘/ hint first, then folds
  // into the icon.
  const rootRef = useRef<HTMLDivElement>(null);
  const [slotSize, setSlotSize] = useState<"wide" | "medium" | "compact">("wide");
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setSlotSize(width < 140 ? "compact" : width < 210 ? "medium" : "wide");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const hideCaps = slotSize !== "wide";
  const compact = slotSize === "compact";
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchIsSlow, setSearchIsSlow] = useState(false);
  // Selection follows the SESSION, not its position: the content tier lands
  // after the instant rows are already on screen and reorders the list, and a
  // stored index would silently move the highlight onto a different session.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [userOnly, setUserOnly] = useState(false);
  const [selectedTeamId, setSelectedTeamId] = useState<Id<"teams"> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [panelTop, setPanelTop] = useState(0);
  const router = useRouter();

  const userTeams = useInboxStore((s) => s.teams);

  useWatchEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // The results panel is viewport-centered (position: fixed), so anchor its
  // vertical offset to the input's bottom edge rather than relying on top-full.
  const recomputePanelTop = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) setPanelTop(rect.bottom + 8);
  }, []);

  useWatchEffect(() => {
    if (isOpen && query.length >= 2) recomputePanelTop();
  }, [isOpen, query, recomputePanelTop]);

  useEventListener("resize", recomputePanelTop);

  // Non-throwing: when the budget blowout comes back as a TERMINAL error, bare
  // useQuery re-throws it in render and crashes the component (ct-37627). The
  // breaker unsubscribes a never-resolving search so its silent retry loop
  // stops flapping the shared websocket (1011) for the rest of the app.
  const { data: searchResults, error: searchError } = useQueryNoThrow(
    api.conversations.searchConversations,
    debouncedQuery.length >= 2
      ? { query: debouncedQuery, limit: 30, userOnly, activeTeamId: selectedTeamId ?? undefined }
      : "skip",
    { breakAfterMs: 15_000 }
  );

  // A broad term scans the whole message history and can exceed Convex's per-query
  // budget; the reactive client treats that system error as retryable and never
  // hands it to useQuery, so searchResults stays undefined and the panel would spin
  // forever. After a grace period, surface a "too broad" hint instead of a bare
  // spinner. The query stays subscribed until the 15s breaker trips — if it
  // resolves before then we show results. (see ct-37627)
  useWatchEffect(() => {
    setSearchIsSlow(false);
    if (debouncedQuery.length < 2 || searchResults !== undefined) return;
    const timer = setTimeout(() => setSearchIsSlow(true), 9000);
    return () => clearTimeout(timer);
  }, [debouncedQuery, searchResults]);

  const searchData = searchResults && "results" in searchResults ? searchResults : null;

  // Cheap always-fast companion: title/subtitle/summary matches come from the
  // small conversations table and land while (or even if never) the message
  // content search resolves — the user always gets something (ct-37627).
  // userOnly filters by message role, which title rows don't have — skip.
  const { data: titleResults } = useQueryNoThrow(
    api.conversations.searchConversationTitles,
    debouncedQuery.length >= 2 && !userOnly
      ? { query: debouncedQuery, limit: 30, activeTeamId: selectedTeamId ?? undefined }
      : "skip"
  );
  const titleData = titleResults && "results" in titleResults ? titleResults : null;

  // Instant tier: the sessions already in the store, matched off the RAW query
  // — no debounce, no round trip. The panel therefore has real rows on the
  // first keystroke, and the two server tiers land on top of them as they
  // resolve. Same rows ⌘K shows, same ranking.
  const instantRows = useInstantSessionRows(query, 12);

  // Content-match rows win, title-only rows next, cache rows fill the tail.
  const groupedResults = useMemo(
    () => mergeSearchRows(searchData?.results as any, titleData?.results as any, instantRows),
    [searchData, titleData, instantRows]
  );

  // Nothing selected (or the selected session dropped out of the list) falls
  // back to the first row, so Enter always has a target.
  const selectedIndex = useMemo(() => {
    if (!selectedId) return 0;
    const i = groupedResults.findIndex((r: any) => r.conversationId === selectedId);
    return i >= 0 ? i : 0;
  }, [groupedResults, selectedId]);

  const totalMatches = searchData?.totalMatches || 0;
  const sessionCount = groupedResults.length;
  // What the header line may claim. Content is the slow tier; until it answers
  // the count on screen is "what we can already see", never a total.
  const contentPending = debouncedQuery.length >= 2 && !searchData && !searchError;

  useShortcutAction('search.open', useCallback(() => {
    setIsOpen(true);
    setIconOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []));

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // With a context menu open, Escape belongs to the menu (Radix closes it
      // itself) — don't tear down the whole search panel on the same press.
      if (sessionCtxMenu.menu) return;
      setIsOpen(false);
      setIconOpen(false);
      setQuery("");
      inputRef.current?.blur();
    }
  }, document);

  useWatchEffect(() => {
    setSelectedId(null);
  }, [query]);

  const goToFullSearch = useCallback(() => {
    router.push(`/search?q=${encodeURIComponent(query.trim())}${userOnly ? "&user=1" : ""}`);
    setIsOpen(false);
    setIconOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }, [router, query, userOnly]);

  const autocomplete = useSessionQueryAutocomplete(query, setQuery, inputRef);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (autocomplete.onKeyDown(e)) return;
      const results = groupedResults;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = e.key === "ArrowDown"
          ? Math.min(selectedIndex + 1, results.length - 1)
          : Math.max(selectedIndex - 1, 0);
        setSelectedId(results[next]?.conversationId ?? null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (query.trim().length < 2) return;
        if (!e.shiftKey && results[selectedIndex]) {
          router.push(
            `/conversation/${results[selectedIndex].conversationId}?highlight=${encodeURIComponent(searchedTermsText(query))}`
          );
          setIsOpen(false);
          setIconOpen(false);
          setQuery("");
          inputRef.current?.blur();
        } else {
          // Shift+Enter always jumps to the full search page; plain Enter
          // lands here too while results are still loading (or empty), so
          // the user is never stuck waiting behind the spinner.
          goToFullSearch();
        }
      }
    },
    [autocomplete, groupedResults, selectedIndex, router, query, goToFullSearch]
  );

  const handleResultClick = (conversationId: string) => {
    const url = `/conversation/${conversationId}?highlight=${encodeURIComponent(searchedTermsText(query))}`;
    router.push(url);
    setIsOpen(false);
    setIconOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  // One cursor menu for all result rows. The full triage menu (pin, label,
  // stash…) mutates the inbox-store row, so it needs both proof of ownership
  // (server-computed isOwn) AND the session present in the store; anything
  // else gets the read-only foreign menu.
  const sessionCtxMenu = useContextMenu<{ session: InboxSession; isForeign: boolean; conversationId: string }>();
  const openSessionMenu = (e: React.MouseEvent, row: any) => {
    const stored = useInboxStore.getState().sessions[row.conversationId];
    const isForeign = !(row.isOwn === true && stored);
    sessionCtxMenu.open(e, {
      session: stored ?? ({ _id: row.conversationId, title: row.title } as InboxSession),
      isForeign,
      conversationId: row.conversationId,
    });
  };

  const isExpanded = isFocused || query.length > 0 || iconOpen;

  return (
    // z-[240]: above every page surface and z-[200] overlay, but BELOW the
    // dropdown-menu portal layer (z-[250]) so the right-click context menu on
    // result rows paints over this panel. CommandPalette (9999) still wins.
    <div ref={rootRef} className="relative w-full min-w-0 z-[240] flex justify-center">
      {/* Slot too tight for a usable field: it folds into this one button;
          clicking it expands the field as a fixed overlay centered over the
          header (.tb-search-overlay in globals.css). */}
      {compact && !isExpanded && (
        <TopbarButton
          onClick={() => {
            setIconOpen(true);
            setIsOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          aria-label="Search sessions"
          title="Search sessions"
        >
          <SearchGlyph />
        </TopbarButton>
      )}
      <SearchField
        value={query}
        expanded={isExpanded}
        compact={compact}
        hideCaps={hideCaps}
        inputRef={inputRef}
        onChange={(e) => {
          setQuery(e.target.value);
          autocomplete.trackCaret(e.target);
          // Clear the slow-search hint the instant the term changes, so it can
          // never linger from a prior broad query onto a fresh, fast one.
          setSearchIsSlow(false);
          if (!isOpen) setIsOpen(true);
        }}
        inputProps={{
          onSelect: autocomplete.inputHandlers.onSelect,
          onFocus: () => { setIsFocused(true); setIsOpen(true); autocomplete.inputHandlers.onFocus(); },
          onBlur: () => { setIsFocused(false); setIconOpen(false); autocomplete.inputHandlers.onBlur(); },
          onKeyDown: handleKeyDown,
        }}
      >
        {autocomplete.open && <SessionQuerySuggestList {...autocomplete.listProps} className="z-[250]" />}
      </SearchField>

      {isOpen && query.length >= 2 && (
        <div
          style={{ top: panelTop }}
          className="fixed left-1/2 -translate-x-1/2 w-[min(1200px,calc(100vw-2rem))] bg-sol-bg border border-sol-border rounded-xl shadow-2xl shadow-black/50 overflow-hidden z-[240]"
        >
            {groupedResults.length === 0 && !searchData ? (
              searchIsSlow || searchError ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-sol-text-secondary mb-2">
                    {searchError ? "Search timed out" : "This search is taking a while"}
                  </p>
                  <p className="text-xs text-sol-text-dim mb-3">
                    Broad terms scan your whole history and can time out. Try a more specific word, or wrap an exact phrase in quotes.
                  </p>
                  <button
                    onClick={goToFullSearch}
                    className="text-xs text-sol-text-secondary hover:text-sol-text px-2.5 py-1 rounded-md border border-sol-border bg-sol-bg-alt hover:bg-sol-bg-highlight transition-colors"
                  >
                    Open full search — narrow by time or scope
                  </button>
                </div>
              ) : (
                <AppLoader className="min-h-0 bg-transparent py-8" size={24} />
              )
            ) : groupedResults.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-sol-text-secondary mb-2">No conversations match</p>
                <p className="text-xs text-sol-text-dim">Try different keywords</p>
              </div>
            ) : (
              <div className="max-h-[80vh] overflow-y-auto">
                <div className="relative px-4 py-2 border-b border-sol-border text-xs text-sol-text-secondary">
                  {searchData
                    ? <>{totalMatches} match{totalMatches !== 1 ? "es" : ""} in {sessionCount} session{sessionCount !== 1 ? "s" : ""}</>
                    : <>{sessionCount} session{sessionCount !== 1 ? "s" : ""} matched by name</>}
                  {contentPending && <span className="text-sol-text-dim"> · searching message content…</span>}
                  {searchError && <span className="text-sol-text-dim"> · content search timed out</span>}
                  {/* The one thing a moving bar should say: the slower tier is
                      still running. It rides the header's bottom edge so rows
                      never shift when it appears or goes. */}
                  {contentPending && (
                    <span className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
                      <span className="search-scan-bar block h-full w-1/3 bg-gradient-to-r from-transparent via-sol-cyan to-transparent" />
                    </span>
                  )}
                </div>
                <div className="space-y-1 py-1">
                {groupedResults.map((session, sessionIndex) => (
                  <SearchResultRow
                    key={session.conversationId}
                    session={session}
                    query={query}
                    selected={sessionIndex === selectedIndex}
                    onClick={() => handleResultClick(session.conversationId)}
                    onContextMenu={(e) => openSessionMenu(e, session)}
                  />
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
                      {userTeams.map((team: any) => (
                        <option key={team?._id} value={team?._id}>
                          {team?.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <span className="text-sol-border">|</span>
                <span className="flex items-center gap-1">
                  <KeyCap size="xs">↑</KeyCap>
                  <KeyCap size="xs">↓</KeyCap>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <KeyCap size="xs">↵</KeyCap>
                  open
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span
                  onClick={goToFullSearch}
                  className="flex items-center gap-1 cursor-pointer text-sol-text-secondary hover:text-sol-text transition-colors"
                >
                  <KeyCap size="xs">⇧</KeyCap>
                  <KeyCap size="xs">↵</KeyCap>
                  full search
                </span>
                <span className="flex items-center gap-1">
                  <KeyCap size="xs">Esc</KeyCap>
                  close
                </span>
              </div>
            </div>
        </div>
      )}

      <ContextMenu state={sessionCtxMenu}>
        {({ session, isForeign, conversationId }) => (
          <SessionMenuItems
            session={session}
            isForeign={isForeign}
            onOpen={() => handleResultClick(conversationId)}
          />
        )}
      </ContextMenu>
    </div>
  );
}
