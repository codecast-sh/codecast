"use client";
// /trial: every trial card (convex lineTrial.ts). A trial project's line run
// goes through every station for real and stops at its gates without asking
// anyone; each gate is a card here. The list carries each card's problem,
// state and age; the pane draws the card with the queue's own components
// (ChangeCardHeadline, ChangeCardVerdictBar, DecisionAnswerControls,
// ChangeCardView), so what is read here is what a person will read in the
// queue. An answer is recorded as what they would have done: an earlier gate
// moves the run on, the change card ends it, and nothing ships.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useSyncTrial, useSyncTrialSpend, useTrialCards, useTrialProjects, useTrialSpend, type TrialCardRow, type TrialSpendRow } from "../../hooks/useSyncTrial";
import { useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { cn } from "../../lib/utils";
import { ChangeCardDecision } from "../decisions/ChangeCardDecision";
import { useSearchParams } from "next/navigation";
import { DecisionAnswerControls } from "../decisions/DecisionAnswerControls";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { verdictOfOption } from "@codecast/shared/contracts/changeCard";

type Filter = "waiting" | "answered" | "all";

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
  const projects = useTrialProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = projects.find((p) => p._id === projectId) ?? projects[0] ?? null;
  useSyncTrialSpend(project?._id ?? null);
  const spend = useTrialSpend(project?._id ?? null);
  const now = useCoarseNow(30_000);

  const inProject = useMemo(() => (project ? cards.filter((c) => c.project_id === project._id) : cards), [cards, project]);
  const counts = useMemo(() => ({
    waiting: inProject.filter((c) => c.status === "waiting").length,
    answered: inProject.filter((c) => c.status === "answered").length,
    all: inProject.length,
  }), [inProject]);
  // A problem page links straight to its card (/trial?card=tc-N).
  const linked = useSearchParams()?.get("card") ?? null;
  const linkedRow = linked ? inProject.find((c) => c.short_id === linked) ?? cards.find((c) => c.short_id === linked) ?? null : null;
  const [filter, setFilter] = useState<Filter>(linkedRow && linkedRow.status !== "waiting" ? "all" : "waiting");
  const shown = useMemo(() => (filter === "all" ? inProject : inProject.filter((c) => c.status === filter)), [inProject, filter]);
  const [selectedId, setSelectedId] = useState<string | null>(linkedRow?._id ?? null);
  const selected = shown.find((c) => c._id === selectedId) ?? shown[0] ?? null;

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
        {spend && <SpendStrip spend={spend} />}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[23rem] shrink-0 flex-col border-r border-sol-border/40" data-trial-list>
          <div className="flex gap-1 px-3 py-2" role="tablist">
            {(["waiting", "answered", "all"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => { setFilter(f); setSelectedId(null); }}
                className={cn("rounded px-2 py-1 text-[12px] capitalize tabular-nums transition-colors", filter === f ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-dim hover:text-sol-text")}
                data-trial-filter={f}
              >
                {f} <span className={cn("ml-0.5", f === "waiting" && counts.waiting ? "text-sol-yellow" : "opacity-60")}>{counts[f]}</span>
              </button>
            ))}
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
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
                    <span className="block truncate text-[12.5px] text-sol-text">{c.card?.headline || c.task_title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
                      <span className={cn("rounded px-1", c.kind === "card" ? "bg-sol-blue/15 text-sol-blue" : "bg-sol-violet/15 text-sol-violet")}>{c.kind === "card" ? "Change" : "Proposal"}</span>
                      <span className="font-mono">{c.task_short_id}</span>
                      {c.answer && <span className={answerTone(c)}>{c.answer.label}{c.answer.stand_in ? " · agent" : ""}</span>}
                      {c.status === "closed" && <span>closed</span>}
                    </span>
                  </span>
                  <span className="text-[11px] tabular-nums text-sol-text-dim">{formatTimeAgo(c.created_at, now)}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-4 py-6 text-[12px] text-sol-text-dim">
                {!ready && cards.length === 0 ? "Reading the trial's cards…" : filter === "waiting" ? "Nothing waits on you." : "No cards yet."}
              </li>
            )}
          </ul>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto" data-main-scroll>
          {selected ? <TrialCardPane key={selected._id} card={selected} now={now} /> : (
            <div className="px-8 py-10 text-[12.5px] text-sol-text-dim">{projects.length ? "Pick a card." : "No trial project in this workspace."}</div>
          )}
        </main>
      </div>
    </div>
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
  const record = c.answer ? `${c.answer.stand_in ? "An agent stood in: " : "Would "}${c.answer.label.toLowerCase()} · ${formatTimeAgo(c.answer.at, now)}` : c.status === "closed" ? "Closed: the run moved on without an answer" : undefined;

  return (
    <article className="decision-doc mx-auto max-w-4xl px-6 pb-16 pt-5" data-trial-pane={c.short_id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-sol-text-dim">
        <span className={waiting ? "text-sol-yellow" : c.status === "answered" ? answerTone(c) : ""}>{waiting ? "Waiting on you" : record}</span>
        <span>asked {formatTimeAgo(c.created_at, now)}</span>
        <Link href={`/tasks/${c.task_short_id}`} className="inline-flex items-center gap-1 hover:text-sol-text" data-trial-problem>{c.task_short_id} <ExternalLink className="h-3 w-3" /></Link>
        <Link href={`/workflows/runs/${c.run_id}`} className="inline-flex items-center gap-1 hover:text-sol-text" data-trial-run>run · {c.run_status} <ExternalLink className="h-3 w-3" /></Link>
        <span className="ml-auto font-mono opacity-70">{c.short_id}</span>
      </div>

      {c.card ? (
        <>
          <div className="mt-3">
            <ChangeCardDecision card={c.card} answer={<DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys={waiting} record={record} describe />} />
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
