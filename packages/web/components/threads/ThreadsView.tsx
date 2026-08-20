import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutList } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useChatMembers, useChatRail } from "../../hooks/useChatSync";
import { useThreadInbox, useThreadInboxCards, useThreadsInboxSync } from "../../hooks/useThreadsSync";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTeamFeature } from "../../lib/teamFeatures";
import { memberName } from "../../lib/chatViews";
import {
  THREAD_KIND_META,
  cardsForChip,
  chipFromSearch,
  dmCards,
  frozenReadAtOf,
  markViewRead,
  serverCards,
  sortCards,
  unreadByChip,
  visibleChips,
  type ThreadCardModel,
} from "../../lib/threadKinds";
import { SegmentedToggle } from "../SegmentedToggle";
import { Switch } from "../ui/switch";
import { NewMessageModal } from "../chat/NewMessageModal";
import { ThreadCard } from "./ThreadCard";
import { ThreadsHeader } from "./ThreadsHeader";
import { ThreadsEmpty } from "./ThreadsEmpty";
import { useSessionThreadCards } from "../../hooks/useSessionThreadCards";
import { queryCircuitOpenError } from "../../hooks/useQueryNoThrow";
import { ThreadsPageCtx, type ThreadsPageContextValue } from "./threadsContext";
import "../chat/chat.css";
import "./threads.css";

// The Threads page body: every conversation the viewer is in — chat threads,
// DMs, session comment threads, task comment streams, and (toggle) inbox
// sessions — one card list, newest activity first, filtered by a single
// select chip. One card is open at a time; its unread boundary is frozen at
// expansion so marking read cannot erase it mid-read; reads happen only while
// the reader is present (tab active, window focused).
//
// The chips are the app's SegmentedToggle rather than GenericListView's tab
// bar: the page is a single-select view over one list in chat-style chrome,
// not a multi-select list page under a PageShell header, and the bordered
// pill group is the control every chat-style header already uses.

const CLOCK_MS = 30_000;

export function ThreadsView({ present }: { present: boolean }) {
  const router = useRouter();
  const search = useSearchParams();
  const chatOn = useTeamFeature("chat");
  const chip = chipFromSearch(search.get("type"), chatOn);
  const setChip = useCallback(
    (key: string) => router.replace(key === "all" ? "/threads" : `/threads?type=${key}`),
    [router],
  );
  const includeSessions = useInboxStore((s) => s.clientState.ui?.threads_include_sessions === true);
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const now = useCoarseNow(CLOCK_MS);

  // ── Sources ───────────────────────────────────────────────────────────────
  const feed = useThreadsInboxSync();
  const rows = useThreadInbox();
  const rail = useChatRail();
  const chatCardList = useThreadInboxCards();
  const chatCards = useMemo(() => new Map(chatCardList.map((c) => [c.entry.root_key, c])), [chatCardList]);
  const { members, byId, viewerId, handles } = useChatMembers();
  const sessionCardList = useSessionThreadCards(includeSessions && chip === "all");
  // Task short ids give the canonical /tasks/<short_id> link. One string
  // signature over just the task rows on the page, not the tasks collection.
  const taskShortSig = useInboxStore((s) => {
    let sig = "";
    for (const r of rows) if (r.kind === "task") sig += `${(s.tasks[String(r.task_id ?? r.root_key)] as any)?.short_id ?? ""}|`;
    return sig;
  });

  const allCards = useMemo(() => {
    const railById = new Map(rail.map((c) => [c.id, c]));
    const tasks = useInboxStore.getState().tasks as Record<string, { short_id?: string }>;
    const server = serverCards(rows, (id) => railById.get(id)?.kind, (id) => tasks[id]?.short_id);
    return [...server, ...dmCards(chatOn ? rail : []), ...sessionCardList];
    // taskShortSig is the wake for the short id lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rail, chatOn, sessionCardList, taskShortSig]);
  const counts = useMemo(() => unreadByChip(allCards), [allCards]);
  const cards = useMemo(
    () => sortCards(cardsForChip(allCards, chip, includeSessions)),
    [allCards, chip, includeSessions],
  );

  // ── One open card ─────────────────────────────────────────────────────────
  const [open, setOpen] = useState<{ id: string; frozenReadAt: number } | null>(null);
  const toggle = useCallback((card: ThreadCardModel) => {
    setOpen((prev) => (prev?.id === card.id ? null : { id: card.id, frozenReadAt: frozenReadAtOf(card) }));
  }, []);

  const nameOf = useCallback((userId: string) => memberName(byId.get(String(userId))), [byId]);
  const ctx = useMemo<ThreadsPageContextValue>(
    () => ({ now, present, teamId, viewerId, members, handles, nameOf, chatCards, toggle }),
    [now, present, teamId, viewerId, members, handles, nameOf, chatCards, toggle],
  );

  // ── Header + chips ────────────────────────────────────────────────────────
  const viewUnread = counts[chip];
  const markAll = useCallback(() => markViewRead(cards, chip, teamId), [cards, chip, teamId]);
  const chipItems = useMemo(
    () => visibleChips(chatOn).map((c) => ({
      key: c.key,
      label: c.label,
      icon: c.key === "all" ? LayoutList : THREAD_KIND_META[c.key].icon,
      count: counts[c.key] || undefined,
    })),
    [chatOn, counts],
  );
  const toggleSessions = useCallback(() => {
    const next = !includeSessions;
    useInboxStore.getState().updateClientUI({ threads_include_sessions: next });
    if (next && chip !== "all") setChip("all");
  }, [includeSessions, chip, setChip]);

  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const openNewMessage = useCallback(() => setNewMessageOpen(true), []);

  const showSkeleton = cards.length === 0 && feed.loading && chip !== "dm";
  // The DM chip reads the chat rail, not this feed, so its error never hides DMs.
  const feedFailed = !!feed.error && chip !== "dm";
  const showEmpty = cards.length === 0 && !showSkeleton && !feedFailed;

  return (
    <ThreadsPageCtx.Provider value={ctx}>
      <div className="ch-shell">
        <div className="ch-main">
          <ThreadsHeader unread={viewUnread} total={cards.length} onMarkAllRead={markAll} />

          <div className="th-bar">
            <SegmentedToggle value={chip} onChange={setChip} items={chipItems} collapse />
            {/* An additive switch, not a second chip: sessions join the All view. */}
            <label className="th-toggle" title="Show your inbox sessions as cards (under All)">
              <Switch checked={includeSessions} onCheckedChange={toggleSessions} />
              Sessions
            </label>
          </div>

          {showSkeleton ? (
            <div className="ch-skeleton" role="status" aria-label="Loading threads">
              {[0, 1, 2].map((i) => (
                <div className="ch-skel-row" key={i}>
                  <div className="ch-skel-avatar" />
                  <div className="ch-skel-lines">
                    <div className="ch-skel-line ch-skel-head" />
                    <div className="ch-skel-line" style={{ width: `${70 - i * 12}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : showEmpty ? (
            <ThreadsEmpty chip={chip} sessionsOn={includeSessions} onNewMessage={chatOn ? openNewMessage : undefined} />
          ) : (
            <div className="th-scroll">
              {feedFailed && (
                <div className="ch-search-hint" role="alert">
                  <p>{feed.error === queryCircuitOpenError ? "Threads timed out." : "Threads are not answering."}</p>
                  <p className="ch-search-hint-sub">
                    {cards.length > 0 ? "Showing what is cached. " : ""}
                    <button type="button" className="ch-agent-retry" onClick={feed.retry}>Try again</button>
                  </p>
                </div>
              )}
              {cards.map((card) => (
                <ThreadCard
                  key={card.id}
                  card={card}
                  expanded={open?.id === card.id}
                  frozenReadAt={open?.id === card.id ? open.frozenReadAt : 0}
                />
              ))}
              {/* The feed pages the mixed list, so only All can promise older
                  items; a kind chip's list is whatever has paged in. */}
              {feed.hasMore && chip === "all" && (
                <button type="button" className="th-older" onClick={feed.loadOlder} disabled={feed.isLoadingOlder}>
                  {feed.isLoadingOlder ? "Loading…" : "Show older threads"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {newMessageOpen && <NewMessageModal onClose={() => setNewMessageOpen(false)} />}
    </ThreadsPageCtx.Provider>
  );
}

