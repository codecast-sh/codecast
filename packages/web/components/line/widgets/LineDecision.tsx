"use client";
// A line fix decision in front of the owner (ct-59652): the one surface every
// line view uses to show what a run proposes for a problem and to answer it.
// The decision is a session_decisions row (task_id the problem, workflow_run_id
// the run) asked by the run's own session, which stays alive to talk it
// through. The page leads with the sweet spot (the session's own words and
// the page it wrote: what was wrong, what the fix changes, shown on a real
// case), then the answers, with the chat to the asking session beside it, and
// everything the run measured folded under as its record. A decision from
// before sessions presented their own carries a structured card instead: its
// words lead the same way and its tiles and cases wait in the fold. The answers
// are pinned to the foot of the pane (under the chat while it is open, so asking
// and answering sit together), the run's recommended one marked, so however
// long the session's words run the way to decide is always in view. The code
// is folded under the words (ChangeCode), never left out.
// A trial run's decision also carries what its card measured as one row of
// number chips (TrialEvidenceBand; the session's words tell the case once),
// and its words ask what you would do, since a trial answer ships nothing. The
// chat is the box and who answers until someone writes; what the session said
// before it asked waits behind one button. It reuses the decision
// page's pieces (DecisionAnswering, DecisionDiscussion, ChangeCardView), so
// an answer reads and lands the same as on /decisions.
import { gateDoc } from "@codecast/shared/contracts/changeCard";
import { useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { MessageSquare, PanelRight, X } from "lucide-react";
import type { DecisionDetailItem, InboxSession, SessionDecisionItem } from "../../../store/inboxStore";
import { useInboxStore } from "../../../store/inboxStore";
import { useDecisionDetail, useSyncDecisionDetail } from "../../../hooks/useSyncDecisionDetail";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useDecisionThread } from "../../../hooks/useDecisionThread";
import { useTrialCards, useTrialHref, useTrialProjects } from "../../../hooks/useSyncTrial";
import { bareVerbAnswers, recommendedOption, trialWords } from "../../../lib/line/fixDecision";
import { cardAsRead, cardProse, proposalAsRead } from "../../../lib/trialEvidence";
import { openConversationBeside } from "../../../hooks/useOpenLinkedSession";
import { SessionInlineThread } from "../../conversation/SessionInlineThread";
import { TrialEvidenceBand, quotesConversation } from "./TrialEvidenceBand";
import { ReaskNotice } from "./ReaskRun";
import { ChangeCode } from "./ChangeCode";
import { useSyncTaskEvidence, useTaskEvidenceByShortId } from "../../../hooks/useSyncTaskEvidence";
import { lineRefHref } from "../../../lib/line/lineWorkspaceUrl";
import { problemHeadName } from "../../../lib/line/problemTable";
import { causeName } from "../../../lib/lineFlow";
import { decisionWaitLabel } from "../../../lib/decisionLinks";
import { formatTimeAgo } from "../../../lib/messageNavigator";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { PreloadPublishedPage, PublishedPageEmbed, PublishedPagesAsLinks } from "../../PublishedPageEmbed";
import { usePageInfo } from "../../../hooks/usePageInfo";
import { DoubtChip } from "../DoubtChip";
import { AskingSessionView } from "../../decisions/DecisionParties";
import { useJumpToDecisionAsk } from "../../../hooks/useJumpToDecisionAsk";
import { DecisionDiscussion } from "../../decisions/DecisionDiscussion";
import { DecisionFacts } from "../../decisions/DecisionSections";
import { GateRunChip } from "../../decisions/DecisionCompactCard";
import { ChangeCardView, ExamplePair } from "../../decisions/ChangeCardView";
import { DecisionAnswerControls } from "../../decisions/DecisionAnswerControls";
import { DecisionAnswerPanel, restatesCard, useDecisionAnswering, useDecisionPage } from "../../decisions/DecisionAnswering";
import "../../decisions/decisions.css";
import "./lineDecision.css";

/** How long the answers wait on a page that has not come into view before they take presses anyway. */
const PAGE_WAIT_MS = 8000;

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
  /** The host already names the problem above it (the problem page): leave out the ref, title, project and wait line. */
  head?: boolean;
  /** Sit in a page's flow: grow with its content instead of filling a fixed pane; the answers stay docked to the viewport. */
  inline?: boolean;
  /** Called once when the decision stops waiting (answered, or settled some other way), so a host can move on. */
  onAnswered?: (decisionId: string, answer: string | null) => void;
  /** False when the host carries what to do after a settled decision (the problem page's new run): its banner then says only the state and when. */
  act?: boolean;
  /** The host already says what kind of decision it is (the team's decision inbox): the answers carry no trial chip or note. */
  quiet?: boolean;
  className?: string;
};

/** Feeds one decision's detail into the store before it is opened, and the page it filed (its metadata and, gated, the
 *  viewer's way in), so opening it paints the words and frames the page at once. */
function PrefetchOne({ id, warm }: { id: string; warm: boolean }) {
  useSyncDecisionDetail(id);
  const row = useDecisionDetail(id)?.decision;
  if (!row?.report_slug) return null;
  return warm ? <PreloadPublishedPage slug={row.report_slug} decision={row._id} /> : <PrefetchPage slug={row.report_slug} decision={row._id} />;
}

function PrefetchPage({ slug, decision }: { slug: string; decision: string }) {
  usePageInfo(slug, decision);
  return null;
}

/** The details of the fix decisions a list shows (the first few), fed ahead of a click: a list mounts it beside its rows.
 *  `warm` are the ones a step away (the next and previous): their pages also load, parked, so stepping to one shows
 *  its page at once. */
export function LineDecisionPrefetch({ ids, warm }: { ids: ReadonlyArray<string>; warm?: ReadonlyArray<string> }) {
  const first = ids.slice(0, 8);
  const extra = (warm ?? []).filter((id) => !first.includes(id));
  return <>{[...first, ...extra].map((id) => <PrefetchOne key={id} id={id} warm={!!warm?.includes(id)} />)}</>;
}

export function LineDecision({ id, ...rest }: LineDecisionProps) {
  const page = useDecisionPage(id);
  if (!page.detail || !page.decision) {
    // A read the server refused never arrives: it is said, with the decision's own page to try, never left loading.
    const state = page.missing && page.ready ? "missing" : page.error ? "unread" : "loading";
    return (
      <article className={`ld ${rest.className ?? ""}`} data-line-decision={id} data-state={state}>
        <div className="ld-empty">
          {state === "missing" ? "This decision does not exist, or it is not yours to read." : state === "unread" ? <>This decision could not be read <Link className="lw-link" href={`/decisions/${id}`}>Open {id}</Link></> : "Loading the decision"}
        </div>
      </article>
    );
  }
  return <LineDecisionBody decision={page.decision} detail={page.detail} answerable={page.answerable} {...rest} />;
}

/** The decision drawn from its row and detail; exported for a test that mounts it on a fixture. */
export function LineDecisionBody({ decision, detail, answerable, source, onProblem, onRun, onClose, head = true, inline = false, onAnswered, act = true, quiet = false, className = "" }: Omit<LineDecisionProps, "id"> & { decision: SessionDecisionItem; detail: DecisionDetailItem; answerable: boolean }) {
  const scope = useRef<HTMLElement>(null);
  const cardTask = decision.card?.cause.task ?? null;
  useSyncTaskEvidence(cardTask);
  const guide = useTaskEvidenceByShortId(cardTask)?.change_guide ?? null;
  const task = detail.task;
  const taskId = task?._id ?? decision.task_id ?? null;
  const projectId = task?.project_id ?? null;
  const project = useInboxStore((s) => (projectId ? (s.projects as Record<string, { title?: string }> | undefined)?.[projectId]?.title ?? null : null));
  // A trial decision says so itself (session_decisions.trial); a project in the trial says it for an older row.
  const trialProjects = useTrialProjects();
  const trial = !!decision.trial || trialProjects.some((p) => p._id === projectId);
  const a = useDecisionAnswering(decision, detail, answerable, trial, act);
  // The trial card this decision is, when a trial run asked it: what the run built and proved.
  // Every trial card, superseded ones too: a replaced decision's own page still shows what its run built.
  const trialCard = useTrialCards({ all: true }).find((c) => c.decision?._id === decision._id) ?? null;
  // The trial this decision belongs to, in its own workspace, with its card open.
  const trialHref = useTrialHref(projectId, trialCard?.short_id ?? null);
  // A trial answer records what you would have done: the question and options say "would", and Ship answers the
  // decision (never the live ship a run's card starts), so nothing ships from here.
  // A trial decision carries no card of its own. When its answers are bare verbs the trial card's is lent to it, so they are
  // the card's (Revise opens a note for the builder, Ship only records); answers the session wrote in its own words stay
  // its own rows. Its run is left off so nothing can start a ship from here.
  const asked = useMemo(() => (trial ? { ...trialWords(decision), workflow_run_id: undefined, card: decision.card ?? (bareVerbAnswers(decision.options) ? trialCard?.card : undefined) ?? undefined } : decision), [trial, decision, trialCard]);
  const card = decision.card ?? null;
  const ref = task?.short_id ?? card?.cause.task ?? null;
  // The problem as a person says it: its written name, else its title without ids, hashes or thread references.
  const named = useInboxStore((s) => (taskId ? causeName((s.tasks as Record<string, Parameters<typeof causeName>[0]> | undefined)?.[taskId]) : null));
  const rawTitle = task?.title ?? card?.cause.title ?? null;
  const title = rawTitle ? problemHeadName({ title: rawTitle, name: named }) : null;
  const doc = gateDoc(detail.doc?.content ?? "") || gateDoc(trialCard?.doc_md ?? "") || null;
  const context = decision.context_md?.trim() || null;
  // The step this run waits at left its line: no answer has anywhere to go until the run is asked again.
  const stale = !!trialCard?.stale_gate && a.pending;
  // The answer the run recommends: a role's on the ladder first, else its own card's verdict, read against the problem now.
  const verdict = trialCard ? (cardAsRead(trialCard)?.recommend ?? proposalAsRead(trialCard.proposal, trialCard.evidence)?.recommend)?.verdict : card?.recommend?.verdict;
  const recommended = a.rec ?? recommendedOption(verdict, decision.options, trialCard?.options) ?? undefined;
  // The asking session is the run's presenting step (its title is that step's name, "Card words · ct-N"), not the agent
  // that built the fix: a run's decision, and a trial's (whose answer carries no run), name it by what it is.
  const fixRun = (!!decision.workflow_run_id && !!taskId) || trial || !!trialCard;
  const askerLabel = fixRun ? "The session presenting this fix" : undefined;

  // A host moves on once the decision stops waiting: one call, on the change, never on a decision that was settled when it opened.
  const wasPending = useRef(a.pending);
  useWatchEffect(() => {
    if (wasPending.current && !a.pending) onAnswered?.(decision._id, decision.answer_index != null ? decision.options?.[decision.answer_index]?.label ?? null : decision.answer_text ?? null);
    wasPending.current = a.pending;
  }, [a.pending, onAnswered]);

  // A decision taken back or dismissed has nobody left to talk it over with when its session is gone.
  const askingSession = useInboxStore((s) => s.sessions[decision.conversation_id] as InboxSession | undefined);
  const talkable = !((decision.status === "withdrawn" || decision.status === "dismissed") && (!askingSession || !!askingSession.inbox_killed_at || askingSession.status === "completed"));
  // The chat stays folded to one line until it holds a message or the person opens it: an empty column is noise beside the decision.
  const { rows: talkThread } = useDecisionThread(decision._id, talkable);
  const [talkOpen, setTalkOpen] = useState(false);
  // Closed by its own Esc, a chat that holds messages stays closed until it is asked for again.
  const [talkClosed, setTalkClosed] = useState(false);
  const talkShown = talkable && (talkOpen || (talkThread.length > 0 && !talkClosed));
  const openTalk = () => { setTalkOpen(true); setTalkClosed(false); };
  const closeTalk = () => { setTalkOpen(false); setTalkClosed(true); };
  const talkRef = useRef<HTMLElement>(null);
  // Opened from the answers' foot, the chat comes into view wherever the reading stands (beside the words it is sticky).
  useWatchEffect(() => { if (talkOpen) talkRef.current?.scrollIntoView?.({ block: "nearest" }); }, [talkOpen]);
  const askAct = talkable && !talkShown ? (
    <button type="button" className="ld-talk-fold" onClick={openTalk} data-line-decision-talk-open>
      <MessageSquare className="w-3.5 h-3.5" aria-hidden />Ask {askerLabel ? askerLabel.replace(/^The /, "the ") : "the session that asked"}
    </button>
  ) : null;

  // The page the session wrote, filed on the decision or on its trial card. It reads in the open under the session's
  // short words (it is where the session shows the problem and the fix), and leads when there are none. It opens whole,
  // in the decision's own scroll, never as a box scrolling inside it.
  const reportSlug = decision.report_slug ?? trialCard?.decision?.report_slug ?? null;
  // The decision that filed it, whose readers open it past a trial's password.
  const reportOf = decision.report_slug ? decision._id : trialCard?.decision?._id ?? null;
  const report = reportSlug && !card ? reportSlug : null;
  // The answers wait for the page they answer: until it is in view they show but take no press and no key, so nobody
  // answers a case they have not seen. A page that never reports in (a hung network) lets go after a while.
  const [pageIn, setPageIn] = useState(false);
  useWatchEffect(() => {
    setPageIn(false);
    if (!report) return;
    const t = setTimeout(() => setPageIn(true), PAGE_WAIT_MS);
    return () => clearTimeout(t);
  }, [report]);
  const reading = !!report && !pageIn;
  // The answers: the session's own options and a typed answer while it waits, else the answer on record.
  const docked = a.pending && answerable;
  const answers: ReactNode = (
    <section className="ld-answers" data-line-decision-answers aria-label="Your answer" data-reading={reading && docked ? "" : undefined} inert={reading && docked ? true : undefined}>
      {stale ? (
        <ReaskNotice taskId={trialCard!.task_id} task={ref ?? trialCard!.task_short_id} reason="Its step left the flow, so an answer has nowhere to go." />
      ) : docked ? (
        <>
          {/* Asking the session before answering sits with the answers, so it is in view at every scroll. */}
          <div className="ld-answers-row">
            <h2 className="ld-answers-h" data-line-decision-trial-note={trial ? "" : undefined}>
              {trial && !quiet && <Link className="ld-trial" href={trialHref} title="A trial run: your answer records what you would have done, and nothing ships. Open the trial">Trial</Link>}
              {trial ? "What would you do?" : "Your answer"}
              {trial && !quiet && <span className="ld-answers-sub">recorded, nothing ships</span>}
            </h2>
            {askAct}
          </div>
          {a.heldNote}
          {/* A fix decision's answers already hold leaving things as they are: no second way out beside them. */}
          <DecisionAnswerControls decision={asked} onAnswer={a.onAnswer} onDismiss={fixRun ? undefined : a.onDismiss} keys={!reading} keyScope={scope} size="compact" recommendation={recommended} record={a.outcome?.pill} caption={!context} />
        </>
      ) : a.outcome && !a.closed ? (
        <div className="ld-outcome" data-line-decision-outcome>{a.outcome.line}</div>
      ) : a.answerSection ? (
        <>
          {trial && <h2 className="ld-answers-h"><Link className="ld-trial" href={trialHref}>Trial</Link>What you would do<span className="ld-answers-sub">recorded, nothing shipped</span></h2>}
          {/* A trial answer on record reads in the trial's own words ("Would ship"), never as a thing done. */}
          <DecisionAnswerPanel decision={trial ? { ...asked, workflow_run_id: decision.workflow_run_id } : decision} detail={detail} answerable={answerable} a={a} keys={false} />
        </>
      ) : null}
    </section>
  );
  // While it waits on you the answers are pinned to the pane's foot, or under the chat while it is open; settled, the
  // answer on record reads in place.
  const inPlace = docked || stale ? null : answers;
  const withTalk = talkShown && (docked || stale);

  // The sweet spot: a structured card's top, or the session's own words. A decision with no short context leads with its doc,
  // and one with neither leads with its published proposal (a trial station writes its case there).
  const lead = card ? null : context ?? doc;
  // What the run measured (checks, diff, cost, reach) is the record behind the session's words, not the decision: once
  // the session has shown the case itself (a page, or words that quote a conversation) it waits in the fold. Words that
  // show no case get the card's real message against what changes, and no words at all get the card's whole case.
  const said = !!lead || !!report;
  const shown = !!report || quotesConversation(context);
  const band = trialCard && !card ? <TrialEvidenceBand card={trialCard} compact={said} quoted={shown} /> : null;
  // A decision from before sessions presented their own (a structured card and no words of the session's): its words
  // read as words, what is wrong today and what the change does, and everything the run measured (tiles, checks, the
  // replayed cases with their raw inputs) waits in the fold with the rest of the record.
  const sweet = card ? (
    <>
      <h1 className="ld-question" data-line-decision-question data-card-headline>{card.headline?.trim() || asked.question}</h1>
      <div className="ld-prose" data-line-decision-card-words>
        {card.context?.trim() && <p>{card.context}</p>}
        {card.wrong?.trim() && <p data-line-decision-today>{card.wrong}</p>}
        {card.change?.trim() && <p data-line-decision-change>{card.change}</p>}
      </div>
      {/* One real case, before and after, as the person affected saw it: the prompt input it was replayed from is the record's. */}
      {card.examples[0] && <div className="ld-case" data-line-decision-case><ExamplePair ex={{ ...card.examples[0], input: "", note: "" }} /></div>}
      {inPlace}
    </>
  ) : (
    <>
      <h1 className="ld-question" data-long={asked.question.length > 140 ? "" : undefined} data-line-decision-question>{asked.question}</h1>
      {/* The session's words as it wrote them: a fenced product reference reads as a link, a quotation without doubled marks (cardProse). */}
      {lead && <div className="ld-prose" data-line-decision-context><MarkdownRenderer content={cardProse(lead, trialCard ?? undefined)} /></div>}
      {report && <div className="ld-lead-report" data-line-decision-report><PublishedPageEmbed slug={report} decision={reportOf} height={lead ? 640 : 560} whole onReady={() => setPageIn(true)} /></div>}
      {!shown && band}
      {inPlace}
    </>
  );

  // The fold: the record behind the decision. A card's full view, the doc the sweet spot left out, the run's figures.
  const fullDoc = card ? (doc && !restatesCard(doc, card) ? doc : null) : lead === doc ? null : doc;
  const folded = shown ? band : null;
  const hasFull = !!card || !!fullDoc || !!folded;

  return (
    <article ref={scope} className={`ld decision-doc ${inline ? "ld-inline" : ""} ${className}`} data-line-decision={decision.short_id ?? decision._id} data-trial={trial ? "" : undefined} tabIndex={-1}>
      {head && <>
      <header className="ld-head">
        {ref && (onProblem && taskId
          ? <button type="button" className="ld-ref" onClick={() => onProblem(taskId)} data-line-decision-problem>{ref}</button>
          : <Link className="ld-ref" href={lineRefHref(ref)} data-line-decision-problem>{ref}</Link>)}
        {title && <span className="ld-title" title={rawTitle ?? undefined}>{title}</span>}
        {source && <span className="lw-srcchip" data-line-decision-source>{source}</span>}
        {project && <span className="ld-project">{project}</span>}
        {trial && !/\btrial\b/i.test(project ?? "") && <Link className="ld-trial" href={trialHref} title="A trial run: answers record what you would have done and ship nothing. Open the trial">Trial</Link>}
        <span className="ld-spacer" />
        <span className="ld-asker" data-line-decision-asker><Asker decision={decision} label={askerLabel} /></span>
        {onClose && <button type="button" className="ld-close" onClick={onClose} aria-label="Close decision (Esc)" title="Close (Esc)"><X className="w-4 h-4" /></button>}
      </header>
      <div className="ld-sub">
        <span data-tone={a.pending ? (decision.blocking ? "wait" : "ask") : "done"}>{stale ? "Step removed: needs a re-ask" : a.pending ? decisionWaitLabel(decision) : decision.status}</span>
        <span>asked {formatTimeAgo(decision.created_at, a.now)}</span>
        {decision.workflow_run_id && (onRun
          ? <button type="button" className="ld-run" onClick={() => onRun(decision.workflow_run_id!, taskId)} data-line-decision-run>the run</button>
          : <GateRunChip runId={decision.workflow_run_id} nodeId={decision.gate_node_id} />)}
        <Link className="ld-id" href={`/decisions/${decision.short_id ?? decision._id}`} title="Open on its own page">{decision.short_id ?? "decision"}</Link>
      </div>
      </>}

      <div className="ld-grid" data-talk={talkShown ? "open" : "folded"}>
        <div className="ld-main">
          {a.banner && <div className="decision-status-banner ld-banner" role="status" data-decision-banner={decision.status}>{a.banner}</div>}
          {a.doubt && <DoubtChip doubt={a.doubt} className="mb-4" />}
          <div className="ld-sweet" data-line-decision-sweet>{sweet}</div>
          {/* Where the answers are docked the ask sits with them; otherwise it reads here, under the words. */}
          {(stale || !docked) && askAct}
          {decision.workflow_run_id && !card && <ChangeCode runId={decision.workflow_run_id} taskId={taskId} projectId={projectId} />}
          {hasFull && (
            <details className="ld-full" data-line-decision-full>
              <summary>The run's record</summary>
              <div className="ld-full-body">
                {card && <ChangeCardView card={card} density="full" change={false} recommend={false} guide={guide} />}
                {fullDoc && <div className="ld-prose" data-decision-doc><MarkdownRenderer content={fullDoc} /></div>}
                {folded}
                <DecisionFacts decision={decision} detail={detail} />
              </div>
            </details>
          )}
        </div>
        {talkShown && (
          <aside ref={talkRef} className="ld-talk" aria-label="Talk to the session that asked" data-line-decision-talk data-with-answers={withTalk ? "" : undefined}>
            <Talk decision={decision} label={askerLabel} onClose={closeTalk} />
            {/* Asking and answering in one place: with the chat open, the answers sit under it. */}
            {withTalk && <div className="ld-talk-answers">{answers}</div>}
          </aside>
        )}
      </div>
      {(docked || stale) && !withTalk && <footer className="ld-dock" data-line-decision-dock>{answers}</footer>}
    </article>
  );
}

/** The asking session in the header: by what it is on a fix decision (its title is a pipeline step's name), else by its own name. */
function Asker({ decision, label }: { decision: SessionDecisionItem; label?: string }) {
  const session = useInboxStore((s) => s.sessions[decision.conversation_id]);
  const jumpToAsk = useJumpToDecisionAsk(decision.conversation_id, decision._id, decision.question);
  return <AskingSessionView decision={decision} session={session} onJumpToAsk={jumpToAsk} label={label} />;
}

/**
 * The chat with the session presenting the fix: who it is and whether it is
 * running, then the decision's discussion, whose words reach it as a turn
 * about this decision. Until someone writes there is only the box and the line
 * saying who answers. What the session said up to its ask (its own working
 * notes, then the decision this page already shows) waits behind one button,
 * and a page it published reads as a link in this column. When the discussion
 * goes elsewhere (decisionDiscussion's owner fell back to the run's starter, a
 * lead or the workspace agent), the head names who it goes to and links the
 * session that asked, so nobody mistakes one for the other.
 */
function Talk({ decision, label, onClose }: { decision: SessionDecisionItem; label?: string; onClose: () => void }) {
  const { owner, rows: thread } = useDecisionThread(decision._id);
  const elsewhere = !!owner && owner.via !== "asker";
  // The session the words go to: its messages are the transcript above the box.
  const sessionId = owner?.conversation_id ?? decision.conversation_id;
  const session = useInboxStore((s) => s.sessions[sessionId] as InboxSession | undefined);
  const live = session?.status === "running" || session?.status === "working" || session?.status === "active";
  const name = elsewhere ? owner!.name : label ?? session?.title ?? decision.session_title ?? "The session that asked";
  const [earlier, setEarlier] = useState(false);
  return (
    <>
      <div className="ld-talk-h" data-line-decision-talk-head>
        <span className="ld-talk-dot" data-live={live ? "" : undefined} title={live ? "Running now" : "Idle: it wakes when you write"} aria-label={live ? "running" : "idle"} />
        {/* A named session keeps its station title off the page, hover included. */}
        <b title={elsewhere || label ? undefined : session?.title ?? decision.session_title ?? undefined}>{name}</b>
        <button type="button" className="ld-talk-open" onClick={() => openConversationBeside(sessionId)} title={elsewhere || label ? "Open the session" : session?.title ?? decision.session_title ?? "Open the session"} data-line-decision-open-session>
          <PanelRight className="w-3 h-3" aria-hidden />Open
        </button>
      </div>
      {elsewhere && (
        <p className="ld-talk-other" data-line-decision-other-asker={owner!.via}>
          Not the session that asked
          <Link href={`/conversation/${decision.conversation_id}`}>Open the asking session</Link>
        </p>
      )}
      {session && (earlier ? (
        <div className="ld-talk-said" data-line-decision-said>
          <PublishedPagesAsLinks.Provider value>
            <SessionInlineThread session={session} seen={false} maxRows={6} foot={false} composer={false} before={thread[0]?.created_at} />
          </PublishedPagesAsLinks.Provider>
        </div>
      ) : (
        <button type="button" className="ld-talk-earlier" onClick={() => setEarlier(true)} data-line-decision-earlier>Its work before it asked</button>
      ))}
      <DecisionDiscussion decisionId={decision._id} open askFirst onOpenChange={(o) => { if (!o) onClose(); }} askerName={label ? label.replace(/^The /, "the ") : undefined} />
    </>
  );
}
