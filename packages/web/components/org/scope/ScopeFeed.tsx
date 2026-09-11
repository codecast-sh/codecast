"use client";
// The scope feed (docs/architecture/scopes-and-feed.md F2, F3): everything in
// a scope as one stream, newest first. Kind chips narrow it; the cursor pages
// it as the reader scrolls; image and page rows carry a thumbnail. Each page is
// one mounted loader over org.scopeFeed, the way the org page pages
// sessionsUnder: a loader reports its rows once and unmounts.
import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CheckSquare, FileText, GitCommit, Image as ImageGlyph, Layers, Megaphone, MessageCircleQuestion, Terminal } from "lucide-react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useScopeFeedPage, type ScopeRef } from "../../../hooks/useScopeQueries";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { compactAge } from "../../../lib/threadState";
import { cn } from "../../../lib/utils";
import { Avatar } from "../../tasks/TaskCommentStream";
import { FEED_KINDS, FEED_KIND_META, type FeedKind, type FeedRow } from "./scopeTypes";

const PAGE = 40;

const KIND_ICON: Record<FeedKind, any> = {
  session: Terminal,
  task: CheckSquare,
  plan: Layers,
  doc: FileText,
  artifact: ImageGlyph,
  decision: MessageCircleQuestion,
  update: Megaphone,
  commit: GitCommit,
};

/** One page of the feed: fires the query for its cursor, reports once, stays mounted so the row stays live. */
function FeedPageLoader({ scope, cursor, kinds, onPage }: { scope: ScopeRef; cursor?: string; kinds: FeedKind[]; onPage: (cursor: string | undefined, rows: FeedRow[], next?: string) => void }) {
  const { data } = useScopeFeedPage({ ...scope, ...(cursor ? { cursor } : {}), limit: PAGE, ...(kinds.length ? { kinds } : {}) });
  useWatchEffect(() => {
    if (!data) return;
    onPage(cursor, data.rows ?? [], data.next_cursor ?? undefined);
  }, [data, cursor, onPage]);
  return null;
}

export type ScopeFeedProps = {
  scope: ScopeRef;
  /** Rows of these kinds only; empty = every kind. */
  className?: string;
  /** Phone: the feed is the page, so it owns the scroll; desktop: the tab body scrolls. */
  fill?: boolean;
};

export function ScopeFeed({ scope, className, fill }: ScopeFeedProps) {
  const [kinds, setKinds] = useState<FeedKind[]>([]);
  // Pages keyed by the cursor that produced them; the first page's key is "".
  const [pages, setPages] = useState<Record<string, { rows: FeedRow[]; next?: string }>>({});
  const [requested, setRequested] = useState<string[]>([""]);
  const scopeKey = JSON.stringify(scope);
  const now = useCoarseNow(30_000);
  const openLinked = useOpenLinkedSession();
  const sentinel = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  // A new scope or a new kind set starts the stream over.
  useWatchEffect(() => {
    setPages({});
    setRequested([""]);
  }, [scopeKey, kinds.join(",")]);

  const onPage = useCallback((cursor: string | undefined, rows: FeedRow[], next?: string) => {
    setPages((prev) => {
      const key = cursor ?? "";
      const cur = prev[key];
      if (cur && cur.next === next && cur.rows.length === rows.length && cur.rows.every((r, i) => r.id === rows[i].id && r.updated_at === rows[i].updated_at)) return prev;
      return { ...prev, [key]: { rows, next } };
    });
  }, []);

  const ordered = useMemo(() => {
    // Walk the chain from the first page so a page that re-fired stays in place.
    const out: FeedRow[] = [];
    const seen = new Set<string>();
    let key = "";
    let last: { rows: FeedRow[]; next?: string } | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const page = pages[key];
      if (!page) break;
      for (const r of page.rows) if (!seen.has(`${r.kind}:${r.id}`)) { seen.add(`${r.kind}:${r.id}`); out.push(r); }
      last = page;
      if (!page.next) break;
      key = page.next;
    }
    return { rows: out, next: last?.next, loaded: !!pages[""] };
  }, [pages]);

  const pending = requested.some((c) => !pages[c]);
  const loadMore = useCallback(() => {
    const next = ordered.next;
    if (!next || pending) return;
    setRequested((r) => (r.includes(next) ? r : [...r, next]));
  }, [ordered.next, pending]);

  // Infinite scroll: the sentinel under the last row asks for the next page.
  useWatchEffect(() => {
    const target = sentinel.current;
    if (!target || !ordered.next) return;
    const root = fill ? scroller.current : (target.closest("[data-scope-scroll]") as HTMLElement | null);
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) loadMore(); }, { root, rootMargin: "320px 0px", threshold: 0 });
    io.observe(target);
    return () => io.disconnect();
  }, [ordered.next, loadMore, fill]);

  const toggleKind = (k: FeedKind) => setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  const body = (
    <>
      {requested.map((c) => <FeedPageLoader key={`${scopeKey}|${kinds.join(",")}|${c}`} scope={scope} cursor={c || undefined} kinds={kinds} onPage={onPage} />)}
      <div className="flex items-center gap-1.5 flex-wrap px-1 pb-3">
        <button
          type="button"
          onClick={() => setKinds([])}
          className={cn("h-[24px] px-2.5 rounded-full text-[11px] font-medium border transition-colors", kinds.length === 0 ? "border-transparent" : "hover:bg-sol-bg-highlight/70")}
          style={kinds.length === 0 ? { background: "var(--sol-text)", color: "var(--sol-bg)", borderColor: "transparent" } : { borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-muted)" }}
        >
          Everything
        </button>
        {FEED_KINDS.map((k) => {
          const on = kinds.includes(k);
          const m = FEED_KIND_META[k];
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              aria-pressed={on}
              className={cn("inline-flex items-center gap-1.5 h-[24px] px-2.5 rounded-full text-[11px] font-medium border transition-colors", !on && "hover:bg-sol-bg-highlight/70")}
              style={on
                ? { background: `color-mix(in srgb, ${m.color} 16%, transparent)`, borderColor: `color-mix(in srgb, ${m.color} 50%, transparent)`, color: m.color }
                : { borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-muted)" }}
            >
              <span className="w-[6px] h-[6px] rounded-full" style={{ background: m.color, opacity: on ? 1 : 0.5 }} />
              {m.plural}
            </button>
          );
        })}
      </div>

      {ordered.rows.length === 0 && ordered.loaded && (
        <div className="py-14 text-center">
          <p className="text-[13px]" style={{ color: "var(--sol-text-muted)" }}>Nothing in this scope yet{kinds.length ? " for those kinds" : ""}.</p>
          <p className="mt-1 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>Sessions, tasks, plans, pages, artifacts, decisions, updates and commits appear here as they move.</p>
        </div>
      )}
      {ordered.rows.length === 0 && !ordered.loaded && (
        <div className="space-y-2 px-1" aria-busy>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[52px] rounded-xl animate-pulse" style={{ background: "color-mix(in srgb, var(--sol-border) 14%, transparent)", animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      )}
      <ol className="space-y-1">
        {ordered.rows.map((r, i) => <FeedRowView key={`${r.kind}:${r.id}`} row={r} now={now} index={i} onOpenSession={(row) => openLinked({ _id: row.id, short_id: row.short_id, title: row.title, agent_type: "claude_code" })} />)}
      </ol>
      <div ref={sentinel} className="h-8 flex items-center justify-center text-[11px]" style={{ color: "var(--sol-text-dim)" }}>
        {ordered.next ? (pending ? "Loading…" : <button type="button" onClick={loadMore} className="hover:underline">Load more</button>) : ordered.rows.length > 0 ? "That is everything in scope." : null}
      </div>
    </>
  );

  if (fill) {
    return <div ref={scroller} className={cn("flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-6", className)}>{body}</div>;
  }
  return <div className={cn("px-1 pt-1", className)}>{body}</div>;
}

// ---------------------------------------------------------------- one row

const stateTone = (kind: FeedKind, state?: string): string | undefined => {
  if (!state) return undefined;
  const s = state.toLowerCase();
  if (kind === "session") {
    if (s === "needs_input" || s === "blocked") return "var(--sol-yellow)";
    if (s === "working") return "var(--sol-green)";
    if (s === "done") return "var(--sol-cyan)";
    if (s === "dormant") return "var(--sol-blue)";
    return "var(--sol-text-dim)";
  }
  if (s === "done" || s === "answered" || s === "completed" || s === "merged") return "var(--sol-cyan)";
  if (s === "in_progress" || s === "active" || s === "working") return "var(--sol-green)";
  if (s === "pending" || s === "open" || s === "in_review") return "var(--sol-yellow)";
  if (s === "dropped" || s === "dismissed" || s === "withdrawn") return "var(--sol-red)";
  return "var(--sol-text-dim)";
};

function FeedRowView({ row, now, index, onOpenSession }: { row: FeedRow; now: number; index: number; onOpenSession: (row: FeedRow) => void }) {
  const m = FEED_KIND_META[row.kind];
  const Icon = KIND_ICON[row.kind];
  const tone = stateTone(row.kind, row.state);
  const inner = (
    <>
      <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: tone ?? `color-mix(in srgb, ${m.color} 55%, transparent)` }} aria-hidden />
      {row.image_url ? (
        <span className="relative shrink-0 w-[72px] h-[48px] rounded-lg overflow-hidden border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)", background: "var(--sol-bg-alt)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={row.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
          <Icon className="absolute right-1 bottom-1 w-3 h-3 drop-shadow" style={{ color: "white" }} />
        </span>
      ) : (
        <span className="shrink-0 w-7 h-7 rounded-lg inline-flex items-center justify-center" style={{ background: `color-mix(in srgb, ${m.color} 12%, transparent)`, color: m.color }}>
          <Icon className="w-3.5 h-3.5" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-[13px] font-medium" style={{ color: "var(--sol-text)" }}>{row.title || "Untitled"}</span>
          {row.state && <span className="shrink-0 text-[10px] px-1.5 h-[17px] inline-flex items-center rounded-md border" style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, color: tone }}>{row.state.replace(/_/g, " ")}</span>}
        </span>
        <span className="mt-[2px] flex items-center gap-1.5 text-[10.5px] min-w-0" style={{ color: "var(--sol-text-dim)" }}>
          <span style={{ fontFamily: "var(--font-mono)" }}>{row.short_id ?? m.label}</span>
          {row.actor && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 min-w-0"><Avatar name={row.actor.name} image={row.actor.image} size="sm" /><span className="truncate">{row.actor.name}{row.actor.is_bot ? " (agent)" : ""}</span></span>
            </>
          )}
          {row.preview && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{row.preview}</span>
            </>
          )}
        </span>
      </span>
      <span className="text-[10.5px] tabular-nums shrink-0 self-start mt-[3px]" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - row.updated_at)}</span>
    </>
  );
  const cls = "group w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-colors hover:bg-sol-bg-highlight/70 scope-feed-row";
  const style = { animationDelay: `${Math.min(index, 12) * 28}ms` } as React.CSSProperties;
  return (
    <li>
      {row.kind === "session" ? (
        <button type="button" onClick={() => onOpenSession(row)} className={cls} style={style}>{inner}</button>
      ) : (
        <Link href={row.href} className={cls} style={style}>{inner}</Link>
      )}
    </li>
  );
}
