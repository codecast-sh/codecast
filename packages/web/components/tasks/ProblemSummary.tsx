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

/** The kinds of miss the judges named, by how often: their markers ("narrates effort, no result") split and counted. */
function topMarkers(signals: LineSignal[], n = 3): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of signals) {
    const last = (s.detail_md ?? "").trim().split("\n").pop() ?? "";
    if (!last || last.startsWith(">") || last.length > 160) continue;
    for (const raw of new Set(last.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean))) counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, count]) => ({ label, count }));
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
  const control = trialCard
    ? { href: `/trial?card=${trialCard.short_id}`, label: "Review the change", primary: true }
    : queueCard
      ? { href: `/decisions/${queueCard.gate_decision_short_id}`, label: "Review the change", primary: true }
      : liveRun
        ? { href: `/workflows/runs/${liveRun._id}`, label: "Watch the fix", primary: false }
        : null;
  const state = trialCard || queueCard ? { tone: "waiting", text: "A fix is ready for your decision." } : where;

  const cited = useMemo(() => [...new Set(signals.map((s) => s.subject).filter(isExpectationId))], [signals]);
  const { data: lines } = useQueryNoThrow((api as any).expectations.lines, cited.length > 0 && workspace ? { workspace, ids: cited } : "skip");
  const rule = (lines as Array<{ id: string; text: string }> | null | undefined)?.find((l) => l.id === cited[0])?.text ?? null;
  const markers = useMemo(() => topMarkers(signals), [signals]);

  return (
    <section className="mb-6" data-problem-summary>
      {rule && (
        <p className="mb-4 text-[12.5px] leading-snug text-sol-text-muted" data-problem-rule title={cited.join(", ")}>
          <span className="text-sol-text-dim">Breaks </span>{rule}
        </p>
      )}

      {/* The numbers: how often, how bad, which way it is going. */}
      <div className="grid grid-cols-[auto_auto_1fr] items-stretch gap-px overflow-hidden rounded-lg border border-sol-border/30 bg-sol-border/30" data-problem-numbers>
        <Stat label="Reports" value={String(count)} sub={firstSeen ? `since ${day(firstSeen)}` : undefined} />
        <Stat label="Worst" value={worst ? `${worst}/10` : "–"} valueClass={worst ? severityTone(worst) : undefined} sub={worst ? severityWord(worst) : undefined} />
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
        <Link href={lineRefHref(task.short_id)} className="shrink-0 text-[11.5px] text-sol-text-dim hover:text-sol-blue" title="Every report, every attempt to fix it, ships and what came back">History</Link>
        {control && (
          <Link
            href={control.href}
            className={cn("shrink-0 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors", control.primary ? "bg-sol-yellow/15 text-sol-yellow ring-1 ring-sol-yellow/40 hover:bg-sol-yellow/25" : "text-sol-cyan ring-1 ring-sol-cyan/30 hover:bg-sol-cyan/10")}
            data-problem-control
          >
            {control.label}<ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>

      {signals.length > 0 && <Findings signals={signals} markers={markers} />}
    </section>
  );
}

function Stat({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="bg-sol-bg px-4 py-2.5 min-w-[7.5rem]">
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
function Findings({ signals, markers }: { signals: LineSignal[]; markers: Array<{ label: string; count: number }> }) {
  const groups = useMemo(() => {
    const by = new Map<string, LineSignal[]>();
    for (const s of signals) by.set(placeOf(s), [...(by.get(placeOf(s)) ?? []), s]);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [signals]);
  const [place, setPlace] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = place ? groups.find(([p]) => p === place)?.[1] ?? [] : signals;
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
      {markers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-problem-markers>
          {markers.map((m) => (
            <span key={m.label} className="rounded bg-sol-bg-alt/70 px-1.5 py-0.5 text-[11px] text-sol-text-muted">{m.label} <span className="tabular-nums text-sol-text-dim">×{m.count}</span></span>
          ))}
        </div>
      )}
      <ul className="mt-2 divide-y divide-sol-border/20 rounded-lg border border-sol-border/30">
        {rows.map((s) => <FindingRow key={s._id} s={s} />)}
      </ul>
      {shown.length > SHOWN && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-sol-text-dim hover:text-sol-text" data-problem-more>
          {all ? "Fewer" : `All ${shown.length}`}<ChevronRight className={cn("h-3 w-3 transition-transform", all ? "-rotate-90" : "rotate-90")} />
        </button>
      )}
    </div>
  );
}

function FindingRow({ s }: { s: LineSignal }) {
  const [open, setOpen] = useState(false);
  const gist = useMemo(() => findingGist(s), [s]);
  const sev = s.severity ?? 0;
  const judge = s.judge ? `${s.judge.charAt(0).toUpperCase()}${s.judge.slice(1)} judge` : null;
  return (
    <li data-problem-finding={s.short_id ?? s._id}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-sol-bg-alt/40">
        <span className={cn("w-7 shrink-0 text-right text-[11.5px] tabular-nums", sev ? severityTone(sev) : "text-sol-text-dim")} title={sev ? `Severity ${sev} of 10: ${severityWord(sev)}` : undefined}>{sev || ""}</span>
        <span className={cn("min-w-0 flex-1 text-[12.5px] leading-snug text-sol-text", !open && "truncate")}>{s.title}</span>
        {s.reopened && <span className="shrink-0 text-[11px] text-sol-red">reopened it</span>}
        <span className="shrink-0 text-[11px] tabular-nums text-sol-text-dim" title={new Date(s.observed_at).toLocaleString()}>{day(s.observed_at)}</span>
      </button>
      {open && (
        <div className="space-y-2 pb-3 pl-[3.25rem] pr-3" data-problem-finding-open>
          {gist.quote && (
            <blockquote className="border-l-2 border-sol-yellow/50 pl-3 text-[13px] leading-relaxed text-sol-text" data-problem-quote>
              {gist.quote}
            </blockquote>
          )}
          {gist.says && <p className="text-[12px] leading-snug text-sol-text-muted">{gist.says}</p>}
          <div className="flex items-center gap-3 text-[11px] text-sol-text-dim">
            {judge && <span>{judge}</span>}
            <Link href={lineRefHref(s.short_id || s._id)} className="hover:text-sol-blue">Trace</Link>
            {s.evidence_url && <a href={s.evidence_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-sol-blue">Source<ArrowUpRight className="h-3 w-3" /></a>}
            {judge && !s.case_of && <WrongControl s={s} judge={judge} />}
          </div>
        </div>
      )}
    </li>
  );
}
