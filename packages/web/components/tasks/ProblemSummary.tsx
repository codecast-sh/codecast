"use client";
// A problem's page head (learning-loop.md LL6): what a busy reader needs
// before anything else, at a glance. The numbers (how often, how bad, the
// trend), the one state it is in with the one control that moves it, and the
// findings behind it, grouped by where they were seen, each opening on the
// words that were actually sent. Everything else the task carries (its
// description, sessions, activity) folds below on the page.
import { createContext, useContext, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import { findingConversation } from "@codecast/shared/contracts/judges";
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
import { cardAsRead, evidenceGone, fateWords, goneWhere } from "../../lib/trialEvidence";
import { holdReasons } from "../decisions/ChangeCardView";
import { evalsOwed } from "@codecast/shared/contracts/changeCard";
import type { TrialWithdrawn } from "../../hooks/useSyncTrial";

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

/** Each moment's findings on other problems: a call judged under several rules shows them as context on each, not as more evidence. */
const ElsewhereContext = createContext<Map<string, LineSignal[]>>(new Map());

const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

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
  const elsewhere = useMemo(() => {
    const by = new Map<string, LineSignal[]>();
    for (const s of all) if (s.moment && s.task_id !== task._id && !s.case_of) by.set(s.moment, [...(by.get(s.moment) ?? []), s]);
    return by;
  }, [all, task._id]);
  const runs = useCauseRuns(task._id);
  const trialCards = useTrialCards();
  const admit = useLineAdmission(task.project_id ?? null);

  // A trial problem's evidence is read live on the server (convex lib/problemEvidence): the one count its card and /trial show too.
  const trialCard = trialCards.find((c) => c.task_short_id === task.short_id && c.status === "waiting") ?? null;
  const evidence = (trialCard ?? trialCards.filter((c) => c.task_short_id === task.short_id).sort((a, b) => b.created_at - a.created_at)[0])?.evidence ?? null;
  const count = evidence ? evidence.findings : task.cause?.signal_count ?? signals.length;
  // Conversations, not reports: one conversation judged at every moment it moved is one place it went wrong.
  const counted = useMemo(() => new Set(signals.map(findingConversation)).size, [signals]);
  const conversations = evidence ? evidence.conversations : counted;
  const worst = signals.reduce((m, s) => Math.max(m, s.severity ?? 0), 0);
  // How many conversations went wrong in a way the contact noticed (the judges' 7 and up): the number that ranks problems.
  const noticed = useMemo(() => noticedCount(signals), [signals]);
  const week = new Set(signals.filter((s) => s.observed_at > now - 7 * DAY).map(findingConversation)).size;
  const lastWeek = new Set(signals.filter((s) => s.observed_at > now - 14 * DAY && s.observed_at <= now - 7 * DAY).map(findingConversation)).size;
  // A run's own count of the miss in the product's record outranks the findings' weekly trend, which only says when judges filed.
  // Only the waiting card's count, and only while it measured the findings on the problem now: an older card's count
  // (or one taken before a regroup) describes another set, and a replay of the fix's answers is not a rate of the miss.
  const measuredBy = trialCard ?? null;
  const measured = measuredBy?.proposal?.measured && measuredBy.proposal.measured.count > 0 && !measuredBy.regrouped ? measuredBy.proposal.measured : null;
  // A closed problem counts what happened after it closed: reports judged later about older conversations are history, not a return.
  const close = useMemo(() => newestClose(runs, task.cause?.last_seen), [runs, task.cause?.last_seen]);
  const closedAt = (task as { closed_at?: number | null }).closed_at ?? close?.at ?? null;
  const isClosed = task.status === "done" || task.status === "dropped";
  const sinceClosed = isClosed && closedAt ? new Set(signals.filter((s) => s.observed_at > closedAt).map(findingConversation)).size : null;
  const firstSeen = task.cause?.first_seen ?? signals[signals.length - 1]?.observed_at ?? null;

  // The one state, and the one control that moves it.
  const stopped = admit.admission ? admissionHold(admit.admission)?.stopped ?? null : null;
  const latest = runs[0] ?? null;
  const where = causeWhere(task, latest, signals.some((s) => s.reopened), now, stopped, close);
  const queueCard = runs.find((r) => r.gate_decision_short_id && r.gate_decision_status === "pending") ?? null;
  const liveRun = latest && (latest.status === "running" || latest.status === "paused" || latest.status === "pending") ? latest : null;
  // A problem no run has touched and that nothing will start says that first, then why, with the way out.
  const open = task.status === "open" || task.status === "backlog";
  const untouched = open && !liveRun && !trialCard && !queueCard;
  const a = admit.admission;
  const control: { href?: string; onClick?: () => void; label: string; primary: boolean } | null = trialCard
    ? { href: `/trial?card=${trialCard.short_id}`, label: trialCard.evidence && evidenceGone(trialCard.evidence) ? "Drop the fix" : "Review the fix", primary: true }
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
  // The fix waiting here, read the way /trial reads it (cardAsRead): its recommendation and what holds it back say its state.
  const read = trialCard ? cardAsRead(trialCard) : undefined;
  const fixState = read ? fixWords(read) : null;
  // A fix waiting on a problem whose findings all left has nothing to fix: it reads stale, the way its card does.
  const stale = trialCard?.evidence && evidenceGone(trialCard.evidence) ? goneWhere(trialCard.evidence) : null;
  const state = stale
    ? { tone: "failed", text: `No current evidence: ${stale}. The fix waiting here has nothing left to fix.` }
    : fixState
    ? fixState
    : trialCard?.proposal
    ? { tone: "waiting", text: `Fix proposed: ${trialCard.proposal.question}` }
    : trialCard?.kind === "gate"
    ? { tone: "waiting", text: "Proposal waiting: nothing is built yet." }
    : trialCard || queueCard
    ? { tone: "waiting", text: "A fix is ready for your decision." }
    : untouched && stopped ? { tone: worst >= 7 ? "failed" : "waiting", text: !a?.role ? "Not being fixed: no one owns fixes for this project yet." : `Not being fixed: ${stopped}.` } : { ...where, text: plainWhere(where.text, sinceClosed, closedAt ? now - closedAt : null) };

  // What it has cost (convex lineTrial.cost): money billed (judging, its runs' call nodes and key sessions), and its runs'
  // subscription sessions at API list price beside it, an equivalent never added to the money.
  const scope = workspace?.startsWith("team:") ? { workspace: "team" as const, team_id: workspace.slice(5) } : { workspace: "personal" as const };
  const { data: cost } = useQueryNoThrow((api as any).lineTrial.cost, workspace && task.cause ? { ...scope, task: task.short_id } : "skip");
  const spent = cost as { billed_usd?: number; judge_usd: number; run_billed_usd: number; run_list_usd: number; runs: number; sessions: number; unpriced_tokens: number } | null | undefined;
  const priced = spent?.billed_usd !== undefined && spent.billed_usd + spent.run_list_usd > 0 ? spent : null;

  const cited = useMemo(() => [...new Set(signals.map((s) => s.subject).filter(isExpectationId))], [signals]);
  const { data: lines } = useQueryNoThrow((api as any).expectations.lines, cited.length > 0 && workspace ? { workspace, ids: cited } : "skip");
  const rule = (lines as Array<{ id: string; text: string }> | null | undefined)?.find((l) => l.id === cited[0])?.text ?? null;

  return (
    <section className="mb-6" data-problem-summary>
      {/* The numbers: how often, how bad, which way it is going. */}
      <div className={cn("grid items-stretch gap-px overflow-hidden rounded-lg border border-sol-border/30 bg-sol-border/30", priced ? "grid-cols-[auto_auto_auto_auto_minmax(10rem,1fr)]" : "grid-cols-[auto_auto_auto_minmax(10rem,1fr)]")} data-problem-numbers>
        <Stat label="Conversations" value={String(conversations || count)} sub={firstSeen ? `since ${day(firstSeen)}` : undefined} title={`${count} ${count === 1 ? "report" : "reports"} across ${conversations} conversations`} />
        <Stat label="Severity" value={worst ? `${worst}/10` : "–"} valueClass={worst >= 9 ? "text-sol-red" : worst >= 7 ? "text-sol-orange" : undefined} sub={worst ? (noticed ? `${noticed} noticed by the contact` : severityWord(worst)) : undefined} title="The worst a judge rated one of these conversations. 9-10 broke the contact's trust, 7-8 the contact noticed, 5-6 a lapse they likely missed." />
        {isClosed && closedAt
          ? <Stat label="Since it closed" value={String(sinceClosed ?? 0)} valueClass={sinceClosed ? "text-sol-red" : "text-sol-green"} sub={`closed ${day(closedAt)}`} title="Conversations that went wrong after the problem closed" />
          : measured
            ? <Stat label="Measured" value={`${measured.count}/${measured.of}`} valueClass="text-sol-orange" sub={measured.window} title={`The fix run counted the miss itself by ${measured.method === "replay" ? "replaying real cases" : "reading production records"}: ${measured.count} of ${measured.of} over ${measured.window}${measured.after !== undefined ? `; ${measured.after} with the fix` : ""}`} />
            : <Stat label="Found this week" value={String(week)} sub={trendWord(week, lastWeek)} title="Conversations judges filed a finding on in the last 7 days, against the 7 before. Findings only: it says when a judge read them, not how often it happens now." />}
        {priced && <Stat label="Billed" value={usd(priced.billed_usd!)} sub={`list ${usd(priced.run_list_usd)}, unbilled`} title={`Billed: judging the conversations behind it ${usd(priced.judge_usd)}, its fix runs ${usd(priced.run_billed_usd)} (call nodes, sessions on API keys). Not billed: ${priced.runs} fix ${priced.runs === 1 ? "run" : "runs"} over ${priced.sessions} subscription sessions, ${usd(priced.run_list_usd)} at API list price${priced.unpriced_tokens ? ` (plus ${Math.round(priced.unpriced_tokens / 1000)}k tokens on unpriced models)` : ""}`} />}
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

      {signals.length > 0 && <ElsewhereContext.Provider value={elsewhere}><Findings signals={signals} ruleText={rule} /></ElsewhereContext.Provider>}
      {signals.length === 0 && evidence?.gone?.length ? <Withdrawn gone={evidence.gone} /> : null}
    </section>
  );
}

/**
 * A fix's state in a few words, from its card as read now: "Fix ready" only
 * when Ship is recommended and every check passes; otherwise the verdict
 * and what holds it back ("Fix needs rework: Up to date: 382 commits behind").
 */
function fixWords(card: NonNullable<ReturnType<typeof cardAsRead>>): { tone: string; text: string } {
  // A card written before headlines names its fix by its change's first sentence.
  const fix = card.headline || card.change.split(/(?<=[.!?])\s/)[0].replace(/^On this (local )?branch,\s*/i, "");
  // The base check's own detail already says the action ("Rebuild on main: …"); its name adds nothing.
  const held = holdReasons(card).map((r) => r.replace(/^Up to date: /, ""));
  const v = card.recommend.verdict;
  if (v === "ship" && !held.length) return { tone: "waiting", text: `${evalsOwed(card) ? "Fix ready after evals" : "Fix ready"}: ${fix}` };
  if (v === "ship") return { tone: "failed", text: `Fix ready but ${held.length === 1 ? "a check fails" : `${held.length} checks fail`} (${held.join("; ")}): ${fix}` };
  if (v === "revise") return { tone: held.length ? "failed" : "waiting", text: `Fix needs rework${held.length ? ` (${held.join("; ")})` : ""}: ${fix}` };
  return { tone: "failed", text: `Drop recommended: ${card.recommend.why || fix}` };
}

/** An emptied problem's findings, folded: each with what it said and how it left, so a Drop can be confirmed at a glance. */
function Withdrawn({ gone }: { gone: TrialWithdrawn[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-5" data-problem-withdrawn>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] font-medium text-sol-text">
        Withdrawn findings <span className="tabular-nums text-sol-text-dim">{gone.length}</span>
        <ChevronRight className={cn("h-3 w-3 text-sol-text-dim transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-sol-border/20 rounded-lg border border-sol-border/30">
          {gone.map((g) => (
            <li key={g.short_id} className="space-y-1.5 px-3 py-2" data-problem-withdrawn-row={g.short_id}>
              <div className="flex items-baseline gap-2.5">
                <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-sol-text-muted">{g.title}</span>
                <span className={cn("shrink-0 text-[11px]", g.to ? "text-sol-blue" : "text-sol-text-dim")}>
                  {g.to ? <Link href={`/tasks/${g.to}`} className="hover:underline">{fateWords(g)}</Link> : fateWords(g)}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-sol-text-dim">{day(g.at)}</span>
              </div>
              {g.quote && <blockquote className="border-l-2 border-sol-border pl-3 text-[12.5px] leading-relaxed text-sol-text-muted">{g.quote}</blockquote>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, sub, valueClass, title }: { label: string; value: string; sub?: string; valueClass?: string; title?: string }) {
  return (
    <div className="bg-sol-bg px-4 py-2.5 min-w-[7.5rem] max-w-[13rem]" title={title}>
      <div className="text-[11px] text-sol-text-dim">{label}</div>
      <div className={cn("text-[22px] font-semibold leading-tight tabular-nums text-sol-text", valueClass)}>{value}</div>
      {sub && <div className="truncate text-[11px] text-sol-text-dim">{sub}</div>}
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
      if (i >= 0 && i < TREND_DAYS) seen[i].add(findingConversation(s));
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
        {/* One unit on the whole page: conversations, the number the header counts, never reports or quotes. */}
        {[["All", convCount(signals)] as const, ...groups.map(([p, xs]) => [p, convCount(xs)] as const)].map(([p, n]) => {
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
          {all ? "Fewer" : `All ${shown.length}`}<ChevronRight className={cn("h-3 w-3 transition-transform", all ? "-rotate-90" : "rotate-90")} />
        </button>
      )}
    </div>
  );
}

function FindingRow({ rows }: { rows: LineSignal[] }) {
  const [open, setOpen] = useState(false);
  const s = rows[0];
  const sev = rows.reduce((m, r) => Math.max(m, r.severity ?? 0), 0);
  const convs = useMemo(() => convCount(rows), [rows]);
  return (
    <li data-problem-finding={s.short_id ?? s._id}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-baseline gap-2.5 px-3 py-2 text-left hover:bg-sol-bg-alt/40">
        <span className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 self-start rounded-full", sev >= 7 ? severityBg(sev) : "bg-sol-border")} title={sev ? `Severity ${sev} of 10: ${severityWord(sev)}` : undefined} />
        <span className={cn("min-w-0 flex-1 text-[12.5px] leading-snug text-sol-text", !open && "line-clamp-2")}>{whatHappened(s)}</span>
        {convs > 1 && <span className="shrink-0 rounded bg-sol-bg-alt px-1.5 text-[11px] tabular-nums text-sol-text-muted" title={`The same miss in ${convs} conversations`}>{convs} conversations</span>}
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

const convCount = (xs: LineSignal[]) => new Set(xs.map(findingConversation)).size;

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
  const elsewhere = useContext(ElsewhereContext);
  // One link per other problem this moment also landed in, named by that problem's title.
  const also = useMemo(() => {
    // Read once when the row opens: a title that changes later needs no re-render here.
    const tasks = useInboxStore.getState().tasks as Record<string, { short_id?: string; title?: string } | undefined>;
    const seen = new Map<string, { href: string; label: string; what: string }>();
    for (const o of (s.moment ? elsewhere.get(s.moment) : null) ?? []) {
      if (seen.has(o.task_id)) continue;
      const t = tasks[o.task_id];
      seen.set(o.task_id, { href: `/tasks/${t?.short_id ?? o.task_id}`, label: t?.title ?? o.title, what: whatHappened(o) });
    }
    return [...seen.values()];
  }, [s.moment, elsewhere]);
  const judge = s.judge ? `${s.judge.charAt(0).toUpperCase()}${s.judge.slice(1)} judge` : null;
  return (
    <div className="group/finding relative space-y-1.5">
      {titled && <p className="text-[12px] text-sol-text-muted">{whatHappened(s)} <span className="text-sol-text-dim tabular-nums">{day(s.observed_at)}</span></p>}
      {gist.quote && (
        <blockquote className="border-l-2 border-sol-yellow/50 pl-3 text-[13px] leading-relaxed text-sol-text" data-problem-quote>
          {gist.quote}
        </blockquote>
      )}
      {also.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11.5px]" data-problem-also>
          <span className="shrink-0 text-sol-text-dim">{placeOf(s) === "Calls" ? "Same call" : "Same conversation"}</span>
          {also.map((a) => (
            <Link key={a.href} href={a.href} title={a.what} className="max-w-full truncate rounded bg-sol-bg-alt px-1.5 py-px text-sol-text-muted hover:text-sol-blue">{a.label}</Link>
          ))}
        </div>
      )}
      <div className="absolute right-0 top-0 flex items-center gap-3 rounded bg-sol-bg/90 pl-2 text-[11px] text-sol-text-dim opacity-0 transition-opacity group-hover/finding:opacity-100 focus-within:opacity-100">
        {s.evidence_url && <a href={s.evidence_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-sol-blue">Source<ArrowUpRight className="h-3 w-3" /></a>}
        {judge && !s.case_of && <WrongControl s={s} judge={judge} />}
      </div>
    </div>
  );
}
