"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "../../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../../components/DashboardLayout";
import { FileDiffLayout, DiffFile } from "../../../../../components/FileDiffLayout";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { GitCommit, ExternalLink, User, Calendar, ArrowLeft } from "lucide-react";
import { Button } from "../../../../../components/ui/button";

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

function CommitHeader({
  commit,
  repository,
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
}) {
  const shortSha = commit.sha.substring(0, 7);
  const commitLines = commit.message.split("\n");
  const commitTitle = commitLines[0];
  const commitBody = commitLines.slice(1).join("\n").trim();
  const githubUrl = `https://github.com/${repository}/commit/${commit.sha}`;

  return (
    <div className="px-4 py-3 border-b border-sol-border bg-sol-bg-alt/30">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sol-violet to-sol-violet/80 flex items-center justify-center shrink-0">
          <GitCommit className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-sol-text leading-snug">
                {commitTitle}
              </h2>
              {commitBody && (
                <pre className="mt-2 text-sm text-sol-text-muted whitespace-pre-wrap font-sans">
                  {commitBody}
                </pre>
              )}
            </div>
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0"
            >
              <Button variant="outline" size="sm" className="h-8">
                <ExternalLink className="w-3 h-3 mr-1.5" />
                GitHub
              </Button>
            </a>
          </div>

          <div className="flex items-center gap-4 mt-3 text-xs text-sol-text-muted flex-wrap">
            <div className="flex items-center gap-1.5">
              <code className="font-mono text-sol-violet bg-sol-violet/10 px-1.5 py-0.5 rounded">
                {shortSha}
              </code>
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

  const shortSha = commit.sha.substring(0, 7);
  const repoName = commit.repository?.split("/").pop() || repo;

  return (
    <div className="h-full flex flex-col">
      <CommitHeader commit={commit} repository={repository} />
      <div className="flex-1 min-h-0">
        <FileDiffLayout
          files={files}
          title={`Commit ${shortSha}`}
          subtitle={
            <div className="flex items-center gap-2 text-sm text-sol-text-muted">
              <span className="font-mono">{repoName}</span>
              {commit.conversation_id && (
                <>
                  <span className="text-sol-text-dim">-</span>
                  <Link
                    href={`/conversation/${commit.conversation_id}`}
                    className="text-sol-yellow hover:underline"
                  >
                    View session
                  </Link>
                </>
              )}
            </div>
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
            <div className="text-sm text-sol-text-muted">
              <span className="font-mono">{owner}/{repo}</span>
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
