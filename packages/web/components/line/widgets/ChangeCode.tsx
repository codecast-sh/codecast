"use client";
// The code a fix decision is about, folded under the decision (presenter.md: the decision opens the change's diff
// itself, so the session's page never spends itself on code). Closed, it is one line; opened, it reads the run's
// branch against the default branch (lineFixChecks.fixBranch) and shows its commits and every changed file's patch.
// A branch no repository holds yet opens in the session that built it, whose own diff view has the change.
import { useState } from "react";
import { PanelRight } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { useFixBranch } from "../../../hooks/useFixCommitChecks";
import { openConversationBeside } from "../../../hooks/useOpenLinkedSession";
import { FileDiffList } from "../../FileDiffView";
import { useRunBranch } from "./ClosedDecisionActs";

type RunNodes = { node_statuses?: Array<{ node_id: string; session?: { _id?: string } | null }> };

/** The session that built the run's change: its implementing step's, the last one when the step ran more than once. */
export function builderSession(run: RunNodes | null | undefined): string | null {
  const nodes = (run?.node_statuses ?? []).filter((n) => /implement|build/i.test(n.node_id) && n.session?._id);
  return nodes.at(-1)?.session?._id ?? null;
}

export function ChangeCode({ runId, taskId, projectId }: { runId: string; taskId: string | null; projectId: string | null }) {
  const [open, setOpen] = useState(false);
  const named = useRunBranch(runId, taskId);
  // Read only once opened: the fold is the record, and a closed one costs nothing.
  const fb = useFixBranch(open ? projectId : null, named, runId);
  const builder = useInboxStore((s) => builderSession((s as unknown as { workflowRuns?: Record<string, RunNodes> }).workflowRuns?.[runId]));
  const found = !!fb?.repository;
  const files = found ? fb!.files.map((f) => ({ ...f, changes: f.additions + f.deletions })) : [];
  return (
    <details className="ld-full ld-code" data-line-decision-code onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        The code
        {found && <span className="ld-code-sum lw-num">{files.length} {files.length === 1 ? "file" : "files"} <b data-k="add">+{fb!.additions}</b> <b data-k="del">−{fb!.deletions}</b></span>}
      </summary>
      <div className="ld-full-body">
        {!open ? null : !projectId && !builder ? (
          <p className="ld-code-note">No record of where this change was built</p>
        ) : projectId && !fb ? (
          <p className="ld-code-note">Reading the change</p>
        ) : found ? (
          <>
            {fb!.commits.length > 0 && <ol className="ld-code-commits">{fb!.commits.map((c) => <li key={c.sha}><code>{c.sha.slice(0, 7)}</code>{c.subject}</li>)}</ol>}
            <FileDiffList files={files} emptyText="No file changes" className="ld-code-files" />
            {fb!.url && <a className="ld-code-link" href={fb!.url} target="_blank" rel="noopener noreferrer">Open on GitHub</a>}
          </>
        ) : (
          <p className="ld-code-note">
            Not on GitHub yet
            {builder && <button type="button" className="ld-code-link" onClick={() => openConversationBeside(builder)} data-line-decision-builder><PanelRight className="w-3 h-3" aria-hidden />Open the session that built it</button>}
          </p>
        )}
      </div>
    </details>
  );
}
