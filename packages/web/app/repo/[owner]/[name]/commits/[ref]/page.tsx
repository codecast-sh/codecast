// A repository's commit history at one ref.
//
// One line per commit, and on each line what codecast knows about it: the
// session that wrote it, the tasks it names, the pull request it belongs to.
// That join is the whole reason this page exists instead of a link to GitHub.
//
// With `?path=` it is the history of one file, and with `?author=` the history
// of one person.
import { Fragment, useCallback, useMemo, type RefCallback } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { FileCode2, GitCommitHorizontal, History as HistoryIcon } from "lucide-react";
import { CommentAvatar } from "../../../../../../components/comments/CommentAvatar";
import { ExternalEventRow } from "../../../../../../components/feed/ExternalEventRow";
import { LoadingSkeleton } from "../../../../../../components/LoadingSkeleton";
import { CommitLinks } from "../../../../../../components/repo/CommitLinks";
import { BranchPicker, RepoHeader } from "../../../../../../components/repo/RepoChrome";
import { RepoPageShell } from "../../../../../../components/repo/RepoPageShell";
import { useRepoFamily } from "../../../../../../components/repo/useRepoFamily";
import { Button } from "../../../../../../components/ui/button";
import { useCoarseNow } from "../../../../../../hooks/useCoarseNow";
import { useRepoBranches, useRepoLog } from "../../../../../../hooks/useRepoBrowse";
import {
  useExternalEvents,
  useSyncRepositoryExternalEvents,
} from "../../../../../../hooks/useSyncExternalEvents";
import { useTitlebarHead } from "../../../../../../hooks/useTitlebarHead";
import { externalEventRowToExternalEvent } from "../../../../../../lib/externalEvents";
import {
  commitPageHref,
  repoCommitsHref,
  repoTreeHref,
  splitCommitMessage,
  type RepoRouteFamily,
} from "../../../../../../lib/repoView";
import { serverErrorText } from "../../../../../../lib/errorCause";
import { relTimeShort } from "../../../../../../lib/utils";
import { useRepoTransport } from "../../../../../../lib/repoTransport";
import "../../../../../../components/repo/repo.css";

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

function CommitsContent({
  repository,
  refName,
  family,
  headRef,
}: {
  repository: string;
  refName: string;
  family: RepoRouteFamily;
  headRef: RefCallback<HTMLElement>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const now = useCoarseNow(60_000);

  const filePath = searchParams.get("path") || undefined;
  const author = searchParams.get("author") || undefined;

  const branches = useRepoBranches(repository);
  const branch = refName || branches.data?.default_branch || "";
  const log = useRepoLog(repository, branch || undefined, filePath, author);
  const mode = useRepoTransport();

  const rows = useMemo(() => log.commits.map((commit) => ({ ...commit, ...splitCommitMessage(commit.message),
    date: new Date(commit.timestamp).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) })), [log.commits]);

  return (
    <div className="repo-page h-full flex flex-col" style={{ ["--repo-accent" as string]: "var(--sol-cyan)" }}>
      <RepoHeader
        headRef={headRef}
        repository={repository}
        tab="commits"
        refName={branch || "HEAD"}
        family={family}
        middle={
          branches.data ? (
            <BranchPicker
              branches={branches.data.branches}
              value={branch}
              defaultBranch={branches.data.default_branch}
              onPick={(next) => router.push(repoCommitsHref(repository, next, { path: filePath, author, family }))}
            />
          ) : null
        }
      />

      <form key={`${filePath}:${author}`} className="flex gap-2 px-4 py-2 border-b border-sol-border/30" onSubmit={(event) => {
        event.preventDefault(); const fields = new FormData(event.currentTarget);
        router.push(repoCommitsHref(repository, branch || "HEAD", { path: String(fields.get("path") || "") || undefined, author: String(fields.get("author") || "") || undefined, family }));
      }}>
        <input name="author" aria-label="Filter commits by author" placeholder="Author username or email" defaultValue={author} className="bg-transparent border border-sol-border/50 rounded px-2 py-1 text-xs min-w-0" />
        <input name="path" aria-label="Filter commits by path" placeholder="Path in repository" defaultValue={filePath} className="bg-transparent border border-sol-border/50 rounded px-2 py-1 text-xs min-w-0 flex-1" />
        <button className="text-xs text-sol-blue">Filter</button>
      </form>
      {(filePath || author) && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30 text-[12px] text-sol-text-muted shrink-0">
          <span>
            {filePath ? (
              <>
                History of <code className="font-mono text-sol-text">{filePath}</code>
              </>
            ) : (
              "Every commit"
            )}
            {author ? (
              <>
                {" "}by <span className="text-sol-text">{author}</span>
              </>
            ) : null}
          </span>
          <Link
            href={repoCommitsHref(repository, branch || "HEAD", { family })}
            className="ml-auto text-sol-text-dim hover:text-sol-text transition-colors"
          >
            Clear
          </Link>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto">
          {branches.error && (
            <p className="px-4 py-3 text-[12px] text-sol-red">
              Branches could not be read: {serverErrorText(branches.error)}
            </p>
          )}
          {log.error && (
            <p className="px-4 py-3 text-[12px] text-sol-red">
              History could not be read: {serverErrorText(log.error)}
            </p>
          )}

          {rows.length === 0 && !log.ready && !log.error && <LoadingSkeleton />}

          {rows.length === 0 && log.ready && (
            <div className="px-6 py-16 text-center text-sol-text-muted">
              <HistoryIcon className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-[13px]">
                {author && log.commits.length > 0
                  ? `Nothing by ${author} in the commits read so far.`
                  : `No commits on ${branch || "this branch"}.`}
              </p>
            </div>
          )}

          <div className="divide-y divide-sol-border/25">
            {rows.map((commit, i) => (
              <Fragment key={commit.sha}>
              {(i === 0 || rows[i - 1].date !== commit.date) && <h2 className="px-4 py-3 text-xs text-sol-text-muted bg-sol-bg-alt/30">{commit.date}</h2>}
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
                      href={commitPageHref(repository, commit.sha, family)}
                      className="text-[13px] text-sol-text hover:underline truncate"
                    >
                      {commit.subject || commit.sha.slice(0, 7)}
                    </Link>
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
                    <Link
                      href={commitPageHref(repository, commit.sha, family)}
                      className="font-mono hover:text-sol-text transition-colors"
                      style={{ color: "var(--repo-accent)" }}
                    >
                      {commit.sha.slice(0, 7)}
                    </Link>
                    <Link
                      href={repoCommitsHref(repository, branch || "HEAD", {
                        path: filePath,
                        author: commit.author_login || commit.author_name || undefined,
                        family,
                      })}
                      className="hover:text-sol-text transition-colors"
                    >
                      {commit.author_login || commit.author_name}
                    </Link>
                    <span title={new Date(commit.timestamp).toLocaleString()}>
                      {relTimeShort(commit.timestamp, now)}
                    </span>
                    {mode === "convex" && <CommitLinks repository={repository} joins={commit} />}
                    {commit.additions !== undefined && <span className="text-sol-green">+{commit.additions}</span>}
                    {commit.deletions !== undefined && <span className="text-sol-red">−{commit.deletions}</span>}
                    {commit.changed_files != null && <span>{commit.changed_files} files</span>}
                  </div>
                </div>

                <div className="repo-row-actions flex items-center gap-1 shrink-0">
                  <Link
                    href={commitPageHref(repository, commit.sha, family)}
                    className="flex items-center gap-1 h-6 rounded border border-sol-border/50 px-1.5 text-[10px] text-sol-text-muted hover:text-sol-text"
                  >
                    <GitCommitHorizontal className="w-3 h-3" />
                    Open commit
                  </Link>
                  <Link
                    href={repoTreeHref(repository, commit.sha, undefined, family)}
                    className="flex items-center gap-1 h-6 rounded border border-sol-border/50 px-1.5 text-[10px] text-sol-text-muted hover:text-sol-text"
                  >
                    <FileCode2 className="w-3 h-3" />
                    Browse tree
                  </Link>
                </div>
              </div></Fragment>
            ))}
          </div>

          {log.commits.length > 0 && (
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

        {mode === "convex" && <HistoryRail repository={repository} branch={branch || "all branches"} />}
      </div>
    </div>
  );
}

export default function RepoCommitsPage() {
  const params = useParams();
  const family = useRepoFamily();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.name as string}`;
  const refName = decodeURIComponent((params.ref as string) ?? "");

  return (
    <RepoPageShell repository={repository}>
      <CommitsContent repository={repository} refName={refName} family={family} headRef={titlebarRef} />
    </RepoPageShell>
  );
}
