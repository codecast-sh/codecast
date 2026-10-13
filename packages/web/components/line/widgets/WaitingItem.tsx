"use client";
// The one reader for something that waits on a person (line-journeys.md
// LJ6.2). Wherever a waiting thing is named (For you, a problem's band, a
// run's person step, a step's waiting rows) this is what shows it, so the
// thing is read and answered where it is named:
//   decision          the session's decision, whole (LineDecision), answered on it
//   question, confirm the question in full, the findings it rests on, the answer box
//   reask             the paused run's proposal and the one act that has its agent ask again
//   lapsed            the decision nobody answered, read only, and a new run to ask again
//   stopped           what the step said when it stopped, and a new run to ask again
// A control that starts a full run says so and goes through a review
// (SwitchReview with startAgainLedger); nothing here restates the problem's
// state as a sentence. The root fills its host: give it a box of fixed height.
import { useMemo, useState } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useSyncTaskSignals } from "../../../hooks/useSyncSignals";
import { useTrialCards } from "../../../hooks/useSyncTrial";
import type { LineNeed } from "../../../lib/line/lineNeeds";
import { answerProblem, ProblemAsk } from "../workspace/views/problem/AskBlock";
import { TrialCardPanel } from "../workspace/views/TrialCardPanel";
import { FindingPlaceholder, FindingReader, useFinderName, type ReaderSignal } from "./FindingReader";
import { LineDecision } from "./LineDecision";
import { useLineNav } from "./parts";
import { StartRunAct } from "./StartRunAct";
import "./waitingItem.css";

export type WaitingItemProps = {
  need: LineNeed;
  /** List the findings the need rests on. Off where they are already on the page (a problem's Findings, just below its band). */
  evidence?: boolean;
  /** Open the need's problem, and its run: the host's own navigation (For you sets the need's process). Default: the line's nav. */
  onProblem?: (taskId: string) => void;
  onRun?: (runId: string, taskId: string | null) => void;
  /** Whether a reader with no head of its own names the problem (ref, project, title). Off where the page already does. */
  head?: boolean;
  now?: number;
};

export function WaitingItem({ need, evidence = true, onProblem, onRun, head = true, now = Date.now() }: WaitingItemProps) {
  const nav = useLineNav();
  const toProblem = onProblem ?? ((id: string) => nav?.openCase?.(id));
  const toRun = onRun ?? ((runId: string, taskId: string | null) => nav?.openRun(runId, taskId));
  const body = need.kind === "decision" && need.decisionRef ? (
    <LineDecision key={need.decisionRef} id={need.decisionRef} onProblem={toProblem} onRun={toRun} />
  ) : need.kind === "reask" ? (
    <Reask need={need} now={now} onProblem={toProblem} onRun={toRun} />
  ) : need.kind === "lapsed" ? (
    <Lapsed need={need} onProblem={toProblem} onRun={toRun} />
  ) : need.kind === "stopped" ? (
    <Stopped need={need} onProblem={toProblem} onRun={toRun} />
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
      <h2 className="lwn-title">{need.title}</h2>
    </header>
  );
}

/** A question or a new problem to confirm: the question in full with its answer box, then the findings it rests on. */
function Ask({ need, evidence, onProblem }: { need: LineNeed; evidence: boolean; onProblem: (taskId: string) => void }) {
  return (
    <div className="lwn-scroll">
      <div className="lwn-col">
        <NeedHead need={need} onProblem={onProblem} />
        <ProblemAsk key={need.key} question={need.ask} why={need.note} taskRef={need.problemRef} focus={false} asks={need.kind === "question"} />
        {evidence && need.caseId && <Evidence caseId={need.caseId} count={need.findings ?? 0} />}
      </div>
    </div>
  );
}

const evidenceSig = (s: ReaderSignal) => `${s._id}|${s.created_at}|${s.judge ?? ""}|${s.judge_review?.state ?? ""}|${(s.detail_md ?? "").length}`;

/** The findings a need rests on, each opened in place (FindingReader), the newest open on arrival. */
function Evidence({ caseId, count }: { caseId: string; count: number }) {
  const { ready } = useSyncTaskSignals(caseId);
  const where = useMemo(() => (s: ReaderSignal) => s.task_id === caseId, [caseId]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: evidenceSig });
  const sorted = useMemo(() => [...rows].sort((a, b) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at)), [rows]);
  const who = useFinderName();
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
        {sorted.map((s) => <FindingReader key={s._id} signal={s} who={who(s)} open={open.includes(s._id)} onToggle={() => toggle(s._id)} />)}
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
  return best ? `${best.short_id ?? best._id}|${best.created_at ?? 0}` : "";
};

const dateWords = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A fix that was built and asked, and nobody answered: the decision as it was asked, read only, and a new run to ask again. */
function Lapsed({ need, onProblem, onRun }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: (runId: string, taskId: string | null) => void }) {
  const sig = useInboxStore((s) => lapsedCardSig((s as unknown as { lineCards?: Record<string, CardRow> }).lineCards, need.caseId));
  const [ref, at] = sig ? sig.split("|") : [null, "0"];
  return (
    <>
      <div className="lwn-thing">
        {ref ? <LineDecision key={ref} id={ref} onProblem={onProblem} onRun={onRun} /> : <div className="lwn-scroll"><div className="lwn-col"><NeedHead need={need} onProblem={onProblem} /></div></div>}
      </div>
      <NewAsk need={need} facts={[{ k: "Branch", v: "The fix is saved on its branch" }, ...(Number(at) ? [{ k: "Asked", v: dateWords(Number(at)) }] : [])]} branch />
    </>
  );
}

type RunRow = { node_statuses?: Array<{ node_id: string; label?: string; result_preview?: string; session?: { result?: string; state?: string } | null }> };

/** What the step a run stopped at said last, whole. */
const stoppedSaid = (rows: Record<string, RunRow> | undefined, runId: string | null, step: string | null | undefined) => {
  const n = runId && step ? rows?.[runId]?.node_statuses?.find((x) => x.node_id === step) : undefined;
  return n ? `${n.label ?? ""}\u0000${n.session?.result || n.result_preview || n.session?.state || ""}` : "";
};

/** A run that finished a step needing a person's yes and had nowhere to take it: what the step said, and a new run to ask again. */
function Stopped({ need, onProblem, onRun }: { need: LineNeed; onProblem: (taskId: string) => void; onRun: (runId: string, taskId: string | null) => void }) {
  const said = useInboxStore((s) => stoppedSaid((s as unknown as { workflowRuns?: Record<string, RunRow> }).workflowRuns, need.runId, need.fail?.step));
  const [label, text] = said.split("\u0000");
  return (
    <>
      <div className="lwn-thing lwn-scroll">
        <div className="lwn-col">
          <NeedHead need={need} onProblem={onProblem} />
          <section className="lwn-stopped" data-line-need-said>
            <h3 className="lwn-h">{label ? `${label} said` : "The step said"}</h3>
            <p className="lwn-said">{text?.trim() || need.ask}</p>
            {need.runId && <button type="button" className="lwn-link" onClick={() => onRun(need.runId!, need.caseId)}>Open the run</button>}
          </section>
        </div>
      </div>
      <NewAsk need={need} facts={need.since ? [{ k: "Stopped", v: dateWords(need.since) }] : []} drop />
    </>
  );
}

/** The dock under a need no answer can reach: its facts, and the one act, a new run that asks again, through its review (StartRunAct). */
function NewAsk({ need, facts, branch, drop }: { need: LineNeed; facts: Array<{ k: string; v: string }>; branch?: boolean; drop?: boolean }) {
  const [dropped, setDropped] = useState(false);
  return (
    <footer className="lwn-dock" data-line-need-dock>
      <dl className="lwn-facts">
        {facts.map((f) => <div key={f.k}><dt>{f.k}</dt><dd>{f.v}</dd></div>)}
      </dl>
      {dropped ? <span className="lw-oc" data-tone="none">closed</span> : (
        <>
          {drop && need.problemRef && <button type="button" className="lw-act" onClick={() => { answerProblem(need.problemRef!, "dropped"); setDropped(true); }} data-line-need-drop>Not a problem</button>}
          {need.caseId && <StartRunAct taskId={need.caseId} projectId={need.projectId} problem={need.problemRef ? `${need.problemRef} · ${need.title}` : need.title} label="Start a new run to ask again" branch={branch} />}
        </>
      )}
    </footer>
  );
}
