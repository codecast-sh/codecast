"use client";
// Closing a problem from wherever it is named (its band, a Problems row, a For you reader, a step's row): one press,
// and the closed problem reopens if a finding comes back.
import { useInboxStore } from "../../../../../store/inboxStore";
import { useFixCommitChecks, useProblemCiRun } from "../../../../../hooks/useFixCommitChecks";
import { fixCiCleared } from "../../../../../lib/line/fixedOnMain";
import { taskByRef } from "../../../../../lib/taskRef";

/** Close a problem, by its ref (or id): "Closed" once it is. */
export function CloseProblem({ taskRef, title, label = "Close", primary = true }: { taskRef: string; title: string; label?: string; primary?: boolean }) {
  const done = useInboxStore((s) => taskByRef(s.tasks as Record<string, { _id: string; short_id?: string; status?: string }>, taskRef)?.status === "done");
  if (done) return <span className="lw-oc" data-tone="ok">Closed</span>;
  return (
    <button type="button" className="lw-act" data-primary={primary ? "" : undefined} title={title} data-line-band-close
      onClick={() => void useInboxStore.getState().updateTaskStatus(taskRef, "done")}>
      {label}
    </button>
  );
}

/** Close a problem whose fix main already carries: the leading act once what failed passes on that commit, never before. */
export function CloseAsFixed({ taskRef, sha, projectId, taskId }: { taskRef: string; sha: string; projectId: string | null; taskId: string }) {
  const ci = useFixCommitChecks(projectId, sha, useProblemCiRun(taskId));
  return <CloseProblem taskRef={taskRef} title={`Close it as fixed by ${sha.slice(0, 7)}`} label="Close as fixed" primary={fixCiCleared(ci)} />;
}
