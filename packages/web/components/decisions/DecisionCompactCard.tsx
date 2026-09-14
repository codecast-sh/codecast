"use client";

import { useCallback } from "react";
import Link from "next/link";
import { ArrowUpRight, Layers, ShieldCheck } from "lucide-react";
import { useInboxStore, useTrackedStore, getProjectName, type SessionDecisionItem, type DecisionAnswerInput } from "../../store/inboxStore";
import { DecisionAnswerControls } from "./DecisionAnswerControls";
import { decisionHref, ladderRecommendation } from "../../lib/decisionLinks";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { isHumanOnlyCategory } from "@codecast/convex/convex/lib/decisionCategory";

// The compact card: the queue's row, the task page's row. Question, who is
// asking, the binding chips, and single-kind answers inline; every other
// kind (and the body, the ladder, the evidence) lives on the document page
// this card links to. Answering here is the same store action the page and
// the transcript card use.
export function DecisionCompactCard({
  decision,
  keys = false,
  selected,
  onToggleSelect,
  showTask = true,
}: {
  decision: SessionDecisionItem;
  keys?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  showTask?: boolean;
}) {
  const s = useTrackedStore([
    (st) => st.sessions[decision.conversation_id]?.title,
    (st) => st.sessions[decision.conversation_id]?.project_path,
    (st) => decision.task_id ? st.tasks[decision.task_id]?.short_id : undefined,
    (st) => decision.stack_id ? st.decisionStacks[decision.stack_id]?.title : undefined,
  ]);
  const answerDecision = useInboxStore((st) => st.answerDecision);
  const session = s.sessions[decision.conversation_id];
  const task = decision.task_id ? s.tasks[decision.task_id] : undefined;
  const stack = decision.stack_id ? s.decisionStacks[decision.stack_id] : undefined;
  const now = useCoarseNow(30_000);
  const kind = decision.kind ?? "single";
  const pending = decision.status === "pending";
  const rec = ladderRecommendation(decision);
  const onAnswer = useCallback((input: DecisionAnswerInput) => answerDecision(decision._id, input), [answerDecision, decision._id]);
  const onDismiss = useCallback(() => answerDecision(decision._id, { dismiss: true }), [answerDecision, decision._id]);

  return (
    <div
      data-decision-card={decision.short_id ?? decision._id}
      className={`rounded-lg border bg-sol-card/40 transition-colors ${selected ? "border-sol-violet/60 bg-sol-violet/5" : keys ? "border-sol-yellow/40" : "border-sol-border/70 hover:border-sol-border"}`}
    >
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim min-w-0">
          {onToggleSelect && (
            <input type="checkbox" checked={!!selected} onChange={onToggleSelect} className="accent-[var(--sol-violet)]" aria-label="Select for a stack" />
          )}
          <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${decision.blocking ? "bg-sol-yellow animate-pulse" : "bg-sol-blue"}`} />
          <Link href={`/conversation/${decision.conversation_id}`} className="text-sol-text-muted hover:text-sol-blue truncate max-w-[16rem]">
            {session?.title || decision.session_title || "Session"}
          </Link>
          {(session?.project_path || decision.project_path) && <span className="truncate">{getProjectName(session?.project_path || decision.project_path!)}</span>}
          <span>· asked {formatTimeAgo(decision.created_at, now)}</span>
          {!decision.blocking && <span className="px-1.5 py-0.5 rounded border border-sol-blue/30 text-sol-blue">advisory</span>}
          {decision.category && (
            <span className={`px-1.5 py-0.5 rounded border ${isHumanOnlyCategory(decision.category) ? "border-sol-red/30 text-sol-red" : "border-sol-border text-sol-text-dim"}`} title={isHumanOnlyCategory(decision.category) ? "Always answered by a person" : "A role may earn a grant for this category"}>
              {decision.category}
            </span>
          )}
          {showTask && (task || decision.task_id) && (
            <Link href={`/tasks/${task?.short_id ?? decision.task_id}`} className="px-1.5 py-0.5 rounded border border-sol-violet/30 text-sol-violet hover:bg-sol-violet/10">
              {task?.short_id ?? "task"}{decision.station ? ` · ${decision.station}` : ""}
            </Link>
          )}
          {stack && (
            <Link href={`/decisions/stacks/${stack.short_id ?? stack._id}`} className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-cyan/30 text-sol-cyan hover:bg-sol-cyan/10">
              <Layers className="w-3 h-3" />{stack.title}
            </Link>
          )}
          {decision.holder?.kind === "role" && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-green/30 text-sol-green"><ShieldCheck className="w-3 h-3" />with a lead</span>
          )}
          <Link href={decisionHref(decision)} className="ml-auto flex items-center gap-1 font-mono text-sol-text-dim hover:text-sol-text">
            {decision.short_id ?? "open"}<ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        <Link href={decisionHref(decision)} className="block mt-1.5 text-[15px] leading-snug text-sol-text hover:text-sol-blue transition-colors">
          {decision.question}
        </Link>
        {rec !== undefined && (
          <div className="mt-1 text-[12px] text-sol-cyan">a lead recommends: {decision.options[rec]?.label}</div>
        )}
      </div>
      {pending && (
        <div className="px-4 pb-3">
          {kind === "single" ? (
            <DecisionAnswerControls decision={decision} onAnswer={onAnswer} onDismiss={onDismiss} keys={keys} size="compact" recommendation={rec} />
          ) : (
            <Link href={decisionHref(decision)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-sol-yellow/40 text-[12px] text-sol-text hover:bg-sol-yellow hover:text-sol-bg transition-colors">
              {kind === "multi" ? "Pick several" : kind === "rank" ? "Rank the options" : "Fill in the form"}<ArrowUpRight className="w-3 h-3" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
