import { useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { KeyCap, MenuKeyCaps } from "../../components/KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";
import { Search, Loader2, ExternalLink, Link as LinkIcon, Users, Clock, ArrowUpDown, MessageSquareText, Hash } from "lucide-react";
import { toast } from "sonner";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator } from "../../components/ui/context-menu";
import { SessionMenuItems } from "../../components/menus/ObjectContextMenus";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { searchedTermsText } from "@codecast/shared/search";
import { copyToClipboard, shareOrigin } from "../../lib/utils";
import { SESSION_QUERY_OPERATORS } from "@codecast/shared/search";
import { useSessionQueryAutocomplete } from "../../hooks/useSessionQuerySuggestions";
import { SessionQuerySuggestList } from "../../components/SessionQuerySuggestList";
import { FeatureUpsell } from "../../components/agentFeatures/FeatureUpsell";
import { useAssistantScope, useModeWords, useSurface } from "../../lib/surfaces";
import { AssistantScopeSwitch, MoreInEverything } from "../../components/AssistantScopeSwitch";
import { useUniversalSearch, SEARCH_KIND_CAP, SEARCH_PAGE_SIZE, SEARCH_RANGES, SEARCH_RANGE_MS, type SearchRange } from "../../hooks/useUniversalSearch";
import { objectKindLabel, type ObjectKind } from "../../hooks/useObjectSearch";
import { useTeamFeature } from "../../lib/teamFeatures";
import { SessionHit, type SessionHitRow } from "../../components/search/SessionHit";
import { ObjectHit } from "../../components/search/ObjectHit";
import { MatchSnippet } from "../../components/search/MatchSnippet";
import { SegmentedToggle } from "../../components/SegmentedToggle";
import { FilterDropdown } from "../../components/FilterDropdown";
import { AuthorAvatar } from "../../components/entityDisplay";
import { lineAuthorFor } from "../../lib/chatViews";
import { CommentAvatar } from "../../components/comments/CommentAvatar";

// Right-click payloads: a session header row or one message match inside it.
type SearchCtxPayload =
  | { kind: "session"; result: any; session: InboxSession; isForeign: boolean }
  | { kind: "message"; result: any; messageId: string };

/** What the results list: everything, one kind of object, conversations or chat. */
type Tab = "all" | "sessions" | "chat" | ObjectKind;
const OBJECT_KINDS: ObjectKind[] = ["task", "plan", "doc", "trigger", "project", "initiative", "role", "person", "page"];
const TABS = new Set<string>(["all", "sessions", "chat", ...OBJECT_KINDS]);

/** Rows each kind shows under All before its "all N" link. */
const ALL_CAP = 3;

/** The page's state as the URL carries it, so a narrowed view is a link. */
function readParams(p: URLSearchParams) {
  const range = p.get("range") || "";
  const kind = p.get("kind") || "";
  return {
    query: p.get("q") || "",
    mineOnly: p.get("mine") === "1",
    // `userOnly=true` is the legacy param name for the same filter.
    userOnly: p.get("user") === "1" || p.get("userOnly") === "true",
    range: (["7d", "30d", "90d"].includes(range) ? range : "all") as SearchRange,
    sort: (p.get("sort") === "relevance" ? "relevance" : "recent") as "recent" | "relevance",
    tab: (TABS.has(kind) ? kind : "all") as Tab,
  };
}

function ResultSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse rounded-lg px-3 py-3" style={{ animationDelay: `${i * 120}ms` }}>
          <div className="flex items-center gap-2">
            <div className="h-[18px] w-[18px] rounded-full bg-sol-bg-highlight" />
            <div className="h-3.5 w-1/3 rounded bg-sol-bg-highlight" />
            <div className="ml-auto h-3 w-14 rounded bg-sol-bg-highlight" />
          </div>
          <div className="mt-3 ml-[26px] space-y-2 border-l border-sol-border/50 pl-4">
            <div className="h-3 w-5/6 rounded bg-sol-bg-highlight" />
            <div className="h-3 w-2/3 rounded bg-sol-bg-highlight" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A group's heading: its name and count, and under All the way to the rest. */
function GroupHeading({ label, count, more, onMore }: { label: string; count?: number | string; more?: boolean; onMore?: () => void }) {
  return (
    <div className="mb-1 flex items-baseline gap-2 px-3">
      <h2 className="text-[11px] font-medium uppercase tracking-wider text-sol-text-muted">{label}</h2>
      {count != null && <span className="text-[11px] tabular-nums text-sol-text-dim">{count}</span>}
      {more && onMore && (
        <button onClick={onMore} className="ml-auto text-[11px] text-sol-text-dim hover:text-sol-text">
          All {count}
        </button>
      )}
    </div>
  );
}

export default function SearchPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initial = readParams(searchParams);

  const [query, setQuery] = useState(initial.query);
  const [mineOnly, setMineOnly] = useState(initial.mineOnly);
  const [userOnly, setUserOnly] = useState(initial.userOnly);
  const [range, setRange] = useState<SearchRange>(initial.range);
  const [sort, setSort] = useState<"recent" | "relevance">(initial.sort);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [limit, setLimit] = useState(SEARCH_PAGE_SIZE);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  // Hosted mode searches the person's conversations in plain words: no
  // operators, no team or role scopes, and the Assistant scope holds here as
  // it does in the inbox and the palette.
  const internals = useSurface("search.internals");
  const words = useModeWords();
  const { only: scopeOnly } = useAssistantScope();
  const autocomplete = useSessionQueryAutocomplete(query, setQuery, inputRef, true);
  const chatOn = useTeamFeature("chat");
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);

  // The search itself, shared with the phone (hooks/useUniversalSearch).
  const search = useUniversalSearch(query, { mineOnly, userOnly, range, sort }, {
    limit,
    scopeOnly,
    chatTeamId: chatOn ? activeTeamId : null,
    chatLimit: tab === "chat" ? 30 : 10,
  });
  const {
    debouncedQuery, parsedQuery, searchActive, searchData, searchError, sessionRows, hiddenByScope,
    objectGroups, chatHits, totalMatches, totalSessions, isLoading, queryErrors,
  } = search;
  const hlQuery = search.highlight;
  const hasMore = search.remaining > 0;

  useWatchEffect(() => {
    setLimit(SEARCH_PAGE_SIZE);
    setSelectedIdx(-1);
  }, [debouncedQuery, mineOnly, userOnly, range, sort, tab]);

  const lastWrittenUrl = useRef<string | null>(null);
  useWatchEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    if (tab !== "all") params.set("kind", tab);
    if (mineOnly) params.set("mine", "1");
    if (userOnly) params.set("user", "1");
    if (range !== "all") params.set("range", range);
    if (sort !== "recent") params.set("sort", sort);
    const url = `/search${params.toString() ? `?${params.toString()}` : ""}`;
    lastWrittenUrl.current = url;
    router.replace(url);
  }, [debouncedQuery, tab, mineOnly, userOnly, range, sort, router]);

  // The tab shell keeps this page mounted across navigations, so a fresh
  // /search?q=… arriving from elsewhere (palette ⌘↵, a link) only changes the
  // URL: adopt it into local state unless it's our own write echoing back.
  const searchParamsKey = searchParams.toString();
  useWatchEffect(() => {
    const current = `/search${searchParamsKey ? `?${searchParamsKey}` : ""}`;
    if (lastWrittenUrl.current === current) return;
    const next = readParams(searchParams);
    setQuery(next.query);
    setMineOnly(next.mineOnly);
    setUserOnly(next.userOnly);
    setRange(next.range);
    setSort(next.sort);
    setTab(next.tab);
  }, [searchParamsKey]);

  const hrefFor = (result: SessionHitRow, messageId?: string) =>
    `/conversation/${result.conversationId}${
      parsedQuery.text ? `?highlight=${encodeURIComponent(searchedTermsText(parsedQuery.text))}` : ""
    }${messageId ? `#msg-${messageId}` : ""}`;

  // What the current tab lists, in reading order: the list the arrow keys walk.
  const showObjects = tab === "all" ? objectGroups : objectGroups.filter((g) => g.kind === tab);
  const showSessions = tab === "all" || tab === "sessions";
  const showChat = (tab === "all" || tab === "chat") && chatHits.length > 0;
  const cap = tab === "all" ? ALL_CAP : SEARCH_KIND_CAP;
  const chatCap = tab === "all" ? ALL_CAP : chatHits.length;
  const nav: Array<{ key: string; href: string; external?: boolean; session?: SessionHitRow }> = [
    ...showObjects.flatMap((g) => g.hits.slice(0, cap).map((h) => ({ key: `${g.kind}:${h.key}`, href: h.href, external: h.external }))),
    ...(showChat ? chatHits.slice(0, chatCap).map((h) => ({ key: `chat:${h._id}`, href: h.permalink })) : []),
    ...(showSessions ? sessionRows.map((r) => ({ key: `session:${r.conversationId}`, href: hrefFor(r, r.matches?.[0]?.messageId), session: r })) : []),
  ];
  const navIndex = new Map(nav.map((n, i) => [n.key, i]));
  const selectedKey = selectedIdx >= 0 ? nav[selectedIdx]?.key : undefined;

  const open = (i: number, newTab = false) => {
    const item = nav[i];
    if (!item) return;
    if (newTab || item.external) window.open(item.href, "_blank");
    else router.push(item.href);
  };

  // One menu instance for the whole result list; rows call open(e, payload).
  const ctxMenu = useContextMenu<SearchCtxPayload>();

  // The full triage menu (pin, label, stash…) mutates the inbox-store row, so
  // it needs both proof of ownership (server-computed isOwn: row user vs auth
  // user) AND the session present in the store. An own session outside the
  // inbox window falls back to the read-only foreign menu: honest, never
  // broken verbs.
  const openSessionMenu = (e: React.MouseEvent, result: SessionHitRow) => {
    const stored = useInboxStore.getState().sessions[result.conversationId];
    const isForeign = !(result.isOwn === true && stored);
    ctxMenu.open(e, {
      kind: "session",
      result,
      session: stored ?? ({ _id: result.conversationId, title: result.title } as InboxSession),
      isForeign,
    });
  };

  // Arrow keys drive selection while focus stays in the input; single-letter
  // keys never leave the field, so no global shortcut leaks.
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (internals && autocomplete.onKeyDown(e as React.KeyboardEvent<HTMLInputElement>)) return;
    if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
      return;
    }
    if (!nav.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(selectedIdx + 1, nav.length - 1) : Math.max(selectedIdx - 1, -1);
      setSelectedIdx(next);
      if (next >= 0) document.querySelector(`[data-nav-key="${CSS.escape(nav[next].key)}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && selectedIdx >= 0) {
      e.preventDefault();
      open(selectedIdx, e.metaKey || e.ctrlKey);
    }
  };

  const hover = (key: string) => () => setSelectedIdx(navIndex.get(key) ?? -1);
  const countLabel = (n: number) => (n >= SEARCH_KIND_CAP ? `${SEARCH_KIND_CAP}+` : n);

  // The tabs: All, then each kind that found something, conversations first.
  // The tab in view stays even when its kind empties, so the page never jumps.
  const tabItems = [
    { key: "all", label: "All" },
    { key: "sessions", label: words.conversations, count: totalSessions },
    ...objectGroups.map((g) => ({ key: g.kind, label: g.label, count: g.hits.length })),
    ...(chatHits.length > 0 ? [{ key: "chat", label: "Chat", count: chatHits.length }] : []),
  ];
  if (!tabItems.some((t) => t.key === tab)) tabItems.push({ key: tab, label: tab === "chat" ? "Chat" : objectKindLabel(tab as ObjectKind, words), count: 0 });

  const sessionFilters = showSessions;
  const anyResults = nav.length > 0;
  const memberById = useMemo(() => {
    const members = ((useInboxStore.getState() as any).teamMembers ?? []) as any[];
    return new Map(members.map((m) => [String(m._id), m]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatHits]);

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="mx-auto max-w-3xl space-y-4" data-search-page>
          <div className="space-y-2.5">
            <div className="group relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4">
                <Search data-cc-search-icon className="h-[18px] w-[18px] text-sol-text-dim transition-colors group-focus-within:text-sol-text" />
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
                className="w-full rounded-xl border border-sol-border bg-sol-bg-alt py-3 pl-11 pr-12 text-[15px] text-sol-text placeholder-sol-text-dim shadow-sm transition-all focus:border-sol-text/50 focus:outline-none focus:ring-[3px] focus:ring-sol-text/[0.06]"
                autoFocus
              />
              <div className="absolute inset-y-0 right-0 flex items-center pr-4">
                {isLoading ? (
                  <Loader2 data-cc-search-icon className="h-4 w-4 animate-spin text-sol-text-dim" />
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

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
              {searchActive && (
                <div className="min-w-0 overflow-x-auto" data-search-tabs>
                  <SegmentedToggle variant="bare" value={tab} onChange={(k) => setTab(k as Tab)} items={tabItems.map((t) => ({ ...t, count: typeof t.count === "number" ? t.count : undefined }))} />
                </div>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <AssistantScopeSwitch label="Which conversations this searches" hidden={hiddenByScope} />
                {internals && sessionFilters && (
                  <FilterDropdown
                    label="Everyone"
                    icon={<Users className="h-3.5 w-3.5" />}
                    value={mineOnly ? "mine" : ""}
                    options={[{ key: "", label: "Everyone" }, { key: "mine", label: "Only mine" }]}
                    onChange={(v) => setMineOnly(v === "mine")}
                  />
                )}
                {internals && sessionFilters && (
                  <FilterDropdown
                    label="Any message"
                    icon={<MessageSquareText className="h-3.5 w-3.5" />}
                    value={userOnly ? "prompts" : ""}
                    options={[{ key: "", label: "Any message" }, { key: "prompts", label: "My prompts" }]}
                    onChange={(v) => setUserOnly(v === "prompts")}
                  />
                )}
                <FilterDropdown
                  label="Any time"
                  icon={<Clock className="h-3.5 w-3.5" />}
                  value={range === "all" ? "" : range}
                  options={SEARCH_RANGES.map((r) => ({ key: r.key === "all" ? "" : r.key, label: r.label }))}
                  onChange={(v) => setRange((v || "all") as SearchRange)}
                />
                {internals && sessionFilters && (
                  <FilterDropdown
                    label="Recent"
                    icon={<ArrowUpDown className="h-3.5 w-3.5" />}
                    value={sort === "relevance" ? "relevance" : ""}
                    options={[{ key: "", label: "Recent" }, { key: "relevance", label: "Relevant" }]}
                    onChange={(v) => setSort(v === "relevance" ? "relevance" : "recent")}
                  />
                )}
              </div>
            </div>
          </div>

          <FeatureUpsell
            slug="memory"
            reason="Your agents can run this same search themselves, so they start a task from what earlier sessions already decided."
          />

          {/* Content the slow tier has not answered yet, or never will. */}
          {showSessions && searchActive && !searchData && sessionRows.length > 0 && (
            <div className="flex items-center gap-2 px-3 text-xs text-sol-text-dim">
              {!searchError && <Loader2 className="h-3 w-3 animate-spin" />}
              {searchError
                ? `Content search timed out, so these are ${words.conversations.toLowerCase()} matched by name. Try a more specific word or a quoted phrase.`
                : `Searching what was said…`}
            </div>
          )}

          {/* An operator walk that stopped at its read budget: the rows are
              the newest part of the answer, and each line says how to reach
              the rest. */}
          {showSessions && searchActive && !!searchData?.truncated?.length && (
            <div className="space-y-0.5 px-3 text-xs text-sol-text-dim">
              {searchData.truncated.map((line: string) => (
                <p key={line}><span className="text-sol-yellow">Partial:</span> {line}</p>
              ))}
            </div>
          )}

          {searchActive && showObjects.map((g) => (
            <section key={g.kind} data-search-group={g.kind}>
              {tab === "all" && <GroupHeading label={g.label} count={countLabel(g.hits.length)} more={g.hits.length > ALL_CAP} onMore={() => setTab(g.kind)} />}
              <div className="space-y-0.5">
                {g.hits.slice(0, cap).map((h) => {
                  const key = `${g.kind}:${h.key}`;
                  return (
                    <div key={key} data-nav-key={key}>
                      <ObjectHit hit={h} highlight={hlQuery} selected={selectedKey === key} onHover={hover(key)} />
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {searchActive && showChat && (
            <section data-search-group="chat">
              {tab === "all" && <GroupHeading label="Chat" count={chatHits.length} more={chatHits.length > ALL_CAP} onMore={() => setTab("chat")} />}
              <div className="space-y-0.5">
                {chatHits.slice(0, chatCap).map((h) => {
                  const key = `chat:${h._id}`;
                  const author = lineAuthorFor(h, { members: memberById });
                  const name = author.name;
                  return (
                    <div
                      key={key}
                      data-nav-key={key}
                      onMouseEnter={hover(key)}
                      className={`rounded-lg border transition-colors ${selectedKey === key ? "border-sol-border bg-sol-bg-alt shadow-sm" : "border-transparent hover:border-sol-border/60 hover:bg-sol-bg-alt/60"}`}
                    >
                      <MatchSnippet
                        content={h.snippet ?? ""}
                        timestamp={h.created_at}
                        userText
                        highlight={hlQuery}
                        href={h.permalink}
                        who={(
                          <>
                            {author.isAgent
                              ? <CommentAvatar name={name} isAgent agentType={author.session?.agentType} size={16} />
                              : <AuthorAvatar name={name} avatar={author.avatarUrl} size={16} />}
                            <span className="truncate font-medium text-sol-text">{name}</span>
                            <span className="flex flex-shrink-0 items-center gap-0.5 text-sol-text-dim">
                              {h.channel_kind === "dm" ? "direct message" : <><Hash className="h-3 w-3" />{h.channel_name}</>}
                            </span>
                          </>
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {showSessions && searchActive && !searchData && sessionRows.length === 0 && (
            searchError ? (
              <div className="px-4 py-10 text-center">
                <p className="mb-2 text-sm text-sol-text-secondary">Search timed out</p>
                <p className="text-xs text-sol-text-dim">
                  Broad terms scan your whole history and can time out. Try a more specific word, wrap an exact phrase in quotes, or narrow the time range.
                </p>
              </div>
            ) : (
              <ResultSkeleton />
            )
          )}

          {showSessions && sessionRows.length > 0 && (
            <section data-search-group="sessions" data-search-conversations>
              <GroupHeading
                label={words.conversations}
                count={internals && parsedQuery.text && totalMatches >= totalSessions && searchData
                  ? `${totalSessions} · ${totalMatches} match${totalMatches !== 1 ? "es" : ""}`
                  : totalSessions}
              />
              {/* The recent tier bounds content matches to a trailing window;
                  titles cover all time. Only worth saying when the selected
                  range exceeds the window. Hosted mode leaves the window to the
                  engine: the line reads as a developer's caveat. */}
              {internals && searchActive && parsedQuery.text && searchData?.contentTier === "recent" &&
                (range === "all" || SEARCH_RANGE_MS[range] > (searchData.contentWindowDays ?? 30) * 86_400_000) && (
                <p className="mb-1 px-3 text-[11px] text-sol-text-dim">
                  Messages from the last {searchData.contentWindowDays ?? 30} days. Older {words.conversations.toLowerCase()} match by title and summary.
                </p>
              )}
              <div className="space-y-1">
                {sessionRows.map((result) => {
                  const key = `session:${result.conversationId}`;
                  return (
                    <div key={key} data-nav-key={key}>
                      <SessionHit
                        row={result}
                        highlight={hlQuery}
                        hrefFor={hrefFor}
                        selected={selectedKey === key}
                        maxMatches={tab === "sessions" ? 5 : 3}
                        onHover={hover(key)}
                        onSessionMenu={(e) => openSessionMenu(e, result)}
                        onMatchMenu={(e, messageId) => ctxMenu.open(e, { kind: "message", result, messageId })}
                      />
                    </div>
                  );
                })}
              </div>
              {hasMore && (
                <button
                  onClick={() => setLimit((l) => l + SEARCH_PAGE_SIZE)}
                  className="mt-2 w-full rounded-lg py-2.5 text-[13px] text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-text"
                >
                  Show more ({search.remaining} remaining)
                </button>
              )}
            </section>
          )}

          {searchActive && <MoreInEverything hidden={hiddenByScope} centered />}

          {searchActive && searchData && !anyResults && !isLoading && queryErrors.length === 0 && (
            <div className="space-y-2 py-16 text-center">
              <p className="text-sol-text-secondary">Nothing found for &ldquo;{debouncedQuery}&rdquo;</p>
              <p className="text-sm text-sol-text-dim">
                {mineOnly || userOnly || range !== "all" || tab !== "all"
                  ? "Try widening the filters, or different words."
                  : 'Try different words, or "quotes" for an exact phrase.'}
              </p>
            </div>
          )}

          {!searchActive && queryErrors.length === 0 && (
            <div className="space-y-3 py-16 text-center">
              <Search className="mx-auto h-8 w-8 text-sol-text-dim/40" />
              <p className="text-sm text-sol-text-dim">
                {internals
                  ? <>Sessions, tasks, plans, docs, routines, people and chat across {mineOnly ? "your" : "your team's"} workspace.</>
                  : "Search your conversations, to-dos and notes."}
              </p>
              <p className="text-[11px] text-sol-text-dim/70">
                Open this page from anywhere with{" "}
                <MenuKeyCaps action="palette.toggle" className="inline-flex items-center gap-0.5" /> then{" "}
                <span className="inline-flex items-center gap-0.5"><KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap></span>
              </p>
              {/* The operators `cast search` reads too; the URL keeps the
                  whole query, so a narrowed view is a link. */}
              {internals && <div className="mx-auto flex max-w-lg flex-wrap justify-center gap-1.5 pt-2">
                {SESSION_QUERY_OPERATORS.map((o) => (
                  <button
                    key={o.op}
                    title={`${o.example}: ${o.hint}`}
                    onClick={() => {
                      setQuery((q) => `${q.trim() ? `${q.trim()} ` : ""}${o.op}`);
                      autocomplete.resetCaret();
                      inputRef.current?.focus();
                    }}
                    className="rounded border border-sol-border/60 bg-sol-bg-alt px-1.5 py-0.5 font-mono text-[11px] text-sol-text-secondary transition-colors hover:border-sol-text/30 hover:text-sol-text"
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
                onOpen={() => router.push(hrefFor(p.result, p.result.matches?.[0]?.messageId))}
              />
            ) : (
              <>
                <CtxHeader title={p.result.title || "Message"} />
                <CtxItem icon={ExternalLink} onSelect={() => router.push(hrefFor(p.result, p.messageId))}>
                  Open
                </CtxItem>
                <CtxItem icon={ExternalLink} onSelect={() => window.open(hrefFor(p.result, p.messageId), "_blank")}>
                  Open in new tab
                </CtxItem>
                <CtxSeparator />
                <CtxItem
                  icon={LinkIcon}
                  onSelect={() =>
                    copyToClipboard(`${shareOrigin()}/conversation/${p.result.conversationId}#msg-${p.messageId}`)
                      .then(() => toast.success("Link copied"))
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
