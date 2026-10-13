"use client";
// The one reader for something that waits on a person (line-journeys.md
// LJ6.2). Wherever a waiting thing is named (For you, a problem's band, a
// run's person step, a step's waiting rows) this is what shows it, so the
// thing is read and answered where it is named:
//   decision          the session's decision, whole (LineDecision), answered on it
//   question, confirm the question in full, the findings it rests on, the answer box
//   reask             the paused run's proposal and the one act that has its agent ask again
//   lapsed            the decision nobody answered, read only, and its answers: Drop now, or a new run to ask again
//   stopped           the yes it waits on in one line, the step's last message whole, Yes (recorded for the next run) or a new run
// A control that starts a full run says so and goes through a review
// (SwitchReview with startAgainLedger); nothing here restates the problem's
// state as a sentence. The root fills its host: give it a box of fixed height.
import { useMemo, useState, type ReactNode } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useConversationMessages } from "../../../hooks/useConversationMessages";
import { useSyncTaskSignals } from "../../../hooks/useSyncSignals";
import { useTrialCards } from "../../../hooks/useSyncTrial";
import { stoppedAsk, type LineNeed, type StoppedAsk } from "../../../lib/line/lineNeeds";
import { findingLeads } from "../../../lib/line/problemPage";
import { problemListName } from "../../../lib/line/problemTable";
import { lastWord, type TraceMessage } from "../../../lib/line/runTrace";
import { stepLabel } from "../../../lib/line/runReport";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { answerProblem, ProblemAsk, useAnswerNext } from "../workspace/views/problem/AskBlock";
import { TrialCardPanel } from "../workspace/views/TrialCardPanel";
import { FindingPlaceholder, FindingReader, useFinderName, type ReaderSignal } from "./FindingReader";
import { LineDecision } from "./LineDecision";
import { useLineNav } from "./parts";
import { StartRunAct } from "./StartRunAct";
import { ClosedDecisionActs } from "./ClosedDecisionActs";
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
  /** The decision sits in the host's page flow and grows with its content (LineDecision inline). */
  inline?: boolean;
  /** False where the host carries the act after a settled decision itself (LineDecision act). */
  act?: boolean;
  /** The run the host already shows (a run's page): no link back to it. */
  runShown?: string | null;
  now?: number;
};

export function WaitingItem({ need, evidence = true, onProblem, onRun, head = true, inline = false, act = true, runShown = null, now = Date.now() }: WaitingItemProps) {
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
    <Stopped need={need} onProblem={toProblem} onRun={toRun} runShown={runShown} />
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
  const next = useAnswerNext(need.caseId, need.projectId ?? null);
  return (
    <div className="lwn-scroll">
      <div className="lwn-col">
        <NeedHead need={need} onProblem={onProblem} />
        <ProblemAsk key={need.key} question={need.ask} why={need.note} taskRef={need.problemRef} focus={false} asks={need.kind === "question"} startWords={next} />
        {evidence && need.caseId && <Evidence caseId={need.caseId} count={need.findings ?? 0} title={need.title} />}
      </div>
    </div>
  );
}

const evidenceSig = (s: ReaderSignal) => `${s._id}|${s.created_at}|${s.judge ?? ""}|${s.judge_review?.state ?? ""}|${(s.detail_md ?? "").length}`;

/** The findings a need rests on, each opened in place (FindingReader), the newest open on arrival. */
function Evidence({ caseId, count, title }: { caseId: string; count: number; title: string }) {
  const { ready } = useSyncTaskSignals(caseId);
  const where = useMemo(() => (s: ReaderSignal) => s.task_id === caseId, [caseId]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: evidenceSig });
  const sorted = useMemo(() => [...rows].sort((a, b) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at)), [rows]);
  const who = useFinderName();
  // The reader heads with the problem's title: a row never says it again.
  const leadOf = useMemo(() => findingLeads(sorted, title), [sorted, title]);
  // The newest is open until the person opens or shuts one; three frames at most, the oldest folding back.
  const [opened, setOpened] = useState<string[] | null>(null);
  const open = opened ?? (sorted[0] ? [sorted[0]._id] : []);
  const toggle = (id: string) => setOpened(open.includes(id) ? open.filter((x) => x !== id) : [...open, id].slice(-3));
  const waiting = !ready && sorted.length < count;
  if (!sorted.length && !waiting) return null;
  return (
    <section className="lwn-evidence" data-line-need-evidence={sorted.length}>
      <h3 className="lwn-h">Findings <span className="lw-num">{Math.max(sorted.length, count)}</span></h3>
      <ul className="lwn-findings">
        {sorted.map((s) => <FindingReader key={s._id} signal={s} who={who(s)} open={open.includes(s._id)} onToggle={() => toggle(s._id)} lead={leadOf(s)} expectation={title} />)}
        {waiting && Array.from({ length: Math.min(4, count - sorted.length) }, (_, i) => <FindingPlaceholder key={i} />)}
      </ul>
    </section>
  );
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
  const acts = need.caseId ? (
    <ClosedDecisionActs decisionRef={ref} state={/^(withdrawn|dismissed|cancell?ed|expired)$/.test(status ?? "") ? "withdrawn" : "lapsed"} taskId={need.caseId} taskRef={need.problemRef ?? null} title={need.title} projectId={need.projectId ?? null} branch />
  ) : null;
  return (
    <>
      <div className="lwn-thing">
        {ref ? <LineDecision key={ref} id={ref} onProblem={onProblem} onRun={onRun} head={head} inline={inline} act={false} /> : <div className="lwn-scroll"><div className="lwn-col"><NeedHead need={need} onProblem={onProblem} /></div></div>}
      </div>
      <NewAsk need={need} facts={[{ k: "Branch", v: "The fix is saved on its branch" }, ...(Number(at) ? [{ k: "Asked", v: dateWords(Number(at)) }] : [])]} acts={acts} />
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
 *  message whole, and the acts a person has: Yes (recorded on the problem for the next run to read), Not a problem, and
 *  the new run that carries the yes on. */
function Stopped({ need, onProblem, onRun, runShown }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: (runId: string, taskId: string | null) => void; runShown: string | null }) {
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
          {ask && <p className="lwn-ask" data-line-need-ask>{ask.line}</p>}
          <section className="lwn-stopped" data-line-need-said>
            <h3 className="lwn-h">{named ? `${named} said` : "The step said"}</h3>
            {session ? <LastMessage sessionId={session} fallback={fallback} /> : <p className="lwn-said">{fallback}</p>}
            {need.runId && need.runId !== runShown && <button type="button" className="lwn-link" onClick={() => onRun(need.runId!, need.caseId)}>Open the run</button>}
          </section>
        </div>
      </div>
      <NewAsk need={need} facts={need.since ? [{ k: "Stopped", v: dateWords(need.since) }] : []} drop yes={ask} />
    </>
  );
}

/** A session's last message, whole, as it wrote it; its pinned words until the messages arrive. */
function LastMessage({ sessionId, fallback }: { sessionId: string; fallback: string }) {
  const { conversation } = useConversationMessages(sessionId);
  const text = useMemo(() => lastWord((conversation?.messages ?? []) as unknown as TraceMessage[]).text, [conversation?.messages]);
  return <div className="lwn-said lwn-md" data-line-need-last={text ? "" : undefined}><MarkdownRenderer content={text || fallback} /></div>;
}

/** The dock under a need no answer can reach: its facts, and the one act, a new run that asks again, through its review (StartRunAct). */
function NewAsk({ need, facts, branch, drop, acts, yes }: { need: LineNeed; facts: Array<{ k: string; v: string }>; branch?: boolean; drop?: boolean; acts?: ReactNode; yes?: StoppedAsk | null }) {
  const [said, setSaid] = useState<"dropped" | "yes" | null>(null);
  const problem = need.problemRef ? `${need.problemRef} · ${need.title}` : need.title;
  // A yes is recorded on the problem at once and starts nothing: the run that carries it on is the next act, reviewed and priced.
  const run = need.caseId && <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={problem} label={said === "yes" ? "Start the run with your yes" : yes ? "Start a new run" : "Start a new run to ask again"} branch={branch} primary={said === "yes" || !yes} />;
  return (
    <footer className="lwn-dock" data-line-need-dock>
      <dl className="lwn-facts">
        {facts.map((f) => <div key={f.k}><dt>{f.k}</dt><dd>{f.v}</dd></div>)}
        {said === "yes" && <div data-line-need-yes-recorded><dt>Your yes</dt><dd>Recorded; the next run reads it</dd></div>}
      </dl>
      {acts !== undefined ? acts : said === "dropped" ? <span className="lw-oc" data-tone="none">closed</span> : said === "yes" ? run : (
        <>
          {yes && need.problemRef && <button type="button" className="lw-act" data-primary="" onClick={() => { answerProblem(need.problemRef!, "confirmed", yes.note); setSaid("yes"); }} data-line-need-yes>{yes.next ? `Yes, go on to ${yes.next}` : "Yes, go on"}</button>}
          {drop && need.problemRef && <button type="button" className="lw-act" onClick={() => { answerProblem(need.problemRef!, "dropped"); setSaid("dropped"); }} data-line-need-drop>Not a problem</button>}
          {run}
        </>
      )}
    </footer>
  );
}
