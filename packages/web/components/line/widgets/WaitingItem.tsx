"use client";
// The one reader for something that waits on a person (line-journeys.md
// LJ6.2). Wherever a waiting thing is named (For you, a problem's band, a
// run's person step, a step's waiting rows) this is what shows it, so the
// thing is read and answered where it is named:
//   decision          the session's decision, whole (LineDecision), answered on it
//   question, confirm the question in full, the findings it rests on, the answer box; a twin folded in (the line
//                     reads it as the same problem under another id) is named under it with Merge into
//   duplicate         a twin whose older problem asks nothing: which one it is the same as, both's findings, Merge into
//   reask             the paused run's proposal and the one act that has its agent ask again
//   lapsed            the decision nobody answered, read only, and its answers: Drop now, or a new run to ask again
//   stopped           the yes it waits on in one line, the step's last message whole, Yes (recorded for the next run) or a new run
//   review            a build handed off for review: what the review needs in the builder's words, the gate it left red,
//                     its branch, and Open its pull request (Ship, through its review)
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
import { adviceWord, stoppedAsk, waitNote, type LineNeed, type StoppedAsk } from "../../../lib/line/lineNeeds";
import { findingLeads } from "../../../lib/line/problemPage";
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
import { TrialCardPanel } from "../workspace/views/TrialCardPanel";
import { FindingPlaceholder, FindingReader, useFinderName, type ReaderSignal } from "./FindingReader";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { mergeProblemLedger } from "../../../lib/line/findingLedger";
import { LineDecision } from "./LineDecision";
import { useLineNav } from "./parts";
import { StartRunAct } from "./StartRunAct";
import { BranchName, ClosedDecisionDock, useRunBranch } from "./ClosedDecisionActs";
import { MergeFixAct } from "../workspace/views/problem/MergeFixAct";
import { useRepoCompare } from "../../../hooks/useRepoBrowse";
import { useFixCommitChecks, useProblemCiRun } from "../../../hooks/useFixCommitChecks";
import { deployOfCommit, failingTestOf, fixCiFacts, fixedNoteRest, newestDeploy, type DeployFact } from "../../../lib/line/fixedOnMain";
import "./waitingItem.css";

export type WaitingItemProps = {
  need: LineNeed;
  /** List the findings the need rests on. Off where they are already on the page (a problem's Findings, just below its band). */
  evidence?: boolean;
  /** Open the need's problem, and its run: the host's own navigation (For you sets the need's process). Default: the line's nav. */
  onProblem?: (taskId: string) => void;
  onRun?: (runId: string, taskId: string | null) => void;
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

export function WaitingItem({ need, evidence = true, onProblem, onRun, head = true, asked = !head, inline = false, act = true, runShown = null, now = Date.now() }: WaitingItemProps) {
  const nav = useLineNav();
  const toProblem = onProblem ?? ((id: string) => nav?.openCase?.(id));
  const toRun = onRun ?? ((runId: string, taskId: string | null) => nav?.openRun(runId, taskId));
  const body = need.kind === "decision" && need.decisionRef ? (
    <LineDecision key={need.decisionRef} id={need.decisionRef} onProblem={toProblem} onRun={toRun} head={head} inline={inline} act={act} />
  ) : need.kind === "reask" ? (
    <Reask need={need} now={now} onProblem={toProblem} onRun={toRun} />
  ) : need.kind === "lapsed" ? (
    <Lapsed need={need} onProblem={toProblem} onRun={toRun} head={head} inline={inline} />
  ) : need.kind === "stopped" ? (
    <Stopped need={need} onProblem={toProblem} onRun={toRun} runShown={runShown} head={head} asked={asked} />
  ) : need.kind === "review" ? (
    <Review need={need} onProblem={toProblem} onRun={toRun} head={head} evidence={evidence} />
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
          {older?.title && <p className="ask-open"><span>{dupOf.ref}</span>{older.title}</p>}
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
function MergeAct({ twin, into, findings, twinProjectId, intoProjectId, primary }: { twin: string; into: string; findings: number | null; twinProjectId: string | null; intoProjectId: string | null; primary?: boolean }) {
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

/** The findings a need rests on, each opened in place (FindingReader), the newest open on arrival. */
function Evidence({ caseId, also, count, title }: { caseId: string; /** Twins folded in: their findings are this need's too. */ also?: ReadonlyArray<string>; count: number; title: string }) {
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
  // The newest is open until the person opens or shuts one; three frames at most, the oldest folding back.
  const [opened, setOpened] = useState<string[] | null>(null);
  const open = opened ?? (listed.rows[0] ? [listed.rows[0].signal._id] : []);
  const toggle = (id: string) => setOpened(open.includes(id) ? open.filter((x) => x !== id) : [...open, id].slice(-3));
  const waiting = !ready && sorted.length < count;
  const feeds = also?.map((id) => <TwinFeed key={id} caseId={id} />);
  if (!listed.rows.length && !waiting) return <>{feeds}</>;
  const shown = waiting ? Math.max(listed.rows.length, count) : listed.rows.length;
  return (
    <>{feeds}
    <section className="lwn-evidence" data-line-need-evidence={listed.rows.length}>
      <h3 className="lwn-h">Findings <span className="lw-num">{shown}</span>{!waiting && listed.empty > 0 && <span className="lwn-h-note" data-line-need-empty={listed.empty}>{listed.empty} empty left out</span>}</h3>
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

/** A paused run nobody can answer yet: its proposal, read whole, and the one act that has its agent present it again. */
function Reask({ need, now, onProblem, onRun }: { need: LineNeed; now: number; onProblem: (taskId: string) => void; onRun: (runId: string, taskId: string | null) => void }) {
  const cards = useTrialCards();
  const card = need.cardRef ? cards.find((c) => c.short_id === need.cardRef) ?? null : null;
  if (!card) return <div className="lwn-scroll"><div className="lwn-col"><NeedHead need={need} onProblem={onProblem} /><p className="lwn-said">{need.ask}</p></div></div>;
  return <TrialCardPanel card={card} now={now} onProblem={() => onProblem(card.task_id)} onRun={() => onRun(card.run_id, card.task_id)} />;
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
 *  message whole, and the acts a person has: go on (a new run, reviewed and priced), Not a problem, and waiting where
 *  the step advised it. */
function Stopped({ need, onProblem, onRun, runShown, head, asked }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: (runId: string, taskId: string | null) => void; runShown: string | null; head: boolean; asked: boolean }) {
  const step = useInboxStore((s) => stoppedStep((s as unknown as { workflowRuns?: Record<string, RunRow> }).workflowRuns, need.runId, need.fail?.step));
  const [label, session, own] = step.split("\u0000");
  const ask = stoppedAsk(need.fail);
  const fallback = prose(own ?? "") || ask?.said || need.ask;
  const named = label || ask?.step || (need.fail?.step ? stepLabel({ id: need.fail.step }) : "");
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
          <section className="lwn-stopped" data-line-need-said>
            <h3 className="lwn-h">{named ? `${named} said` : "The step said"}</h3>
            {session ? <LastMessage sessionId={session} fallback={fallback} /> : <p className="lwn-said">{fallback}</p>}
            {need.runId && need.runId !== runShown && <button type="button" className="lwn-link" onClick={() => onRun(need.runId!, need.caseId)}>Open the run</button>}
          </section>
        </div>
      </div>
      <NewAsk need={need} facts={need.since ? [{ k: "Finished", v: dateWords(need.since) }] : []} drop yes={ask} />
    </>
  );
}

/** A problem whose run found main already carries the fix: the commit, the run's note, and closing it as fixed. */
/** A build handed off for review: what the review needs, in the builder's own words, whole; the gate it left red; and
 *  the review itself, its pull request opened (or shipped) through the merge review. Nothing lands until that confirm. */
function Review({ need, onProblem, onRun, head, evidence }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: (runId: string, taskId: string | null) => void; head: boolean; evidence: boolean }) {
  const branch = useRunBranch(need.runId, need.caseId);
  const said = need.fail?.review?.ask ?? null;
  const gate = need.fail?.review?.gate ?? null;
  const step = need.fail?.step ? stepLabel({ id: need.fail.step }) : null;
  return (
    <>
      <div className="lwn-thing lwn-scroll">
        <div className="lwn-col">
          {head && <NeedHead need={need} onProblem={onProblem} />}
          {said && <p className="lwn-said" data-line-need-review-ask>{said}</p>}
          {need.runId && <button type="button" className="lwn-link" onClick={() => onRun(need.runId!, need.caseId)}>Open the run</button>}
          {evidence && need.caseId && <Evidence caseId={need.caseId} count={need.findings ?? 0} title={need.title} />}
        </div>
      </div>
      <footer className="lwn-dock" data-line-need-dock>
        <dl className="lwn-facts">
          {step && <div><dt>Built at</dt><dd>{step}</dd></div>}
          {gate && <div data-tone="warn"><dt>Left red</dt><dd>{gate}</dd></div>}
          {branch && <div><dt>Branch</dt><dd><BranchName name={branch} /></dd></div>}
          {need.since && <div><dt>Handed off</dt><dd>{dateWords(need.since)}</dd></div>}
        </dl>
        {need.caseId && <MergeFixAct taskId={need.caseId} problem={`${need.problemRef ? `${need.problemRef} · ` : ""}${problemListName(need)}`} change={null} approved={null} />}
      </footer>
    </>
  );
}

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
          {note && <p className="lwn-said" data-line-need-fixed-note>{note}</p>}
          {need.runId && <button type="button" className="lwn-link" onClick={() => onRun(need.runId!, need.caseId)}>Open the run</button>}
          {evidence && need.caseId && <Evidence caseId={need.caseId} count={need.findings ?? 0} title={need.title} />}
        </div>
      </div>
      <footer className="lwn-dock" data-line-need-dock>
        <FixedFacts need={need} sha={sha} />
        {done ? <span className="lw-oc" data-tone="ok">Closed</span> : ref && (
          <button type="button" className="lw-act" data-primary="" title={`Close it as fixed by ${sha.slice(0, 7)}`} data-line-need-close-fixed
            onClick={() => void useInboxStore.getState().updateTaskStatus(ref, "done")}>Close as fixed</button>
        )}
      </footer>
    </>
  );
}

const deploySig = (d: DeployFact & { _id: string }) => `${d.at}|${d.sha ?? ""}`;

/** What a person checks before closing a problem as fixed on main: the commit, how its CI went (read live from GitHub,
 *  lineFixChecks, the same read as the problem's band), and whether a recorded deploy carried it. */
function FixedFacts({ need, sha }: { need: LineNeed; sha: string }) {
  const ci = useFixCommitChecks(need.projectId ?? null, sha || null, useProblemCiRun(need.caseId));
  const repository = ci?.repository ?? null;
  // Deploys a workspace source reported name their commit; the fix's own deploy is found by its sha.
  const deploys = useCollectionRows<DeployFact & { _id: string }>("lineDeploys", { sig: deploySig });
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
          {need.note && <p className="lwn-said" data-line-need-note>{need.note}</p>}
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

/** A session's last message, whole, as it wrote it; its pinned words until the messages arrive. */
function LastMessage({ sessionId, fallback }: { sessionId: string; fallback: string }) {
  const { conversation } = useConversationMessages(sessionId);
  const text = useMemo(() => lastWord((conversation?.messages ?? []) as unknown as TraceMessage[]).text, [conversation?.messages]);
  return <div className="lwn-said lwn-md" data-line-need-last={text ? "" : undefined}><MarkdownRenderer content={text || fallback} /></div>;
}

/** The dock under a need no answer can reach: its facts, and the one act, a new run, through its review (StartRunAct).
 *  For a step that stopped with nowhere to go (`yes`), that run is the yes: a run cannot pick up where another stopped,
 *  so going on is a new run that redoes the steps up to it, said on the button and in its review. */
function NewAsk({ need, facts, branch, drop, acts, yes }: { need: LineNeed; facts: Array<{ k: string; v: string }>; branch?: boolean; drop?: boolean; acts?: ReactNode; yes?: StoppedAsk | null }) {
  const [said, setSaid] = useState<"dropped" | "waits" | null>(null);
  // The step's own advice picks the lead: going on leads where it said go on; where it said wait, waiting does; where
  // it asked for a review, or said nothing, no answer leads and its words decide.
  const advice = yes?.advice?.act ?? null;
  const next = yes?.next ? ` to ${yes.next}` : "";
  const goWords = advice === "review" ? `Reviewed: go on${next}` : advice === "wait" ? `Go on${next} anyway` : `Go on${next}`;
  const problem = need.problemRef ? `${need.problemRef} · ${need.title}` : need.title;
  const run = need.caseId && (yes
    ? <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={problem} label={`${goWords} (new run)`} branch={branch} primary={advice === "go"} goOn={{ step: yes.step, next: yes.next }} />
    : <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={problem} label="Start a new run to ask again" branch={branch} primary />);
  return (
    <footer className="lwn-dock" data-line-need-dock>
      <dl className="lwn-facts">
        {facts.map((f) => <div key={f.k}><dt>{f.k}</dt><dd>{f.v}</dd></div>)}
        {said === "waits" && <div data-line-need-wait-recorded><dt>Asks again</dt><dd>When its findings double</dd></div>}
      </dl>
      {acts !== undefined ? acts : said === "dropped" ? <span className="lw-oc" data-tone="none">closed</span> : said === "waits" ? <span className="lw-oc" data-tone="none">Waiting for more findings</span> : (
        <>
          {/* Waiting is always an answer to a finished step, unless the step itself said go on; it leads only where the step advised it. */}
          {yes && advice !== "go" && need.problemRef && <button type="button" className="lw-act" data-primary={advice === "wait" ? "" : undefined} title="Park it: grounding asks again when its findings double" onClick={() => { answerProblem(need.problemRef!, "waits", waitNote(yes)); setSaid("waits"); }} data-line-need-wait>Wait for more findings</button>}
          {drop && need.problemRef && <button type="button" className="lw-act" onClick={() => { answerProblem(need.problemRef!, "dropped"); setSaid("dropped"); }} data-line-need-drop>Not a problem</button>}
          {run}
        </>
      )}
    </footer>
  );
}
