"use client";
// The acts under a decision no answer can reach any more (lapsed or withdrawn,
// line-journeys.md LJ6.5): the card's own answers, as acts that still work.
// Drop closes the problem here and now, with the decision it settles recorded
// on it, and starts nothing. Ask again is a new run (Ship and Revise both need
// one: a builder to revise, a run to land the branch), priced on its button and
// reviewed before it starts. Whatever the card recommended comes first, so the
// answer a person just read is the first thing they can press.
import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { useTrialCards } from "../../../hooks/useSyncTrial";
import { cardAsRead, proposalAsRead } from "../../../lib/trialEvidence";
import { answerProblem } from "../workspace/views/problem/AskBlock";
import { dayTimeWords } from "../../../lib/line/problemPage";
import { StartRunAct } from "./StartRunAct";
import { MergeFixAct } from "../workspace/views/problem/MergeFixAct";
import { noAnswerFacts, type NoAnswerRun } from "../../../lib/line/decisionOutcome";
import { spanShort } from "../../../lib/line/runPage";

type DecisionRow = { _id: string; short_id?: string | null; card?: { recommend?: { verdict?: string } | null } | null };

/** A verdict that closes the problem: the change card's Drop, a proposal's Not now. */
const CLOSES = new Set(["drop", "wait"]);

/** What the decision recommended, read the way its page reads it: its trial card as it stands now, else its own card. */
export function useClosedVerdict(ref: string | null): string | null {
  const own = useInboxStore((s) => {
    if (!ref) return null;
    const st = s as unknown as { sessionDecisions?: Record<string, DecisionRow>; lineCards?: Record<string, DecisionRow> };
    for (const rows of [st.sessionDecisions, st.lineCards]) {
      for (const r of Object.values(rows ?? {})) if (r._id === ref || r.short_id === ref) return r.card?.recommend?.verdict ? `${r._id}|${r.card.recommend.verdict}` : `${r._id}|`;
    }
    return null;
  });
  const [rowId, ownVerdict] = own ? own.split("|") : [null, ""];
  const trial = useTrialCards({ all: true }).find((c) => !!c.decision && (c.decision._id === rowId || c.decision._id === ref || (!!ref && c.decision.short_id === ref))) ?? null;
  return useMemo(() => {
    const read = trial ? (cardAsRead(trial)?.recommend ?? proposalAsRead(trial.proposal, trial.evidence)?.recommend)?.verdict : null;
    return read || ownVerdict || null;
  }, [trial, ownVerdict]);
}

export function ClosedDecisionActs({ decisionRef, state, taskId, taskRef, title, projectId, branch }: {
  /** The decision's ref (sd-N) or row id. */
  decisionRef: string | null;
  state: "lapsed" | "withdrawn";
  taskId: string;
  /** The problem's ref (ct-N): Drop writes to it. */
  taskRef: string | null;
  title: string;
  projectId: string | null;
  /** A fix is saved on its branch for the new run. */
  branch?: boolean;
}) {
  const verdict = useClosedVerdict(decisionRef);
  const [dropped, setDropped] = useState(false);
  if (dropped) return <span className="lw-oc" data-tone="none" data-line-closed-dropped>Dropped · problem closed</span>;
  const dropFirst = !!verdict && CLOSES.has(verdict);
  const drop = taskRef ? (
    <button
      key="drop"
      type="button"
      className="lw-act"
      data-primary={dropFirst ? "" : undefined}
      data-recommended={dropFirst ? "" : undefined}
      onClick={() => {
        const said = `Dropped on ${decisionRef ?? "its decision"}, ${state === "lapsed" ? "which lapsed" : "withdrawn"} before anyone answered${dropFirst ? "; the decision recommended dropping it" : ""}.`;
        answerProblem(taskRef, "dropped", said);
        setDropped(true);
      }}
      data-line-closed-drop={taskRef}
    >
      Drop: close the problem
    </button>
  ) : null;
  // A fix saved on its branch lands from here, no new run: Ship opens its pull request (or merges where it may), and the
  // press is the approval nobody gave. Asking again is the slower route, a whole new run that asks the same question.
  const ship = branch ? <MergeFixAct key="ship" taskId={taskId} problem={taskRef ? `${taskRef} · ${title}` : title} change={null} approved={null} primary={!dropFirst} /> : null;
  const again = (
    <StartRunAct
      key="again"
      label="Ask again"
      priced
      primary={!dropFirst && !ship}
      icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden />}
      taskId={taskId}
      problem={taskRef ? `${taskRef} · ${title}` : title}
      projectId={projectId}
      branch={branch}
    />
  );
  return <span className="lw-closed-acts" data-line-closed-acts={verdict ?? "none"}>{dropFirst ? [drop, ship, again] : [ship, again, drop]}</span>;
}

type BranchRun = { task_id?: string; created_at?: number; node_statuses?: Array<{ node_id: string; result_preview?: string; session?: { result?: string; state?: string; handoff?: { note?: string } | null } | null }> };

/** The branch a run's fix is saved on ("codecast/line-ct-58282"), as its steps printed it; null when none named one. */
/** `taskId`: where the caller knows only the problem, its newest run that named one. */
export function useRunBranch(runId: string | null, taskId?: string | null): string | null {
  return useInboxStore((s) => {
    const rows = (s as unknown as { workflowRuns?: Record<string, BranchRun> }).workflowRuns;
    const own = runId ? rows?.[runId] : null;
    // The run's own words first; a run that rebuilt on the branch an earlier run made often names it only by its head
    // ("branch head is 1a5f0ae63"), so the problem's other runs, newest first, name it then.
    const others = taskId ? Object.values(rows ?? {}).filter((r) => r.task_id === taskId && r !== own).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)) : [];
    const runs = own ? [own, ...others] : others;
    // A landing step names the branch it tried to land; another step's text may name a scratch branch beside it.
    const LANDING = new Set(["rebase", "ship", "merge"]);
    for (const r of runs) for (const n of [...(r.node_statuses ?? [])].sort((a, b) => Number(LANDING.has(b.node_id)) - Number(LANDING.has(a.node_id)))) {
      for (const t of [n.result_preview, n.session?.result, n.session?.state, n.session?.handoff?.note]) {
        // Named outright, else by its worktree: the runner names the branch `codecast/<worktree>`.
        const m = t ? /\bcodecast\/line-[\w.-]*\w/.exec(t) ?? /\.codecast\/worktrees\/(line-[\w.-]*\w)/.exec(t) : null;
        if (m) return m[1] ? `codecast/${m[1]}` : m[0];
      }
    }
    return null;
  });
}

/** Who closed the run's fix decision unanswered, how long it stood open, and what the run did next (noAnswerFacts),
 *  read from the run's node records in the store. */
function useNoAnswerFacts(runId: string | null, taskId: string | null): ReturnType<typeof noAnswerFacts> {
  const sig = useInboxStore((s) => {
    const rows = (s as unknown as { workflowRuns?: Record<string, NoAnswerRun & { task_id?: string; created_at?: number }> }).workflowRuns;
    // Where the caller knows only the problem: its newest run.
    const r = runId ? rows?.[runId] ?? null : taskId ? Object.values(rows ?? {}).filter((x) => x.task_id === taskId).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0] ?? null : null;
    return r ? JSON.stringify(noAnswerFacts(r)) : "null";
  });
  return useMemo(() => JSON.parse(sig), [sig]);
}

/** The branch by its name; a press copies it, so it can be checked out. */
export function BranchName({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="lw-link lw-branch" title="Copy the branch name" data-line-branch={name}
      onClick={() => { void navigator.clipboard?.writeText(name).then(() => setCopied(true)); }}>
      <code>{name}</code>{copied && <span className="lw-branch-copied"> copied</span>}
    </button>
  );
}

/** The dock under a fix decision nobody answered, the same wherever it shows (a problem's band, For you, a run's Decide
 *  step): where the fix is saved, when it was asked, a link to its run when the host is not that run, and the acts. */
export function ClosedDecisionDock({ decisionRef, state, taskId, taskRef, title, projectId, runId, askedAt, built, onRun, acts = true }: {
  decisionRef: string | null;
  state: "lapsed" | "withdrawn";
  taskId: string;
  taskRef: string | null;
  title: string;
  projectId: string | null;
  runId: string | null;
  askedAt: number | null;
  built: boolean;
  /** Open the run; absent where the host is the run. */
  onRun?: (runId: string) => void;
  /** False when the problem is closed or a newer run moved on: the facts stay, the acts go. */
  acts?: boolean;
}) {
  const branch = useRunBranch(built ? runId : null, built ? taskId : null);
  const after = useNoAnswerFacts(runId, taskId);
  return (
    <footer className="lwn-dock" data-line-need-dock>
      <dl className="lwn-facts">
        {built && <div><dt>Branch</dt><dd>{branch ? <BranchName name={branch} /> : "Saved on its branch"}</dd></div>}
        {askedAt != null && <div><dt>Asked</dt><dd>{dayTimeWords(askedAt)}{after?.waited != null && `, open ${spanShort(after.waited)} with no answer`}</dd></div>}
        {after && <div data-line-taken-back><dt>{state === "withdrawn" ? "Withdrawn by" : "Closed by"}</dt><dd>{after.by}</dd></div>}
        {after?.then && <div data-line-after><dt>Then</dt><dd>{after.then}</dd></div>}
        {onRun && runId && <div><dt>Run</dt><dd><button type="button" className="lw-link" onClick={() => onRun(runId)} data-line-band-run>Open the run</button></dd></div>}
      </dl>
      {acts && <ClosedDecisionActs decisionRef={decisionRef} state={state} taskId={taskId} taskRef={taskRef} title={title} projectId={projectId} branch={built} />}
    </footer>
  );
}

