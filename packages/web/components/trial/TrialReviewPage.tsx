"use client";
// /trial: every trial card (convex lineTrial.ts). A trial project's line run
// goes through every station for real and stops at its gates without asking
// anyone; each gate is a card here. The list carries each card's problem,
// state and age; the pane draws the card with the queue's own components
// (ChangeCardHeadline, ChangeCardVerdictBar, DecisionAnswerControls,
// ChangeCardView), so what is read here is what a person will read in the
// queue. An answer is recorded as what they would have done: an earlier gate
// moves the run on, the change card ends it, and nothing ships. A run that
// failed before its card is a row of its own (Failed), with the station it
// stopped at and why, and a rerun from a fresh branch off origin/main.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, RotateCcw } from "lucide-react";
import { useSyncTrial, useSyncTrialSpend, useTrialCards, useTrialProjects, useTrialRuns, useTrialSpend, type TrialCardRow, type TrialRunRow, type TrialSpendRow } from "../../hooks/useSyncTrial";
import { useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { cn } from "../../lib/utils";
import { ChangeCardDecision, type SeenCase } from "../decisions/ChangeCardDecision";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { findingGist } from "../../lib/line/loopSteps";
import { useSearchParams } from "next/navigation";
import { DecisionAnswerControls } from "../decisions/DecisionAnswerControls";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { cardFailing, evalsOwed, verdictLabel, verdictOfOption } from "@codecast/shared/contracts/changeCard";
import { impactLine } from "../tasks/impact";

type Filter = "waiting" | "failed" | "answered" | "all";

/** A failed run, and its rerun until that one settles: the Failed list. */
const inFailedList = (r: TrialRunRow) => r.status === "failed" || (r.fresh_branch && (r.status === "pending" || r.status === "running"));

const stationName = (id: string | null) => (id ? id.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase()) : "Start");

/** Why a run stopped, in a station's words: "max_visits=2 exceeded on prove" reads "Prove: 2 rounds, still red". */
export function failWords(reason: string | null): string {
  if (!reason) return "Stopped without a reason";
  const rounds = /max_visits=(\d+) exceeded on (\w+)/.exec(reason);
  if (rounds) return `${stationName(rounds[2])}: ${rounds[1]} rounds, never passed`;
  const killed = /killed after (\w+) at (\w+)/.exec(reason);
  if (killed) return `${stationName(killed[2])}: stopped after ${killed[1]}`;
  return reason;
}

const wordSet = (t: string) => new Set(t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).map((w) => w.slice(0, 6)));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size || 1); };

const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

/** The card as the queue's answer controls read a decision. */
function asDecision(c: TrialCardRow): SessionDecisionItem {
  const index = c.answer ? c.options.findIndex((o) => o.key === c.answer!.key) : -1;
  return {
    _id: c._id,
    short_id: c.short_id,
    conversation_id: "",
    session_id: "",
    question: c.question,
    context_md: c.context_md,
    options: c.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    card: c.card,
    blocking: true,
    kind: "single",
    status: c.status === "answered" ? "answered" : c.status === "waiting" ? "pending" : "withdrawn",
    ...(index >= 0 ? { answer_index: index } : {}),
    ...(c.answer?.note ? { answer_text: c.answer.note } : {}),
    gate_node_id: c.node_id,
    workflow_run_id: c.run_id,
    created_at: c.created_at,
  } as SessionDecisionItem;
}

const STATE_TONE: Record<TrialCardRow["status"], string> = { waiting: "bg-sol-yellow", answered: "bg-sol-green", closed: "bg-sol-text-dim/40" };

function answerTone(c: TrialCardRow): string {
  const v = verdictOfOption(c.answer?.label);
  return v === "ship" || c.answer?.key === "A" ? "text-sol-green" : v === "drop" || c.answer?.key === "D" ? "text-sol-red" : "text-sol-yellow";
}

export function TrialReviewPage() {
  const { ready } = useSyncTrial();
  const cards = useTrialCards();
  const runs = useTrialRuns();
  const projects = useTrialProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = projects.find((p) => p._id === projectId) ?? projects[0] ?? null;
  useSyncTrialSpend(project?._id ?? null);
  const spend = useTrialSpend(project?._id ?? null);
  const now = useCoarseNow(30_000);

  const inProject = useMemo(() => (project ? cards.filter((c) => c.project_id === project._id) : cards), [cards, project]);
  const failedRuns = useMemo(() => runs.filter((r) => (!project || r.project_id === project._id) && inFailedList(r)), [runs, project]);
  const failedByTask = useMemo(() => new Map(runs.filter((r) => r.status === "failed").map((r) => [r.task_short_id, r])), [runs]);
  const counts = useMemo(() => ({
    failed: failedRuns.filter((r) => r.status === "failed").length,
    waiting: inProject.filter((c) => c.status === "waiting").length,
    answered: inProject.filter((c) => c.status === "answered").length,
    all: inProject.length,
  }), [inProject]);
  // A problem page links straight to its card (/trial?card=tc-N).
  const linked = useSearchParams()?.get("card") ?? null;
  const linkedRow = linked ? inProject.find((c) => c.short_id === linked) ?? cards.find((c) => c.short_id === linked) ?? null : null;
  const [filter, setFilter] = useState<Filter>(linkedRow && linkedRow.status !== "waiting" ? "all" : "waiting");
  const shown = useMemo(() => (filter === "all" ? inProject : filter === "failed" ? [] : inProject.filter((c) => c.status === filter)), [inProject, filter]);
  const [selectedId, setSelectedId] = useState<string | null>(linkedRow?._id ?? null);
  // Conversations behind each card's problem, counted once per moment: the row's size.
  useSyncSignals(project?.workspace ?? null);
  const signals = useWorkspaceSignals(project?.workspace ?? null);
  const sizes = useMemo(() => {
    const by = new Map<string, Set<string>>();
    for (const sg of signals) if (sg.task_id) (by.get(sg.task_id) ?? by.set(sg.task_id, new Set()).get(sg.task_id)!).add(sg.moment ?? sg._id);
    return by;
  }, [signals]);
  const owed = inProject.some((c) => c.status === "waiting" && c.card && evalsOwed(c.card));
  const selected = filter === "failed" ? null : shown.find((c) => c._id === selectedId) ?? (selectedId === null || selectedId === linkedRow?._id ? linkedRow : null) ?? shown[0] ?? null;
  const selectedRun = filter === "failed" ? failedRuns.find((r) => r._id === selectedId) ?? failedRuns[0] ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-trial-page>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-sol-border/40 px-5 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[15px] font-semibold text-sol-text">Trial</h1>
          {projects.length > 1 ? (
            <select value={project?._id ?? ""} onChange={(e) => { setProjectId(e.target.value); setSelectedId(null); }} className="rounded border border-sol-border/50 bg-transparent px-1.5 py-0.5 text-[12px] text-sol-text" data-trial-project>
              {projects.map((p) => <option key={p._id} value={p._id}>{p.title}</option>)}
            </select>
          ) : project ? <span className="text-[12px] text-sol-text-muted" data-trial-project>{project.title}</span> : null}
        </div>
        {owed && <span className="rounded border border-sol-yellow/40 px-1.5 py-0.5 text-[11px] text-sol-yellow" title="The trial never runs a change's evals: they write to the database they point at. A card whose fix works says Ship after evals." data-trial-evals>Evals not run in the trial</span>}
        {spend && <SpendStrip spend={spend} />}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[20rem] shrink-0 flex-col border-r border-sol-border/40" data-trial-list>
          <div className="flex gap-1 px-3 py-2" role="tablist">
            {(["waiting", "failed", "answered", "all"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => { setFilter(f); setSelectedId(null); }}
                className={cn("rounded px-2 py-1 text-[12px] capitalize tabular-nums transition-colors", filter === f ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-dim hover:text-sol-text")}
                data-trial-filter={f}
              >
                {f} <span className={cn("ml-0.5", f === "waiting" && counts.waiting ? "text-sol-yellow" : f === "failed" && counts.failed ? "text-sol-red" : "opacity-60")}>{counts[f]}</span>
              </button>
            ))}
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {filter === "failed" && failedRuns.map((r) => <FailedRunRow key={r._id} run={r} selected={selectedRun?._id === r._id} now={now} onSelect={() => setSelectedId(r._id)} />)}
            {shown.map((c) => (
              <li key={c._id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c._id)}
                  className={cn("grid w-full grid-cols-[0.5rem_1fr_auto] items-start gap-x-2.5 border-l-2 px-3 py-2.5 text-left transition-colors", selected?._id === c._id ? "border-sol-blue bg-sol-bg-alt/60" : "border-transparent hover:bg-sol-bg-alt/30")}
                  data-trial-card={c.short_id}
                >
                  <span className={cn("mt-1.5 h-2 w-2 rounded-full", STATE_TONE[c.status])} />
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-[12.5px] leading-snug text-sol-text">{c.card?.headline || c.task_title}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
                      <RowVerdict card={c} />
                      {sizes.get(c.task_id)?.size ? <span className="tabular-nums" title="Conversations behind the problem">{sizes.get(c.task_id)!.size} conv</span> : null}
                      {c.answer && <span className={answerTone(c)}>{c.answer.label}{c.answer.stand_in ? " · agent" : ""}</span>}
                      {c.status === "closed" && <span>closed</span>}
                    </span>
                  </span>
                  <span className="text-[11px] tabular-nums text-sol-text-dim">{formatTimeAgo(c.created_at, now)}</span>
                </button>
              </li>
            ))}
            {(filter === "failed" ? failedRuns.length === 0 : shown.length === 0) && (
              <li className="px-4 py-6 text-[12px] text-sol-text-dim">
                {!ready && cards.length === 0 ? "Reading the trial's cards…" : filter === "waiting" ? "Nothing waits on you." : filter === "failed" ? "No failed runs." : "No cards yet."}
              </li>
            )}
          </ul>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto" data-main-scroll>
          {selectedRun ? <FailedRunPane key={selectedRun._id} run={selectedRun} cards={inProject.filter((c) => c.task_short_id === selectedRun.task_short_id)} now={now} onOpenCard={(id) => { setFilter("all"); setSelectedId(id); }} /> : selected ? <TrialCardPane key={selected._id} card={selected} now={now} /> : (
            <div className="px-8 py-10 text-[12.5px] text-sol-text-dim">{projects.length ? "Pick a card." : "No trial project in this workspace."}</div>
          )}
        </main>
      </div>
    </div>
  );
}

function FailedRunRow({ run: r, selected, now, onSelect }: { run: TrialRunRow; selected: boolean; now: number; onSelect: () => void }) {
  const failed = r.status === "failed";
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn("grid w-full grid-cols-[0.5rem_1fr_auto] items-start gap-x-2.5 border-l-2 px-3 py-2.5 text-left transition-colors", selected ? "border-sol-blue bg-sol-bg-alt/60" : "border-transparent hover:bg-sol-bg-alt/30")}
        data-trial-failed-run={r.task_short_id}
      >
        <span className={cn("mt-1.5 h-2 w-2 rounded-full", failed ? "bg-sol-red" : "animate-pulse bg-sol-blue")} />
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] text-sol-text">{r.task_title}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
            <span className={cn("shrink-0 rounded px-1", failed ? "bg-sol-red/15 text-sol-red" : "bg-sol-blue/15 text-sol-blue")}>{failed ? "Failed" : "Rerunning"}</span>
            <span className="shrink-0 whitespace-nowrap font-mono">{r.task_short_id}</span>
            <span className="truncate">{failed ? failWords(r.fail_reason) : stationName(r.node_id)}</span>
          </span>
        </span>
        <span className="text-[11px] tabular-nums text-sol-text-dim">{formatTimeAgo(r.updated_at, now)}</span>
      </button>
    </li>
  );
}

/** A failed run: where it stopped, why, the cards it left, and the rerun (lineTrial.rerun, from a fresh branch). */
function FailedRunPane({ run: r, cards, now, onOpenCard }: { run: TrialRunRow; cards: TrialCardRow[]; now: number; onOpenCard: (id: string) => void }) {
  const trialRerun = useInboxStore((s) => s.trialRerun);
  const failed = r.status === "failed";
  return (
    <article className="decision-doc mx-auto max-w-5xl px-6 pb-16 pt-5" data-trial-run-pane={r.task_short_id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-sol-text-dim">
        <span className={failed ? "text-sol-red" : "text-sol-blue"}>{failed ? `Failed ${formatTimeAgo(r.updated_at, now)}` : `Rerunning on a fresh branch · ${stationName(r.node_id)}`}</span>
        <Link href={`/tasks/${r.task_short_id}`} className="inline-flex items-center gap-1 hover:text-sol-text">the problem <ExternalLink className="h-3 w-3" /></Link>
        <Link href={`/workflows/runs/${r.run_id}`} className="ml-auto inline-flex items-center gap-1 opacity-70 hover:text-sol-text hover:opacity-100">the run <ExternalLink className="h-3 w-3" /></Link>
      </div>
      <h1 className="decision-question mt-3 text-sol-text">{r.task_title}</h1>
      {failed && (
        <section className="mt-5 flex flex-wrap items-center gap-4 rounded-md border border-sol-red/30 bg-sol-red/5 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-sol-text">{failWords(r.fail_reason)}</div>
            {r.fail_reason && <div className="mt-0.5 font-mono text-[11px] text-sol-text-dim">{r.fail_reason}</div>}
          </div>
          <button
            type="button"
            onClick={() => trialRerun(r._id)}
            className="inline-flex items-center gap-1.5 rounded-md bg-sol-blue px-3 py-1.5 text-[12.5px] font-medium text-sol-bg transition-opacity hover:opacity-90"
            data-trial-rerun={r.task_short_id}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Rerun from main
          </button>
        </section>
      )}
      {cards.length > 0 && (
        <ul className="mt-6 divide-y divide-sol-border/30 border-y border-sol-border/30 text-[12px]">
          {cards.map((c) => (
            <li key={c._id} className="flex items-center gap-2 py-2">
              <span className={cn("rounded px-1 text-[11px]", c.kind === "card" ? "bg-sol-blue/15 text-sol-blue" : "bg-sol-violet/15 text-sol-violet")}>{c.kind === "card" ? "Change" : "Proposal"}</span>
              <button type="button" onClick={() => onOpenCard(c._id)} className="min-w-0 flex-1 truncate text-left text-sol-text hover:underline">{c.card?.headline || c.question}</button>
              {c.answer && <span className={answerTone(c)}>{c.answer.label}{c.answer.stand_in ? " · agent" : ""}</span>}
              <span className="tabular-nums text-sol-text-dim">{formatTimeAgo(c.created_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

const VERDICT_INK = { ship: "text-sol-green", revise: "text-sol-yellow", drop: "text-sol-red" } as const;

/** A row's lead mark: a change card's recommended answer in its color with a red count when checks fail; a gate's kind. */
function RowVerdict({ card: c }: { card: TrialCardRow }) {
  if (!c.card) return <span className="rounded bg-sol-violet/15 px-1 text-sol-violet">Proposal</span>;
  const v = c.card.recommend.verdict;
  const failing = cardFailing(c.card);
  return (
    <>
      <span className={cn("font-medium", VERDICT_INK[v] ?? "")} data-row-verdict={v}>{v === "ship" && evalsOwed(c.card) ? "Ship after evals" : verdictLabel(v)}</span>
      {failing > 0 && <span className="inline-flex items-center gap-1 text-sol-red" title={`${failing} failing ${failing === 1 ? "check" : "checks"}`} data-row-red><span className="h-1.5 w-1.5 rounded-full bg-sol-red" />{failing}</span>}
    </>
  );
}

/** What the trial has cost: the model budget (judging, grouping) against its cap, and the line runs' sessions. */
function SpendStrip({ spend }: { spend: TrialSpendRow }) {
  const b = spend.budget;
  const model = b.spent_usd + b.earlier_months_usd;
  const pct = b.cap_usd > 0 ? Math.min(100, (b.spent_usd / b.cap_usd) * 100) : 0;
  return (
    <div className="ml-auto flex items-center gap-5 text-[11.5px] tabular-nums text-sol-text-dim" data-trial-spend>
      <span title={`Judging ${usd(b.by_purpose.judge)} · grouping ${usd(b.by_purpose.grouping)} · calls ${usd(b.by_purpose.call)}${b.refused ? ` · ${b.refused} calls refused at the cap` : ""}`} className="flex items-center gap-2">
        Model
        <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-sol-border/40">
          <span className={cn("absolute inset-y-0 left-0 rounded-full", pct > 85 ? "bg-sol-red" : pct > 60 ? "bg-sol-yellow" : "bg-sol-blue")} style={{ width: `${pct}%` }} />
        </span>
        <span className="text-sol-text">{usd(b.spent_usd)}</span>/{usd(b.cap_usd)} {b.month}
      </span>
      <span title={`${spend.sessions} sessions${spend.unpriced_tokens ? `, ${Math.round(spend.unpriced_tokens / 1000)}k tokens on unpriced models` : ""}`}>
        Runs <span className="text-sol-text">{spend.runs}</span> · <span className="text-sol-text">{usd(spend.session_usd)}</span>
      </span>
      <span>Total <span className="font-semibold text-sol-text">{usd(model + spend.session_usd)}</span></span>
    </div>
  );
}

function TrialCardPane({ card: c, now }: { card: TrialCardRow; now: number }) {
  const trialAnswer = useInboxStore((s) => s.trialAnswer);
  const decision = useMemo(() => asDecision(c), [c]);
  const waiting = c.status === "waiting";
  const onAnswer = (input: DecisionAnswerInput) => {
    if ("dismiss" in input) return;
    const option = input.index !== undefined ? c.options[input.index] : c.options.find((o) => o.key === "R");
    if (option) trialAnswer(c._id, option.key, input.text ?? null);
  };
  // The conversations behind the cause the card's author picked as most central, each with what the contact asked for;
  // an older card without picks reads the two that sound most like its problem.
  useSyncSignals(c.workspace);
  const signals = useWorkspaceSignals(c.workspace);
  const mine = useMemo(() => signals.filter((s) => s.task_id === c.task_id), [signals, c.task_id]);
  const about = useMemo(() => wordSet(`${c.card?.cause.title ?? ""} ${c.card?.wrong ?? ""}`), [c.card]);
  const seen = useMemo<SeenCase[]>(() => {
    const picks = c.card?.seen ?? [];
    if (picks.length) {
      return picks.flatMap((p) => {
        const s = mine.find((x) => x.short_id === p.signal);
        if (!s) return [];
        const gist = findingGist(s);
        const quote = p.quote || gist.says || s.title;
        return [{ key: s._id, title: s.title, quote, asked: p.asked, at: s.observed_at, finding: !p.quote }];
      });
    }
    return mine
      .map((s) => ({ s, quote: findingGist(s).quote, near: overlap(wordSet(s.title), about) }))
      .filter((x): x is { s: typeof x.s; quote: string; near: number } => !!x.quote && x.quote.length > 30)
      .sort((a, b) => b.near - a.near || (b.s.severity ?? 0) - (a.s.severity ?? 0) || b.s.observed_at - a.s.observed_at)
      .filter((x, i, all) => all.findIndex((y) => y.quote === x.quote) === i)
      .slice(0, 2)
      .map(({ s, quote }) => ({ key: s._id, title: s.title, quote, at: s.observed_at }));
  }, [mine, c.card, about]);
  const live = useMemo(() => new Set(mine.map((s) => s.moment ?? s._id)).size, [mine]);
  const impact = useMemo(() => impactLine(mine), [mine]);
  const record = c.answer ? `${c.answer.stand_in ? "An agent stood in: " : "Would "}${c.answer.label.toLowerCase()} · ${formatTimeAgo(c.answer.at, now)}` : c.status === "closed" ? "Closed: the run moved on without an answer" : undefined;

  return (
    <article className="decision-doc mx-auto max-w-5xl px-6 pb-16 pt-5" data-trial-pane={c.short_id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-sol-text-dim">
        <span className={waiting ? "text-sol-yellow" : c.status === "answered" ? answerTone(c) : ""}>{waiting ? "Waiting on you" : record}</span>
        <span>asked {formatTimeAgo(c.created_at, now)}</span>
        <Link href={`/tasks/${c.task_short_id}`} className="inline-flex items-center gap-1 hover:text-sol-text" data-trial-problem>the problem <ExternalLink className="h-3 w-3" /></Link>
        <Link href={`/workflows/runs/${c.run_id}`} className="ml-auto inline-flex items-center gap-1 opacity-70 hover:text-sol-text hover:opacity-100" title={c.card ? `${c.short_id}: built in ${c.card.cost.minutes} agent min, +${c.card.diff.added} −${c.card.diff.removed} lines in ${c.card.diff.files} files (${c.run_status})` : `${c.short_id}: the run that built it (${c.run_status})`} data-trial-run>how it was built <ExternalLink className="h-3 w-3" /></Link>
      </div>

      {c.card ? (
        <>
          <div className="mt-3">
            <ChangeCardDecision card={c.card} seen={seen} impact={impact || undefined} live={live || undefined} answer={<DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys={waiting} record={record} describe />} />
          </div>
        </>
      ) : (
        <>
          <h1 className="decision-question mt-3 text-sol-text">{c.question}</h1>
          <p className="mt-1 text-[12px] text-sol-text-muted">{c.task_title}</p>
          <section className="mt-5">
            {waiting ? <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys /> : record && <p className={cn("text-[12.5px]", c.status === "answered" ? answerTone(c) : "text-sol-text-dim")}>{record}{c.answer?.note ? `: ${c.answer.note}` : ""}</p>}
          </section>
          {c.doc_md && <section className="mt-8 border-t border-sol-border/30 pt-6"><MarkdownRenderer content={c.doc_md} /></section>}
        </>
      )}
    </article>
  );
}
