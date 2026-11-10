import Link from "next/link";
import { GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { commitPageHref } from "../../../lib/repoView";
import type { GitToolOutcome } from "../../../lib/gitToolOutcome";
import { EntityIdPill } from "../../EntityIdPill";

/**
 * The object a shell call produced, as its reference: a commit pill that
 * resolves once the commit row exists (a push, the daemon's publish) and a
 * plain link to the commit page until then; a pull request pill that falls
 * back to the GitHub URL the command printed.
 */
export function GitOutcomeRow({ outcome, repository }: { outcome: GitToolOutcome; repository: string | null }) {
  const label = outcome.kind === "commit"
    ? <><span className="font-mono">{outcome.hash.slice(0, 7)}</span>{outcome.subject && <span className="truncate">{outcome.subject}</span>}</>
    : <span className="font-mono">{outcome.ref}</span>;
  const plain = "inline-flex items-center gap-1.5 min-w-0 max-w-full text-meta text-sol-text-muted hover:text-sol-text";
  const fallback = outcome.kind === "commit"
    ? repository
      ? <Link href={commitPageHref(repository, outcome.hash)} className={plain} onClick={(e) => e.stopPropagation()}><GitCommitHorizontal className="w-3 h-3 shrink-0 text-sol-yellow" />{label}</Link>
      : <span className={plain}><GitCommitHorizontal className="w-3 h-3 shrink-0 text-sol-yellow" />{label}</span>
    : <a href={outcome.url} target="_blank" rel="noopener noreferrer" className={plain} onClick={(e) => e.stopPropagation()}><GitPullRequest className="w-3 h-3 shrink-0 text-sol-green" />{label}</a>;
  const ref = outcome.kind === "commit" ? (repository ? `${repository}@${outcome.hash}` : null) : outcome.ref;
  // Sits in the tool card's header strip, so it reads on a collapsed card; the
  // click must not toggle the card.
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-[24rem] text-meta" onClick={(e) => e.stopPropagation()}>
      <span className="text-sol-text-dim flex-shrink-0">{outcome.kind === "commit" ? "committed" : "opened"}</span>
      {ref ? <EntityIdPill type={outcome.kind} id={ref} fallback={fallback} /> : fallback}
    </span>
  );
}
