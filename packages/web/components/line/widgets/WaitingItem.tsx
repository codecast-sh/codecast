"use client";
// The one reader for a need (line-journeys.md LJ6.2). Wherever one is named
// (For you, a problem's band, a run's person step, a step's waiting rows) this
// is what shows it, so the thing is read and answered where it is named. For
// you lists only the counted kind (lineNeeds COUNTED: the end decision); the
// rest are read on their problem and its run:
//   decision          the session's decision, whole (LineDecision), answered on it; a trial card no session has
//                     presented yet is one line naming the step it is with, that session and its run (NotPresented)
//   question, confirm the question in full, the findings it rests on, the answer box; a twin folded in (the line
//                     reads it as the same problem under another id) is named under it with Merge into
//   duplicate         a twin whose older problem asks nothing: which one it is the same as, both's findings, Merge into
//   reask             the same line, and the one act that has its agent ask again
//   lapsed            the decision nobody answered, read only, and its answers: Drop now, or a new run to ask again
//   stopped           the yes it waits on in one line, the step's last message whole, Yes (recorded for the next run) or a new run
//   review, unlanded  a built fix: the decision its run's session presented it as, whole (LineDecision), else the
//                     NotPresented line; its branch and the act its facts call for (send back, rebuild, land) on its run's page
//   fixed             the commit main already fixes it in and the run's note, Close as fixed
//   assigned          the problem's note and findings, Hand it to the line (unassign: the sweep can start it) or Close
//   ask               what an agent asked a person to do by a date: when, the agent's reason whole, the task where it is
//                     done (the product's own), and Done, which takes it off For you
// A control that starts a full run says so and goes through a review
// (SwitchReview with startAgainLedger); nothing here restates the problem's
// state as a sentence. The root fills its host: give it a box of fixed height.
import { useMemo, useState, type ReactNode } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useConversationMessages } from "../../../hooks/useConversationMessages";
import { useSyncTaskSignals } from "../../../hooks/useSyncSignals";
import { useTrialCards } from "../../../hooks/useSyncTrial";
import { openConversationBeside } from "../../../hooks/useOpenLinkedSession";
import { answersAtGate } from "../../../lib/line/lineInbox";
import { decisionRef, runFixDecision } from "../../../lib/line/fixDecision";
import { adviceWord, goOnProof, oneCaseClaim, proseAdvice, stoppedAsk, waitNote, type LineNeed, type StoppedAsk } from "../../../lib/line/lineNeeds";
import { findingLeads, rebaseLandLedger } from "../../../lib/line/problemPage";
import { listedFindings } from "../../../lib/line/findingEvidence";
import { problemListName } from "../../../lib/line/problemTable";
import { lastWord, type TraceMessage } from "../../../lib/line/runTrace";
import { stepLabel } from "../../../lib/line/runReport";
import { sameFailures } from "../../../lib/line/sameFailures";
import { ageShort } from "../../../lib/lineFlow";
import { useOpsGroups } from "../../../hooks/useSyncOps";
import { opsHref } from "../../ops/opsPaths";
import Link from "next/link";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { answerProblem, ProblemAsk } from "../workspace/views/problem/AskBlock";
import { FindingPlaceholder, FindingReader, useFinderName, type ReaderSignal } from "./FindingReader";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { mergeProblemLedger } from "../../../lib/line/findingLedger";
import { LineDecision } from "./LineDecision";
import { useLineNav } from "./parts";
import { StartRunAct } from "./StartRunAct";
import { BranchName, ClosedDecisionDock, useRunBranch } from "./ClosedDecisionActs";
import { MergeFixAct } from "../workspace/views/problem/MergeFixAct";
import { LandAgain } from "../workspace/views/problem/LandAgain";
import { CloseAsFixed } from "../workspace/views/problem/CloseProblem";
import { useRepoCompare } from "../../../hooks/useRepoBrowse";
import { useCommitLive, useFixBranch, useFixCommitChecks, useProblemCiRun, wentLive } from "../../../hooks/useFixCommitChecks";
import { branchStanding } from "../../../lib/line/mergeFixLedger";
import { fixHolder, reviewGates, reviewMove, sendBackNote } from "../../../lib/line/fixReview";
import { ReaskNotice } from "./ReaskRun";
import { deployOfCommit, failingTestOf, fixCiFacts, fixedNoteRest, newestDeploy, undeployedCited, type DeployFact } from "../../../lib/line/fixedOnMain";
import "./waitingItem.css";

export type WaitingItemProps = {
  need: LineNeed;
  /** List the findings the need rests on. Off where they are already on the page (a problem's Findings, just below its band). */
  evidence?: boolean;
  /** Open the need's problem, and its run: the host's own navigation (For you sets the need's process). Default: the line's nav. */
  onProblem?: (taskId: string) => void;
  onRun?: RunOpener;
  /** Whether the reader names the problem (ref, project, title, wait line). Off where the host already does: the
   *  decision then opens straight on its question. */
  head?: boolean;
  /** Whether the host already states what is asked in its own line (a problem's band, a run's head). Default: when it
   *  has no head of its own. For you's reader names only the problem, so it asks here. */
  asked?: boolean;
  /** The decision sits in the host's page flow and grows with its content (LineDecision inline). */
  inline?: boolean;
  /** False where the host carries the act after a settled decision itself (LineDecision act). */
  act?: boolean;
  /** The run the host already shows (a run's page): no link back to it. */
  runShown?: string | null;
  now?: number;
};

/** Opens a run, at one of its steps when `step` is given (the run page's step). */
export type RunOpener = (runId: string, taskId: string | null, step?: string) => void;

export function WaitingItem({ need, evidence = true, onProblem, onRun, head = true, asked = !head, inline = false, act = true, runShown = null }: WaitingItemProps) {
  const nav = useLineNav();
  const toProblem = onProblem ?? ((id: string) => nav?.openCase?.(id));
  const toRun: RunOpener = onRun ?? ((runId, taskId) => nav?.openRun(runId, taskId));
  const body = need.kind === "decision" && need.decisionRef ? (
    <LineDecision key={need.decisionRef} id={need.decisionRef} onProblem={toProblem} onRun={toRun} head={head} inline={inline} act={act} />
  ) : need.kind === "reask" || (need.kind === "decision" && need.cardRef) ? (
    <TrialCardNeed need={need} onProblem={toProblem} onRun={toRun} head={head} runShown={runShown} />
  ) : need.kind === "lapsed" ? (
    <Lapsed need={need} onProblem={toProblem} onRun={toRun} head={head} inline={inline} />
  ) : need.kind === "stopped" ? (
    <Stopped need={need} onProblem={toProblem} onRun={toRun} runShown={runShown} head={head} asked={asked} evidence={evidence} />
  ) : need.kind === "review" || need.kind === "unlanded" ? (
    <Review need={need} onProblem={toProblem} onRun={toRun} head={head} inline={inline} runShown={runShown} />
  ) : need.kind === "fixed" ? (
    <Fixed need={need} onProblem={toProblem} onRun={toRun} evidence={evidence} />
  ) : need.kind === "assigned" ? (
    <Assigned need={need} onProblem={toProblem} evidence={evidence} />
  ) : need.kind === "duplicate" && need.dupOf ? (
    <Duplicate need={need} dupOf={need.dupOf} onProblem={toProblem} evidence={evidence} />
  ) : (
    <Ask need={need} evidence={evidence} onProblem={toProblem} />
  );
  return <div className="lwn" data-headless={head ? undefined : ""} data-line-need={need.kind} data-line-need-ref={need.ref}>{body}</div>;
}

/** The problem a need is about, above a reader that has no head of its own: its ref (which opens it) and its whole title. */
function NeedHead({ need, onProblem }: { need: LineNeed; onProblem: (taskId: string) => void }) {
  const project = useInboxStore((s) => (need.projectId ? (s.projects as Record<string, { title?: string }> | undefined)?.[need.projectId]?.title ?? null : null));
  return (
    <header className="lwn-head">
      {need.caseId && need.problemRef && <button type="button" className="lwn-ref" onClick={() => onProblem(need.caseId!)} data-line-need-problem={need.problemRef}>{need.problemRef}</button>}
      {project && <span className="lwn-project">{project}</span>}
      <h2 className="lwn-title">{problemListName(need)}</h2>
    </header>
  );
}

/** A question or a new problem to confirm: the question in full with its answer box, then the findings it rests on. */
function Ask({ need, evidence, onProblem }: { need: LineNeed; evidence: boolean; onProblem: (taskId: string) => void }) {
  return (
    <div className="lwn-scroll">
      <div className="lwn-col">
        <NeedHead need={need} onProblem={onProblem} />
        <ProblemAsk key={need.key} question={need.ask} why={need.note} taskRef={need.problemRef} caseId={need.caseId} focus={false} asks={need.kind === "question"} />
        {need.dups?.length && need.problemRef ? <Twins need={need} into={need.problemRef} onProblem={onProblem} /> : null}
        {evidence && need.caseId && <Evidence caseId={need.caseId} also={need.dups?.map((d) => d.caseId)} count={need.findings ?? 0} title={need.title} />}
      </div>
    </div>
  );
}

const projectTitle = (s: unknown, id: string | null | undefined) => (id ? (s as { projects?: Record<string, { title?: string } | undefined> }).projects?.[id]?.title ?? null : null);

/** The newer problems folded into this one: each by its ref (which opens it) and project, and the act that makes the
 *  fold real. Until it is merged the line still holds both. */
function Twins({ need, into, onProblem }: { need: LineNeed; into: string; onProblem: (taskId: string) => void }) {
  const projects = useInboxStore((s) => (need.dups ?? []).map((d) => projectTitle(s, d.projectId)).join("\u0000"));
  const names = projects.split("\u0000");
  return (
    <section className="lwn-twins" data-line-need-twins={need.dups!.length}>
      <h3 className="lwn-h">Same problem</h3>
      <ul>
        {need.dups!.map((d, i) => (
          <li key={d.caseId} className="lwn-twin" data-line-need-twin={d.ref ?? d.caseId}>
            {d.ref && <button type="button" className="lwn-ref" onClick={() => onProblem(d.caseId)}>{d.ref}</button>}
            {names[i] && <span className="lwn-project">{names[i]}</span>}
            {d.findings != null && <span className="lwn-twin-n"><span className="lw-num">{d.findings}</span> {d.findings === 1 ? "finding" : "findings"}</span>}
            {d.ref && <MergeAct twin={d.ref} into={into} findings={d.findings} twinProjectId={d.projectId} intoProjectId={need.projectId} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A problem the line reads as an older one's twin, with nothing of the older one asked: which it is the same as, the
 *  findings of both, and Merge into. */
function Duplicate({ need, dupOf, onProblem, evidence }: { need: LineNeed; dupOf: NonNullable<LineNeed["dupOf"]>; onProblem: (taskId: string) => void; evidence: boolean }) {
  const older = useInboxStore((s) => (s as { tasks?: Record<string, { title?: string; project_id?: string | null } | undefined> }).tasks?.[dupOf.caseId] ?? null);
  return (
    <div className="lwn-scroll">
      <div className="lwn-col">
        <NeedHead need={need} onProblem={onProblem} />
        <section className="ask" data-line-need-dup-of={dupOf.ref ?? dupOf.caseId}>
          <p className="ask-q">Same as <button type="button" className="lwn-ref" onClick={() => onProblem(dupOf.caseId)}>{dupOf.ref ?? "an older problem"}</button></p>
          {older?.title && <p className="ask-open"><span>{dupOf.ref}</span>{problemListName({ title: older.title })}</p>}
          <div className="ask-acts">
            {need.problemRef && dupOf.ref && <MergeAct twin={need.problemRef} into={dupOf.ref} findings={need.findings} twinProjectId={need.projectId} intoProjectId={older?.project_id ?? null} primary />}
            {need.problemRef && <button type="button" className="lw-act" onClick={() => answerProblem(need.problemRef!, "dropped")} data-line-need-drop>Not a problem</button>}
          </div>
        </section>
        {evidence && need.caseId && <Evidence caseId={need.caseId} also={[dupOf.caseId]} count={need.findings ?? 0} title={need.title} />}
      </div>
    </div>
  );
}

/** "Merge into ct-N", through the one review every hard-to-undo act goes through: the twin's findings move to the older
 *  problem and the twin is dropped as its duplicate. The rows leave For you at once (the store's draft). */
export function MergeAct({ twin, into, findings, twinProjectId, intoProjectId, primary }: { twin: string; into: string; findings: number | null; twinProjectId: string | null; intoProjectId: string | null; primary?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const twinProject = useInboxStore((s) => projectTitle(s, twinProjectId));
  const intoProject = useInboxStore((s) => projectTitle(s, intoProjectId));
  const ledger = useMemo(() => mergeProblemLedger({ twin, into, findings, twinProject, intoProject }), [twin, into, findings, twinProject, intoProject]);
  const merge = () => {
    setReviewing(false);
    setError(null);
    useInboxStore.getState().mergeProblem(twin, into).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <>
      <button type="button" className="lw-act" data-primary={primary ? "" : undefined} aria-haspopup="dialog" onClick={() => setReviewing(true)} data-line-merge-into={into}>Merge into {into}…</button>
      {error && <span className="lw-oc" data-tone="bad" title={error}>Not merged</span>}
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={merge} />}
    </>
  );
}

const evidenceSig = (s: ReaderSignal) => `${s._id}|${s.created_at}|${s.judge ?? ""}|${s.judge_review?.state ?? ""}|${(s.detail_md ?? "").length}`;

/** The findings a need rests on, one line each, each opened in place (FindingReader). */
function Evidence({ caseId, also, count, title, after }: { caseId: string; /** Twins folded in: their findings are this need's too. */ also?: ReadonlyArray<string>; count: number; title: string;
  /** A moment the findings are counted against ("since Prove finished"): how many were filed after it. */ after?: { at: number; words: string } }) {
  const { ready } = useSyncTaskSignals(caseId);
  const ids = useMemo(() => new Set([caseId, ...(also ?? [])]), [caseId, also?.join(",")]);
  const where = useMemo(() => (s: ReaderSignal) => !!s.task_id && ids.has(s.task_id), [ids]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: evidenceSig });
  const sorted = useMemo(() => [...rows].sort((a, b) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at)), [rows]);
  const who = useFinderName();
  // The reader heads with the problem's title: a row never says it again.
  const leadOf = useMemo(() => findingLeads(sorted, title), [sorted, title]);
  // A finding that says nothing is no evidence, and one that repeats another's words is one row: neither is counted.
  const listed = useMemo(() => listedFindings(sorted), [sorted]);
  // Every finding is one line until the person opens it (a finding can hold a whole call); three open at most, the oldest folding back.
  const [open, setOpen] = useState<string[]>([]);
  const toggle = (id: string) => setOpen(open.includes(id) ? open.filter((x) => x !== id) : [...open, id].slice(-3));
  const waiting = !ready && sorted.length < count;
  const feeds = also?.map((id) => <TwinFeed key={id} caseId={id} />);
  if (!listed.rows.length && !waiting) return <>{feeds}</>;
  const shown = waiting ? Math.max(listed.rows.length, count) : listed.rows.length;
  const later = after && !waiting ? listed.rows.filter(({ signal: s }) => (s.created_at ?? 0) > after.at).length : null;
  return (
    <>{feeds}
    <section className="lwn-evidence" data-line-need-evidence={listed.rows.length}>
      <h3 className="lwn-h">Findings <span className="lw-num">{shown}</span>{later != null && <span className="lwn-h-note" data-line-need-findings-after={later}>{later} {after!.words}</span>}{!waiting && listed.empty > 0 && <span className="lwn-h-note" data-line-need-empty={listed.empty}>{listed.empty} empty left out</span>}</h3>
      <ul className="lwn-findings">
        {listed.rows.map(({ signal: s, repeats }) => <FindingReader key={s._id} signal={s} who={who(s)} open={open.includes(s._id)} onToggle={() => toggle(s._id)} lead={leadOf(s)} expectation={title} times={1 + repeats.length} />)}
        {waiting && Array.from({ length: Math.min(4, count - sorted.length) }, (_, i) => <FindingPlaceholder key={i} />)}
      </ul>
    </section></>
  );
}

/** Feeds a folded twin's findings into the store, so its findings list with the need's own. */
function TwinFeed({ caseId }: { caseId: string }) {
  useSyncTaskSignals(caseId);
  return null;
}

type HolderRun = { node_statuses?: Array<{ node_id: string; status: string; label?: string; session?: { _id?: string } | null }> };
/** The session a fix with no decision is with (fixReview fixHolder), as "step|label|session|preparing". */
const holderSig = (rows: Record<string, HolderRun> | undefined, runId: string | null, step: string | null | undefined) => {
  const h = fixHolder(runId ? rows?.[runId]?.node_statuses : null, step);
  return h ? [h.step, h.label ?? "", h.sessionId, h.preparing ? "1" : ""].join("\u0000") : "";
};

/** A fix no session has presented as a decision yet: one line naming the step it is with, that session to open and
 *  talk to, and its run. The decision is the session's to write, so nothing here stands in for it from the run's own
 *  figures (its gates, its files, its findings): those are the run's, one link away. */
function NotPresented({ need, onRun, runShown }: { need: LineNeed; onRun: RunOpener; runShown: string | null }) {
  const sig = useInboxStore((s) => holderSig((s as unknown as { workflowRuns?: Record<string, HolderRun> }).workflowRuns, need.runId, need.fail?.step));
  const [step, label, session, preparing] = sig.split("\u0000");
  const who = label || (step ? stepLabel({ id: step }) : "");
  return (
    <p className="lwn-ask lwn-pending" data-line-need-not-presented={preparing ? "preparing" : "waiting"}>
      <span>{!who ? "No session has presented this fix yet" : preparing ? `${who} is preparing this decision` : `Waiting on ${who} to present it`}</span>
      {session && <button type="button" className="lw-link" onClick={() => openConversationBeside(session)} data-line-need-session={session}>Open its session</button>}
      {need.runId && need.runId !== runShown && <button type="button" className="lw-link" onClick={() => onRun(need.runId!, need.caseId)} data-line-need-run>Open the run</button>}
    </p>
  );
}

/** A trial card no session posted as a decision: the NotPresented line, and where no answer can land at all (its step
 *  left the line, or nothing asked it) the one act that has its run's agent present it. */
function TrialCardNeed({ need, onProblem, onRun, head, runShown }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: RunOpener; head: boolean; runShown: string | null }) {
  const cards = useTrialCards();
  const card = need.cardRef ? cards.find((c) => c.short_id === need.cardRef) ?? null : null;
  return (
    <div className="lwn-scroll">
      <div className="lwn-col">
        {head && <NeedHead need={need} onProblem={onProblem} />}
        <NotPresented need={need} onRun={onRun} runShown={runShown} />
        {card?.status === "waiting" && !answersAtGate(card) && <ReaskNotice taskId={card.task_id} task={card.task_short_id} reason={card.stale_gate ? "Its step left the line, so an answer has nowhere to go." : "No session asked this, so nobody can take an answer."} />}
      </div>
    </div>
  );
}

type CardRow = { _id: string; short_id?: string; task_id?: string; status: string; created_at?: number };

/** The newest decision a problem's fix was presented as that is no longer open: its row id and when it was asked ("id|at"). */
const lapsedCardSig = (rows: Record<string, CardRow> | undefined, taskId: string | null) => {
  let best: CardRow | null = null;
  for (const c of Object.values(rows ?? {})) if (c.task_id === taskId && c.status !== "pending" && (!best || (c.created_at ?? 0) > (best.created_at ?? 0))) best = c;
  return best ? `${best.short_id ?? best._id}|${best.created_at ?? 0}|${best.status}` : "";
};

const dateWords = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A fix that was built and asked, and nobody answered: the decision as it was asked, read only, and its answers as
 *  acts that still work (ClosedDecisionActs: Drop closes the problem, Ask again is a new run), its recommended one first. */
function Lapsed({ need, onProblem, onRun, head, inline }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: (runId: string, taskId: string | null) => void; head: boolean; inline: boolean }) {
  const sig = useInboxStore((s) => lapsedCardSig((s as unknown as { lineCards?: Record<string, CardRow> }).lineCards, need.caseId));
  const [ref, at, status] = sig ? sig.split("|") : [null, "0", ""];
  return (
    <>
      <div className="lwn-thing">
        {ref ? <LineDecision key={ref} id={ref} onProblem={onProblem} onRun={onRun} head={head} inline={inline} act={false} /> : <div className="lwn-scroll"><div className="lwn-col"><NeedHead need={need} onProblem={onProblem} /></div></div>}
      </div>
      {need.caseId ? (
        <ClosedDecisionDock decisionRef={ref} state={/^(withdrawn|dismissed|cancell?ed|expired)$/.test(status ?? "") ? "withdrawn" : "lapsed"} taskId={need.caseId} taskRef={need.problemRef ?? null} title={need.title} projectId={need.projectId ?? null} runId={need.runId} askedAt={Number(at) || null} built />
      ) : <NewAsk need={need} facts={Number(at) ? [{ k: "Asked", v: dateWords(Number(at)) }] : []} acts={null} />}
    </>
  );
}

type RunRow = { node_statuses?: Array<{ node_id: string; label?: string; result_preview?: string; session?: { _id?: string; result?: string; state?: string } | null }> };

/** The step a run stopped at: its label, its session, and its own words short of its last message (its pinned report,
 *  else what it printed), as "label|session|words". */
const stoppedStep = (rows: Record<string, RunRow> | undefined, runId: string | null, step: string | null | undefined) => {
  const n = runId && step ? rows?.[runId]?.node_statuses?.find((x) => x.node_id === step) : undefined;
  return n ? [n.label ?? "", n.session?._id ?? "", n.session?.state || n.session?.result || n.result_preview || ""].join("\u0000") : "";
};

/** A step's words with its routing JSON taken out: `{"reproduced": true}` is for the line, not for a person. */
const prose = (text: string) => text.replace(/```json[ \t]*\n[\s\S]*?\n[ \t]*```/g, "").replace(/^\s*\{[\s\S]*\}\s*$/, "").trim();

/** A run that finished a step with a report and had nowhere to take it: the yes it waits on in one line, the step's last
 *  message whole, the findings the problem holds (how many came after the step finished), and the acts a person has: go
 *  on (a new run, reviewed and priced), Not a problem, and what the step advised: waiting, or a review by someone before
 *  it is built. A step that rests its advice on one case while the problem holds more is said to, and proving again on
 *  all of them takes waiting's place. */
function Stopped({ need, onProblem, onRun, runShown, head, asked, evidence }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: RunOpener; runShown: string | null; head: boolean; asked: boolean; evidence: boolean }) {
  const step = useInboxStore((s) => stoppedStep((s as unknown as { workflowRuns?: Record<string, RunRow> }).workflowRuns, need.runId, need.fail?.step));
  const [label, session, own] = step.split("\u0000");
  const body = (text: string) => <StoppedView need={need} onProblem={onProblem} onRun={onRun} runShown={runShown} asked={asked} evidence={evidence} label={label} own={own ?? ""} text={text} />;
  return session ? <LastText sessionId={session}>{body}</LastText> : body("");
}

function StoppedView({ need, onProblem, onRun, runShown, asked, evidence, label, own, text }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: RunOpener; runShown: string | null; asked: boolean; evidence: boolean; label: string; own: string; text: string }) {
  const stopped = stoppedAsk(need.fail);
  const fallback = prose(own) || stopped?.said || need.ask;
  // The step's advice: its routing JSON's, else its own closing words (a run from before prove.md asked for `next`).
  const ask = useMemo(() => (stopped && !stopped.advice ? { ...stopped, advice: proseAdvice(text || fallback) } : stopped), [stopped?.line, stopped?.advice, text, fallback]); // eslint-disable-line react-hooks/exhaustive-deps -- stoppedAsk is pure over need.fail
  const named = label || ask?.step || (need.fail?.step ? stepLabel({ id: need.fail.step }) : "");
  // "Still one case" over a problem that holds more: the advice rests on a count the findings contradict. Counted as the
  // findings list counts them (empty ones and repeats are not findings).
  useSyncTaskSignals(need.caseId);
  const where = useMemo(() => (x: ReaderSignal) => !!need.caseId && x.task_id === need.caseId, [need.caseId]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: evidenceSig });
  const held = Math.max(need.findings ?? 0, useMemo(() => listedFindings(rows).rows.length, [rows]));
  const reprove = ask?.advice?.act === "wait" && oneCaseClaim(ask.advice.why ?? text) && held > 1 ? held : null;
  return (
    <>
      <div className="lwn-thing lwn-scroll">
        <div className="lwn-col">
          <NeedHead need={need} onProblem={onProblem} />
          {/* Where the host's own state line already asks it (a problem's band, a run's head), it is not said twice. */}
          {/* What the step advised is a tag on that line, so the choice it shapes is read before its words. */}
          {ask && (!asked || ask.advice) && (
            <p className="lwn-ask" data-line-need-ask>
              {!asked && ask.line}
              {ask.advice && <span className="lwn-advice" data-act={ask.advice.act} data-line-need-advice={ask.advice.act} title={ask.advice.why ?? undefined}>{ask.step} recommends: {adviceWord(ask.advice)}{ask.advice.by ? ` by ${ask.advice.by}` : ""}</span>}
            </p>
          )}
          {reprove && (
            <p className="lwn-contra" data-line-need-one-case={reprove}>
              {ask!.step} read one case; the problem holds <b className="lw-num">{reprove}</b> findings
            </p>
          )}
          <section className="lwn-stopped" data-line-need-said data-line-need-last={text ? "" : undefined}>
            <FoldedNote who={named || "The step"} at={need.since} text={text || fallback} />
            {need.runId && need.runId !== runShown && <button type="button" className="lwn-link" onClick={() => onRun(need.runId!, need.caseId)}>Open the run</button>}
          </section>
          {evidence && need.caseId && <Evidence caseId={need.caseId} count={held} title={need.title} after={need.since ? { at: need.since, words: `since ${ask?.step ?? "the step"} finished` } : undefined} />}
        </div>
      </div>
      <NewAsk need={need} facts={need.since ? [{ k: "Finished", v: dateWords(need.since) }] : []} drop yes={ask} said={own || fallback} reprove={reprove}
        extra={need.caseId ? <CitedLive caseId={need.caseId} projectId={need.projectId ?? null} /> : null} />
    </>
  );
}

/** A session's last message, whole, as it wrote it, handed to `children` ("" until the messages arrive). */
function LastText({ sessionId, children }: { sessionId: string; children: (text: string) => ReactNode }) {
  const { conversation } = useConversationMessages(sessionId);
  const text = useMemo(() => lastWord((conversation?.messages ?? []) as unknown as TraceMessage[]).text, [conversation?.messages]);
  return <>{children(text ?? "")}</>;
}

/** Markdown as one line of plain words: what a folded note's row shows. */
const oneLine = (md: string) => md.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[#*_`>|]+/g, "").replace(/\s+/g, " ").trim();

/** An agent's note under a need, folded like a finding: who said it, when, and its words on one line; open, the note
 *  in full as it was written. A step's report can run to pages, so it never opens by itself. */
function FoldedNote({ who, at, text }: { who: string; at?: number | null; text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <ul className="lwn-findings lwn-note">
      <li className="fr" data-open={open ? "" : undefined} data-line-need-note-open={open ? "" : undefined}>
        <button type="button" className="fr-row" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="lw-chev" aria-hidden />
          <span className="fr-who">{who}</span>
          <span className="fr-at">{at ? dateWords(at) : ""}</span>
          {/* Open, the note below is the words: the row keeps only who and when. */}
          <span className="fr-words">{open ? "" : oneLine(text)}</span>
        </button>
        {open && <div className="fr-open"><div className="lwn-said lwn-md"><MarkdownRenderer content={text} /></div></div>}
      </li>
    </ul>
  );
}

const citedSig = (s: ReaderSignal) => `${s._id}|${(s.detail_md ?? "").length}|${s.title?.length ?? 0}`;

/** A change the problem's findings say is not in production yet (fixedOnMain undeployedCited), as it stands now:
 *  in production since the deploy that carried it, or still not deployed. A finding written before a deploy reads
 *  stale after it, and whether the moment has passed decides the answer. */
function CitedLive({ caseId, projectId }: { caseId: string; projectId: string | null }) {
  useSyncTaskSignals(caseId);
  const where = useMemo(() => (s: ReaderSignal) => s.task_id === caseId, [caseId]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: citedSig });
  const cited = useMemo(() => undeployedCited(rows), [rows]);
  const live = useCommitLive(projectId, cited?.sha ?? null);
  if (!cited) return null;
  const name = cited.pr ?? cited.sha.slice(0, 7);
  const words = !live ? "Reading production" : live.first ? `In production since ${dateWords(live.first.at)}` : live.repository ? `Not deployed${live.newest ? `, newest deploy ${dateWords(live.newest.at)}` : ""}` : "Not readable here";
  return (
    <div data-line-need-cited={live?.first ? "live" : live?.repository ? "not-live" : "reading"} data-tone={live?.first ? "warn" : live?.repository ? "ok" : undefined} title={`${cited.sha}: a finding says it is not in production`}>
      <dt>{name}</dt>
      <dd>{words}</dd>
    </div>
  );
}

type GateRun = { node_statuses?: Array<{ node_id: string; status: string }> };
/** The run's steps as "id:status" pairs: what its gates read (fixReview reviewGates). */
const gateSig = (rows: Record<string, GateRun> | undefined, runId: string | null) =>
  (runId ? rows?.[runId]?.node_statuses ?? [] : []).map((n) => `${n.node_id}:${n.status}`).join(" ");

/** A built fix's review read from facts (its branch, its gates on the last build, where it stands against main) and
 *  the one act that moves it on: the same for the reader below and for a step page's closed row (ReviewSummary). */
function useReviewFacts(need: LineNeed) {
  const named = useRunBranch(need.runId, need.caseId);
  const fb = useFixBranch(need.projectId, named, need.runId);
  const found = fb?.repository ? fb : null;
  // The branch the run itself built on, once the server has read it; until then what the run's words name.
  const branch = fb?.branch || named;
  const standing = branchStanding(found);
  const change = found ? { files: found.files.length, added: found.additions, removed: found.deletions, pr: null } : null;
  const sig = useInboxStore((s) => gateSig((s as unknown as { workflowRuns?: Record<string, GateRun> }).workflowRuns, need.runId));
  const gates = useMemo(() => reviewGates(sig ? sig.split(" ").map((x) => { const i = x.lastIndexOf(":"); return { node_id: x.slice(0, i), status: x.slice(i + 1) }; }) : [], { step: need.fail?.check?.step ?? null, words: need.fail?.review?.gate ?? null }), [sig, need.fail]);
  const checks = found && found.checks.state !== "none" && found.checks.state !== "unknown" ? found.checks : null;
  const unlanded = need.kind === "unlanded";
  const move = unlanded ? null : reviewMove(gates, standing);
  const viewer = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const approver = unlanded ? (need.approvedBy && need.approvedBy === viewer ? "You" : need.approvedBy ? "Someone else" : null) : null;
  const approved = unlanded ? [approver, need.aliases[0], need.since ? dateWords(need.since) : null].filter(Boolean).join(" · ") || "Yes" : null;
  const problem = `${need.problemRef ? `${need.problemRef} · ` : ""}${problemListName(need)}`;
  return { fb, found, branch, standing, change, gates, checks, unlanded, move, approved, problem };
}
type ReviewFacts = ReturnType<typeof useReviewFacts>;

/** The act that moves a built fix on, from its facts. */
function ReviewAct({ need, f }: { need: LineNeed; f: ReviewFacts }) {
  const { fb, found, branch, standing, change, move, approved, problem, unlanded } = f;
  // Named for what the press does (fixActName: merge, or open its pull request), never for an approval it may not be.
  const land = need.caseId && <MergeFixAct taskId={need.caseId} problem={problem} change={change} approved={approved} standing={standing} primary={!move || move.act === "approve"} />;
  // Read, and on GitHub nowhere: there is nothing to open a pull request on, so the act is a new run that builds it again.
  if (fb && !found && need.caseId) return <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={problem} label="Rebuild the branch" primary />;
  // Refused for being behind: the line's own Rebase step puts it on the default branch, checks it, and ships it.
  if (need.behind && need.runId) return <LandAgain runId={need.runId} ledger={rebaseLandLedger({ problem, branch, base: need.behind, approved: approved ?? "Yes", change })} />;
  // A red gate: back to its builder is the only act until it is green (nothing lands a fix its own checks failed). A
  // branch main has moved under: rebuilding on main first, landing it anyway second.
  if (move && move.act !== "approve" && need.caseId && need.problemRef) {
    return <>
      {move.act === "rebuild" && land}
      <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={problem} label={move.act === "rebuild" ? "Rebuild on main" : "Send back to Implement"} branch primary sendBack={{ act: move.act, why: move.why }}
        before={() => void useInboxStore.getState().addTaskComment(need.problemRef!, sendBackNote(move, standing?.base ?? found?.base ?? null), "review")} />
    </>;
  }
  return <>{land}</>;
}

/** A built fix waiting on review, in one line for a list's closed row: the gate it left red, how far main has moved
 *  under it, and its act. The reader (WaitingItem) is the whole of it. */
export function ReviewSummary({ need }: { need: LineNeed }) {
  const f = useReviewFacts(need);
  const red = f.gates.find((g) => g.state === "red" || g.state === "changes");
  return (
    <span className="lwn-sum" data-line-review-summary="">
      <span className="lwn-sum-facts">
        {red ? <span className="lwn-sum-fact" data-tone="bad" data-line-review-red={red.step}>Left red: {red.name}{red.state === "changes" ? " asked for changes" : ""}</span>
          : f.gates.length > 0 && <span className="lwn-sum-fact" data-tone="ok">Gates green</span>}
        {f.standing && f.standing.behind > 0 && <span className="lwn-sum-fact" data-tone={f.standing.conflicts ? "warn" : undefined} data-line-review-behind={f.standing.behind}>{f.standing.behind} behind {f.standing.base}{f.standing.conflicts ? `, ${f.standing.onBoth} ${f.standing.onBoth === 1 ? "file" : "files"} on both` : ""}</span>}
        {f.fb && !f.found && <span className="lwn-sum-fact" data-tone="warn">Branch not on GitHub</span>}
      </span>
      <span className="lwn-sum-act"><ReviewAct need={need} f={f} /></span>
    </span>
  );
}

/** A built fix waiting on review, or approved and not merged: the decision its run's session presented it as, whole and
 *  first, as that session wrote it (an approved one reads with its answer on record). A fix no session has presented is
 *  the NotPresented line. While the decision waits, answering it is the only act here. The build's plumbing (its branch,
 *  a refused landing, back to its builder, rebase and land) is the run's: on the run's own page the dock carries it,
 *  everywhere else one "Open the run" leads there. */
function Review({ need, onProblem, onRun, head, inline, runShown }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: RunOpener; head: boolean; inline: boolean; runShown: string | null }) {
  const presented = useInboxStore((s) => {
    const d = runFixDecision(s.sessionDecisions as never, (s as unknown as { lineCards?: never }).lineCards, need.caseId, need.runId);
    return d ? `${decisionRef(d)}\u0000${(d as { status?: string }).status ?? ""}` : "";
  });
  const [ref, status] = presented ? presented.split("\u0000") : [null, null];
  const onRunPage = !!need.runId && need.runId === runShown;
  return (
    <>
      <div className="lwn-thing" data-line-need-review={ref ? "decision" : "not-presented"}>
        {ref ? <LineDecision key={ref} id={ref} onProblem={onProblem} onRun={onRun} head={head} inline={inline} act={false} /> : (
          <div className="lwn-scroll">
            <div className="lwn-col">
              {head && <NeedHead need={need} onProblem={onProblem} />}
              <NotPresented need={need} onRun={onRun} runShown={runShown} />
            </div>
          </div>
        )}
      </div>
      {onRunPage ? <ReviewDock need={need} /> : ref && status !== "pending" && need.runId && (
        <footer className="lwn-dock" data-line-need-dock>
          <button type="button" className="lw-act" onClick={() => onRun(need.runId!, need.caseId)} data-line-need-run>Open the run</button>
        </footer>
      )}
    </>
  );
}

/** The build's plumbing under a built fix, on its run's page: its branch, where landing stands, and the act its facts call for. */
function ReviewDock({ need }: { need: LineNeed }) {
  const f = useReviewFacts(need);
  const { branch, unlanded, approved } = f;
  return (
    <footer className="lwn-dock" data-line-need-dock>
      <dl className="lwn-facts">
        {branch && <div><dt>Branch</dt><dd><BranchName name={branch} /></dd></div>}
        {unlanded ? <>
          <div data-line-need-approved=""><dt>Approved</dt><dd>{approved}</dd></div>
          {need.behind && <div data-tone="warn" data-line-need-landing="behind"><dt>Landing</dt><dd>Refused: branch behind {need.behind}</dd></div>}
          {need.since && <div data-tone={Date.now() - need.since > 86_400_000 ? "warn" : undefined}><dt>Waiting</dt><dd>{ageShort(Math.max(0, Date.now() - need.since))}, not merged</dd></div>}
        </> : need.since && <div><dt>Handed off</dt><dd>{dateWords(need.since)}</dd></div>}
      </dl>
      <ReviewAct need={need} f={f} />
    </footer>
  );
}

/** A problem whose run found main already carries the fix: the commit, the run's note, and closing it as fixed. */
function Fixed({ need, onProblem, onRun, evidence }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: (runId: string, taskId: string | null) => void; evidence: boolean }) {
  const ref = need.problemRef;
  const done = useInboxStore((s) => !!need.caseId && (s.tasks as Record<string, { status?: string }>)[need.caseId]?.status === "done");
  const sha = need.sha ?? "";
  // The note past its "Already fixed on main by <sha>", which the facts say.
  const note = fixedNoteRest(need.note);
  return (
    <>
      <div className="lwn-thing lwn-scroll">
        <div className="lwn-col">
          <NeedHead need={need} onProblem={onProblem} />
          {note && <div data-line-need-fixed-note><FoldedNote who="The run" at={need.since} text={note} /></div>}
          {need.runId && <button type="button" className="lwn-link" onClick={() => onRun(need.runId!, need.caseId)}>Open the run</button>}
          {evidence && need.caseId && <Evidence caseId={need.caseId} count={need.findings ?? 0} title={need.title} />}
        </div>
      </div>
      <footer className="lwn-dock" data-line-need-dock>
        <FixedFacts need={need} sha={sha} />
        {done ? <span className="lw-oc" data-tone="ok">Closed</span> : ref && need.caseId && <CloseAsFixed taskRef={ref} sha={sha} projectId={need.projectId ?? null} taskId={need.caseId} />}
      </footer>
    </>
  );
}

const deploySig = (d: DeployFact & { _id: string; status?: string }) => `${d.at}|${d.sha ?? ""}|${d.status ?? ""}`;
const liveOnly = (d: { status?: string }) => wentLive(d);

/** What a person checks before closing a problem as fixed on main: the commit, how its CI went (read live from GitHub,
 *  lineFixChecks, the same read as the problem's band), and whether a recorded deploy carried it. */
function FixedFacts({ need, sha }: { need: LineNeed; sha: string }) {
  const ci = useFixCommitChecks(need.projectId ?? null, sha || null, useProblemCiRun(need.caseId));
  const repository = ci?.repository ?? null;
  // Deploys a workspace source reported name their commit; the fix's own deploy is found by its sha.
  const deploys = useCollectionRows<DeployFact & { _id: string; status?: string }>("lineDeploys", { where: liveOnly, sig: deploySig });
  const own = useMemo(() => (sha ? deployOfCommit(sha, deploys) : null), [sha, deploys]);
  const newest = useMemo(() => (own ? null : newestDeploy(deploys)), [own, deploys]);
  // No deploy named the commit: whether the newest deploy carries it is a question of ancestry, asked of the repository.
  const later = useRepoCompare(newest && repository ? repository : undefined, sha || undefined, newest?.sha ?? undefined);
  const carried = later.data ? later.data.status === "ahead" || later.data.status === "identical" : null;
  const short = sha.slice(0, 7);
  return (
    <dl className="lwn-facts">
      {/* The commit on GitHub: the app's own commit page knows only commits it ingested, and a run's fix often is not one. */}
      <div><dt>Fixed on main</dt><dd>{ci?.url ? <a className="lw-link" href={ci.url} target="_blank" rel="noreferrer" data-line-need-fixed-commit><code>{short}</code></a> : <code>{short}</code>}</dd></div>
      {fixCiFacts(ci, failingTestOf(need.title)).map((f) => (
        <div key={f.key} data-line-need-ci={f.key === "ci" ? ci?.state ?? "reading" : f.key} data-tone={f.tone}>
          <dt>{f.k}</dt>
          <dd>{f.url && ci?.state !== "unknown" ? <a className="lw-link" href={f.url} target="_blank" rel="noreferrer">{f.v}</a> : f.v}</dd>
        </div>
      ))}
      {own ? (
        <div data-line-need-live="deployed" data-tone="ok"><dt>Deployed</dt><dd>{own.url ? <a className="lw-link" href={own.url} target="_blank" rel="noreferrer">{dateWords(own.at)}</a> : dateWords(own.at)}</dd></div>
      ) : newest && carried !== null ? (
        <div data-line-need-live={carried ? "carried" : "not"} data-tone={carried ? "ok" : "warn"}><dt>Deployed</dt><dd>{carried ? `In ${newest.sha!.slice(0, 7)}, ${dateWords(newest.at)}` : `Not yet: last deploy ${newest.sha!.slice(0, 7)}, ${dateWords(newest.at)}`}</dd></div>
      ) : null}
      {need.since && <div><dt>Checked</dt><dd>{dateWords(need.since)}</dd></div>}
    </dl>
  );
}

/** A problem assigned to the viewer: the line never starts a problem a person holds, so it is theirs to work, to hand
 *  back to the line (unassigned, the sweep can start it), or to close. A problem about a named service's failure says,
 *  from the product's own error log, whether it is still failing: the one fact that decides whether to close it. */
function Assigned({ need, onProblem, evidence }: { need: LineNeed; onProblem: (taskId: string) => void; evidence: boolean }) {
  const ref = need.problemRef;
  const groups = useOpsGroups();
  const failing = useMemo(() => sameFailures(need.title, groups), [need.title, groups]);
  const state = useInboxStore((s) => { const t = need.caseId ? (s.tasks as Record<string, { status?: string; assignee?: string | null }>)[need.caseId] : null; return t?.status === "done" ? "closed" : t && !t.assignee ? "handed" : "mine"; });
  return (
    <>
      <div className="lwn-thing lwn-scroll">
        <div className="lwn-col">
          <NeedHead need={need} onProblem={onProblem} />
          {need.note && <div data-line-need-note><FoldedNote who="Note" at={need.since} text={need.note} /></div>}
          {evidence && need.caseId && <Evidence caseId={need.caseId} count={need.findings ?? 0} title={need.title} />}
        </div>
      </div>
      <footer className="lwn-dock" data-line-need-dock>
        <dl className="lwn-facts">
          <div><dt>Assigned to</dt><dd>You</dd></div>
          {need.since && <div><dt>Since</dt><dd>{dateWords(need.since)}</dd></div>}
          {failing && (
            // Within the hour reads as still failing; past it, as the last time it did.
            <div data-line-need-failing={Date.now() - failing.last < 3_600_000 ? "now" : "quiet"}>
              <dt>{failing.name} errors</dt>
              <dd>{Date.now() - failing.last < 3_600_000 ? "Still failing" : `None for ${ageShort(Date.now() - failing.last)}`}, last {dateWords(failing.last)} · {failing.refs.map((r, i) => <span key={r}>{i ? " " : ""}<Link className="lw-link" href={opsHref.issue(r)}>{r}</Link></span>)} ×{failing.count}</dd>
            </div>
          )}
        </dl>
        {state === "closed" ? <span className="lw-oc" data-tone="ok">Closed</span> : state === "handed" ? <span className="lw-oc" data-tone="none">With the line</span> : ref && (
          <>
            <button type="button" className="lw-act" title="Unassign it: the line can start it" data-line-need-hand-back onClick={() => void useInboxStore.getState().updateTask(ref, { assignee: null as unknown as string })}>Hand to the line</button>
            <button type="button" className="lw-act" data-primary="" data-line-need-close onClick={() => void useInboxStore.getState().updateTaskStatus(ref, "done")}>Close</button>
          </>
        )}
      </footer>
    </>
  );
}

/** The dock under a need no answer can reach: its facts, and the one act, a new run, through its review (StartRunAct).
 *  For a step that stopped with nowhere to go (`yes`), that run is the yes: a run cannot pick up where another stopped,
 *  so going on is a new run that redoes the steps up to it, said on the button and in its review. */
function NewAsk({ need, facts, branch, drop, acts, yes, said, extra, reprove }: { need: LineNeed; facts: Array<{ k: string; v: string }>; branch?: boolean; drop?: boolean; acts?: ReactNode; yes?: StoppedAsk | null; /** The stopped step's own words: what it says about its proof. */ said?: string; /** More facts, drawn after these. */ extra?: ReactNode;
  /** The findings the problem holds when the step's advice rested on one case: proving again on all of them takes waiting's place. */ reprove?: number | null }) {
  const category = useInboxStore((s) => (need.caseId ? (s.tasks as Record<string, { category?: string }>)[need.caseId]?.category ?? null : null));
  const [answered, setSaid] = useState<"dropped" | "waits" | null>(null);
  // The step's own advice picks the lead: going on leads where it said go on; where it said wait, waiting does; where
  // it asked for a review, or said nothing, no answer leads and its words decide.
  const advice = yes?.advice?.act ?? null;
  const next = yes?.next ? ` to ${yes.next}` : "";
  const goWords = advice === "review" ? `Reviewed: go on${next}` : advice === "wait" ? `Go on${next} anyway` : `Go on${next}`;
  const problem = `${need.problemRef ? `${need.problemRef} · ` : ""}${problemListName(need)}`;
  const run = need.caseId && (yes
    ? <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={problem} label={`${goWords} (new run)`} branch={branch} primary={advice === "go"} goOn={{ step: yes.step, next: yes.next, ...goOnProof(category, said) }} />
    : <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={problem} label="Start a new run to ask again" branch={branch} primary />);
  return (
    <footer className="lwn-dock" data-line-need-dock>
      <dl className="lwn-facts">
        {facts.map((f) => <div key={f.k}><dt>{f.k}</dt><dd>{f.v}</dd></div>)}
        {extra}
        {answered === "waits" && <div data-line-need-wait-recorded><dt>Asks again</dt><dd>When its findings double</dd></div>}
      </dl>
      {acts !== undefined ? acts : answered === "dropped" ? <span className="lw-oc" data-tone="none">closed</span> : answered === "waits" ? <span className="lw-oc" data-tone="none">Waiting for more findings</span> : (
        <>
          {/* A review the step asked for before the build: handed to the person who gives it. */}
          {yes && advice === "review" && need.problemRef && <HandToReviewer need={need} yes={yes} />}
          {/* "Still one case" over a problem with more: proving again on all of them, not waiting for what already came. */}
          {yes && reprove && need.caseId && <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={problem} label={`${yes.step} again on all ${reprove}`} primary reprove={{ step: yes.step, findings: reprove }}
            before={() => void useInboxStore.getState().addTaskComment(need.problemRef!, `${yes.step} again on all ${reprove} findings: the last ${yes.step} read one case while the problem held ${reprove}. Weigh every finding on it before advising.`, "review")} />}
          {/* Waiting is always an answer to a finished step, unless the step itself said go on; it leads only where the step advised it. */}
          {yes && advice !== "go" && !reprove && need.problemRef && <button type="button" className="lw-act" data-primary={advice === "wait" ? "" : undefined} title="Park it: grounding asks again when its findings double" onClick={() => { answerProblem(need.problemRef!, "waits", waitNote(yes)); setSaid("waits"); }} data-line-need-wait>Wait for more findings</button>}
          {drop && need.problemRef && <button type="button" className="lw-act" onClick={() => { answerProblem(need.problemRef!, "dropped"); setSaid("dropped"); }} data-line-need-drop>Not a problem</button>}
          {run}
        </>
      )}
    </footer>
  );
}

/** A review the step asked for before the fix is built ("needs an engineer's safety review before it's built"), handed
 *  to the person who gives it: the problem is assigned to them (the line never starts a problem a person holds, and it
 *  waits in their For you as assigned) and the step's reason is left on it. Pick a teammate; one press each, undone by
 *  handing it back to the line. */
function HandToReviewer({ need, yes }: { need: LineNeed; yes: StoppedAsk }) {
  const sig = useInboxStore((s) => ((s.teamMembers ?? []) as Array<{ _id: string; name?: string; is_bot?: boolean }>).filter((m) => !m.is_bot && m.name).map((m) => `${m._id}\u0001${m.name}`).join("\u0000"));
  const people = useMemo(() => [...new Map(sig.split("\u0000").filter(Boolean).map((x) => { const [id, name] = x.split("\u0001"); return [name, { id, name }] as const; })).values()], [sig]);
  const viewer = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const holder = useInboxStore((s) => (need.caseId ? (s.tasks as Record<string, { assignee?: string | null }>)[need.caseId]?.assignee ?? null : null));
  const [open, setOpen] = useState(false);
  const by = yes.advice?.by ?? null;
  if (holder) {
    const name = holder === viewer ? "You" : people.find((p) => p.id === holder)?.name ?? "Someone";
    return <span className="lw-oc" data-tone="none" data-line-need-reviewer={holder}>With {name} to review</span>;
  }
  const hand = (p: { id: string; name: string }) => {
    setOpen(false);
    const st = useInboxStore.getState();
    void st.addTaskComment(need.problemRef!, `Review before ${yes.next ?? "the next step"}, handed to ${p.name}: ${yes.advice?.why ?? `${yes.step} asked for a review`}`, "review");
    void st.updateTask(need.problemRef!, { assignee: p.id } as never);
  };
  return (
    <span className="lwn-pick-wrap">
      <button type="button" className="lw-act" data-primary="" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-line-need-hand-review>Hand to a reviewer…</button>
      {open && (
        <div className="lwn-pick" role="menu" aria-label="Who reviews it">
          {[...people].sort((a, b) => Number(b.name === by) - Number(a.name === by)).map((p) => (
            <button key={p.id} type="button" role="menuitem" className="lwn-pick-row" onClick={() => hand(p)} data-line-need-reviewer-pick={p.name}>
              {p.id === viewer ? `${p.name} (you)` : p.name}{p.name === by && <span className="lwn-h-note"> named by {yes.step}</span>}
            </button>
          ))}
          {people.length === 0 && <span className="lwn-h-note">No teammates here</span>}
        </div>
      )}
    </span>
  );
}
