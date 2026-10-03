"use client";

import { useCallback } from "react";
import Link from "next/link";
import { ArrowUpRight, Layers, LayoutTemplate, ShieldCheck, Workflow } from "lucide-react";
import { useInboxStore, useTrackedStore, getProjectName, type SessionDecisionItem, type DecisionAnswerInput } from "../../store/inboxStore";
import { DecisionAnswerControls } from "./DecisionAnswerControls";
import { askingSessionName, decisionHref, gateRunLabel, ladderRecommendation, runHref } from "../../lib/decisionLinks";
import { optionPageSlugs } from "../../lib/decisionQueue";
import { useSyncWorkflowRun } from "../../hooks/useSyncWorkflows";
import { useJumpToDecisionAsk } from "../../hooks/useJumpToDecisionAsk";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { isHumanOnlyCategory } from "@codecast/convex/convex/lib/decisionCategory";
import { DecisionProposalOrigin } from "../org/ProposalAuthorPill";
import { CollapsibleBody } from "../CollapsibleBody";
import { AskingSessionView, type AskingSessionRow } from "./DecisionParties";
import { askingSessionDeps } from "./askingSessionDeps";
import { OptionPages } from "./OptionPages";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { ChangeCardHeadline, ChangeCardView, SepRow, cardAnswerIndexes } from "./ChangeCardView";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { hasCanvasFence } from "../HtmlSnippet";
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
  line = false,
  folded = false,
}: {
  decision: SessionDecisionItem;
  keys?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  showTask?: boolean;
  /** This decision is what a surface is waiting on (a task held at its
   *  station): a tint and a warm edge mark it as the thing to do. */
  cta?: boolean;
  /** Drawn in the line's Awaiting station (LE13). */
  line?: boolean;
  /** A line card the cursor is not on: its cause and proof row only. */
  folded?: boolean;
}) {
  const s = useTrackedStore([
    ...askingSessionDeps(decision.conversation_id),
    (st) => decision.task_id ? st.tasks[decision.task_id]?.short_id : undefined,
    (st) => decision.stack_id ? st.decisionStacks[decision.stack_id]?.title : undefined,
  ]);
  const answerDecision = useInboxStore((st) => st.answerDecision);
  const jumpToAsk = useJumpToDecisionAsk(decision.conversation_id, decision._id, decision.question);
  const session = s.sessions[decision.conversation_id];
  const task = decision.task_id ? s.tasks[decision.task_id] : undefined;
  const stack = decision.stack_id ? s.decisionStacks[decision.stack_id] : undefined;
  const now = useCoarseNow(30_000);
  const onAnswer = useCallback((input: DecisionAnswerInput) => answerDecision(decision._id, input), [answerDecision, decision._id]);
  const onDismiss = useCallback(() => answerDecision(decision._id, { dismiss: true }), [answerDecision, decision._id]);

  return (
    <DecisionCompactCardView
      decision={decision}
      session={session}
      task={task}
      stack={stack}
      now={now}
      onAnswer={onAnswer}
      onDismiss={onDismiss}
      onJumpToAsk={jumpToAsk}
      keys={keys}
      selected={selected}
      onToggleSelect={onToggleSelect}
      showTask={showTask}
      cta={cta}
      line={line}
      folded={folded}
    />
  );
}

/** The compact card drawn from props: the decision, the asking session's row,
 *  the task and stack it is bound to, the clock, and the answer and jump
 *  callbacks. DecisionCompactCard feeds it from the store; a surface outside
 *  the app feeds it fixtures. */
export function DecisionCompactCardView({
  decision,
  session,
  task,
  stack,
  now,
  onAnswer,
  onDismiss,
  onJumpToAsk,
  keys = false,
  selected,
  onToggleSelect,
  showTask = true,
  cta = false,
  line = false,
  folded = false,
}: {
  decision: SessionDecisionItem;
  session?: AskingSessionRow;
  task?: { short_id?: string };
  stack?: { _id: string; short_id?: string; title: string };
  now: number;
  onAnswer: (input: DecisionAnswerInput) => void;
  onDismiss: () => void;
  /** A plain click on the asking session's name. */
  onJumpToAsk: () => void;
  keys?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  showTask?: boolean;
  cta?: boolean;
  /** The line's Awaiting station (LE13): every card there is a line run at
   *  its decide gate, so the category and run chips say nothing, and the
   *  change card tells its story (cause, change, one example). */
  line?: boolean;
  /** A line card the cursor is not on: the cause and the proof row, no answers. */
  folded?: boolean;
}) {
  const kind = decision.kind ?? "single";
  const pending = decision.status === "pending";
  const rec = ladderRecommendation(decision);
  const pageCount = optionPageSlugs(decision.options).length;
  // The answer controls carry the card's recommendation, so the proof line
  // does not say it again beside them.
  const answersHere = pending && kind === "single" && !folded;
  // A card's Ship / Revise / Drop ride its one row as chips.
  const chipsInRow = answersHere && !!cardAnswerIndexes(decision);
  const asked = `asked ${formatTimeAgo(decision.created_at, now)}`;
  const taskRef = task?.short_id ?? decision.card?.cause.task;
  // A change card draws the head every surface does (ChangeCardHeadline):
  // the change, then one dim line with its cause and this row's facts, so the
  // founder reaches the proof after one grey line. A line gate is every card
  // in the queue, so it goes unsaid here (the decision page names it); a
  // card some other session asked names that session, and the click jumps
  // to the ask. An advisory card's course is said beside its chips.
  const lineGate = !!(decision.workflow_run_id || decision.station);
  const cardFacts = decision.card ? [
    { key: "asked", className: "cc-nowrap", node: asked },
    ...(!lineGate ? [{ key: "who", className: "min-w-0", node: <span className="inline-flex min-w-0 gap-1">from <AskingSessionView decision={decision} session={session} onJumpToAsk={onJumpToAsk} label={askingSessionName(session?.title || decision.session_title, taskRef) || "a session"} /></span> }] : []),
    ...(stack ? [{ key: "stack", node: <Link href={`/decisions/stacks/${stack.short_id ?? stack._id}`} className="text-sol-cyan hover:underline">{stack.title}</Link> }] : []),
    ...(decision.holder?.kind === "role" ? [{ key: "lead", className: "cc-nowrap text-sol-green", node: "with a lead" }] : []),
  ] : [];

  const openLink = (
    <Link href={decisionHref(decision)} className="flex items-center gap-1 font-mono text-[11px] text-sol-text-dim hover:text-sol-text" title={decision.card ? `Open ${decision.short_id ?? "the decision"}` : undefined} aria-label={decision.card ? "Open the decision" : undefined}>
      {/* A card's change is its link and its task chip names it, so its own
          id stays on hover. */}
      {!decision.card && (decision.short_id ?? "open")}<ArrowUpRight className="w-3 h-3" />
    </Link>
  );

  return (
    <div
      data-decision-card={decision.short_id ?? decision._id}
      data-cta={cta ? "true" : undefined}
      // A change card the answer keys act on wears the same ring a focused
      // transcript card does (changeCard.css), and only it shows keycaps.
      data-keys-live={keys && decision.card ? "" : undefined}
      className={`decision-card rounded-lg border bg-sol-card/40 transition-colors ${selected ? "border-sol-violet/60 bg-sol-violet/5" : keys && !line && !decision.card ? "border-sol-yellow/40" : "border-sol-border/70 hover:border-sol-border"}`}
    >
      <div className="px-4 pt-3 pb-2">
        {/* Each fact carries its own separator (SepRow), so a wrapped line
            never opens on a dot or an orphaned mark. The asking session's
            own dot says whether it is live; only a blocking ask adds one. */}
        {!decision.card && <div className="flex items-start gap-2">
          <SepRow
          className="flex-1 min-w-0 text-[11px] text-sol-text-dim"
          items={[
            {
              key: "who",
              plain: true,
              className: "items-center gap-2",
              node: (
                <>
                  {onToggleSelect && (
                    <input type="checkbox" checked={!!selected} onChange={onToggleSelect} className="accent-[var(--sol-violet)]" aria-label="Select for a stack" />
                  )}
                  {decision.blocking && <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-sol-yellow animate-pulse" title="Blocking: the session is parked" aria-label="blocking" />}
                  <AskingSessionView decision={decision} session={session} onJumpToAsk={onJumpToAsk} className="max-w-[22rem]" />
                </>
              ),
            },
            { key: "asked", className: "cc-nowrap", node: asked },
            { key: "chips", plain: true, className: "flex-wrap items-center gap-2 min-w-0", node: (
              <>
                {!decision.blocking && <span className="px-1.5 py-0.5 rounded border border-sol-blue/30 text-sol-blue">advisory</span>}
                {/* The category decides who may answer, and only a real one says
                    anything: "unknown" is the absence of a proposal, so it earns no
                    chip here. The document page spells out what it means. */}
                {!line && decision.category && decision.category !== "unknown" && (
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
                {!line && decision.workflow_run_id && <GateRunChip runId={decision.workflow_run_id} nodeId={decision.gate_node_id} />}
                {pageCount > 0 && (
                  <Link href={decisionHref(decision)} className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-border text-sol-text-dim hover:text-sol-text" title="The options carry pages to compare">
                    <LayoutTemplate className="w-3 h-3" />{pageCount} page{pageCount === 1 ? "" : "s"}
                  </Link>
                )}
                {decision.holder?.kind === "role" && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-green/30 text-sol-green"><ShieldCheck className="w-3 h-3" />with a lead</span>
                )}
              </>
            ) },
            { key: "open", plain: true, end: true, node: openLink },
          ]}
          />
        </div>}
        {decision.card ? (
          // A change card (LE11) is the same card on the queue and on the
          // line: the head (change, cause, goal and this row's facts), the
          // line's one before and after, then the proof, checks and risk
          // with Ship / Revise / Drop beside them while they fit and under
          // them when not (cc-card-row). The whole card is on the document
          // page and in the sheet.
          <>
            <div className="flex items-start gap-2">
              {onToggleSelect && <input type="checkbox" checked={!!selected} onChange={onToggleSelect} className="mt-1 accent-[var(--sol-violet)]" aria-label="Select for a stack" />}
              <ChangeCardHeadline card={decision.card} size="row" href={decisionHref(decision)} question={decision.question} facts={cardFacts} folded={folded} className="flex-1 min-w-0" />
              {!line && <span className="shrink-0 pt-px">{openLink}</span>}
            </div>
            <div className="cc-card-row mt-2" data-card-row>
              <ChangeCardView card={decision.card} density="line" recommend={!answersHere && pending && !folded} story={line} folded={folded} />
              {chipsInRow && <DecisionAnswerControls decision={decision} onAnswer={onAnswer} onDismiss={onDismiss} keys={keys} size="line" recommendation={rec} />}
            </div>
          </>
        ) : (
          <Link href={decisionHref(decision)} className="decision-question block mt-2 text-sol-text hover:text-sol-blue transition-colors">
            {decision.question}
          </Link>
        )}
        {/* The reasoning, inline. A decision cannot be made from its title
            and its option labels alone, so the context the asker wrote reads
            here, clipped to a few lines with the way to open it. Collapsed it
            renders as stripped text, not parsed markdown: a queue of ten
            cards would otherwise parse ten bodies nobody has opened. A body
            holding a canvas is the exception, since its stripped text is raw
            HTML and the visual is what the reader came for. */}
        {/* A change card's own line says what the context would: the
            question, then the change, then the proof, once each. */}
        {decision.context_md && !decision.card && (
          <CollapsibleBody
            className="mt-2"
            collapsedHeight={112}
            toggleClassName="mt-1"
            expandLabel="Read the whole thing"
            collapseLabel="Show less"
          >
            {(expanded) => (
              <div className="decision-card-body" data-decision-context>
                {expanded || hasCanvasFence(decision.context_md!)
                  ? <MarkdownRenderer content={decision.context_md!} />
                  : <p className="whitespace-pre-wrap">{stripMarkdown(decision.context_md!, { keepNewlines: true })}</p>}
              </div>
            )}
          </CollapsibleBody>
        )}
        {/* An attached report is the evidence the question rests on, so it
            renders here rather than living one click away on the document
            page. Clipped like the context: a page is taller than a card. */}
        {decision.report_slug && !decision.card && (
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
      {pending && !chipsInRow && !folded && (
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
