import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutList } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useChatMembers, useChatRail } from "../../hooks/useChatSync";
import { useCommentThreadMap, useQuestionThreadCards, useThreadInbox, useThreadInboxCards, useThreadsInboxSync } from "../../hooks/useThreadsSync";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTeamFeature } from "../../lib/teamFeatures";
import { memberName } from "../../lib/chatViews";
import {
  THREAD_KIND_META,
  THREAD_KIND_SPECS,
  arrangeVisit,
  cardsForChip,
  chipFromSearch,
  dmCards,
  isDismissible,
  markViewRead,
  newVisit,
  serverCards,
  sortCards,
  unreadByChip,
  visibleChips,
  walkIndex,
  type ThreadCardModel,
  type ThreadsVisit,
} from "../../lib/threadKinds";
import type { ThreadInboxRow } from "../../store/threadTypes";
import { useShortcutAction, useShortcutContext } from "../../shortcuts/ShortcutProvider";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { SegmentedToggle } from "../SegmentedToggle";
import { Switch } from "../ui/switch";
import { NewMessageModal } from "../chat/NewMessageModal";
import { openCardIn } from "../../lib/threadRows";
import { ThreadCard } from "./ThreadCard";
import { ThreadsHeader } from "./ThreadsHeader";
import { ThreadsEmpty } from "./ThreadsEmpty";
import { useSessionThreadCards } from "../../hooks/useSessionThreadCards";
import { queryCircuitOpenError } from "../../hooks/useQueryNoThrow";
import { ThreadsPageCtx, type ThreadsPageContextValue } from "./threadsContext";
import "../chat/chat.css";
import "./threads.css";

// The Threads page body: every conversation the viewer takes part in (chat
// threads, DMs, session comment threads, task comment streams, code and page
// discussions, pending questions and, by toggle, inbox sessions) as one long
// stable list, filtered by a single select chip. Every thread is open, its
// body showing enough to read and answer in place, with nothing scrolling
// inside it. Threads with something new come first; a marker follows; then
// the threads already seen. The order holds for the visit: reading,
// answering or finishing a thread leaves it where it is (lib/threadCards
// arrangeVisit owns the rules). The keyboard walks it (j/k move, e is done,
// r replies, o opens) and a thread on screen while the reader is here is read.
//
// The chips are the app's SegmentedToggle rather than GenericListView's tab
// bar: the page is a single-select view over one list in chat-style chrome,
// not a multi-select list page under a PageShell header, and the bordered
// pill group is the control every chat-style header already uses.

const CLOCK_MS = 30_000;

/** How long the reader must be away before returning starts a new visit
 *  (the list re-sorts, and what was read drops under the marker). A glance at
 *  another window keeps the list exactly as it was. */
const NEW_VISIT_AFTER_MS = 2 * 60_000;

/** How long the `r` key's focus request stands: long enough for the body to
 *  mount and its composer to take it, short enough that the next `r` is a
 *  fresh request. */
const FOCUS_REQUEST_MS = 400;

export function ThreadsView({ present, reading }: { present: boolean; reading: boolean }) {
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
  const questionCardList = useQuestionThreadCards();
  const commentThreads = useCommentThreadMap(rows);
  // Task short ids give the canonical /tasks/<short_id> link. One string
  // signature over just the task rows on the page, not the tasks collection.
  const taskShortSig = useInboxStore((s) => {
    let sig = "";
    for (const r of rows) if (r.kind === "task") sig += `${(s.tasks[String(r.task_id ?? r.root_key)] as any)?.short_id ?? ""}|`;
    return sig;
  });
  // Page slugs give the published page link; one string over just the page rows.
  const pageSlugSig = useInboxStore((s) => {
    let sig = "";
    for (const r of rows) if (r.kind === "page") sig += `${(s.pageThreads[r.root_key] as any)?.slug ?? ""}|`;
    return sig;
  });

  const allCards = useMemo(() => {
    const railById = new Map(rail.map((c) => [c.id, c]));
    const st = useInboxStore.getState();
    const tasks = st.tasks as Record<string, { short_id?: string }>;
    const pages = st.pageThreads as Record<string, { slug?: string }>;
    const server = serverCards(rows, (id) => railById.get(id)?.kind, (id) => tasks[id]?.short_id, (id) => pages[id]?.slug, viewerId);
    return [...server, ...dmCards(chatOn ? rail : []), ...sessionCardList, ...questionCardList];
    // taskShortSig / pageSlugSig are the wakes for the id lookups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rail, chatOn, sessionCardList, questionCardList, taskShortSig, pageSlugSig, viewerId]);
  const counts = useMemo(() => unreadByChip(allCards), [allCards]);
  const chipped = useMemo(
    () => sortCards(cardsForChip(allCards, chip, includeSessions)),
    [allCards, chip, includeSessions],
  );
  // The visit: one per chip and Sessions setting, so switching views starts
  // that view's own stable list. Returning after a real absence starts over.
  const visitsRef = useRef<Map<string, ThreadsVisit>>(new Map());
  const awaySinceRef = useRef<number | null>(null);
  if (!reading && awaySinceRef.current === null) awaySinceRef.current = Date.now();
  if (reading && awaySinceRef.current !== null) {
    if (Date.now() - awaySinceRef.current > NEW_VISIT_AFTER_MS) visitsRef.current.clear();
    awaySinceRef.current = null;
  }
  const visitKey = `${chip}|${includeSessions}`;
  let visit = visitsRef.current.get(visitKey);
  if (!visit) {
    visit = newVisit();
    visitsRef.current.set(visitKey, visit);
  }
  const { fresh, seen } = useMemo(() => arrangeVisit(visit!, chipped), [visit, chipped]);
  const cards = useMemo(() => [...fresh, ...seen], [fresh, seen]);

  // ── The cursor ────────────────────────────────────────────────────────────
  // The thread the keyboard is on. It lives in the store (ephemeral UI) so
  // leaving and returning lands on the same thread.
  const cursorId = useInboxStore((s) => s.threadsCursor.id);
  const cursorIndex = useMemo(() => cards.findIndex((c) => c.id === cursorId), [cards, cursorId]);
  const setCursor = useCallback((id: string | null) => useInboxStore.getState().setThreadsCursor({ id }), []);
  // A click inside a card only moves the cursor; the page never scrolls
  // under the reader's mouse.
  const select = useCallback((card: ThreadCardModel) => setCursor(card.id), [setCursor]);
  // The keyboard walk moves the cursor AND brings the card's head to the top.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const jump = useCallback((index: number): boolean => {
    const target = cards[index];
    if (!target) return false;
    setCursor(target.id);
    scrollRef.current?.querySelector(`[data-thread-index="${index}"]`)?.scrollIntoView({ block: "start" });
    return true;
  }, [cards, setCursor]);
  const move = useCallback((delta: number): boolean => jump(walkIndex(cards.length, cursorIndex, delta)), [cards.length, cursorIndex, jump]);

  // Done: archive the follow (or, for a kind with no follow to archive, mark
  // it read) and step to the next thread. The thread itself stays in place
  // for the visit.
  const done = useCallback((): boolean => {
    const card = cursorIndex >= 0 ? cards[cursorIndex] : undefined;
    if (!card) return false;
    if (isDismissible(card)) {
      const row = card.source as ThreadInboxRow;
      useInboxStore.getState().dismissThread(row.kind, row.root_key);
    } else {
      THREAD_KIND_SPECS[card.kind].markRead(card);
    }
    move(1);
    return true;
  }, [cards, cursorIndex, move]);

  // `r`: hand the cursor's composer the focus once.
  const [focusId, setFocusId] = useState<string | null>(null);
  const reply = useCallback((): boolean => {
    const card = cursorIndex >= 0 ? cards[cursorIndex] : cards[0];
    if (!card) return false;
    setCursor(card.id);
    setFocusId(card.id);
    window.setTimeout(() => setFocusId((id) => (id === card.id ? null : id)), FOCUS_REQUEST_MS);
    return true;
  }, [cards, cursorIndex, setCursor]);
  const openCurrent = useCallback((): boolean => {
    const card = cursorIndex >= 0 ? cards[cursorIndex] : undefined;
    if (!card) return false;
    openCardIn(card, router);
    return true;
  }, [cards, cursorIndex, router]);

  // The keyboard: the app's list chords for the walk, the page's own for the
  // inbox verbs. The contexts stand only while the reader is here, and every
  // handler declines when they are not: a Threads pane in a background tab
  // stays mounted, and its handlers must not answer a `j` meant for the list
  // page in the active one.
  useShortcutContext("list", present);
  useShortcutContext("threads", present);
  const here = useCallback((fn: () => boolean) => () => (present ? fn() : false), [present]);
  useShortcutAction("list.down", here(() => move(1)));
  useShortcutAction("list.up", here(() => move(-1)));
  useShortcutAction("list.first", here(() => jump(0)));
  useShortcutAction("list.last", here(() => jump(cards.length - 1)));
  useShortcutAction("list.open", here(openCurrent));
  useShortcutAction("threads.done", here(done));
  useShortcutAction("threads.reply", here(reply));
  useShortcutAction("threads.openIn", here(openCurrent));

  const nameOf = useCallback((userId: string) => memberName(byId.get(String(userId))), [byId]);
  const ctx = useMemo<ThreadsPageContextValue>(
    () => ({ now, present: reading, teamId, viewerId, members, handles, nameOf, chatCards, commentThreads, select }),
    [now, reading, teamId, viewerId, members, handles, nameOf, chatCards, commentThreads, select],
  );

  // ── Header + chips ────────────────────────────────────────────────────────
  const viewUnread = counts[chip];
  const markAll = useCallback(() => markViewRead(cards, chip, teamId), [cards, chip, teamId]);
  useShortcutAction("threads.markAllRead", here(() => { if (viewUnread === 0) return false; markAll(); return true; }));
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

  const renderCard = (card: ThreadCardModel, index: number) => (
    <ThreadCard
      key={card.id}
      card={card}
      index={index}
      selected={card.id === cursorId}
      frozenReadAt={visit!.readAt.get(card.id) ?? 0}
      focusComposer={focusId === card.id}
    />
  );

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
            <label className="th-toggle" title="Show the sessions waiting on you (under All)">
              <Switch checked={includeSessions} onCheckedChange={toggleSessions} />
              Sessions
            </label>
            {cards.length > 0 && (
              <span className="th-keys" aria-hidden="true">
                <span className="th-key"><KeyCap size="xs">j</KeyCap><KeyCap size="xs">k</KeyCap> move</span>
                <span className="th-key"><KeyCap size="xs">e</KeyCap> done</span>
                <span className="th-key"><KeyCap size="xs">r</KeyCap> reply</span>
                <span className="th-key"><KeyCap size="xs">o</KeyCap> open</span>
              </span>
            )}
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
            <ThreadsEmpty
              chip={chip}
              sessionsOn={includeSessions}
              caughtUp={allCards.some((c) => (chip === "all" ? c.chip !== "session" : c.chip === chip))}
              onNewMessage={chatOn ? openNewMessage : undefined}
            />
          ) : (
            <div className="th-scroll" ref={scrollRef}>
              {feedFailed && (
                <div className="ch-search-hint" role="alert">
                  <p>{feed.error === queryCircuitOpenError ? "Threads timed out." : "Threads are not answering."}</p>
                  <p className="ch-search-hint-sub">
                    {cards.length > 0 ? "Showing what is cached. " : ""}
                    <button type="button" className="ch-agent-retry" onClick={feed.retry}>Try again</button>
                  </p>
                </div>
              )}
              {fresh.length > 0 && (
                <div className="th-list" role="list" aria-label="New">
                  {fresh.map((card, i) => renderCard(card, i))}
                </div>
              )}
              <div className="th-marker" role="separator">
                <span>You&apos;re up to date</span>
              </div>
              {seen.length > 0 && (
                <div className="th-list th-list-seen" role="list" aria-label="Seen">
                  {seen.map((card, i) => renderCard(card, fresh.length + i))}
                </div>
              )}
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
