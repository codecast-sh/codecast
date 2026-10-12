"use client";
// One trial card as a person decides it: the change card, the proposal card,
// or a bare gate, with its answers. /trial and the /line Inbox both draw this,
// each with its own header around it.
import { useMemo } from "react";
import { findingConversation } from "@codecast/shared/contracts/judges";
import { verdictOfOption } from "@codecast/shared/contracts/changeCard";
import type { TrialCardRow } from "../../hooks/useSyncTrial";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from "../../store/inboxStore";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { findingGist } from "../../lib/line/loopSteps";
import { cn } from "../../lib/utils";
import { ChangeCardDecision, type SeenCase } from "../decisions/ChangeCardDecision";
import { ProposalCardDecision } from "../decisions/ProposalCardDecision";
import { DecisionAnswerControls } from "../decisions/DecisionAnswerControls";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { impactLine } from "../tasks/impact";

const wordSet = (t: string) => new Set(t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).map((w) => w.slice(0, 6)));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size || 1); };

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

export function answerTone(c: TrialCardRow): string {
  const v = verdictOfOption(c.answer?.label);
  return v === "ship" || c.answer?.key === "A" ? "text-sol-green" : v === "drop" || c.answer?.key === "D" ? "text-sol-red" : "text-sol-yellow";
}

/** How the card was answered, in a few words; undefined while it waits. */
export function trialRecord(c: TrialCardRow, now: number): string | undefined {
  if (c.answer) return `${c.answer.stand_in ? "An agent stood in: " : "Would "}${c.answer.label.toLowerCase()} · ${formatTimeAgo(c.answer.at, now)}`;
  return c.status === "closed" ? "Closed: the run moved on without an answer" : undefined;
}

export function TrialCardBody({ card: c, now }: { card: TrialCardRow; now: number }) {
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
  const live = useMemo(() => new Set(mine.map(findingConversation)).size, [mine]);
  const impact = useMemo(() => impactLine(mine), [mine]);
  // A proposal card's one conversation: its sent words, or the finding's own text when none show the miss.
  const proposalSeen = useMemo<SeenCase | null>(() => {
    const pc = c.proposal?.case;
    const s = pc ? mine.find((x) => x.short_id === pc.signal) : undefined;
    if (!pc || !s) return null;
    return { key: s._id, title: s.title, quote: pc.quote || findingGist(s).says || s.title, asked: pc.asked, at: s.observed_at, finding: !pc.quote };
  }, [c.proposal, mine]);
  const record = trialRecord(c, now);
  const recordLine = record ? <p className={cn("text-[12.5px]", c.status === "answered" ? answerTone(c) : "text-sol-text-dim")} data-trial-record>{record}{c.answer?.note ? `: ${c.answer.note}` : ""}</p> : null;

  if (c.card) {
    return <ChangeCardDecision card={c.card} seen={seen} impact={impact || undefined} live={live || undefined} answer={<DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys={waiting} record={record} describe />} />;
  }
  if (c.proposal) {
    return (
      <ProposalCardDecision
        card={c.proposal}
        seen={proposalSeen}
        impact={impact || undefined}
        live={live || undefined}
        answer={waiting ? <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys describe /> : recordLine}
        doc={c.doc_md ? <MarkdownRenderer content={c.doc_md} /> : null}
      />
    );
  }
  return (
    <>
      <h1 className="decision-question text-sol-text">{c.question}</h1>
      <p className="mt-1 text-[12px] text-sol-text-muted">{c.task_title}</p>
      <section className="mt-5">{waiting ? <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys /> : recordLine}</section>
      {c.doc_md && <section className="mt-8 border-t border-sol-border/30 pt-6"><MarkdownRenderer content={c.doc_md} /></section>}
    </>
  );
}
