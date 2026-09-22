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
  cardsForChip,
  chipFromSearch,
  dmCards,
  frozenReadAtOf,
  isDismissible,
  markViewRead,
  serverCards,
  sortCards,
  unreadByChip,
  unreadOnlyCards,
  visibleChips,
  type ThreadCardModel,
} from "../../lib/threadKinds";
import type { ThreadInboxRow, ThreadsCursor } from "../../store/threadTypes";
import { useShortcutAction, useShortcutContext } from "../../shortcuts/ShortcutProvider";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { SegmentedToggle } from "../SegmentedToggle";
import { Switch } from "../ui/switch";
import { NewMessageModal } from "../chat/NewMessageModal";
import { ThreadCard, openCardIn } from "./ThreadCard";
import { ThreadsHeader } from "./ThreadsHeader";
import { ThreadsEmpty } from "./ThreadsEmpty";
import { useSessionThreadCards } from "../../hooks/useSessionThreadCards";
import { queryCircuitOpenError } from "../../hooks/useQueryNoThrow";
import { ThreadsPageCtx, type ThreadsPageContextValue } from "./threadsContext";
import "../chat/chat.css";
import "./threads.css";

// The Threads page body: every conversation with something new for the
// viewer — chat threads, DMs, session comment threads, task comment streams,
// page discussions, pending questions and (toggle) inbox sessions — one list
// of rows, newest activity first, filtered by a single select chip. The page
// is a reader: rows are collapsed to two lines each, and ONE row is open at
// a time, showing its thread in place with the composer. The keyboard walks
// it — j/k open the next row, Enter toggles, e is done, r replies — and the
// mouse does the same by clicking. Reading a row (opening it while present)
// marks it read; a row read this visit stays listed until the page is left,
// so it never vanishes under the reader (lib/threadCards owns the rules).
//
// The chips are the app's SegmentedToggle rather than GenericListView's tab
// bar: the page is a single-select view over one list in chat-style chrome,
// not a multi-select list page under a PageShell header, and the bordered
// pill group is the control every chat-style header already uses.

const CLOCK_MS = 30_000;

/** How long the `r` key's focus request stands: long enough for the body to
 *  mount and its composer to take it, short enough that the next `r` is a
 *  fresh request. */
const FOCUS_REQUEST_MS = 400;

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
  // Every view shows only cards with something unread for the viewer. The
  // hold set keeps a card on screen for the visit once it has shown, so
  // reading it (which zeroes unread) cannot yank it away under the reader.
  const heldRef = useRef<Set<string>>(new Set());
  const cards = useMemo(() => unreadOnlyCards(chipped, heldRef.current), [chipped]);

  // ── The cursor ────────────────────────────────────────────────────────────
  // One row is selected and at most that row is open. The cursor lives in
  // the store (ephemeral UI) so leaving and returning lands on the same row.
  const cursor = useInboxStore((s) => s.threadsCursor);
  const cursorIndex = useMemo(() => cards.findIndex((c) => c.id === cursor.id), [cards, cursor.id]);
  // Where the cursor last stood, for when its row leaves the list (dismissed
  // elsewhere, answered, retired): the next move starts from here.
  const lastIndexRef = useRef(0);
  if (cursorIndex >= 0) lastIndexRef.current = cursorIndex;

  const setCursor = useCallback((next: ThreadsCursor) => useInboxStore.getState().setThreadsCursor(next), []);
  const select = useCallback((card: ThreadCardModel) => setCursor({ id: card.id, open: false, frozenReadAt: 0 }), [setCursor]);
  const openCard = useCallback(
    (card: ThreadCardModel) => setCursor({ id: card.id, open: true, frozenReadAt: frozenReadAtOf(card) }),
    [setCursor],
  );
  const toggle = useCallback((card: ThreadCardModel) => {
    const c = useInboxStore.getState().threadsCursor;
    if (c.id === card.id && c.open) setCursor({ ...c, open: false });
    else openCard(card);
  }, [openCard, setCursor]);

  /** The row the cursor is on, or the one it would land on next. */
  const cardAt = useCallback((index: number): ThreadCardModel | undefined => {
    if (cards.length === 0) return undefined;
    return cards[Math.min(cards.length - 1, Math.max(0, index))];
  }, [cards]);
  const move = useCallback((delta: number): boolean => {
    if (cards.length === 0) return false;
    const from = cursorIndex >= 0 ? cursorIndex : lastIndexRef.current - (delta > 0 ? 1 : 0);
    const target = cardAt(from + delta);
    if (!target) return false;
    // A walk reads: the next row opens as the cursor lands on it.
    openCard(target);
    return true;
  }, [cards.length, cursorIndex, cardAt, openCard]);

  // Done: archive the follow (or, for a kind with no follow to archive, mark
  // it read) and step to the next row, keeping the open state — a reader
  // clearing the inbox with `e` never has to press Enter between rows.
  const done = useCallback((): boolean => {
    const card = cursorIndex >= 0 ? cards[cursorIndex] : undefined;
    if (!card) return false;
    const next = cards[cursorIndex + 1] ?? cards[cursorIndex - 1];
    if (isDismissible(card)) {
      const row = card.source as ThreadInboxRow;
      useInboxStore.getState().dismissThread(row.kind, row.root_key);
    } else {
      THREAD_KIND_SPECS[card.kind].markRead(card);
    }
    heldRef.current.delete(card.id);
    if (next) setCursor({ id: next.id, open: cursor.open, frozenReadAt: cursor.open ? frozenReadAtOf(next) : 0 });
    else setCursor({ id: null, open: false, frozenReadAt: 0 });
    return true;
  }, [cards, cursorIndex, cursor.open, setCursor]);

  // `r`: open the row if it is closed, and hand its composer the focus once.
  const [focusId, setFocusId] = useState<string | null>(null);
  const reply = useCallback((): boolean => {
    const card = cursorIndex >= 0 ? cards[cursorIndex] : cardAt(lastIndexRef.current);
    if (!card) return false;
    if (!(cursor.id === card.id && cursor.open)) openCard(card);
    setFocusId(card.id);
    window.setTimeout(() => setFocusId((id) => (id === card.id ? null : id)), FOCUS_REQUEST_MS);
    return true;
  }, [cards, cursorIndex, cursor, cardAt, openCard]);

  // The keyboard: the app's list chords for the walk, the page's own for the
  // inbox verbs. Both stand only while the reader is here.
  useShortcutContext("list", present);
  useShortcutContext("threads", present);
  useShortcutAction("list.down", () => move(1));
  useShortcutAction("list.up", () => move(-1));
  useShortcutAction("list.first", () => { const c = cardAt(0); if (!c) return false; openCard(c); return true; });
  useShortcutAction("list.last", () => { const c = cardAt(cards.length - 1); if (!c) return false; openCard(c); return true; });
  useShortcutAction("list.open", () => {
    const card = cursorIndex >= 0 ? cards[cursorIndex] : cardAt(lastIndexRef.current);
    if (!card) return false;
    toggle(card);
    return true;
  });
  useShortcutAction("threads.done", done);
  useShortcutAction("threads.reply", reply);
  useShortcutAction("threads.openIn", () => {
    const card = cursorIndex >= 0 ? cards[cursorIndex] : undefined;
    if (!card) return false;
    openCardIn(card, router);
    return true;
  });
  useShortcutAction("threads.collapse", () => {
    if (!cursor.open) return false;
    setCursor({ ...cursor, open: false });
    return true;
  });

  const nameOf = useCallback((userId: string) => memberName(byId.get(String(userId))), [byId]);
  const ctx = useMemo<ThreadsPageContextValue>(
    () => ({ now, present, teamId, viewerId, members, handles, nameOf, chatCards, commentThreads, select, toggle }),
    [now, present, teamId, viewerId, members, handles, nameOf, chatCards, commentThreads, select, toggle],
  );

  // ── Header + chips ────────────────────────────────────────────────────────
  const viewUnread = counts[chip];
  const markAll = useCallback(() => markViewRead(cards, chip, teamId), [cards, chip, teamId]);
  useShortcutAction("threads.markAllRead", () => { if (viewUnread === 0) return false; markAll(); return true; });
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
            <label className="th-toggle" title="Show your inbox sessions as rows (under All)">
              <Switch checked={includeSessions} onCheckedChange={toggleSessions} />
              Sessions
            </label>
            {cards.length > 0 && (
              <span className="th-keys" aria-hidden="true">
                <span className="th-key"><KeyCap size="xs">j</KeyCap><KeyCap size="xs">k</KeyCap> read</span>
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
              <div className="th-list" role="list">
                {cards.map((card, i) => {
                  const selected = card.id === cursor.id;
                  return (
                    <ThreadCard
                      key={card.id}
                      card={card}
                      index={i}
                      selected={selected}
                      open={selected && cursor.open}
                      frozenReadAt={selected ? cursor.frozenReadAt : 0}
                      focusComposer={selected && focusId === card.id}
                    />
                  );
                })}
              </div>
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
