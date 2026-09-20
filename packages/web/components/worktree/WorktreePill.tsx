// A worktree wherever one is named: in prose, in the conversation header, on
// an inbox card. One pill, one hover card, so the same worktree reads the same
// everywhere and always leads to its row on the repository's Worktrees page.
import Link from "next/link";
import { FolderGit2, GitBranch } from "lucide-react";
import { HoverCard } from "../ui/HoverCard";
import { EntityIdPill } from "../EntityIdPill";
import { useRepoWorktrees } from "../../hooks/useRepoBrowse";
import { useKnownWorktrees } from "./WorktreesContext";
import { repoWorktreesHref } from "../../lib/repoView";
import { relTimeShort } from "../../lib/utils";
import { findWorktree, worktreeCondition, worktreesOfSession, type FoundWorktree, type WorktreeCondition, type WorktreeRef } from "./worktreeModel";

const TONE: Record<WorktreeCondition["tone"], string> = {
  ok: "text-sol-text-dim",
  idle: "text-sol-text-dim",
  work: "text-sol-yellow",
  warn: "text-sol-violet",
  bad: "text-sol-red",
};

/** Whether the worktree still holds anything, as one colored line. The page row and the hover card share it. */
export function WorktreeConditionLine({ found, className = "" }: { found: FoundWorktree; className?: string }) {
  const { worktree } = found;
  const condition = worktreeCondition(worktree);
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span aria-hidden className={`size-1.5 rounded-full bg-current ${TONE[condition.tone]}`} />
      <span className={TONE[condition.tone]}>{condition.label}</span>
      {!!worktree.behind && <span className="text-sol-text-dim">· {worktree.behind} behind {found.checkout.default_branch}</span>}
    </span>
  );
}

/** The sessions that run in, ran in, or acquired a worktree, as live references. */
export function WorktreeSessions({ sessions, limit = 4 }: { sessions?: string[]; limit?: number }) {
  if (!sessions?.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {sessions.slice(-limit).reverse().map((id) => <EntityIdPill key={id} id={id} type="session" compact />)}
      {sessions.length > limit && <span className="text-sol-text-dim">+{sessions.length - limit} more</span>}
    </span>
  );
}

function WorktreeHoverContent({ found, repository }: { found: FoundWorktree; repository: string }) {
  const { worktree: w, checkout } = found;
  const where = [checkout.device_label, !checkout.mine && checkout.owner?.name].filter(Boolean).join(" · ");
  return (
    <div className="p-3 text-[11px] text-sol-text-muted space-y-2">
      <div className="flex items-center gap-1.5 text-[12px] text-sol-text">
        <FolderGit2 className="size-3.5 shrink-0 text-sol-cyan" />
        <span className="font-mono font-medium truncate">{w.name}</span>
        {where && <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim">{where}</span>}
      </div>
      {w.branch && (
        <div className="flex items-center gap-1.5 font-mono">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{w.branch}</span>
          <span className="text-sol-text-dim">{w.head_sha.slice(0, 7)}</span>
        </div>
      )}
      <WorktreeConditionLine found={found} />
      {w.subject && <div className="truncate">{w.subject}{!!w.committed_at && <span className="text-sol-text-dim"> · {relTimeShort(w.committed_at)}</span>}</div>}
      {!!w.ports && <div className="font-mono text-sol-text-dim">{Object.entries(w.ports).map(([name, port]) => `${name} :${port}`).join("  ")}</div>}
      <WorktreeSessions sessions={w.sessions} />
      <div className="font-mono text-[10px] text-sol-text-dim break-all">{w.path}</div>
      <Link href={repoWorktreesHref(repository, w.name)} className="block pt-1 text-[10px] text-sol-blue no-underline hover:underline">All worktrees of {repository}</Link>
    </div>
  );
}

/**
 * The pill. `repository` is what makes it live: with it the worktree is looked
 * up among the checkouts that repository's teams publish, and the pill gains
 * its condition dot, its hover card and its link. Without it, or for a
 * worktree nobody published, it still names the worktree and nothing more.
 */
export function WorktreePill({ repository, children, className = "", ...ref }: WorktreeRef & {
  repository?: string | null;
  /** What to show instead of the worktree's name: the inline code that named it, say. */
  children?: React.ReactNode;
  className?: string;
}) {
  // Inside a conversation the list is already in context; the pill's own read then asks for nothing.
  const known = useKnownWorktrees();
  const shared = known && known.repository === repository ? known.checkouts : undefined;
  const own = useRepoWorktrees(shared ? undefined : repository ?? undefined).data?.checkouts;
  const found = findWorktree(shared ?? own, ref);
  const label = children ?? found?.worktree.name ?? ref.name;
  if (!label) return null;
  const body = (
    <>
      <FolderGit2 className="w-[1em] h-[1em] shrink-0 opacity-80" />
      <span className="truncate">{label}</span>
      {found && <span aria-hidden className={`size-[0.4em] shrink-0 rounded-full bg-current ${TONE[worktreeCondition(found.worktree).tone]}`} />}
    </>
  );
  const shape = `not-prose entity-ref inline-flex min-w-0 items-center gap-[0.25em] px-[0.2em] rounded-[0.2em] font-mono text-sol-cyan leading-none align-baseline ${className}`;
  if (!found || !repository) return <span className={shape}>{body}</span>;
  return (
    <HoverCard card={<WorktreeHoverContent found={found} repository={repository} />}>
      <Link href={repoWorktreesHref(repository, found.worktree.name)} className={`${shape} no-underline hover:underline decoration-current/40 underline-offset-2`}>
        {body}
      </Link>
    </HoverCard>
  );
}

/** A conversation header's worktrees: the one the session runs in, and any it made along the way. Two at most. */
export function SessionWorktreePills({ session, repository, className }: {
  session: Parameters<typeof worktreesOfSession>[1];
  repository?: string | null;
  className?: string;
}) {
  const refs = worktreesOfSession(useKnownWorktrees()?.checkouts, session).slice(0, 2);
  return <>{refs.map((ref) => <WorktreePill key={ref.name} repository={repository} className={className} {...ref} />)}</>;
}
