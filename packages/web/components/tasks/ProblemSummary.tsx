"use client";
// A problem's page head (learning-loop.md LL6): what a busy reader needs
// before anything else, at a glance. The numbers (how often, how bad, the
// trend), the one state it is in with the one control that moves it, and the
// findings behind it, grouped by where they were seen, each opening on the
// words that were actually sent. Everything else the task carries (its
// description, sessions, activity) folds below on the page.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useSyncTrial, useTrialCards } from "../../hooks/useSyncTrial";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { findingGist } from "../../lib/line/loopSteps";
import { lineRefHref } from "../../lib/line/lineWorkspaceUrl";
import { causeWhere, newestClose, type ReportTask } from "../../lib/line/runReport";
import { admissionHold, type LineCauseTask, type LineSignal } from "../../lib/lineFlow";
import { useCauseRuns } from "../line/RunReport";
import { useLineAdmission } from "../line/map/useLineAdmission";
import { WrongControl } from "./TaskLineStory";
import { cn } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { toast } from "sonner";

type ProblemTask = LineCauseTask & ReportTask & { _id: string; short_id: string; workspace?: string | null; project_id?: string | null };

const DAY = 86_400_000;
const TREND_DAYS = 30;

/** Where a judge saw it, as the place a reader knows (the judge reads one kind of moment). */
const PLACE: Record<string, string> = { comms: "Contact emails", match: "Introductions", call: "Calls" };
const placeOf = (s: LineSignal) => PLACE[s.judge ?? s.source.replace(/^judge:/, "")] ?? "Other reports";

/** The judges' own scale (judges/*.md): 9-10 breaks trust, 7-8 the contact noticed, 5-6 a lapse they likely missed. */
function severityWord(n: number): string {
  return n >= 9 ? "breaks trust" : n >= 7 ? "contact noticed" : "likely unnoticed";
}
const severityTone = (n: number) => (n >= 9 ? "text-sol-red" : n >= 7 ? "text-sol-orange" : "text-sol-yellow");
const severityBg = (n: number) => (n >= 9 ? "bg-sol-red" : n >= 7 ? "bg-sol-orange" : "bg-sol-yellow");

const STATE_TONE: Record<string, string> = { shipped: "text-sol-green", closed: "text-sol-text-muted", live: "text-sol-cyan", waiting: "text-sol-yellow", failed: "text-sol-red", calm: "text-sol-text" };
const STATE_DOT: Record<string, string> = { shipped: "bg-sol-green", closed: "bg-sol-text-dim", live: "bg-sol-cyan animate-pulse", waiting: "bg-sol-yellow", failed: "bg-sol-red", calm: "bg-sol-text-dim" };

const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "with", "no", "not", "and", "or", "its", "own"]);
const stem = (w: string) => w.replace(/(ations?|ates?|ing|ion|ed|es|s)$/, "").slice(0, 6);
const titleWords = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
/** Findings that say nearly the same thing collapse into one row with a count, newest first. */
function collapseAlike(signals: LineSignal[]): LineSignal[][] {
  const out: Array<{ words: Set<string>; rows: LineSignal[] }> = [];
  for (const s of signals) {
    const w = titleWords(s.title);
    const hit = out.find((g) => {
      let shared = 0;
      for (const x of w) if (g.words.has(x)) shared++;
      return shared / (w.size + g.words.size - shared || 1) >= 0.5;
    });
    if (hit) hit.rows.push(s); else out.push({ words: w, rows: [s] });
  }
  // The most repeated shapes first: they are what the problem is; a lone stray reads last.
  return out.map((g) => g.rows).sort((a, b) => b.length - a.length || b[0].observed_at - a[0].observed_at);
}

export function ProblemSummary({ task }: { task: ProblemTask }) {
  const workspace = task.workspace ?? null;
  useSyncSignals(workspace);
  useSyncTrial();
  const now = useCoarseNow(60_000);
  const all = useWorkspaceSignals(workspace);
  const signals = useMemo(() => all.filter((s) => s.task_id === task._id).sort((a, b) => b.observed_at - a.observed_at), [all, task._id]);
  const runs = useCauseRuns(task._id);
  const trialCards = useTrialCards();
  const admit = useLineAdmission(task.project_id ?? null);

  const count = task.cause?.signal_count ?? signals.length;
  // Conversations, not reports: one conversation judged twice is one place it went wrong.
  const conversations = useMemo(() => new Set(signals.map((s) => s.moment ?? s._id)).size, [signals]);
  const worst = signals.reduce((m, s) => Math.max(m, s.severity ?? 0), 0);
  const week = signals.filter((s) => s.observed_at > now - 7 * DAY).length;
  const firstSeen = task.cause?.first_seen ?? signals[signals.length - 1]?.observed_at ?? null;

  // The one state, and the one control that moves it.
  const stopped = admit.admission ? admissionHold(admit.admission)?.stopped ?? null : null;
  const close = useMemo(() => newestClose(runs, task.cause?.last_seen), [runs, task.cause?.last_seen]);
  const latest = runs[0] ?? null;
  const where = causeWhere(task, latest, signals.some((s) => s.reopened), now, stopped, close);
  const trialCard = trialCards.find((c) => c.task_short_id === task.short_id && c.status === "waiting") ?? null;
  const queueCard = runs.find((r) => r.gate_decision_short_id && r.gate_decision_status === "pending") ?? null;
  const liveRun = latest && (latest.status === "running" || latest.status === "paused" || latest.status === "pending") ? latest : null;
  // A problem no run has touched and that nothing will start says that first, then why, with the way out.
  const open = task.status === "open" || task.status === "backlog";
  const untouched = open && !liveRun && !trialCard && !queueCard;
  const a = admit.admission;
  const control: { href?: string; onClick?: () => void; label: string; primary: boolean } | null = trialCard
    ? { href: `/trial?card=${trialCard.short_id}`, label: "Review the fix", primary: true }
    : queueCard
      ? { href: `/decisions/${queueCard.gate_decision_short_id}`, label: "Review the fix", primary: true }
      : liveRun
        ? { href: `/workflows/runs/${liveRun._id}`, label: "Watch the fix", primary: false }
        : untouched && a && !a.noProject && (!a.role || a.role.paused) && task.project_id
          ? { href: `/projects/${task.project_id}`, label: a.role ? "Open the project" : "Assign an owner", primary: false }
          : untouched && a?.role && !a.on
            ? { onClick: () => { useInboxStore.getState().startLineCause(task._id).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e))); }, label: "Start a fix", primary: false }
            : null;
  const fix = trialCard?.card?.headline ?? null;
  const state = trialCard || queueCard
    ? { tone: "waiting", text: fix ? `Fix ready: ${fix}` : "A fix is ready for your decision." }
    : untouched && stopped ? { tone: "waiting", text: !a?.role ? "Not being fixed: no one owns fixes for this project yet." : `Not being fixed: ${stopped}.` } : where;

  const cited = useMemo(() => [...new Set(signals.map((s) => s.subject).filter(isExpectationId))], [signals]);
  const { data: lines } = useQueryNoThrow((api as any).expectations.lines, cited.length > 0 && workspace ? { workspace, ids: cited } : "skip");
  const rule = (lines as Array<{ id: string; text: string }> | null | undefined)?.find((l) => l.id === cited[0])?.text ?? null;

  return (
    <section className="mb-6" data-problem-summary>
      {rule && <RuleLine rule={rule} ids={cited} />}

      {/* The numbers: how often, how bad, which way it is going. */}
      <div className="grid grid-cols-[auto_auto_1fr] items-stretch gap-px overflow-hidden rounded-lg border border-sol-border/30 bg-sol-border/30" data-problem-numbers>
        <Stat label="Conversations" value={String(conversations || count)} sub={firstSeen ? `since ${day(firstSeen)}` : undefined} title={`${count} ${count === 1 ? "report" : "reports"} across ${conversations} conversations`} />
        <Stat label="Worst severity" value={worst ? `${worst}/10` : "–"} valueClass={worst ? severityTone(worst) : undefined} sub={worst ? severityWord(worst) : undefined} title="The judges' scale: 9-10 breaks the contact's trust, 7-8 the contact noticed, 5-6 a lapse they likely missed" />
        <div className="bg-sol-bg px-4 py-2.5 min-w-0">
          <div className="flex items-baseline justify-between gap-2 text-[11px] text-sol-text-dim">
            <span>Last {TREND_DAYS} days</span>
            <span className="tabular-nums"><span className="text-sol-text">{week}</span> this week</span>
          </div>
          <Trend signals={signals} now={now} />
        </div>
      </div>

      {/* Where it stands, and the one thing to do about it. */}
      <div className="mt-3 flex items-center gap-3 rounded-lg border border-sol-border/30 px-4 py-2.5" data-problem-state>
        <span className={cn("h-2 w-2 shrink-0 rounded-full", STATE_DOT[state.tone] ?? "bg-sol-text-dim")} aria-hidden />
        <span className={cn("min-w-0 flex-1 text-[13px]", STATE_TONE[state.tone])} data-cause-where>{state.text}</span>
        <Link href={lineRefHref(task.short_id)} className="shrink-0 text-[11.5px] text-sol-text-dim hover:text-sol-blue" title="Every report, every attempt to fix it, ships and what came back">Timeline</Link>
        {control && (() => {
          const cls = cn("shrink-0 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors", control.primary ? "bg-sol-yellow/15 text-sol-yellow ring-1 ring-sol-yellow/40 hover:bg-sol-yellow/25" : "text-sol-cyan ring-1 ring-sol-cyan/30 hover:bg-sol-cyan/10");
          return control.href
            ? <Link href={control.href} className={cls} data-problem-control>{control.label}<ArrowUpRight className="h-3.5 w-3.5" /></Link>
            : <button type="button" onClick={control.onClick} className={cls} data-problem-control>{control.label}</button>;
        })()}
      </div>

      {signals.length > 0 && <Findings signals={signals} />}
    </section>
  );
}

/** What the product should have done: one line, the whole rule on a click. */
function RuleLine({ rule, ids }: { rule: string; ids: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cn("mb-4 block w-full text-left text-[12.5px] leading-snug text-sol-text-muted hover:text-sol-text", !open && "line-clamp-3")} data-problem-rule title={open ? ids.join(", ") : rule}>
      <span className="text-sol-text-dim">Rule: </span>{rule}
    </button>
  );
}

function Stat({ label, value, sub, valueClass, title }: { label: string; value: string; sub?: string; valueClass?: string; title?: string }) {
  return (
    <div className="bg-sol-bg px-4 py-2.5 min-w-[7.5rem]" title={title}>
      <div className="text-[11px] text-sol-text-dim">{label}</div>
      <div className={cn("text-[22px] font-semibold leading-tight tabular-nums text-sol-text", valueClass)}>{value}</div>
      {sub && <div className="text-[11px] text-sol-text-dim whitespace-nowrap">{sub}</div>}
    </div>
  );
}

/** One bar a day, by when it happened (not when it was judged), the worst severity of the day as its ink. */
function Trend({ signals, now }: { signals: LineSignal[]; now: number }) {
  const days = useMemo(() => {
    const end = new Date(now); end.setHours(24, 0, 0, 0);
    const start = end.getTime() - TREND_DAYS * DAY;
    const out = Array.from({ length: TREND_DAYS }, (_, i) => ({ at: start + i * DAY, n: 0, worst: 0 }));
    for (const s of signals) {
      const i = Math.floor((s.observed_at - start) / DAY);
      if (i >= 0 && i < TREND_DAYS) { out[i].n++; out[i].worst = Math.max(out[i].worst, s.severity ?? 0); }
    }
    return out;
  }, [signals, now]);
  const max = Math.max(1, ...days.map((d) => d.n));
  return (
    <div className="mt-1.5 flex h-9 items-end gap-[2px]" role="img" aria-label="Reports per day" data-problem-trend>
      {days.map((d) => (
        <span
          key={d.at}
          className={cn("flex-1 rounded-[1px]", d.n ? severityBg(d.worst) : "bg-sol-border/40")}
          style={{ height: d.n ? `${Math.max(12, (d.n / max) * 100)}%` : "2px", opacity: d.n ? 0.85 : 1 }}
          title={`${day(d.at)}: ${d.n} ${d.n === 1 ? "report" : "reports"}`}
        />
      ))}
    </div>
  );
}

const SHOWN = 5;

/** The findings, grouped by where they were seen, newest first; a row opens on the words that were sent. */
function Findings({ signals }: { signals: LineSignal[] }) {
  const groups = useMemo(() => {
    const by = new Map<string, LineSignal[]>();
    for (const s of signals) by.set(placeOf(s), [...(by.get(placeOf(s)) ?? []), s]);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [signals]);
  const [place, setPlace] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = useMemo(() => collapseAlike(place ? groups.find(([p]) => p === place)?.[1] ?? [] : signals), [place, groups, signals]);
  const rows = all ? shown : shown.slice(0, SHOWN);
  return (
    <div className="mt-5" data-problem-findings>
      <div className="flex flex-wrap items-center gap-1.5">
        <h2 className="mr-1 text-[12px] font-medium text-sol-text">Evidence</h2>
        {[["All", signals.length] as const, ...groups.map(([p, xs]) => [p, xs.length] as const)].map(([p, n]) => {
          const on = (p === "All" && !place) || p === place;
          return (
            <button key={p} type="button" onClick={() => { setPlace(p === "All" ? null : p); setAll(false); }} aria-pressed={on} className={cn("rounded-full px-2.5 py-0.5 text-[11.5px] tabular-nums transition-colors", on ? "bg-sol-bg-alt text-sol-text ring-1 ring-sol-border" : "text-sol-text-dim hover:text-sol-text")} data-problem-place={p}>
              {p} <span className="opacity-60">{n}</span>
            </button>
          );
        })}
      </div>
      <ul className="mt-2 divide-y divide-sol-border/20 rounded-lg border border-sol-border/30">
        {rows.map((g) => <FindingRow key={g[0]._id} rows={g} />)}
      </ul>
      {shown.length > SHOWN && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-sol-text-dim hover:text-sol-text" data-problem-more>
          {all ? "Fewer" : `${shown.length - SHOWN} more`}<ChevronRight className={cn("h-3 w-3 transition-transform", all ? "-rotate-90" : "rotate-90")} />
        </button>
      )}
    </div>
  );
}

function FindingRow({ rows }: { rows: LineSignal[] }) {
  const [open, setOpen] = useState(false);
  const s = rows[0];
  const sev = rows.reduce((m, r) => Math.max(m, r.severity ?? 0), 0);
  return (
    <li data-problem-finding={s.short_id ?? s._id}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-baseline gap-2.5 px-3 py-2 text-left hover:bg-sol-bg-alt/40">
        <span className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 self-start rounded-full", sev >= 7 ? severityBg(sev) : "bg-sol-border")} title={sev ? `Severity ${sev} of 10: ${severityWord(sev)}` : undefined} />
        <span className={cn("min-w-0 flex-1 text-[12.5px] leading-snug text-sol-text", !open && "line-clamp-2")}>{s.title}</span>
        {rows.length > 1 && <span className="shrink-0 rounded bg-sol-bg-alt px-1.5 text-[11px] tabular-nums text-sol-text-muted" title={`${rows.length} findings say nearly the same`}>×{rows.length}</span>}
        {rows.some((r) => r.reopened) && <span className="shrink-0 text-[11px] text-sol-red">reopened it</span>}
        <span className="shrink-0 text-[11px] tabular-nums text-sol-text-dim" title={new Date(s.observed_at).toLocaleString()}>{day(s.observed_at)}</span>
      </button>
      {open && (
        <div className="space-y-3 pb-3 pl-[1.6rem] pr-3" data-problem-finding-open>
          {distinctWords(rows).slice(0, 3).map((r) => <FindingWords key={r._id} s={r} titled={false} />)}
          {distinctWords(rows).length > 3 && <p className="text-[11px] text-sol-text-dim">and {distinctWords(rows).length - 3} more like these</p>}
        </div>
      )}
    </li>
  );
}

/** Findings with distinct quoted words: the same message judged in two moments shows once. */
function distinctWords(rows: LineSignal[]): LineSignal[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const q = (findingGist(r).quote ?? r.title).trim().toLowerCase();
    if (seen.has(q)) return false;
    seen.add(q);
    return true;
  });
}

/** One finding opened: the words that were sent, what the judge saw, and its controls. */
function FindingWords({ s, titled }: { s: LineSignal; titled: boolean }) {
  const gist = useMemo(() => findingGist(s), [s]);
  const judge = s.judge ? `${s.judge.charAt(0).toUpperCase()}${s.judge.slice(1)} judge` : null;
  return (
    <div className="space-y-1.5">
      {titled && <p className="text-[12px] text-sol-text-muted">{s.title} <span className="text-sol-text-dim tabular-nums">{day(s.observed_at)}</span></p>}
      {gist.quote && (
        <blockquote className="border-l-2 border-sol-yellow/50 pl-3 text-[13px] leading-relaxed text-sol-text" data-problem-quote>
          {gist.quote}
        </blockquote>
      )}
      <div className="flex items-center gap-3 text-[11px] text-sol-text-dim">
        {s.evidence_url && <a href={s.evidence_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-sol-blue">Source<ArrowUpRight className="h-3 w-3" /></a>}
        {judge && !s.case_of && <WrongControl s={s} judge={judge} />}
      </div>
    </div>
  );
}
