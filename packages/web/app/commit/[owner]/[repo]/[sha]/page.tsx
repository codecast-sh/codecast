import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "../../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../../components/DashboardLayout";
import { FileDiffLayout, DiffFile } from "../../../../../components/FileDiffLayout";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { GitCommit, ExternalLink, User, Calendar, ArrowLeft, Copy, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../../../../components/ui/button";
import { cn, copyToClipboard } from "../../../../../lib/utils";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DiffStatsBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;

  const addPct = Math.round((additions / total) * 100);
  const maxBars = 5;
  const addBars = Math.round((additions / total) * maxBars);
  const delBars = maxBars - addBars;

  return (
    <div className="flex items-center gap-1" title={`+${additions} / -${deletions}`}>
      {Array.from({ length: addBars }).map((_, i) => (
        <div key={`add-${i}`} className="w-2 h-2 rounded-sm bg-sol-green" />
      ))}
      {Array.from({ length: delBars }).map((_, i) => (
        <div key={`del-${i}`} className="w-2 h-2 rounded-sm bg-sol-red" />
      ))}
    </div>
  );
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "p-1 rounded hover:bg-sol-bg-alt/50 transition-colors",
        className
      )}
      title={copied ? "Copied!" : "Copy to clipboard"}
    >
      {copied ? (
        <Check className="w-3 h-3 text-sol-green" />
      ) : (
        <Copy className="w-3 h-3 text-sol-text-dim" />
      )}
    </button>
  );
}

function CommitHeader({
  commit,
  repository,
  adjacentCommits,
}: {
  commit: {
    sha: string;
    message: string;
    author_name: string;
    author_email: string;
    timestamp: number;
    files_changed: number;
    insertions: number;
    deletions: number;
  };
  repository: string;
  adjacentCommits?: { prev?: string; next?: string };
}) {
  const shortSha = commit.sha.substring(0, 7);
  const commitLines = commit.message.split("\n");
  const commitTitle = commitLines[0];
  const commitBody = commitLines.slice(1).join("\n").trim();
  const githubUrl = `https://github.com/${repository}/commit/${commit.sha}`;
  const [owner, repo] = repository.split("/");

  return (
    <div className="px-4 py-3 border-b border-sol-border bg-sol-bg-alt/30">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sol-violet to-sol-violet/80 flex items-center justify-center shrink-0">
          <GitCommit className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-sol-text leading-snug">
                {commitTitle}
              </h2>
              {commitBody && (
                <pre className="mt-2 text-sm text-sol-text-muted whitespace-pre-wrap font-sans max-h-24 overflow-y-auto">
                  {commitBody}
                </pre>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {adjacentCommits?.prev && (
                <Link href={`/commit/${owner}/${repo}/${adjacentCommits.prev}`}>
                  <Button variant="ghost" size="sm" className="h-8 px-2" title="Previous commit">
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                </Link>
              )}
              {adjacentCommits?.next && (
                <Link href={`/commit/${owner}/${repo}/${adjacentCommits.next}`}>
                  <Button variant="ghost" size="sm" className="h-8 px-2" title="Next commit">
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </Link>
              )}
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm" className="h-8">
                  <ExternalLink className="w-3 h-3 mr-1.5" />
                  GitHub
                </Button>
              </a>
            </div>
          </div>

          <div className="flex items-center gap-4 mt-3 text-xs text-sol-text-muted flex-wrap">
            <div className="flex items-center gap-1">
              <code className="font-mono text-sol-violet bg-sol-violet/10 px-1.5 py-0.5 rounded">
                {shortSha}
              </code>
              <CopyButton text={commit.sha} />
            </div>
            <div className="flex items-center gap-1">
              <User className="w-3 h-3" />
              <span>{commit.author_name}</span>
            </div>
            <div className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              <span>{formatDate(commit.timestamp)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sol-green font-medium">+{commit.insertions}</span>
              <span className="text-sol-red font-medium">-{commit.deletions}</span>
              <DiffStatsBar additions={commit.insertions} deletions={commit.deletions} />
              <span className="text-sol-text-dim">
                ({commit.files_changed} {commit.files_changed === 1 ? "file" : "files"})
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommitContent() {
  const params = useParams();
  const owner = params.owner as string;
  const repo = params.repo as string;
  const sha = params.sha as string;
  const repository = `${owner}/${repo}`;

  const commit = useQuery(api.commits.getCommitBySha, { sha });
  const repoCommits = useQuery(
    api.commits.getCommitsByRepository,
    commit?.repository ? { repository: commit.repository, limit: 50 } : "skip"
  );

  const adjacentCommits = (() => {
    if (!repoCommits || !commit) return undefined;
    const idx = repoCommits.findIndex((c) => c.sha === commit.sha);
    if (idx === -1) return undefined;
    return {
      prev: idx < repoCommits.length - 1 ? repoCommits[idx + 1].sha : undefined,
      next: idx > 0 ? repoCommits[idx - 1].sha : undefined,
    };
  })();

  if (commit === undefined) {
    return <LoadingSkeleton />;
  }

  if (!commit) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-sol-text-muted">
        <GitCommit className="w-12 h-12 mb-4 opacity-30" />
        <h2 className="text-lg font-medium mb-2">Commit not found</h2>
        <p className="text-sm mb-4">
          The commit <code className="font-mono text-sol-violet">{sha.substring(0, 7)}</code> was
          not found in our database.
        </p>
        <p className="text-xs text-sol-text-dim mb-4">
          Try syncing your GitHub repositories from the timeline.
        </p>
        <a
          href={`https://github.com/${repository}/commit/${sha}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button variant="outline">
            <ExternalLink className="w-4 h-4 mr-2" />
            View on GitHub
          </Button>
        </a>
      </div>
    );
  }

  const files: DiffFile[] = (commit.files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch,
  }));

  if (files.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <CommitHeader commit={commit} repository={repository} adjacentCommits={adjacentCommits} />
        <div className="flex-1 flex items-center justify-center text-sol-text-muted">
          <div className="text-center">
            <GitCommit className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No file changes in this commit</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <CommitHeader commit={commit} repository={repository} adjacentCommits={adjacentCommits} />
      <div className="flex-1 min-h-0">
        <FileDiffLayout
          files={files}
          sidebarHeader={
            commit.conversation_id ? (
              <div className="px-3 py-2 border-b border-sol-border/50">
                <Link
                  href={`/conversation/${commit.conversation_id}`}
                  className="text-xs text-sol-yellow hover:underline flex items-center gap-1.5"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow" />
                  View coding session
                </Link>
              </div>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

export default function CommitPage() {
  const params = useParams();
  const owner = params.owner as string;
  const repo = params.repo as string;
  const sha = params.sha as string;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-[calc(100vh-56px)] flex flex-col">
          <div className="px-4 py-2 border-b border-sol-border bg-sol-bg flex items-center gap-3">
            <Link href="/timeline">
              <Button variant="ghost" size="sm" className="h-8">
                <ArrowLeft className="w-4 h-4 mr-1" />
                Timeline
              </Button>
            </Link>
            <div className="flex items-center gap-1.5 text-sm text-sol-text-muted">
              <a
                href={`https://github.com/${owner}/${repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:text-sol-violet transition-colors"
              >
                {owner}/{repo}
              </a>
              <span className="text-sol-text-dim">/</span>
              <span className="font-mono text-sol-text-dim">{sha.substring(0, 7)}</span>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <CommitContent />
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
