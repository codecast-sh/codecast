"use client";

import { useCallback } from "react";
import Link from "next/link";
import { ArrowUpRight, Layers, LayoutTemplate, ShieldCheck, Workflow } from "lucide-react";
import { useInboxStore, useTrackedStore, getProjectName, type SessionDecisionItem, type DecisionAnswerInput } from "../../store/inboxStore";
import { DecisionAnswerControls } from "./DecisionAnswerControls";
import { decisionHref, gateRunLabel, ladderRecommendation, runHref } from "../../lib/decisionLinks";
import { optionPageSlugs } from "../../lib/decisionQueue";
import { useSyncWorkflowRun } from "../../hooks/useSyncWorkflows";
import { useJumpToDecisionAsk } from "../../hooks/useJumpToDecisionAsk";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { isHumanOnlyCategory } from "@codecast/convex/convex/lib/decisionCategory";
import { DecisionProposalOrigin } from "../org/ProposalAuthorPill";
import { CollapsibleBody } from "../CollapsibleBody";
import { AskingSession } from "./DecisionParties";
import { OptionPages } from "./OptionPages";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { stripMarkdown } from "../../lib/notificationText";
import "./decisions.css";

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
  cta = false,
}: {
  decision: SessionDecisionItem;
  keys?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  showTask?: boolean;
  /** This decision is what a surface is waiting on (a task held at its
   *  station): a tint and a warm edge mark it as the thing to do. */
  cta?: boolean;
}) {
  const s = useTrackedStore([
    (st) => st.sessions[decision.conversation_id]?.title,
    (st) => st.sessions[decision.conversation_id]?.project_path,
    (st) => decision.task_id ? st.tasks[decision.task_id]?.short_id : undefined,
    (st) => decision.stack_id ? st.decisionStacks[decision.stack_id]?.title : undefined,
  ]);
  const answerDecision = useInboxStore((st) => st.answerDecision);
  const jumpToAsk = useJumpToDecisionAsk(decision.conversation_id, decision._id, decision.question);
  const session = s.sessions[decision.conversation_id];
  const task = decision.task_id ? s.tasks[decision.task_id] : undefined;
  const stack = decision.stack_id ? s.decisionStacks[decision.stack_id] : undefined;
  const now = useCoarseNow(30_000);
  const kind = decision.kind ?? "single";
  const pending = decision.status === "pending";
  const rec = ladderRecommendation(decision);
  const onAnswer = useCallback((input: DecisionAnswerInput) => answerDecision(decision._id, input), [answerDecision, decision._id]);
  const onDismiss = useCallback(() => answerDecision(decision._id, { dismiss: true }), [answerDecision, decision._id]);
  const pageCount = optionPageSlugs(decision.options).length;

  return (
    <div
      data-decision-card={decision.short_id ?? decision._id}
      data-cta={cta ? "true" : undefined}
      className={`decision-card rounded-lg border bg-sol-card/40 transition-colors ${selected ? "border-sol-violet/60 bg-sol-violet/5" : keys ? "border-sol-yellow/40" : "border-sol-border/70 hover:border-sol-border"}`}
    >
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim min-w-0">
          {onToggleSelect && (
            <input type="checkbox" checked={!!selected} onChange={onToggleSelect} className="accent-[var(--sol-violet)]" aria-label="Select for a stack" />
          )}
          <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${decision.blocking ? "bg-sol-yellow animate-pulse" : "bg-sol-blue"}`} />
          <AskingSession decision={decision} className="max-w-[22rem]" />
          <span>· asked {formatTimeAgo(decision.created_at, now)}</span>
          {!decision.blocking && <span className="px-1.5 py-0.5 rounded border border-sol-blue/30 text-sol-blue">advisory</span>}
          {/* The category decides who may answer, and only a real one says
              anything: "unknown" is the absence of a proposal, so it earns no
              chip here. The document page spells out what it means. */}
          {decision.category && decision.category !== "unknown" && (
            <span className={`px-1.5 py-0.5 rounded border ${isHumanOnlyCategory(decision.category) ? "border-sol-red/30 text-sol-red" : "border-sol-border text-sol-text-dim"}`} title={isHumanOnlyCategory(decision.category) ? "Always answered by a person, never a role" : "A role can earn the right to answer these"}>
              {decision.category}
            </span>
          )}
          {/* S15: a staffing proposal's pointer card names who wrote the proposal */}
          <DecisionProposalOrigin contextMd={decision.context_md} />
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
          {decision.workflow_run_id && <GateRunChip runId={decision.workflow_run_id} nodeId={decision.gate_node_id} />}
          {pageCount > 0 && (
            <Link href={decisionHref(decision)} className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-border text-sol-text-dim hover:text-sol-text" title="The options carry pages to compare">
              <LayoutTemplate className="w-3 h-3" />{pageCount} page{pageCount === 1 ? "" : "s"}
            </Link>
          )}
          {decision.holder?.kind === "role" && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-green/30 text-sol-green"><ShieldCheck className="w-3 h-3" />with a lead</span>
          )}
          <Link href={decisionHref(decision)} className="ml-auto flex items-center gap-1 font-mono text-sol-text-dim hover:text-sol-text">
            {decision.short_id ?? "open"}<ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        <Link href={decisionHref(decision)} className="decision-question block mt-2 text-sol-text hover:text-sol-blue transition-colors">
          {decision.question}
        </Link>
        {/* The reasoning, inline. A decision cannot be made from its title
            and its option labels alone, so the context the asker wrote reads
            here, clipped to a few lines with the way to open it. Collapsed it
            renders as stripped text, not parsed markdown: a queue of ten
            cards would otherwise parse ten bodies nobody has opened. */}
        {decision.context_md && (
          <CollapsibleBody
            className="mt-2"
            collapsedHeight={112}
            toggleClassName="mt-1"
            expandLabel="Read the whole thing"
            collapseLabel="Show less"
          >
            {(expanded) => (
              <div className="decision-card-body" data-decision-context>
                {expanded
                  ? <MarkdownRenderer content={decision.context_md!} />
                  : <p className="whitespace-pre-wrap">{stripMarkdown(decision.context_md!, { keepNewlines: true })}</p>}
              </div>
            )}
          </CollapsibleBody>
        )}
        {/* An attached report is the evidence the question rests on, so it
            renders here rather than living one click away on the document
            page. Clipped like the context: a page is taller than a card. */}
        {decision.report_slug && (
          <div className="mt-1" data-decision-report={decision.report_slug}>
            <PublishedPageEmbed slug={decision.report_slug} height={240} />
          </div>
        )}
        {pageCount > 0 && (
          <div className="mt-2"><OptionPages decision={decision} answerable={pending && kind === "single"} onAnswer={(i) => onAnswer({ index: i })} /></div>
        )}
        {rec !== undefined && (
          <div className="mt-2 text-[12px] text-sol-cyan">a lead recommends: {decision.options[rec]?.label}</div>
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

// The run chip on a gate (the-line.md L4, L10): workflow name and gate node
// label from the workflowRuns store row, which useSyncWorkflowRun feeds per
// card (a run is per view data, not a global feed). A row not yet synced
// reads "a workflow run"; the chip links to the run either way.
const runChipSig = (r: any) => (r ? `${r.workflow_name ?? ""}|${r.current_node_id ?? ""}|${r.current_node_label ?? ""}|${r.status ?? ""}` : "");

export function GateRunChip({ runId, nodeId, className = "" }: { runId: string; nodeId?: string; className?: string }) {
  useSyncWorkflowRun(runId);
  const s = useTrackedStore([(st) => runChipSig((st as any).workflowRuns?.[runId])]);
  const run = (s as any).workflowRuns?.[runId];
  const label = gateRunLabel(run, nodeId);
  return (
    <Link
      href={runHref(runId)}
      data-gate-run={runId}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-green/30 text-sol-green hover:bg-sol-green/10 max-w-[18rem] min-w-0 ${className}`}
      title={label.known ? `Gate on ${label.workflow}${label.node ? ` at ${label.node}` : ""}` : "A gate on a workflow run"}
    >
      <Workflow className="w-3 h-3 shrink-0" />
      <span className="truncate">{label.workflow}{label.node ? ` · ${label.node}` : ""}</span>
    </Link>
  );
}
