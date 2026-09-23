import Link from "next/link";
import { GitCommitHorizontal } from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { relTimeShort } from "../../lib/utils";
import type { PrCommitRow } from "../../lib/prView";
import type { PRDetailsRead } from "../../hooks/usePRDetails";
import { PRDetailsFrame } from "./PRDetailsFrame";

// The Commits tab: the head branch, oldest first, as GitHub lists it. Each row
// is a commit page away; the sha is monospace because that is what a person
// copies from here.

export function PRCommits({ repository, commits, total, read }: { repository: string; commits: PrCommitRow[] | undefined; total?: number; read?: PRDetailsRead }) {
  return <PRDetailsFrame read={read} hasRows={!!commits?.length} label="Commits"><CommitRows repository={repository} commits={commits} total={total} /></PRDetailsFrame>;
}

function CommitRows({ repository, commits, total }: { repository: string; commits: PrCommitRow[] | undefined; total?: number }) {
  const rows = commits ?? [];
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-8 py-16 text-center">
        <GitCommitHorizontal className="w-8 h-8 text-sol-text-dim/40" />
        <p className="text-[13px] text-sol-text-muted">{commits ? "No commits on this pull request" : "Commits have not loaded yet"}</p>
      </div>
    );
  }
  return (
    <div className="px-5 py-4">
      {total !== undefined && total > rows.length && <p className="mb-3 text-[11px] text-sol-text-dim">Showing {rows.length} of {total} commits</p>}
      <ol className="divide-y divide-sol-border/40 rounded-xl border border-sol-border/50 bg-sol-card">
        {rows.map((commit, index) => {
          const [subject, ...rest] = commit.message.split("\n");
          const body = rest.join("\n").trim();
          return (
            <li key={commit.sha} className="pr-rise flex items-start gap-3 px-4 py-2.5" style={{ ["--d" as string]: `${Math.min(index, 12) * 30}ms` }}>
              <CommentAvatar name={commit.author_login ?? commit.author_name ?? "?"} image={commit.author_avatar_url} size={20} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <Link href={`/commit/${repository}/${commit.sha}`} className="text-[13px] text-sol-text hover:text-sol-cyan truncate transition-colors">
                    {subject}
                  </Link>
                  <span className="ml-auto shrink-0 text-[11px] text-sol-text-dim">
                    {commit.committed_at ? relTimeShort(commit.committed_at) : ""}
                  </span>
                </div>
                {body && <p className="mt-0.5 text-[12px] text-sol-text-dim line-clamp-2 whitespace-pre-line">{body}</p>}
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-sol-text-dim">
                  <span>{commit.author_login ?? commit.author_name}</span>
                  <Link href={`/commit/${repository}/${commit.sha}`} className="font-mono hover:text-sol-cyan transition-colors">{commit.sha.slice(0, 7)}</Link>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
