// A repository's history.
//
// One line per commit, and on each line what codecast knows about it: the
// session that wrote it, the tasks it names, the pull request it belongs to.
// That join is the whole reason this page exists instead of a link to GitHub.
import { useCallback, useMemo, type RefCallback } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { FileCode2, GitCommitHorizontal, History as HistoryIcon } from "lucide-react";
import { AuthGuard } from "../../../../components/AuthGuard";
import { CommentAvatar } from "../../../../components/comments/CommentAvatar";
import { DashboardLayout } from "../../../../components/DashboardLayout";
import { ExternalEventRow } from "../../../../components/feed/ExternalEventRow";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { CommitLinks } from "../../../../components/repo/CommitLinks";
import { BranchPicker, RepoHeader } from "../../../../components/repo/RepoChrome";
import { Button } from "../../../../components/ui/button";
import { useCoarseNow } from "../../../../hooks/useCoarseNow";
import { useRepoBranches, useRepoLog } from "../../../../hooks/useRepoBrowse";
import {
  useExternalEvents,
  useSyncRepositoryExternalEvents,
} from "../../../../hooks/useSyncExternalEvents";
import { useTitlebarHead } from "../../../../hooks/useTitlebarHead";
import { externalEventRowToExternalEvent } from "../../../../lib/externalEvents";
import { repoHistoryHref, repoTreeHref, splitCommitMessage } from "../../../../lib/repoView";
import { relTimeShort } from "../../../../lib/utils";
import "../../../../components/repo/repo.css";

function HistoryRail({ repository, branch }: { repository: string; branch: string }) {
  useSyncRepositoryExternalEvents(repository ? { repository, limit: 60 } : "skip");
  const events = useExternalEvents(
    useCallback((e: any) => e.repository === repository, [repository]),
  );

  return (
    <aside className="repo-rail w-[320px] shrink-0 border-l border-sol-border/50 bg-sol-bg-alt/20 overflow-y-auto">
      <div className="px-4 py-3 border-b border-sol-border/30">
        <h2 className="text-[10px] uppercase tracking-wider text-sol-text-dim">Recent activity</h2>
        <p className="mt-0.5 text-[11px] text-sol-text-dim">{branch}</p>
      </div>
      {events.length === 0 ? (
        <p className="px-4 py-6 text-[12px] text-sol-text-dim leading-relaxed">
          Pushes, reviews and check results on this repository appear here as they arrive.
        </p>
      ) : (
        <div className="px-2 py-2 space-y-0.5">
          {events.map((event: any) => (
            <ExternalEventRow
              key={event._id}
              event={externalEventRowToExternalEvent(event)}
              density="compact"
              showActor
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function HistoryContent({
  repository,
  headRef,
}: {
  repository: string;
  headRef: RefCallback<HTMLElement>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const now = useCoarseNow(60_000);

  const branches = useRepoBranches(repository);
  const branch = searchParams.get("branch") || branches.data?.default_branch || "";
  const log = useRepoLog(repository, branch || undefined, undefined);

  const rows = useMemo(
    () =>
      log.commits.map((commit) => ({
        ...commit,
        ...splitCommitMessage(commit.message),
      })),
    [log.commits],
  );

  return (
    <div className="repo-page h-full flex flex-col" style={{ ["--repo-accent" as string]: "var(--sol-cyan)" }}>
      <RepoHeader
        headRef={headRef}
        repository={repository}
        tab="history"
        historyHref={repoHistoryHref(repository, branch)}
        codeHref={repoTreeHref(repository, branch || "HEAD")}
        middle={
          branches.data ? (
            <BranchPicker
              branches={branches.data.branches}
              value={branch}
              defaultBranch={branches.data.default_branch}
              onPick={(next) => router.push(repoHistoryHref(repository, next))}
            />
          ) : null
        }
      />

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto">
          {branches.error && (
            <p className="px-4 py-3 text-[12px] text-sol-red">
              Branches could not be read: {branches.error.message}
            </p>
          )}
          {log.error && (
            <p className="px-4 py-3 text-[12px] text-sol-red">
              History could not be read: {log.error.message}
            </p>
          )}

          {rows.length === 0 && !log.ready && !log.error && <LoadingSkeleton />}

          {rows.length === 0 && log.ready && (
            <div className="px-6 py-16 text-center text-sol-text-muted">
              <HistoryIcon className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-[13px]">No commits on {branch || "this branch"}.</p>
            </div>
          )}

          <div className="divide-y divide-sol-border/25">
            {rows.map((commit, i) => (
              <div
                key={commit.sha}
                className="repo-row repo-rise group flex items-start gap-3 px-4 py-2.5 hover:bg-sol-bg-alt/40 transition-colors"
                style={{ ["--d" as string]: `${Math.min(i, 14) * 25}ms` }}
              >
                <CommentAvatar
                  name={commit.author_login || commit.author_name || "?"}
                  image={commit.author_avatar_url}
                  size={22}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <Link
                      href={`/commit/${repository}/${commit.sha}`}
                      className="text-[13px] text-sol-text hover:underline truncate"
                    >
                      {commit.subject || commit.sha.slice(0, 7)}
                    </Link>
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
                    <Link
                      href={`/commit/${repository}/${commit.sha}`}
                      className="font-mono hover:text-sol-text transition-colors"
                      style={{ color: "var(--repo-accent)" }}
                    >
                      {commit.sha.slice(0, 7)}
                    </Link>
                    <span>{commit.author_login || commit.author_name}</span>
                    <span title={new Date(commit.timestamp).toLocaleString()}>
                      {relTimeShort(commit.timestamp, now)}
                    </span>
                    <CommitLinks repository={repository} joins={commit} />
                  </div>
                </div>

                <div className="repo-row-actions flex items-center gap-1 shrink-0">
                  <Link
                    href={`/commit/${repository}/${commit.sha}`}
                    className="flex items-center gap-1 h-6 rounded border border-sol-border/50 px-1.5 text-[10px] text-sol-text-muted hover:text-sol-text"
                  >
                    <GitCommitHorizontal className="w-3 h-3" />
                    Open commit
                  </Link>
                  <Link
                    href={repoTreeHref(repository, commit.sha)}
                    className="flex items-center gap-1 h-6 rounded border border-sol-border/50 px-1.5 text-[10px] text-sol-text-muted hover:text-sol-text"
                  >
                    <FileCode2 className="w-3 h-3" />
                    Browse tree
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {rows.length > 0 && (
            <div className="flex justify-center py-6">
              {log.exhausted ? (
                <span className="text-[11px] text-sol-text-dim">That is the whole history we can read.</span>
              ) : (
                <Button variant="outline" size="sm" onClick={log.loadOlder} disabled={log.loadingMore}>
                  {log.loadingMore ? "Reading" : "Load older"}
                </Button>
              )}
            </div>
          )}
        </div>

        <HistoryRail repository={repository} branch={branch || "all branches"} />
      </div>
    </div>
  );
}

export default function RepoHistoryPage() {
  const params = useParams();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.name as string}`;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-[calc(100vh-56px)]">
          <HistoryContent repository={repository} headRef={titlebarRef} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
