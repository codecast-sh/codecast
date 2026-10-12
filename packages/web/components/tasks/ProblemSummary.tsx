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
import { noticedCount, severityWord } from "./impact";

type ProblemTask = LineCauseTask & ReportTask & { _id: string; short_id: string; workspace?: string | null; project_id?: string | null };


const DAY = 86_400_000;
const TREND_DAYS = 30;

/** Where a judge saw it, as the place a reader knows (the judge reads one kind of moment). */
const PLACE: Record<string, string> = { comms: "Contact emails", match: "Introductions", call: "Calls" };
const placeOf = (s: LineSignal) => PLACE[s.judge ?? s.source.replace(/^judge:/, "")] ?? "Other reports";

/** This week against the week before, in words. */
function trendWord(week: number, last: number): string {
  if (!week && !last) return "none in two weeks";
  if (!last) return "new this week";
  const pct = Math.round(((week - last) / last) * 100);
  return pct >= 15 ? `up ${pct}% on last week` : pct <= -15 ? `down ${-pct}% on last week` : "about the same as last week";
}
const severityBg = (n: number) => (n >= 9 ? "bg-sol-red" : n >= 7 ? "bg-sol-orange" : "bg-sol-yellow");

const STATE_TONE: Record<string, string> = { shipped: "text-sol-green", closed: "text-sol-text-muted", live: "text-sol-cyan", waiting: "text-sol-yellow", failed: "text-sol-red", calm: "text-sol-text" };
const STATE_DOT: Record<string, string> = { shipped: "bg-sol-green", closed: "bg-sol-text-dim", live: "bg-sol-cyan animate-pulse", waiting: "bg-sol-yellow", failed: "bg-sol-red", calm: "bg-sol-text-dim" };

/** A live run's station, as the step a reader follows ("Working: at Dissolve." says nothing to them). */
const STEP_WORDS: Record<string, string> = {
  problem: "reading the reports", ground: "reading the reports", dissolve: "checking whether it still happens", investigate: "finding the cause",
  refine: "sorting the reports by cause", prove: "reproducing it", red: "reproducing it", propose: "proposing a fix", proposal: "waiting on the proposal",
  approve: "approving the proposal", build: "building the fix", implement: "building the fix", verify: "checking the fix", green: "checking the fix",
  "eval scope": "checking the fix", eval: "testing the fix on real cases", review: "an independent review of the fix", "card draft": "writing up the fix",
  "card words": "writing up the fix", card: "writing up the fix",
};
/** `since`: conversations that happened after the problem closed, null when it is open. */
function plainWhere(text: string, since: number | null, closedAgo: number | null): string {
  if (/^(Closed without a change|Dissolved) at /.test(text)) {
    if (since) return `Closed with no new fix, but seen in ${since} ${since === 1 ? "conversation" : "conversations"} since.`;
    // Too soon to say it stopped: the reports so far all came before the close.
    if (closedAgo !== null && closedAgo < 2 * DAY) return "Closed with no new fix needed. Watching for new cases.";
    return since === 0 ? "Closed with no new fix needed. Not seen since it closed." : "Closed with no new fix needed.";
  }
  const looped = /^Stopped: ([^.]+?) looped/.exec(text);
  if (looped) return `Fix attempt stopped while ${STEP_WORDS[looped[1].trim().toLowerCase()] ?? looped[1].toLowerCase()}: three tries did not pass the checks.`;
  const m = /^Working: at ([^.]+)\.?(.*)$/.exec(text);
  if (!m) return text;
  const step = STEP_WORDS[m[1].trim().toLowerCase()] ?? m[1].trim().toLowerCase();
  return `Being fixed: ${step}. Nothing needed from you yet.`;
}

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
      return shared / (w.size + g.words.size - shared || 1) >= 0.4;
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
  // How many conversations went wrong in a way the contact noticed (the judges' 7 and up): the number that ranks problems.
  const noticed = useMemo(() => noticedCount(signals), [signals]);
  const week = new Set(signals.filter((s) => s.observed_at > now - 7 * DAY).map((s) => s.moment ?? s._id)).size;
  const lastWeek = new Set(signals.filter((s) => s.observed_at > now - 14 * DAY && s.observed_at <= now - 7 * DAY).map((s) => s.moment ?? s._id)).size;
  // A closed problem counts what happened after it closed: reports judged later about older conversations are history, not a return.
  const close = useMemo(() => newestClose(runs, task.cause?.last_seen), [runs, task.cause?.last_seen]);
  const closedAt = (task as { closed_at?: number | null }).closed_at ?? close?.at ?? null;
  const isClosed = task.status === "done" || task.status === "dropped";
  const sinceClosed = isClosed && closedAt ? new Set(signals.filter((s) => s.observed_at > closedAt).map((s) => s.moment ?? s._id)).size : null;
  const firstSeen = task.cause?.first_seen ?? signals[signals.length - 1]?.observed_at ?? null;

  // The one state, and the one control that moves it.
  const stopped = admit.admission ? admissionHold(admit.admission)?.stopped ?? null : null;
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
        : latest && latest.status === "failed" && !isClosed
          ? { href: `/workflows/runs/${latest._id}`, label: "See what failed", primary: false }
        : untouched && a && !a.noProject && (!a.role || a.role.paused) && task.project_id
          ? { href: `/projects/${task.project_id}`, label: a.role ? "Open the project" : "Assign an owner", primary: false }
          : untouched && a?.role && !a.on
            ? { onClick: () => { useInboxStore.getState().startLineCause(task._id).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e))); }, label: "Start a fix", primary: false }
            : null;
  // A card written before headlines names its fix by its change's first sentence.
  const fix = trialCard?.card ? trialCard.card.headline || trialCard.card.change.split(/(?<=[.!?])\s/)[0].replace(/^On this (local )?branch,\s*/i, "") : null;

  const state = trialCard || queueCard
    ? { tone: "waiting", text: fix ? `Fix ready: ${fix}` : "A fix is ready for your decision." }
    : untouched && stopped ? { tone: worst >= 7 ? "failed" : "waiting", text: !a?.role ? "Not being fixed: no one owns fixes for this project yet." : `Not being fixed: ${stopped}.` } : { ...where, text: plainWhere(where.text, sinceClosed, closedAt ? now - closedAt : null) };

  const cited = useMemo(() => [...new Set(signals.map((s) => s.subject).filter(isExpectationId))], [signals]);
  const { data: lines } = useQueryNoThrow((api as any).expectations.lines, cited.length > 0 && workspace ? { workspace, ids: cited } : "skip");
  const rule = (lines as Array<{ id: string; text: string }> | null | undefined)?.find((l) => l.id === cited[0])?.text ?? null;

  return (
    <section className="mb-6" data-problem-summary>
      {/* The numbers: how often, how bad, which way it is going. */}
      <div className="grid grid-cols-[auto_auto_auto_1fr] items-stretch gap-px overflow-hidden rounded-lg border border-sol-border/30 bg-sol-border/30" data-problem-numbers>
        <Stat label="Conversations" value={String(conversations || count)} sub={firstSeen ? `since ${day(firstSeen)}` : undefined} title={`${count} ${count === 1 ? "report" : "reports"} across ${conversations} conversations`} />
        <Stat label="Severity" value={worst ? `${worst}/10` : "–"} valueClass={worst >= 9 ? "text-sol-red" : worst >= 7 ? "text-sol-orange" : undefined} sub={worst ? (noticed ? `${noticed} noticed by the contact` : severityWord(worst)) : undefined} title="The worst a judge rated one of these conversations. 9-10 broke the contact's trust, 7-8 the contact noticed, 5-6 a lapse they likely missed." />
        {isClosed && closedAt
          ? <Stat label="Since it closed" value={String(sinceClosed ?? 0)} valueClass={sinceClosed ? "text-sol-red" : "text-sol-green"} sub={`closed ${day(closedAt)}`} title="Conversations that went wrong after the problem closed" />
          : <Stat label="This week" value={String(week)} sub={trendWord(week, lastWeek)} title="Conversations that went wrong in the last 7 days, against the 7 before" />}
        <div className="bg-sol-bg px-4 py-2.5 min-w-0">
          <div className="flex items-baseline justify-between gap-2 text-[11px] text-sol-text-dim">
            <span>Conversations per day</span>

          </div>
          <Trend signals={signals} now={now} closedAt={isClosed ? closedAt : null} />
        </div>
      </div>

      {/* Where it stands, and the one thing to do about it. */}
      <div className="mt-3 flex items-center gap-3 rounded-lg border border-sol-border/30 px-4 py-2.5" data-problem-state>
        <span className={cn("h-2 w-2 shrink-0 rounded-full", STATE_DOT[state.tone] ?? "bg-sol-text-dim")} aria-hidden />
        <span className={cn("min-w-0 flex-1 text-[13px]", STATE_TONE[state.tone])} data-cause-where>{state.text}</span>
        <Link href={lineRefHref(task.short_id)} className="shrink-0 text-[11.5px] text-sol-text-dim hover:text-sol-blue" title="Every report, every attempt to fix it, ships and what came back">{task.status === "done" || task.status === "dropped" ? "See why" : "Timeline"}</Link>
        {control && (() => {
          const cls = cn("shrink-0 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors", control.primary ? "bg-sol-yellow/15 text-sol-yellow ring-1 ring-sol-yellow/40 hover:bg-sol-yellow/25" : "text-sol-cyan ring-1 ring-sol-cyan/30 hover:bg-sol-cyan/10");
          return control.href
            ? <Link href={control.href} className={cls} data-problem-control>{control.label}<ArrowUpRight className="h-3.5 w-3.5" /></Link>
            : <button type="button" onClick={control.onClick} className={cls} data-problem-control>{control.label}</button>;
        })()}
      </div>

      {signals.length > 0 && <Findings signals={signals} ruleText={rule} />}
    </section>
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

/** One bar a day of conversations, by when they happened (not when they were judged), with the close marked. */
function Trend({ signals, now, closedAt }: { signals: LineSignal[]; now: number; closedAt: number | null }) {
  const days = useMemo(() => {
    const end = new Date(now); end.setHours(24, 0, 0, 0);
    const start = end.getTime() - TREND_DAYS * DAY;
    const seen = Array.from({ length: TREND_DAYS }, () => new Set<string>());
    for (const s of signals) {
      const i = Math.floor((s.observed_at - start) / DAY);
      if (i >= 0 && i < TREND_DAYS) seen[i].add(s.moment ?? s._id);
    }
    return seen.map((set, i) => ({ at: start + i * DAY, n: set.size }));
  }, [signals, now]);
  const max = Math.max(1, ...days.map((d) => d.n));
  return (
    <>
    <div className="relative mt-1.5 flex h-9 items-end gap-[2px]" role="img" aria-label="Reports per day" data-problem-trend>
      {closedAt && closedAt > days[0].at && (
        <span className="pointer-events-none absolute inset-y-0 border-l border-dashed border-sol-green/70" style={{ left: `${Math.min(100, ((closedAt - days[0].at) / (TREND_DAYS * DAY)) * 100)}%` }} title={`Closed ${day(closedAt)}`}>
        </span>
      )}
      {days.map((d) => (
        <span
          key={d.at}
          className={cn("flex-1 rounded-[1px]", d.n ? "bg-sol-blue" : "bg-sol-border/40")}
          style={{ height: d.n ? `${Math.max(12, (d.n / max) * 100)}%` : "2px", opacity: d.n ? 0.85 : 1 }}
          title={`${day(d.at)}: ${d.n} ${d.n === 1 ? "conversation" : "conversations"}`}
        />
      ))}
    </div>
    <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-sol-text-dim" aria-hidden>
      <span>{day(days[0].at)}</span><span>{day(days[Math.floor(TREND_DAYS / 2)].at)}</span><span>today</span>
    </div>
    </>
  );
}

const SHOWN = 3;

/** The findings, grouped by where they were seen, newest first; a row opens on the words that were sent. */
function Findings({ signals, ruleText }: { signals: LineSignal[]; ruleText: string | null }) {
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
        <h2 className="mr-1 text-[12px] font-medium text-sol-text" title={typeof ruleText === "string" ? `Judged against: ${ruleText}` : undefined}>Evidence</h2>
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
          {all ? "Fewer" : `All ${signals.length} reports`}<ChevronRight className={cn("h-3 w-3 transition-transform", all ? "-rotate-90" : "rotate-90")} />
        </button>
      )}
    </div>
  );
}

function FindingRow({ rows }: { rows: LineSignal[] }) {
  const [open, setOpen] = useState(false);
  const s = rows[0];
  const sev = rows.reduce((m, r) => Math.max(m, r.severity ?? 0), 0);
  const alike = useMemo(() => distinctWords(rows).length, [rows]);
  return (
    <li data-problem-finding={s.short_id ?? s._id}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-baseline gap-2.5 px-3 py-2 text-left hover:bg-sol-bg-alt/40">
        <span className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 self-start rounded-full", sev >= 7 ? severityBg(sev) : "bg-sol-border")} title={sev ? `Severity ${sev} of 10: ${severityWord(sev)}` : undefined} />
        <span className={cn("min-w-0 flex-1 text-[12.5px] leading-snug text-sol-text", !open && "line-clamp-2")}>{whatHappened(s)}</span>
        {alike > 1 && <span className="shrink-0 rounded bg-sol-bg-alt px-1.5 text-[11px] tabular-nums text-sol-text-muted" title={`${alike} findings say nearly the same${rows.length > alike ? `; ${rows.length} reports in all` : ""}`}>{alike} alike</span>}
        {rows.some((r) => r.reopened) && <span className="shrink-0 text-[11px] text-sol-red">reopened it</span>}
        <span className="shrink-0 text-[11px] tabular-nums text-sol-text-dim" title={new Date(s.observed_at).toLocaleString()}>{day(s.observed_at)}</span>
      </button>
      {open && (
        <div className="space-y-3 pb-3 pl-[1.6rem] pr-3" data-problem-finding-open>
          <ClusterWords rows={distinctWords(rows)} />
        </div>
      )}
    </li>
  );
}

/** What the judge said happened, whole: a title is its first sentence, which can stop before the miss ("Joseph asked what Union costs."). */
function whatHappened(s: LineSignal): string {
  const head = (s.detail_md ?? "").split(/\n\s*\n|\n>/)[0]?.trim();
  return head && head.length >= s.title.length && head.length < 600 ? head : s.title;
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

/** An opened row: its first finding's words, the alike ones a click further. */
function ClusterWords({ rows }: { rows: LineSignal[] }) {
  const [more, setMore] = useState(false);
  const shown = more ? rows : rows.slice(0, 1);
  return (
    <>
      {shown.map((r, i) => <FindingWords key={r._id} s={r} titled={i > 0} />)}
      {rows.length > 1 && (
        <button type="button" onClick={() => setMore((m) => !m)} className="text-[11.5px] text-sol-text-dim hover:text-sol-text">
          {more ? "Show one" : `${rows.length - 1} more like this`}
        </button>
      )}
    </>
  );
}

/** One finding opened: the words that were sent, what the judge saw, and its controls. */
function FindingWords({ s, titled }: { s: LineSignal; titled: boolean }) {
  const gist = useMemo(() => findingGist(s), [s]);
  const judge = s.judge ? `${s.judge.charAt(0).toUpperCase()}${s.judge.slice(1)} judge` : null;
  return (
    <div className="group/finding relative space-y-1.5">
      {titled && <p className="text-[12px] text-sol-text-muted">{whatHappened(s)} <span className="text-sol-text-dim tabular-nums">{day(s.observed_at)}</span></p>}
      {gist.quote && (
        <blockquote className="border-l-2 border-sol-yellow/50 pl-3 text-[13px] leading-relaxed text-sol-text" data-problem-quote>
          {gist.quote}
        </blockquote>
      )}
      <div className="absolute right-0 top-0 flex items-center gap-3 rounded bg-sol-bg/90 pl-2 text-[11px] text-sol-text-dim opacity-0 transition-opacity group-hover/finding:opacity-100 focus-within:opacity-100">
        {s.evidence_url && <a href={s.evidence_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-sol-blue">Source<ArrowUpRight className="h-3 w-3" /></a>}
        {judge && !s.case_of && <WrongControl s={s} judge={judge} />}
      </div>
    </div>
  );
}
