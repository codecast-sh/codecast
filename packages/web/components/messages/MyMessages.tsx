// The Messages feed, "Mine": everything the viewer typed into sessions, newest
// first, and one press from the session each message went to.
//
// The job is to find something you said and get back to it. So the list is
// dense (a line or three a message), paints from the local cache on the first
// frame (hooks/useMySends), filters as you type over every cached message
// while the server searches the rest, and opens the session scrolled to that
// message. j/k (or the arrows) walk it and open the selected message whole;
// Enter jumps. Coming back restores the selection and the scroll.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Copy, CornerDownLeft, Filter, Search, X } from "lucide-react";
import { useMySends, useMySendSearch, useMySendText, type MySendRow } from "../../hooks/useMySends";
import { useTabActive } from "../../hooks/usePagePresence";
import { matchesAction } from "../../shortcuts";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { scrollParentOf } from "../../lib/scrollWithin";
import { KeyCap } from "../KeyCap";
import { SkeletonRows } from "../ui/skeleton";
import { EmptyState } from "../ui/empty-state";
import { segmentsOf } from "../../lib/messageSegments";

// ── what a message looks like as text ──────────────────────────────────────

function termsOf(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every term appears somewhere in the message, its session or its folder. */
const hayOf = new WeakMap<MySendRow, string>();
function matches(row: MySendRow, terms: string[]): boolean {
  if (!terms.length) return true;
  let hay = hayOf.get(row);
  if (hay === undefined) {
    hay = `${row.text}\n${row.session_title}\n${row.project ?? ""}\n${row.question ?? ""}`.toLowerCase();
    hayOf.set(row, hay);
  }
  return terms.every((t) => hay.includes(t));
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <mark key={i} className="rounded-[2px] bg-sol-yellow/30 text-inherit">{p}</mark> : p,
      )}
    </>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex items-center rounded border border-sol-border/40 bg-sol-bg-alt px-1 align-[1px] font-mono text-[11px] leading-[16px] text-sol-text-dim">
      {children}
    </span>
  );
}

function MessageText({ text, terms }: { text: string; terms: string[] }) {
  const segs = useMemo(() => segmentsOf(text), [text]);
  if (!segs.length) return <span className="text-sol-text-dim">(empty)</span>;
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "text" ? <Highlight key={i} text={s.text} terms={terms} />
        : s.kind === "paste" ? <Chip key={i}>pasted · {s.lines} {s.lines === 1 ? "line" : "lines"}</Chip>
        : <Chip key={i}>{s.label}</Chip>,
      )}
    </>
  );
}

// ── time ────────────────────────────────────────────────────────────────────

const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
const timeOf = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  const yest = new Date(now - 86400000);
  if (dayKey(ts) === dayKey(today.getTime())) return "Today";
  if (dayKey(ts) === dayKey(yest.getTime())) return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

// ── rows ────────────────────────────────────────────────────────────────────

type Item = { kind: "day"; key: string; label: string; count: number } | { kind: "row"; key: string; row: MySendRow; index: number };

/** More than the three lines a row shows (a guess from the text alone). */
const isLong = (r: MySendRow) => r.clipped || r.text.length > 300 || r.text.split("\n").length > 3;

/** The sticky toolbar's height: search, then the day and count line. */
const TOOLBAR_H = 76;

const hrefOf = (r: MySendRow) => `/conversation/${r.conversation_id}#msg-${r.message_id}`;

const Row = memo(function Row({
  row, terms, selected, onOpen, onSelect, onFilterSession, filteredToSession,
}: {
  row: MySendRow;
  terms: string[];
  selected: boolean;
  onOpen: (r: MySendRow, newTab: boolean) => void;
  onSelect: (id: string) => void;
  onFilterSession: (r: MySendRow) => void;
  filteredToSession: boolean;
}) {
  const full = useMySendText(selected && row.clipped ? String(row.message_id) : null);
  const text = selected && full ? full : row.text;
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(full ?? row.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <a
      href={hrefOf(row)}
      data-row-id={row._id}
      aria-selected={selected}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onOpen(row, false);
      }}
      className={`group relative flex gap-3 rounded-md px-3 py-2 outline-none transition-colors duration-75 ${
        selected ? "bg-sol-bg-alt" : "hover:bg-sol-bg-alt/50"
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-1.5 left-0 w-[2px] rounded-full transition-opacity ${selected ? "bg-sol-blue opacity-100" : "opacity-0"}`}
      />
      <time className="w-[52px] shrink-0 pt-[2px] text-right font-mono text-[11px] tabular-nums text-sol-text-dim">
        {timeOf(row.timestamp)}
      </time>
      <div className="min-w-0 flex-1">
        {row.question ? (
          <div className="mb-0.5 truncate text-[12px] text-sol-text-dim">
            <span className="text-sol-violet">answered</span> {row.question}
          </div>
        ) : null}
        <div
          className={`whitespace-pre-wrap break-words text-[14px] leading-[20px] text-sol-text ${
            selected ? "max-h-[60vh] overflow-y-auto" : "line-clamp-3"
          }`}
        >
          <MessageText text={text} terms={terms} />
          {selected && row.clipped && !full ? <span className="text-sol-text-dim"> …</span> : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] leading-[16px]">
          {!selected && isLong(row) ? (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(row._id); }}
              className="shrink-0 rounded text-sol-blue/80 hover:text-sol-blue"
            >
              Show all
            </button>
          ) : null}
          <span className={`min-w-0 truncate ${selected ? "text-sol-text-muted" : "text-sol-text-dim"}`}>
            <Highlight text={row.session_title} terms={terms} />
          </span>
          {row.project ? <span className="shrink-0 font-mono text-[11px] text-sol-text-dim/70">{row.project}</span> : null}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <span className={`flex items-center gap-1 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
              {!filteredToSession ? (
                <button
                  type="button"
                  aria-label="Only this session"
                  title="Only this session"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFilterSession(row); }}
                  className="rounded p-1 text-sol-text-dim hover:bg-sol-border/30 hover:text-sol-text"
                >
                  <Filter className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Copy message"
                title="Copy message"
                onClick={copy}
                className="rounded p-1 text-sol-text-dim hover:bg-sol-border/30 hover:text-sol-text"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-sol-green" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </span>
            {selected ? (
              <span className="ml-1 flex items-center gap-1 text-sol-blue">
                Open <KeyCap size="xs"><CornerDownLeft className="h-3 w-3" /></KeyCap>
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </a>
  );
});

// ── the page ────────────────────────────────────────────────────────────────

// Where the person was, so coming back from a session lands them on the same
// message. Module state: it outlives the page's unmount, not a reload.
const memory: { selectedId: string | null; scrollTop: number; q: string; session: { id: string; title: string } | null } = {
  selectedId: null, scrollTop: 0, q: "", session: null,
};

export function MyMessages() {
  const router = useRouter();
  const feed = useMySends();
  const [q, setQ] = useState(memory.q);
  const [session, setSession] = useState(memory.session);
  const [selectedId, setSelectedId] = useState<string | null>(memory.selectedId);
  const terms = useMemo(() => termsOf(q), [q]);

  // Debounced server search over everything typed, cached window or not.
  const [serverQ, setServerQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setServerQ(q), 220);
    return () => clearTimeout(t);
  }, [q]);
  const search = useMySendSearch(serverQ);
  const searching = terms.length > 0 && (serverQ !== q || !search.ready);

  const rows = useMemo(() => {
    const local = feed.rows.filter((r) => (!session || String(r.conversation_id) === session.id) && matches(r, terms));
    if (!terms.length || serverQ !== q) return local;
    const held = new Set(local.map((r) => r._id));
    const extra = search.rows.filter((r) => !held.has(r._id) && (!session || String(r.conversation_id) === session.id) && matches(r, terms));
    if (!extra.length) return local;
    return [...local, ...extra].sort((a, b) => b.timestamp - a.timestamp);
  }, [feed.rows, terms, session, search.rows, serverQ, q]);

  const now = Date.now();
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let current = "";
    let header: Extract<Item, { kind: "day" }> | null = null;
    rows.forEach((row, index) => {
      const k = dayKey(row.timestamp);
      if (k !== current) {
        current = k;
        header = { kind: "day", key: `d:${k}`, label: dayLabel(row.timestamp, now), count: 0 };
        out.push(header);
      }
      header!.count++;
      out.push({ kind: "row", key: row._id, row, index });
    });
    return out;
    // `now` moves every render; the labels only need it per day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dayKey(now)]);

  const rowIndexOfItem = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it, i) => { if (it.kind === "row") m.set(it.row._id, i); });
    return m;
  }, [items]);

  // The page's own scroller (Modern's column, Classic's shell) carries the
  // list; the virtual rows are placed from the top of the list body, below
  // the sticky toolbar.
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const hasBody = feed.ready && rows.length > 0;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const sc = scrollParentOf(el);
    setScroller(sc);
    const body = bodyRef.current;
    if (!sc || !body) return;
    const measure = () => setMargin(body.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [feed.ready, hasBody]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: (i) => (items[i]?.kind === "day" ? 34 : 66),
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 12,
    scrollMargin: margin,
  });

  // Restore the scroll position once, when the list first has rows.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !scroller || !items.length) return;
    restored.current = true;
    if (memory.scrollTop > 0) scroller.scrollTop = memory.scrollTop;
  }, [scroller, items.length]);
  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => { memory.scrollTop = scroller.scrollTop; };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scroller]);
  useEffect(() => { memory.q = q; memory.session = session; memory.selectedId = selectedId; }, [q, session, selectedId]);

  // Page older history in as the bottom comes near.
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisible = virtualItems[virtualItems.length - 1]?.index ?? 0;
  const { loadOlder, hasMore, loadingOlder } = feed;
  useEffect(() => {
    if (!terms.length && !session && hasMore && !loadingOlder && items.length && lastVisible >= items.length - 25) loadOlder();
  }, [lastVisible, items.length, hasMore, loadingOlder, loadOlder, terms.length, session]);

  // The day the top of the view is in, for the toolbar.
  const topDay = useMemo(() => {
    // The toolbar names the day under it once that day's own header has
    // scrolled away beneath it.
    const under = (scroller?.scrollTop ?? 0) + TOOLBAR_H;
    const first = virtualItems.find((v) => v.end > under);
    if (!first) return null;
    for (let i = first.index; i >= 0; i--) {
      if (items[i]?.kind !== "day") continue;
      const header = virtualItems.find((v) => v.index === i);
      if (header && header.start >= under - 8) return null;
      return (items[i] as Extract<Item, { kind: "day" }>).label;
    }
    return null;
  }, [virtualItems, items, scroller]);

  const open = useCallback((r: MySendRow, newTab: boolean) => {
    setSelectedId(r._id);
    memory.selectedId = r._id;
    if (newTab) window.open(hrefOf(r), "_blank", "noopener");
    else router.push(hrefOf(r));
  }, [router]);

  const filterSession = useCallback((r: MySendRow) => {
    setSession({ id: String(r.conversation_id), title: r.session_title });
    setSelectedId(r._id);
    scroller?.scrollTo({ top: 0 });
  }, [scroller]);

  // Keyboard: walk, open, search. Only while this tab is the active pane,
  // and never from a text field or a region that owns its keys.
  const searchRef = useRef<HTMLInputElement>(null);
  const paneActive = useTabActive();
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const move = useCallback((delta: number) => {
    if (!rows.length) return;
    const sel = selectedRef.current;
    const cur = sel ? rows.findIndex((r) => r._id === sel) : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta))];
    selectedRef.current = next._id;
    setSelectedId(next._id);
    const idx = rowIndexOfItem.get(next._id);
    if (idx !== undefined) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [rows, rowIndexOfItem, virtualizer]);

  useEffect(() => {
    if (!paneActive) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target === searchRef.current) {
        if (e.key === "ArrowDown" || (e.key === "Enter" && !selectedId)) { e.preventDefault(); searchRef.current?.blur(); move(e.key === "Enter" ? 0 : 1); return; }
        if (e.key === "Enter") { e.preventDefault(); const r = rows.find((x) => x._id === selectedId); if (r) open(r, e.metaKey || e.ctrlKey); return; }
        if (e.key === "Escape") { e.preventDefault(); if (q) setQ(""); else searchRef.current?.blur(); }
        return;
      }
      if (keyBelongsElsewhere(target)) return;
      if (e.metaKey && e.key !== "Enter") return;
      if (target.closest?.('[role="menu"],[role="listbox"],[role="dialog"]')) return;
      if (matchesAction(e, "list.down") || (e.key === "ArrowDown" && !e.ctrlKey)) { e.preventDefault(); move(1); return; }
      if (matchesAction(e, "list.up") || (e.key === "ArrowUp" && !e.ctrlKey)) { e.preventDefault(); move(-1); return; }
      if (e.key === "Enter") {
        const r = rows.find((x) => x._id === selectedId);
        if (r) { e.preventDefault(); open(r, e.metaKey || e.ctrlKey); }
        return;
      }
      if (matchesAction(e, "list.search")) { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if (matchesAction(e, "list.first")) { e.preventDefault(); if (rows[0]) { setSelectedId(rows[0]._id); virtualizer.scrollToIndex(0); } return; }
      if (e.key === "Escape") {
        if (session) { e.preventDefault(); setSession(null); return; }
        if (q) { e.preventDefault(); setQ(""); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneActive, move, open, rows, selectedId, q, session, virtualizer]);

  // A filter that hides the selection moves it to the first match.
  useEffect(() => {
    if (selectedId && rows.length && !rowIndexOfItem.has(selectedId) && (terms.length || session)) setSelectedId(rows[0]._id);
  }, [rows, rowIndexOfItem, selectedId, terms.length, session]);

  const toolbar = (
    <div className="sticky top-0 z-10 -mx-1 mb-1 bg-sol-bg/95 px-1 pb-2 pt-1 backdrop-blur supports-[backdrop-filter]:bg-sol-bg/80">
      <div className="flex items-center gap-2">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-sol-border/50 bg-sol-bg-alt/40 px-2.5 focus-within:border-sol-blue/60 focus-within:bg-sol-bg">
          <Search className="h-4 w-4 shrink-0 text-sol-text-dim" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search everything you typed"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-sol-text outline-none placeholder:text-sol-text-dim"
          />
          {q ? (
            <button type="button" aria-label="Clear search" onClick={() => { setQ(""); searchRef.current?.focus(); }} className="rounded p-0.5 text-sol-text-dim hover:text-sol-text">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <KeyCap size="xs">/</KeyCap>
          )}
        </label>
        {session ? (
          <button
            type="button"
            onClick={() => setSession(null)}
            title="Show every session"
            className="flex h-9 max-w-[260px] shrink-0 items-center gap-1.5 rounded-lg border border-sol-blue/40 bg-sol-blue/10 px-2.5 text-[13px] text-sol-blue hover:bg-sol-blue/15"
          >
            <span className="truncate">{session.title}</span>
            <X className="h-3.5 w-3.5 shrink-0" />
          </button>
        ) : null}
      </div>
      <div className="mt-1.5 flex h-4 items-center gap-2 px-0.5 text-[12px] text-sol-text-dim">
        <span className="font-medium text-sol-text-muted">{topDay ?? ""}</span>
        <span className="ml-auto tabular-nums">
          {terms.length || session
            ? `${rows.length.toLocaleString()} ${rows.length === 1 ? "match" : "matches"}${searching ? " · searching all history" : ""}`
            : `${rows.length.toLocaleString()} messages${hasMore ? (loadingOlder ? " · loading older" : "") : " · all history"}`}
        </span>
      </div>
    </div>
  );

  if (!feed.ready) {
    return <div ref={listRef}>{toolbar}<SkeletonRows rows={8} className="px-3 pt-3" rowClassName="h-10" /></div>;
  }

  return (
    <div ref={listRef} data-my-messages>
      {toolbar}
      {rows.length === 0 ? (
        terms.length || session ? (
          searching ? <SkeletonRows rows={3} className="px-3 pt-3" rowClassName="h-10" /> : <EmptyState icon={Search} title={q ? `Nothing you typed matches “${q}”` : "No messages in this session"} />
        ) : (
          <EmptyState icon={Search} title="Nothing typed yet" />
        )
      ) : (
        <div ref={bodyRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualItems.map((v) => {
            const it = items[v.index];
            if (!it) return null;
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start - margin}px)` }}
              >
                {it.kind === "day" ? (
                  <div className="flex items-baseline gap-2 px-3 pb-1 pt-4 text-[12px]">
                    <span className="font-semibold text-sol-text-muted">{it.label}</span>
                    <span className="tabular-nums text-sol-text-dim">{it.count}</span>
                  </div>
                ) : (
                  <Row
                    row={it.row}
                    terms={terms}
                    selected={it.row._id === selectedId}
                    onOpen={open}
                    onSelect={setSelectedId}
                    onFilterSession={filterSession}
                    filteredToSession={!!session}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {!terms.length && !session && rows.length > 0 && !hasMore ? (
        <div className="py-6 text-center text-[12px] text-sol-text-dim">The first message you typed</div>
      ) : null}
    </div>
  );
}
