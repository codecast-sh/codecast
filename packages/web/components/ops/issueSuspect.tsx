// What broke it: the commit an issue most likely came from, with the session
// and task that wrote it, and for a CI check the run history by commit. An
// agent's commit carries its session, so the page names who to ask and opens
// them in one press.
import { Fragment } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useShaCommit, useSyncShaCommit } from "../../hooks/useSyncOps";
import { commitPath } from "../../lib/externalEvents";
import { relTimeShort } from "../../lib/utils";
import { EntityIdPill } from "../EntityIdPill";
import { commitMessageParts, squashPr, type CiRunRow } from "./issuesModel";

/** A commit message's first line with its task and pull request ids as live references. */
export function CommitMessage({ message, repository }: { message: string | undefined; repository?: string | null }) {
  const parts = commitMessageParts(message);
  return (
    <span className="iss-commit-msg">
      {parts.map((p, i) =>
        p.t === "text" ? <Fragment key={i}>{p.v}</Fragment>
          : p.t === "task" ? <EntityIdPill key={i} shortId={p.v} compact />
          : repository ? <EntityIdPill key={i} type="pr" id={`${repository}#${p.n}`} certain compact />
          : <Fragment key={i}>#{p.n}</Fragment>,
      )}
    </span>
  );
}

/**
 * The commit that probably broke it: its sha (linked), the session that wrote
 * it or its author, the tasks it names and its pull request. `why` says how
 * it was picked; `compare` links the span of commits it sits in.
 */
export function SuspectCommit({ sha, why, now, compare, label = "Suspect" }: { sha: string; why: string; now: number; compare?: string | null; label?: string }) {
  const feed = useSyncShaCommit(sha);
  const commit = useShaCommit(sha);
  // Until the lookup answers, the commit is unknown, not unseen: a skeleton, never "not a commit codecast has seen".
  const looking = !commit && !feed.ready;
  const href = commit?.repository && commit?.sha ? commitPath({ repository: commit.repository, sha: commit.sha }) : null;
  const tasks: string[] = commit?.task_ids ?? [];
  const pr = commit ? commit.pr_number ?? squashPr(commit.message) : null;
  return (
    <div className="iss-suspect" data-known={commit ? "true" : "false"}>
      <div className="iss-suspect-head">
        <span className="iss-suspect-k" data-label={label}>{label}</span>
        {href ? <Link href={href} className="ops-mono hover:underline">{sha.slice(0, 7)}</Link> : <span className="ops-mono">{sha.slice(0, 7)}</span>}
        <span className="ops-dim">{why}</span>
        {compare && <a href={compare} target="_blank" rel="noopener noreferrer" className="iss-suspect-cmp">commits between <ExternalLink className="w-3 h-3" /></a>}
      </div>
      {commit ? (
        <>
          <div className="iss-suspect-msg"><CommitMessage message={commit.message} repository={commit.repository} /></div>
          <div className="iss-suspect-refs">
            {commit.conversation_id ? <EntityIdPill type="session" id={commit.conversation_id} compact /> : <span className="ops-quiet">{commit.author_login ?? commit.author_name}</span>}
            {tasks.slice(0, 3).map((t) => <EntityIdPill key={t} type="task" id={t} compact />)}
            {pr && commit.repository ? <EntityIdPill type="pr" id={`${commit.repository}#${pr}`} certain compact /> : null}
            {commit.timestamp ? <span className="ops-dim ops-num">{relTimeShort(commit.timestamp, now)} ago</span> : null}
            {commit.conversation_id && <Link href={`/conversation/${commit.conversation_id}`} className="ops-btn iss-suspect-open">Open its session</Link>}
          </div>
        </>
      ) : looking ? (
        <div className="iss-skel" style={{ width: "60%" }} aria-busy="true" />
      ) : (
        <div className="ops-dim text-[11.5px]">not a commit codecast has seen</div>
      )}
    </div>
  );
}

/** A check's runs as a strip, oldest left, each a cell by how it ended with its commit on hover; the run that broke it is ringed. */
export function CiRunStrip({ runs, breakAt, now }: { runs: CiRunRow[]; breakAt: number | null; now: number }) {
  const shown = runs.slice(0, 40).reverse();
  return (
    <div className="iss-runs" role="list" aria-label="Runs, oldest first">
      {shown.map((r) => {
        const body = (
          <>
            <i data-ok={r.ok ? "true" : "false"} data-break={r.at === breakAt ? "true" : undefined} />
          </>
        );
        const title = `${r.conclusion}${r.sha ? ` at ${r.sha.slice(0, 7)}` : ""} · ${relTimeShort(r.at, now)} ago`;
        return r.url ? (
          <a key={`${r.at}${r.run_id ?? ""}`} role="listitem" href={r.url} target="_blank" rel="noopener noreferrer" className="iss-run" title={title}>{body}</a>
        ) : (
          <span key={`${r.at}${r.run_id ?? ""}`} role="listitem" className="iss-run" title={title}>{body}</span>
        );
      })}
    </div>
  );
}
