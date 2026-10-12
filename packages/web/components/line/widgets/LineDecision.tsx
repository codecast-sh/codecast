"use client";
// A line fix decision in front of the owner (ct-59652): the one surface every
// line view uses to show what a run proposes for a problem and to answer it.
// The decision is a session_decisions row (task_id the problem, workflow_run_id
// the run) asked by the run's own session, which stays alive to talk it
// through. The page leads with the sweet spot (the session's own context: what
// changes, before and after, proof, risk; for a structured card its headline,
// today against after, tiles and cases), then the answers, with the chat to the
// asking session beside it, and the full proposal folded under. A trial run's
// decision also carries what its card measured (TrialEvidenceBand: a real
// message today against what the change sends, the proof as numbers), and its
// words ask what you would do, since a trial answer ships nothing. It reuses the
// decision page's pieces (DecisionAnswering, DecisionDiscussion, ChangeCardView,
// ChangeCardDecision), so an answer reads and lands the same as on /decisions.
import { useMemo, useRef, type ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import type { DecisionDetailItem, SessionDecisionItem } from "../../../store/inboxStore";
import { useInboxStore } from "../../../store/inboxStore";
import { useSyncDecisionDetail } from "../../../hooks/useSyncDecisionDetail";
import { useDecisionDiscussion } from "../../../hooks/useDecisionDiscussion";
import { useTrialCards, useTrialProjects } from "../../../hooks/useSyncTrial";
import { trialWords } from "../../../lib/line/fixDecision";
import { TrialEvidenceBand } from "./TrialEvidenceBand";
import { useSyncTaskEvidence, useTaskEvidenceByShortId } from "../../../hooks/useSyncTaskEvidence";
import { lineRefHref } from "../../../lib/line/lineWorkspaceUrl";
import { decisionWaitLabel } from "../../../lib/decisionLinks";
import { formatTimeAgo } from "../../../lib/messageNavigator";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { PublishedPageEmbed } from "../../PublishedPageEmbed";
import { DoubtChip } from "../DoubtChip";
import { AskingSession } from "../../decisions/DecisionParties";
import { DecisionDiscussion } from "../../decisions/DecisionDiscussion";
import { DecisionFacts } from "../../decisions/DecisionSections";
import { GateRunChip } from "../../decisions/DecisionCompactCard";
import { ChangeCardView } from "../../decisions/ChangeCardView";
import { ChangeCardDecision } from "../../decisions/ChangeCardDecision";
import { DecisionAnswerControls } from "../../decisions/DecisionAnswerControls";
import { DecisionAnswerPanel, restatesCard, useDecisionAnswering, useDecisionPage } from "../../decisions/DecisionAnswering";
import "../../decisions/decisions.css";
import "./lineDecision.css";

export type LineDecisionProps = {
  /** The decision: a short id ("sd-N") or its Convex id. */
  id: string;
  /** The problem's source in chip words (sourceChipWords), when the surface knows it. */
  source?: string | null;
  /** Open the problem in place (the line app's Problems view); without it the ref links to the problem's place. */
  onProblem?: (taskId: string) => void;
  /** Open the run in place (the line app's Runs view); without it the run chip links out. */
  onRun?: (runId: string, taskId: string | null) => void;
  /** Close the decision (the surface that opened it beside a list). */
  onClose?: () => void;
  className?: string;
};

const NO_FN = () => {};

/** Feeds one decision's detail into the store before it is opened, so opening it paints from the store at once. */
function PrefetchOne({ id }: { id: string }) {
  useSyncDecisionDetail(id);
  return null;
}

/** The details of the fix decisions a list shows (the first few), fed ahead of a click: a list mounts it beside its rows. */
export function LineDecisionPrefetch({ ids }: { ids: ReadonlyArray<string> }) {
  return <>{ids.slice(0, 8).map((id) => <PrefetchOne key={id} id={id} />)}</>;
}

export function LineDecision({ id, ...rest }: LineDecisionProps) {
  const page = useDecisionPage(id);
  if (!page.detail || !page.decision) {
    return (
      <article className={`ld ${rest.className ?? ""}`} data-line-decision={id} data-state={page.missing && page.ready ? "missing" : "loading"}>
        <div className="ld-empty">{page.missing && page.ready ? "This decision does not exist, or it is not yours to read." : "Loading the decision"}</div>
      </article>
    );
  }
  return <LineDecisionBody decision={page.decision} detail={page.detail} answerable={page.answerable} {...rest} />;
}

/** The decision drawn from its row and detail; exported for a test that mounts it on a fixture. */
export function LineDecisionBody({ decision, detail, answerable, source, onProblem, onRun, onClose, className = "" }: Omit<LineDecisionProps, "id"> & { decision: SessionDecisionItem; detail: DecisionDetailItem; answerable: boolean }) {
  const scope = useRef<HTMLElement>(null);
  const a = useDecisionAnswering(decision, detail, answerable);
  useSyncTaskEvidence(a.cardTask);
  const guide = useTaskEvidenceByShortId(a.cardTask)?.change_guide ?? null;
  const task = detail.task;
  const taskId = task?._id ?? decision.task_id ?? null;
  const projectId = task?.project_id ?? null;
  const project = useInboxStore((s) => (projectId ? (s.projects as Record<string, { title?: string }> | undefined)?.[projectId]?.title ?? null : null));
  // A trial decision says so itself (session_decisions.trial); a project in the trial says it for an older row.
  const trialProjects = useTrialProjects();
  const trial = !!decision.trial || trialProjects.some((p) => p._id === projectId);
  // The trial card this decision is, when a trial run asked it: what the run built and proved.
  const trialCard = useTrialCards().find((c) => c.decision?._id === decision._id) ?? null;
  // A trial answer records what you would have done: the question and options say "would", and Ship answers the
  // decision (never the live ship a run's card starts), so nothing ships from here.
  const asked = useMemo(() => (trial ? { ...trialWords(decision), workflow_run_id: undefined } : decision), [trial, decision]);
  const card = decision.card ?? null;
  const ref = task?.short_id ?? card?.cause.task ?? null;
  const title = task?.title ?? card?.cause.title ?? null;
  const doc = detail.doc?.content?.trim() || trialCard?.doc_md?.trim() || null;
  const context = decision.context_md?.trim() || null;

  // The answers: the session's own options and a typed answer while it waits, else the answer on record.
  const answers: ReactNode = (
    <section className="ld-answers" data-line-decision-answers aria-label="Your answer">
      {a.pending && answerable ? (
        <>
          {trial && <h2 className="ld-answers-h" data-line-decision-trial-note><span className="ld-trial" title="A trial run: your answer records what you would have done, and nothing ships">Trial</span>What would you do?</h2>}
          {a.heldNote}
          <DecisionAnswerControls decision={asked} onAnswer={a.onAnswer} onDismiss={a.onDismiss} keys keyScope={scope} recommendation={a.rec} record={a.outcome?.pill} />
        </>
      ) : a.outcome && !a.closed ? (
        <div className="ld-outcome" data-line-decision-outcome>{a.outcome.line}</div>
      ) : a.answerSection ? (
        <DecisionAnswerPanel decision={decision} detail={detail} answerable={answerable} a={a} keys={false} />
      ) : null}
    </section>
  );

  // The sweet spot: a structured card's top, or the session's own words. A decision with no short context leads with its doc,
  // and one with neither leads with its published proposal (a trial station writes its case there).
  const lead = card ? null : context ?? doc;
  const reportLeads = !card && !lead && !!decision.report_slug;
  const sweet = card ? (
    <ChangeCardDecision card={card} answer={answers} />
  ) : (
    <>
      <h1 className="ld-question" data-long={asked.question.length > 140 ? "" : undefined} data-line-decision-question>{asked.question}</h1>
      {lead && <div className="ld-prose" data-line-decision-context><MarkdownRenderer content={lead} /></div>}
      {trialCard && <TrialEvidenceBand card={trialCard} />}
      {reportLeads && <div className="ld-lead-report" data-line-decision-report><PublishedPageEmbed slug={decision.report_slug!} height={460} /></div>}
      {answers}
    </>
  );

  // The full proposal: what the sweet spot leaves out, folded.
  const fullDoc = card ? (doc && !restatesCard(doc, card) ? doc : null) : lead === doc ? null : doc;
  const reportSlug = decision.report_slug ?? trialCard?.decision?.report_slug ?? null;
  const report = reportSlug && !card && !reportLeads ? reportSlug : null;
  const hasFull = !!card || !!fullDoc || !!report;

  return (
    <article ref={scope} className={`ld decision-doc ${className}`} data-line-decision={decision.short_id ?? decision._id} data-trial={trial ? "" : undefined} tabIndex={-1}>
      <header className="ld-head">
        {ref && (onProblem && taskId
          ? <button type="button" className="ld-ref" onClick={() => onProblem(taskId)} data-line-decision-problem>{ref}</button>
          : <Link className="ld-ref" href={lineRefHref(ref)} data-line-decision-problem>{ref}</Link>)}
        {title && <span className="ld-title" title={title}>{title}</span>}
        {source && <span className="lw-srcchip" data-line-decision-source>{source}</span>}
        {project && <span className="ld-project">{project}</span>}
        {trial && !/\btrial\b/i.test(project ?? "") && <span className="ld-trial" title="A trial run: answers record what you would have done and ship nothing">Trial</span>}
        <span className="ld-spacer" />
        <span className="ld-asker" data-line-decision-asker><AskingSession decision={decision} /></span>
        {onClose && <button type="button" className="ld-close" onClick={onClose} aria-label="Close decision (Esc)" title="Close (Esc)"><X className="w-4 h-4" /></button>}
      </header>
      <div className="ld-sub">
        <span data-tone={a.pending ? (decision.blocking ? "wait" : "ask") : "done"}>{a.pending ? decisionWaitLabel(decision) : decision.status}</span>
        <span>asked {formatTimeAgo(decision.created_at, a.now)}</span>
        {decision.workflow_run_id && (onRun
          ? <button type="button" className="ld-run" onClick={() => onRun(decision.workflow_run_id!, taskId)} data-line-decision-run>the run</button>
          : <GateRunChip runId={decision.workflow_run_id} nodeId={decision.gate_node_id} />)}
        <Link className="ld-id" href={`/decisions/${decision.short_id ?? decision._id}`} title="Open on its own page">{decision.short_id ?? "decision"}</Link>
      </div>

      <div className="ld-grid">
        <div className="ld-main">
          {a.banner && <div className="decision-status-banner ld-banner" role="status" data-decision-banner={decision.status}>{a.banner}</div>}
          {a.doubt && <DoubtChip doubt={a.doubt} className="mb-4" />}
          <div className="ld-sweet" data-line-decision-sweet>{sweet}</div>
          {hasFull && (
            <details className="ld-full" data-line-decision-full>
              <summary>Full proposal</summary>
              <div className="ld-full-body">
                {card && <ChangeCardView card={card} density="full" change={false} recommend={false} summarized guide={guide} />}
                {fullDoc && <div className="ld-prose" data-decision-doc><MarkdownRenderer content={fullDoc} /></div>}
                {report && <PublishedPageEmbed slug={report} />}
                <DecisionFacts decision={decision} detail={detail} />
              </div>
            </details>
          )}
        </div>
        <aside className="ld-talk" aria-label="Talk to the session that asked" data-line-decision-talk>
          <TalkHead decision={decision} problem={ref} />
          <DecisionDiscussion decisionId={decision._id} open onOpenChange={NO_FN} />
        </aside>
      </div>
    </article>
  );
}

/**
 * Who the chat reaches, said plainly. The contract is the session that asked
 * (the run's own, which wrote the fix); when the discussion goes elsewhere
 * (decisionDiscussion's owner fell back to the run's starter, a lead or the
 * workspace agent), the head names who it goes to and links the session that
 * asked, so nobody mistakes one for the other.
 */
function TalkHead({ decision, problem }: { decision: SessionDecisionItem; problem: string | null }) {
  const { owner } = useDecisionDiscussion(decision._id);
  const elsewhere = !!owner && owner.via !== "asker";
  return (
    <>
      <div className="ld-talk-h">Talk it through<span>{owner && elsewhere ? `with ${owner.name}` : problem ? `with the run on ${problem}` : "with the session that asked"}</span></div>
      {elsewhere && (
        <p className="ld-talk-other" data-line-decision-other-asker={owner!.via}>
          Not the session that asked
          <Link href={`/conversation/${decision.conversation_id}`}>Open the asking session</Link>
        </p>
      )}
    </>
  );
}
