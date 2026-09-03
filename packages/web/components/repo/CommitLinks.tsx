// What codecast knows about a commit, as a row of pills: the session that
// wrote it, the tasks it names, and the pull request it belongs to.
//
// The same row appears on a history line and on the commit page, so a reader
// scanning history sees exactly what they would see after opening it.
import Link from "next/link";
import { GitPullRequest, MessagesSquare } from "lucide-react";
import { EntityIdPill } from "../EntityIdPill";

export type CommitJoins = {
  conversation_id?: string | null;
  session?: { _id: string; title?: string } | null;
  tasks?: { _id: string; short_id?: string; title?: string }[];
  pr_number?: number | null;
};

const PILL =
  "inline-flex items-center gap-1 h-[18px] px-1.5 rounded border border-sol-border/25 bg-sol-bg-alt/50 text-[10px] text-sol-text-muted hover:text-sol-text hover:border-sol-border/50 transition-colors max-w-[16rem] truncate";

export function CommitLinks({
  repository,
  joins,
  className,
}: {
  repository: string;
  joins: CommitJoins;
  className?: string;
}) {
  const sessionId = joins.session?._id ?? joins.conversation_id ?? null;
  const tasks = joins.tasks ?? [];
  const prNumber = joins.pr_number ?? null;
  if (!sessionId && tasks.length === 0 && prNumber === null) return null;

  return (
    <div className={`flex items-center gap-1 flex-wrap ${className ?? ""}`}>
      {sessionId && (
        <Link href={`/conversation/${sessionId}`} className={PILL} title={joins.session?.title ?? "The session that wrote this"}>
          <MessagesSquare className="w-2.5 h-2.5 shrink-0 text-sol-yellow" />
          <span className="truncate">{joins.session?.title || "Session"}</span>
        </Link>
      )}
      {tasks.map((task) =>
        task.short_id ? (
          <EntityIdPill key={task._id} shortId={task.short_id} type="task" />
        ) : (
          <EntityIdPill key={task._id} id={task._id} type="task" />
        ),
      )}
      {prNumber !== null && (
        <Link href={`/pr/${repository}/${prNumber}`} className={PILL} title={`Pull request #${prNumber}`}>
          <GitPullRequest className="w-2.5 h-2.5 shrink-0 text-sol-green" />#{prNumber}
        </Link>
      )}
    </div>
  );
}
