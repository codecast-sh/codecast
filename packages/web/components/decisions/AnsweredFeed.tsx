"use client";
// The team's answered decisions as a feed to read: newest answer first,
// grouped by day, each decision drawn whole in place (who answered and when,
// the question, every option with the pick marked or the typed answer, then
// the agent's reasoning), so a reader scrolls through what the team decided without opening
// anything. The decision's own page, a click away, adds its comments, its
// attached document and the ladder it climbed. Rows come from the store
// (the Decisions page's team feeder, the last week of answers).
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, FileText, MessagesSquare } from "lucide-react";
import type { SessionDecisionItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useJumpToDecisionAsk } from "../../hooks/useJumpToDecisionAsk";
import { useDecisionParties, type DecisionPartyLabel } from "../../hooks/useDecisionParties";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { chosenOptions } from "../../lib/decisionLinks";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { ChangeCardHeadline } from "./ChangeCardView";
import { priorityCardAsk, priorityCardRecord } from "../../lib/priorityCardDecision";
import "./decisions.css";

/** How many entries draw at first, and how many more each time the reader nears the end. */
const PAGE = 25;
/** Context longer than this reads folded until the reader opens it. */
const LONG_CONTEXT = 1400;

const answeredAt = (d: SessionDecisionItem) => d.resolved_at ?? d.created_at;

function dayLabel(ts: number, now: number): string {
  const day = new Date(ts);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function AnsweredFeed({ rows }: { rows: ReadonlyArray<SessionDecisionItem> }) {
  const now = useCoarseNow(60_000);
  const { partyOf } = useDecisionParties();
  const answered = useMemo(
    () => rows.filter((d) => d.status === "answered").sort((a, b) => answeredAt(b) - answeredAt(a)),
    [rows],
  );
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  const more = shown < answered.length;
  useWatchEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
    }, { rootMargin: "1200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, shown]);

  const days = useMemo(() => {
    const total = new Map<string, number>();
    for (const d of answered) { const l = dayLabel(answeredAt(d), now); total.set(l, (total.get(l) ?? 0) + 1); }
    const out: { label: string; total: number; items: SessionDecisionItem[] }[] = [];
    for (const d of answered.slice(0, shown)) {
      const label = dayLabel(answeredAt(d), now);
      if (out[out.length - 1]?.label === label) out[out.length - 1].items.push(d);
      else out.push({ label, total: total.get(label) ?? 0, items: [d] });
    }
    return out;
  }, [answered, shown, now]);

  if (answered.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-sm text-sol-text-dim" data-answered-feed-empty>Nothing answered this week</div>;
  }
  return (
    <div className="flex-1 overflow-y-auto decision-doc decision-feed" data-answered-feed={answered.length} data-main-scroll>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pb-16">
        {days.map((day) => (
          <section key={day.label} data-answered-feed-day={day.label}>
            <h2 className="decision-feed-day decision-kicker">{day.label}<span className="tabular-nums">{day.total}</span></h2>
            <div className="space-y-4">
              {day.items.map((d) => <FeedEntry key={d._id} d={d} now={now} answerer={d.answered_by ? partyOf(`${d.answered_by.kind}:${d.answered_by.id}`) : null} />)}
            </div>
          </section>
        ))}
        {more && <div ref={sentinel} className="py-8 text-center text-meta text-sol-text-dim">Loading older answers</div>}
      </div>
    </div>
  );
}

function FeedEntry({ d, now, answerer }: { d: SessionDecisionItem; now: number; answerer: DecisionPartyLabel | null }) {
  const href = `/decisions/${d.short_id ?? d._id}`;
  const jump = useJumpToDecisionAsk(d.conversation_id, d._id, d.question);
  const picked = new Set(chosenOptions(d));
  const by = d.answered_by;
  const who = by?.kind === "policy" ? "A stack's default" : answerer?.label ?? (by?.kind === "role" ? "A role" : "Someone");
  return (
    <article className="decision-feed-entry rounded-xl border border-sol-border/60 bg-sol-card/40 px-5 py-4" data-answered-feed-entry={d.short_id ?? d._id}>
      <header className="flex items-center gap-2 text-meta text-sol-text-dim min-w-0">
        <span className="w-5 h-5 shrink-0 flex items-center justify-center">{answerer?.face}</span>
        <span className="text-sol-text font-medium truncate">{who}</span>
        <span className="shrink-0">answered {formatTimeAgo(answeredAt(d), now)}</span>
        {/* A priority card is its person's, not its session's question: no way into that session. */}
        {!d.priority_card && <button type="button" onClick={() => void jump()} className="min-w-0 inline-flex items-center gap-1 truncate hover:text-sol-text transition-colors" title="Open the session that asked" data-answered-feed-session>
          <MessagesSquare className="w-3 h-3 shrink-0" /><span className="truncate">{d.session_title || "the session"}</span>
        </button>}
        <Link href={href} className="ml-auto shrink-0 font-mono opacity-70 hover:opacity-100 no-underline text-sol-text-dim">{d.short_id ?? "open"}</Link>
      </header>

      {d.priority_card ? <PriorityCardRecord d={d} href={href} /> : <>
      <Link href={href} className="block mt-2.5 no-underline text-sol-text hover:text-sol-blue transition-colors">
        {d.card ? <ChangeCardHeadline card={d.card} question={d.question} size="card" questionFirst /> : <h3 className="decision-question">{d.question}</h3>}
      </Link>

      {/* The answer, before the reasoning: it is the news. */}
      <div className="mt-3 empty:hidden decision-feed-answer" data-answered-feed-answer>
        {d.answer_text ? (
          <div className="flex items-start gap-2.5 rounded-lg px-3 py-2 bg-sol-green/10 border border-sol-green/40">
            <span className="mt-0.5 w-5 h-5 shrink-0 rounded-full border border-sol-green text-sol-green flex items-center justify-center"><Check className="w-3 h-3" /></span>
            <span className="text-sol-text font-medium whitespace-pre-wrap">{d.answer_text}</span>
          </div>
        ) : d.kind === "form" && d.answer_json && typeof d.answer_json === "object" ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            {Object.entries(d.answer_json).map(([k, v]) => <div key={k} className="contents"><dt className="text-sol-text-dim">{k}</dt><dd className="text-sol-text">{String(v)}</dd></div>)}
          </dl>
        ) : null}
      </div>

      {d.options.length > 0 && !d.answer_text && d.kind !== "form" && (
        <ol className="mt-3 space-y-1.5" data-answered-feed-options>
          {(d.kind === "rank" ? chosenOptions(d).map((i) => [i, d.options[i]] as const) : d.options.map((o, i) => [i, o] as const)).map(([i, o], pos) => o && (
            <li key={i} className={`flex items-start gap-2.5 rounded-lg px-3 py-2 ${picked.has(i) ? "bg-sol-green/10 border border-sol-green/40" : "border border-transparent"}`} data-picked={picked.has(i) || undefined}>
              <span className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border flex items-center justify-center text-meta font-mono ${picked.has(i) ? "border-sol-green text-sol-green" : "border-sol-border text-sol-text-dim"}`}>
                {d.kind === "rank" ? pos + 1 : picked.has(i) ? <Check className="w-3 h-3" /> : i + 1}
              </span>
              <div className="min-w-0">
                <div className={picked.has(i) ? "text-sol-text font-medium" : "text-sol-text-muted"}>{o.label}</div>
                {o.description && <div className={`text-[13px] leading-relaxed ${picked.has(i) ? "text-sol-text-muted" : "text-sol-text-dim"}`}>{o.description}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {d.context_md && <FeedContext md={d.context_md} />}

      {(d.doc_id || d.report_slug) && (
        <Link href={href} className="mt-3 inline-flex items-center gap-1.5 text-meta text-sol-blue hover:underline" data-answered-feed-more>
          <FileText className="w-3 h-3" />{d.report_slug ? "Its report" : "Its document"}
        </Link>
      )}
      </>}
    </article>
  );
}

// A priority card's record, not its sixteen options: what was accepted, or the
// person's words in place of an answer. The whole record opens the card.
function PriorityCardRecord({ d, href }: { d: SessionDecisionItem; href: string }) {
  const record = priorityCardRecord(d);
  return (
    <Link href={href} className="block mt-2.5 no-underline text-sol-text hover:text-sol-blue transition-colors" data-answered-feed-priority-card>
      <h3 className="decision-question">{record?.headline ?? priorityCardAsk(d.priority_card!)}</h3>
      {record?.text && <p className="mt-1.5 pl-3 border-l-2 border-sol-cyan/50 italic text-sol-text [overflow-wrap:anywhere]" data-answered-feed-words>{record.text}</p>}
      <div className="mt-1.5 text-meta text-sol-text-dim">{priorityCardAsk(d.priority_card!)}</div>
    </Link>
  );
}

function FeedContext({ md }: { md: string }) {
  const long = md.length > LONG_CONTEXT;
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 relative">
      <div className={`decision-body text-sol-text ${long && !open ? "decision-feed-folded" : ""}`} data-answered-feed-context>
        <MarkdownRenderer content={md} />
      </div>
      {long && !open && (
        <button type="button" onClick={() => setOpen(true)} className="mt-1 inline-flex items-center gap-1 text-meta text-sol-text-dim hover:text-sol-text transition-colors" data-answered-feed-unfold>
          <ChevronDown className="w-3 h-3" />Read all of it
        </button>
      )}
    </div>
  );
}
