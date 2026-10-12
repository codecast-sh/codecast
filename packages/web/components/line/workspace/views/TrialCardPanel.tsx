"use client";
// A trial card inside the line app (line-workspace.md LW1): the Inbox opens a
// card here, beside its rows, so the header, the nav and the way back stay.
// It draws the card with the queue's own components (ChangeCardDecision,
// DecisionAnswerControls), the same reading /trial gives it.
import { useMemo } from "react";
import { X } from "lucide-react";
import type { TrialCardRow } from "../../../../hooks/useSyncTrial";
import { useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from "../../../../store/inboxStore";
import { ChangeCardDecision, type SeenCase } from "../../../decisions/ChangeCardDecision";
import { DecisionAnswerControls } from "../../../decisions/DecisionAnswerControls";
import { MarkdownRenderer } from "../../../tools/MarkdownRenderer";
import { findingGist } from "../../../../lib/line/loopSteps";
import { ageShort } from "../../../../lib/lineFlow";

/** The card as the queue's answer controls read a decision. */
function asDecision(c: TrialCardRow): SessionDecisionItem {
  const index = c.answer ? c.options.findIndex((o) => o.key === c.answer!.key) : -1;
  return {
    _id: c._id, short_id: c.short_id, conversation_id: "", session_id: "",
    question: c.question, context_md: c.context_md,
    options: c.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    card: c.card, blocking: true, kind: "single",
    status: c.status === "answered" ? "answered" : c.status === "waiting" ? "pending" : "withdrawn",
    ...(index >= 0 ? { answer_index: index } : {}),
    ...(c.answer?.note ? { answer_text: c.answer.note } : {}),
    gate_node_id: c.node_id, workflow_run_id: c.run_id, created_at: c.created_at,
  } as SessionDecisionItem;
}

type Finding = { _id: string; task_id?: string | null; title: string; detail_md?: string | null; severity?: number | null; observed_at?: number; created_at: number; moment?: string | null };

export function TrialCardPanel({ card: c, findings, now, onClose, onProblem, onRun }: {
  card: TrialCardRow;
  /** The findings in view: the card's problem's two clearest cases come from them. */
  findings: ReadonlyArray<Finding>;
  now: number;
  onClose: () => void;
  onProblem: () => void;
  onRun: () => void;
}) {
  const trialAnswer = useInboxStore((s) => s.trialAnswer);
  const decision = useMemo(() => asDecision(c), [c]);
  const waiting = c.status === "waiting";
  const onAnswer = (input: DecisionAnswerInput) => {
    if ("dismiss" in input) return;
    const option = input.index !== undefined ? c.options[input.index] : c.options.find((o) => o.key === "R");
    if (option) trialAnswer(c._id, option.key, input.text ?? null);
  };
  const mine = useMemo(() => findings.filter((s) => s.task_id === c.task_id), [findings, c.task_id]);
  const seen = useMemo<SeenCase[]>(() => mine
    .map((s) => ({ s, quote: findingGist(s).quote }))
    .filter((x): x is { s: Finding; quote: string } => !!x.quote && x.quote.length > 30)
    .sort((a, b) => (b.s.severity ?? 0) - (a.s.severity ?? 0) || (b.s.observed_at ?? b.s.created_at) - (a.s.observed_at ?? a.s.created_at))
    .filter((x, i, all) => all.findIndex((y) => y.quote === x.quote) === i)
    .slice(0, 2)
    .map(({ s, quote }) => ({ key: s._id, title: s.title, quote, at: s.observed_at ?? s.created_at })), [mine]);
  const worst = useMemo(() => mine.reduce((m, s) => Math.max(m, s.severity ?? 0), 0), [mine]);
  const live = useMemo(() => new Set(mine.map((s) => s.moment ?? s._id)).size, [mine]);
  const record = c.answer ? `${c.answer.stand_in ? "Stand-in: " : ""}${c.answer.label} · ${ageShort(now - c.answer.at)} ago` : c.status === "closed" ? "Closed unanswered" : undefined;

  return (
    <aside className="lwt-panel" aria-label={`Trial card ${c.short_id}`} data-line-trial-panel={c.short_id}>
      <header className="lwt-panel-h">
        <b className="lwt-panel-ref">{c.short_id}</b>
        <button type="button" className="lw-chip" onClick={onProblem} data-line-trial-problem>{c.task_short_id}</button>
        <button type="button" className="lw-chip" onClick={onRun} data-line-trial-run>run</button>
        <span className="lwt-panel-state" data-state={c.status}>{waiting ? "waiting" : record}</span>
        <span className="lw-num lwt-panel-age">{ageShort(now - c.created_at)}</span>
        <span className="lw-spacer" />
        <button type="button" className="lw-iconbtn" onClick={onClose} aria-label="Close card (Esc)" title="Close (Esc)"><X className="w-4 h-4" /></button>
      </header>
      <div className="lwt-panel-body decision-doc">
        {c.card ? (
          <ChangeCardDecision card={c.card} seen={seen} worst={worst || undefined} live={live || undefined} answer={<DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys={waiting} record={record} describe />} />
        ) : (
          <>
            <h1 className="decision-question">{c.question}</h1>
            <section className="mt-4">
              {waiting ? <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys /> : record && <p>{record}{c.answer?.note ? `: ${c.answer.note}` : ""}</p>}
            </section>
            {c.doc_md && <section className="mt-6"><MarkdownRenderer content={c.doc_md} /></section>}
          </>
        )}
      </div>
    </aside>
  );
}
