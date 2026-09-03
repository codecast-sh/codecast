// One commit.
//
// The page answers two questions at once: what changed, and who inside
// codecast made it happen. The diff is the body; the header carries the join
// (the session that wrote it, the tasks it names, the pull request it belongs
// to) so a commit is never just a stranger's sha.
//
// The page's accent is the commit itself: green when it mostly added, red when
// it mostly removed, yellow when it rewrote about as much as it kept.
import { useCallback, useMemo, useState, type RefCallback } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
} from "lucide-react";
import { AuthGuard } from "../../../../../components/AuthGuard";
import { CommentAvatar } from "../../../../../components/comments/CommentAvatar";
import { DashboardLayout } from "../../../../../components/DashboardLayout";
import { FileDiffLayout, type DiffFile, type FileLineThreads } from "../../../../../components/FileDiffLayout";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PRLineThread } from "../../../../../components/pr/PRThread";
import { CommitLinks } from "../../../../../components/repo/CommitLinks";
import { Button } from "../../../../../components/ui/button";
import { useCodeComments, useSyncRefCodeComments } from "../../../../../hooks/useSyncCodeComments";
import { useAttributedSession, useLineComments } from "../../../../../hooks/useLineComments";
import { useCoarseNow } from "../../../../../hooks/useCoarseNow";
import { useEnsureCommitFiles } from "../../../../../hooks/useRepoBrowse";
import {
  useCommit,
  useCommits,
  usePullRequest,
  useSyncCommit,
  useSyncCommits,
  useSyncPullRequest,
} from "../../../../../hooks/useSyncTimeline";
import { useTitlebarHead } from "../../../../../hooks/useTitlebarHead";
import type { CodeCommentRow } from "../../../../../lib/prView";
import {
  commitBalanceAccent,
  repoHistoryHref,
  repoTreeHref,
  splitCommitMessage,
} from "../../../../../lib/repoView";
import { copyToClipboard, relTimeShort } from "../../../../../lib/utils";
import "../../../../../components/repo/repo.css";

function ShaCopy({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await copyToClipboard(sha);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1.5 font-mono text-[12px] rounded px-1.5 py-0.5 transition-colors hover:bg-sol-bg-alt/60"
      style={{ color: "var(--repo-accent)" }}
      title={copied ? "Copied" : `Copy ${sha}`}
    >
      {sha.slice(0, 7)}
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3 opacity-60" />}
    </button>
  );
}

/** How the change is balanced, as a short bar. Same colours as the accent. */
function BalanceBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;
  const addPct = Math.round((additions / total) * 100);
  return (
    <span className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-sol-red/60" title={`+${additions} / -${deletions}`}>
      <span className="h-full bg-sol-green" style={{ width: `${addPct}%` }} />
    </span>
  );
}

function CommitHeader({
  commit,
  repository,
  neighbours,
  headRef,
}: {
  commit: any;
  repository: string;
  neighbours: { older?: string; newer?: string };
  headRef?: RefCallback<HTMLElement>;
}) {
  const now = useCoarseNow(60_000);
  const { subject, body } = splitCommitMessage(commit.message);

  return (
    <header ref={headRef} className="repo-band border-b border-sol-border/60 px-4 py-3 shrink-0">
      <div className="flex items-start gap-3">
        <GitCommitHorizontal className="w-5 h-5 mt-1 shrink-0" style={{ color: "var(--repo-accent)" }} />
        <div className="min-w-0 flex-1">
          <h1
            className="repo-rise font-serif text-[22px] leading-tight text-sol-text"
            style={{ ["--d" as string]: "0ms" }}
          >
            {subject}
          </h1>
          {body && (
            <pre className="repo-rise mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-sol-text-muted" style={{ ["--d" as string]: "40ms" }}>
              {body}
            </pre>
          )}

          <div
            className="repo-rise mt-2.5 flex items-center gap-3 flex-wrap text-[11px] text-sol-text-dim"
            style={{ ["--d" as string]: "80ms" }}
          >
            <ShaCopy sha={commit.sha} />
            <span className="flex items-center gap-1.5">
              <CommentAvatar
                name={commit.author_login || commit.author_name || "?"}
                image={commit.author_avatar_url}
                size={18}
              />
              <span className="text-sol-text-muted">{commit.author_login || commit.author_name}</span>
            </span>
            <span title={new Date(commit.timestamp).toLocaleString()}>
              {relTimeShort(commit.timestamp, now)}
            </span>
            {commit.branch && (
              <Link
                href={repoHistoryHref(repository, commit.branch)}
                className="flex items-center gap-1 hover:text-sol-text transition-colors"
              >
                <GitBranch className="w-3 h-3" />
                {commit.branch}
              </Link>
            )}
            <span className="flex items-center gap-1.5">
              <span className="text-sol-green">+{commit.insertions ?? 0}</span>
              <span className="text-sol-red">-{commit.deletions ?? 0}</span>
              <BalanceBar additions={commit.insertions ?? 0} deletions={commit.deletions ?? 0} />
              <span>
                {commit.files_changed ?? 0} {commit.files_changed === 1 ? "file" : "files"}
              </span>
            </span>
          </div>

          <div className="repo-rise mt-2" style={{ ["--d" as string]: "120ms" }}>
            <CommitLinks repository={repository} joins={commit} />
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {neighbours.newer && (
            <Link href={`/commit/${repository}/${neighbours.newer}`} title="Newer commit">
              <Button variant="ghost" size="sm" className="h-7 px-1.5">
                <ChevronLeft className="w-4 h-4" />
              </Button>
            </Link>
          )}
          {neighbours.older && (
            <Link href={`/commit/${repository}/${neighbours.older}`} title="Older commit">
              <Button variant="ghost" size="sm" className="h-7 px-1.5">
                <ChevronRight className="w-4 h-4" />
              </Button>
            </Link>
          )}
          <Link href={repoTreeHref(repository, commit.sha)}>
            <Button variant="outline" size="sm" className="h-7">
              Browse tree
            </Button>
          </Link>
          <a
            href={`https://github.com/${repository}/commit/${commit.sha}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline" size="sm" className="h-7">
              <ExternalLink className="w-3 h-3 mr-1.5" />
              GitHub
            </Button>
          </a>
        </div>
      </div>
    </header>
  );
}

function CommitNotFound({ repository, sha }: { repository: string; sha: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-sol-text-muted px-6 text-center">
      <GitCommitHorizontal className="w-10 h-10 mb-3 opacity-30" />
      <h2 className="text-base font-medium mb-1">Commit not found</h2>
      <p className="text-[13px] mb-4">
        <code className="font-mono text-sol-violet">{sha.slice(0, 7)}</code> in{" "}
        <code className="font-mono">{repository}</code> is not in this workspace.
      </p>
      <div className="flex items-center gap-2">
        <Link href={repoHistoryHref(repository)}>
          <Button variant="outline">Browse the history</Button>
        </Link>
        <a
          href={`https://github.com/${repository}/commit/${sha}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button variant="outline">
            <ExternalLink className="w-4 h-4 mr-2" />
            GitHub
          </Button>
        </a>
      </div>
    </div>
  );
}

/**
 * A commit whose row carries no patches.
 *
 * A commit that arrived by webhook has its message and counts but no diff, so
 * the page fetches the files once. The store row updates itself when they land,
 * which is why this component can simply say what it is doing and then say what
 * it found.
 */
function CommitWithoutFiles({ repository, sha }: { repository: string; sha: string }) {
  const fetchFiles = useEnsureCommitFiles(repository, sha, true);

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 text-center text-sol-text-muted">
      {fetchFiles.pending ? (
        <p className="text-[13px]">Reading this commit's diff from GitHub.</p>
      ) : (
        <>
          <p className="text-[13px] mb-1">
            {fetchFiles.error
              ? "The diff for this commit could not be read."
              : "This commit changed no files we can show."}
          </p>
          <p className="text-[12px] text-sol-text-dim mb-4 max-w-md leading-relaxed">
            {fetchFiles.error
              ? fetchFiles.error.message
              : "A merge commit with no combined diff looks like this, and so does a commit whose files GitHub no longer serves."}
          </p>
          <a
            href={`https://github.com/${repository}/commit/${sha}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline">
              <ExternalLink className="w-4 h-4 mr-2" />
              See it on GitHub
            </Button>
          </a>
        </>
      )}
    </div>
  );
}

function CommitContent({
  repository,
  sha,
  headRef,
}: {
  repository: string;
  sha: string;
  headRef: RefCallback<HTMLElement>;
}) {
  // Local first: the row may already be in the store from the timeline lane.
  // This feeder refreshes it and fills in what the lane leaves out.
  const feed = useSyncCommit(sha);
  useSyncCommits({ repository, limit: 100 });
  const commit = useCommit(sha);

  const repoCommits = useCommits(useCallback((c: any) => c.repository === repository, [repository]));
  const neighbours = useMemo(() => {
    const index = repoCommits.findIndex((c: any) => c.sha === sha);
    if (index === -1) return {};
    return {
      newer: index > 0 ? repoCommits[index - 1].sha : undefined,
      older: index < repoCommits.length - 1 ? repoCommits[index + 1].sha : undefined,
    };
  }, [repoCommits, sha]);

  // A comment on a commit that is part of an OPEN pull request belongs on that
  // review too, so it mirrors. On any other commit it stays here: GitHub would
  // file it against a review that nobody is reading.
  useSyncPullRequest(commit?.pr_number ? { repository, number: commit.pr_number } : "skip");
  const pr = usePullRequest(repository, commit?.pr_number ?? -1);

  const searchParams = useSearchParams();
  const conversationId = useAttributedSession(searchParams.get("session"));

  useSyncRefCodeComments(repository, sha);
  const comments = useCodeComments(
    useCallback((c: CodeCommentRow) => c.repository === repository && c.ref === sha, [repository, sha]),
  );

  const lineComments = useLineComments({
    repository,
    ref: sha,
    comments,
    mirror: pr?.state === "open",
    conversationId,
  });

  const lineThreads: FileLineThreads = useMemo(
    () => ({
      threadsFor: (filename) => lineComments.threadsByFile.get(filename),
      render: (filename, line, items) => (
        <PRLineThread
          comments={items as CodeCommentRow[]}
          authed={lineComments.authed}
          onReply={(content) =>
            lineComments.post({
              file_path: filename,
              line_number: line,
              side: "RIGHT",
              content,
              parent_id: (items as CodeCommentRow[])[0]?._id,
              ...(pr?.state === "open" ? { pull_request_id: pr._id } : {}),
            })
          }
          onResolve={(resolved) => lineComments.setThreadResolved(items as CodeCommentRow[], resolved)}
          onClose={lineComments.closeComposer}
        />
      ),
      onComment: (filename, line) => {
        if (line !== undefined) lineComments.openComposer(filename, line);
      },
    }),
    [lineComments, pr],
  );

  if (!commit) {
    if (!feed.ready && !feed.error) return <LoadingSkeleton />;
    return <CommitNotFound repository={repository} sha={sha} />;
  }

  const files: DiffFile[] = (commit.files ?? []).map((f: any) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch,
  }));

  return (
    <div
      className="repo-page h-full flex flex-col"
      style={{
        ["--repo-accent" as string]: commitBalanceAccent(
          commit.insertions ?? 0,
          commit.deletions ?? 0,
        ),
      }}
    >
      <CommitHeader
        commit={commit}
        repository={repository}
        neighbours={neighbours}
        headRef={headRef}
      />
      <div className="flex-1 min-h-0">
        {files.length === 0 ? (
          <CommitWithoutFiles repository={repository} sha={commit.sha} />
        ) : (
          <FileDiffLayout files={files} lineThreads={lineThreads} />
        )}
      </div>
    </div>
  );
}

export default function CommitPage() {
  const params = useParams();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.repo as string}`;
  const sha = params.sha as string;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-[calc(100vh-56px)]">
          <CommitContent repository={repository} sha={sha} headRef={titlebarRef} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
