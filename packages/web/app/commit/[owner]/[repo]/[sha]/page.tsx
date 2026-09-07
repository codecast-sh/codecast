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
import { Group, Panel, Separator } from "react-resizable-panels";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { codeThreadRootKey } from "@codecast/shared/comments";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  MessageSquare,
} from "lucide-react";
import { CommentAvatar } from "../../../../../components/comments/CommentAvatar";
import { BlobContent } from "../../../../../components/repo/BlobContent";
import { CommitRail } from "../../../../../components/repo/CommitRail";
import { RepoPageShell } from "../../../../../components/repo/RepoPageShell";
import { RepoWindowControl } from "../../../../../components/repo/RepoWindowControl";
import { useRepoFamily } from "../../../../../components/repo/useRepoFamily";
import { FileDiffLayout, type DiffFile, type FileLineThreads } from "../../../../../components/FileDiffLayout";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PRLineThread } from "../../../../../components/pr/PRThread";
import { CommitLinks } from "../../../../../components/repo/CommitLinks";
import { Button } from "../../../../../components/ui/button";
import { useCodeComments, useSyncRefCodeComments } from "../../../../../hooks/useSyncCodeComments";
import { useAttributedSession, useLineComments } from "../../../../../hooks/useLineComments";
import { useCoarseNow } from "../../../../../hooks/useCoarseNow";
import { useQueryNoThrow } from "../../../../../hooks/useQueryNoThrow";
import { useEnsureCommitFiles } from "../../../../../hooks/useRepoBrowse";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import {
  useCommit,
  useCommits,
  usePullRequest,
  useSyncCommit,
  useSyncPullRequest,
} from "../../../../../hooks/useSyncTimeline";
import { useTitlebarHead } from "../../../../../hooks/useTitlebarHead";
import { serverErrorText } from "../../../../../lib/errorCause";
import { serverCommentId, threadSide, type CodeCommentRow } from "../../../../../lib/prView";
import {
  commitBalanceAccent,
  commitPageHref,
  repoBlobHref,
  repoCommitsHref,
  repoHomeHref,
  repoTreeHref,
  splitCommitMessage,
} from "../../../../../lib/repoView";
import { cn, copyToClipboard, relTimeShort } from "../../../../../lib/utils";
import "../../../../../components/repo/repo.css";

// `api` is a proxy, so naming a function prod has not deployed yet still
// produces a reference; useQueryNoThrow then reports the miss as an error
// and the arrows fall back to what the store knows.
const api = _api as any;

/** One commit beside this one: enough to link it and name it on hover. */
type Neighbour = { sha: string; message?: string };
type Neighbours = { older?: Neighbour; newer?: Neighbour };

/** How wide the page must be before the discussion rail opens on its own. */
const RAIL_AUTO_OPEN_WIDTH = 1180;

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

function NeighbourArrow({
  repository,
  neighbour,
  direction,
}: {
  repository: string;
  neighbour: Neighbour | undefined;
  direction: "newer" | "older";
}) {
  const family = useRepoFamily();
  const Icon = direction === "newer" ? ChevronLeft : ChevronRight;
  const label = direction === "newer" ? "Newer commit" : "Older commit";
  const title = neighbour
    ? `${label}: ${splitCommitMessage(neighbour.message).subject || neighbour.sha.slice(0, 7)}`
    : `No ${direction} commit known`;
  const button = (
    <Button variant="ghost" size="sm" className="h-7 px-1.5" disabled={!neighbour} aria-label={label}>
      <Icon className="w-4 h-4" />
    </Button>
  );
  if (!neighbour) return <span title={title}>{button}</span>;
  return (
    <Link href={commitPageHref(repository, neighbour.sha, family)} title={title}>
      {button}
    </Link>
  );
}

function CommitHeader({
  commit,
  repository,
  neighbours,
  headRef,
  threadCount,
  railOpen,
  onToggleRail,
}: {
  commit: any;
  repository: string;
  neighbours: Neighbours;
  headRef?: RefCallback<HTMLElement>;
  threadCount: number;
  railOpen: boolean;
  onToggleRail: () => void;
}) {
  const now = useCoarseNow(60_000);
  const family = useRepoFamily();
  const { subject, body } = splitCommitMessage(commit.message);
  const [owner, name] = repository.split("/");

  return (
    <header ref={headRef} className="repo-band border-b border-sol-border/60 px-4 py-3 shrink-0">
      <div className="flex items-start gap-3">
        <GitCommitHorizontal className="w-5 h-5 mt-1 shrink-0" style={{ color: "var(--repo-accent)" }} />
        <div className="min-w-0 flex-1">
          {/* The same breadcrumb the source pages carry, so a commit is one
              click from its repository and two from the index. */}
          <div
            className="repo-rise flex items-baseline gap-1 text-[12px] mb-0.5"
            style={{ ["--d" as string]: "0ms" }}
          >
            <Link href="/repo" className="text-sol-text-muted hover:text-sol-text transition-colors">
              {owner}
            </Link>
            <span className="text-sol-text-dim">/</span>
            <Link
              href={repoHomeHref(repository, family)}
              className="text-sol-text-muted hover:text-sol-text transition-colors truncate"
            >
              {name}
            </Link>
          </div>
          <h1
            className="repo-rise font-serif text-[22px] leading-tight text-sol-text"
            style={{ ["--d" as string]: "40ms" }}
          >
            {subject}
          </h1>
          {body && (
            <pre className="repo-rise mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-sol-text-muted" style={{ ["--d" as string]: "80ms" }}>
              {body}
            </pre>
          )}

          <div
            className="repo-rise mt-2.5 flex items-center gap-3 flex-wrap text-[11px] text-sol-text-dim"
            style={{ ["--d" as string]: "120ms" }}
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
                href={repoCommitsHref(repository, commit.branch, { family })}
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

          <div className="repo-rise mt-2" style={{ ["--d" as string]: "160ms" }}>
            <CommitLinks repository={repository} joins={commit} />
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Both arrows, always: a disabled one says the history ends here,
              where a missing one only said the page had not looked. */}
          <NeighbourArrow repository={repository} neighbour={neighbours.newer} direction="newer" />
          <NeighbourArrow repository={repository} neighbour={neighbours.older} direction="older" />
          <button
            type="button"
            onClick={onToggleRail}
            aria-pressed={railOpen}
            className={cn(
              "flex items-center gap-1.5 h-7 rounded-md border px-2 text-[12px] transition-colors",
              railOpen
                ? "border-transparent text-sol-bg"
                : "border-sol-border/60 text-sol-text-muted hover:text-sol-text hover:border-sol-border",
            )}
            style={railOpen ? { background: "var(--repo-accent)" } : undefined}
            title={railOpen ? "Hide the discussion" : "Show the discussion"}
          >
            <MessageSquare className="w-3 h-3" />
            {threadCount > 0 && <span className="tabular-nums">{threadCount}</span>}
          </button>
          <Link href={repoTreeHref(repository, commit.sha, undefined, family)}>
            <Button variant="outline" size="sm" className="h-7">
              Browse tree
            </Button>
          </Link>
          <RepoWindowControl />
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
  const family = useRepoFamily();
  return (
    <div className="h-full flex flex-col items-center justify-center text-sol-text-muted px-6 text-center">
      <GitCommitHorizontal className="w-10 h-10 mb-3 opacity-30" />
      <h2 className="text-base font-medium mb-1">Commit not found</h2>
      <p className="text-[13px] mb-4">
        <code className="font-mono text-sol-violet">{sha.slice(0, 7)}</code> in{" "}
        <code className="font-mono">{repository}</code> is not in this workspace.
      </p>
      <div className="flex items-center gap-2">
        <Link href={repoHomeHref(repository, family)}>
          <Button variant="outline">Browse the repository</Button>
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
 * the page asks the backend to fetch them once. Those patches are written onto
 * the commit row itself, and the row is what this page reads, so a successful
 * fetch replaces this whole component with the diff. Everything below is
 * therefore a reason the diff is not coming, said plainly.
 */
function CommitWithoutFiles({ repository, sha }: { repository: string; sha: string }) {
  const fetchFiles = useEnsureCommitFiles(repository, sha, true);

  // `unknown_commit` means the backend found no commit row for this sha under
  // this repository. The page only renders here when a row DOES exist, so the
  // one way to see it is a URL naming a different repository than the commit.
  const explanation = fetchFiles.error
    ? serverErrorText(fetchFiles.error)
    : fetchFiles.reason === "unknown_commit"
      ? "This commit belongs to a different repository than the one in the address, so its diff is not here to fetch."
      : "A merge commit with no combined diff looks like this, and so does a commit whose files GitHub no longer serves.";

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 text-center text-sol-text-muted">
      {fetchFiles.pending ? (
        <p className="text-[13px]">Reading this commit's diff.</p>
      ) : fetchFiles.reason === "requested" ? (
        // A checkout that publishes this repository was asked, and the commit
        // row updates itself when the answer lands. GitHub answers instead if
        // no checkout can.
        <p className="text-[13px]">Reading this commit's diff from a checkout of this repository. It arrives as soon as that machine answers.</p>
      ) : (
        <>
          <p className="text-[13px] mb-1">
            {fetchFiles.error
              ? "The diff for this commit could not be read."
              : "No file changes to show for this commit."}
          </p>
          <p className="text-[12px] text-sol-text-dim mb-4 max-w-md leading-relaxed">{explanation}</p>
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
  const commit = useCommit(sha);

  // Neighbours: the server answers with the nearest commits by time on the
  // same branch (commits.neighbours), which is cheap and complete. Until it
  // does, or when this build's backend is older than the page, the arrows
  // fall back to whatever of this repository's commits the store holds.
  const family = useRepoFamily();
  const neighbourQuery = useQueryNoThrow(api.commits.neighbours, { repository, sha });
  const repoCommits = useCommits(useCallback((c: any) => c.repository === repository, [repository]));
  const neighbours: Neighbours = useMemo(() => {
    const served = neighbourQuery.data as Neighbours | null | undefined;
    if (served && (served.older || served.newer)) return served;
    const index = repoCommits.findIndex((c: any) => c.sha === sha);
    if (index === -1) return {};
    const pick = (c: any) => (c ? { sha: c.sha, message: c.message } : undefined);
    return {
      newer: index > 0 ? pick(repoCommits[index - 1]) : undefined,
      older: index < repoCommits.length - 1 ? pick(repoCommits[index + 1]) : undefined,
    };
  }, [neighbourQuery.data, repoCommits, sha]);

  // The pull request this commit belongs to, when it has one. A comment then
  // names it directly (`pull_request_id`), which is the one thing the server
  // cannot work out from the file path alone.
  useSyncPullRequest(commit?.pr_number ? { repository, number: commit.pr_number } : "skip");
  const pr = usePullRequest(repository, commit?.pr_number ?? -1);

  const searchParams = useSearchParams();
  const conversationId = useAttributedSession(searchParams.get("session"));

  // The discussion rail opens on its own on a wide page and folds away on a
  // narrow one; the button in the header overrides either. A link that names
  // a file (`?file=`, from a Threads card) also opens the diff on that file.
  const [railOpen, setRailOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= RAIL_AUTO_OPEN_WIDTH,
  );
  const [focusFile, setFocusFile] = useState<string | null>(() => searchParams.get("file"));
  useWatchEffect(() => {
    const file = searchParams.get("file");
    if (file) setFocusFile(file);
  }, [searchParams]);
  // The file open beside the diff, whole, at this commit.
  const [openFile, setOpenFile] = useState<{ path: string; line?: number } | null>(null);

  useSyncRefCodeComments(repository, sha);
  const comments = useCodeComments(
    useCallback((c: CodeCommentRow) => c.repository === repository && c.ref === sha, [repository, sha]),
  );

  // No `mirror` here on purpose. The server mirrors unless told not to, and it
  // already checks that an OPEN pull request touches the file. Gating on "this
  // commit belongs to an open PR" was narrower than that rule and hid comments
  // on files a live review does cover.
  const lineComments = useLineComments({
    repository,
    ref: sha,
    comments,
    conversationId,
  });

  const lineThreads: FileLineThreads = useMemo(
    () => ({
      threadsFor: (filename) => lineComments.threadsByFile.get(filename),
      render: (filename, anchor, items) => (
        <PRLineThread
          repository={repository}
          threadKey={codeThreadRootKey(repository, sha, { file_path: filename, line_number: anchor.lineNumber })}
          comments={items as CodeCommentRow[]}
          authed={lineComments.authed}
          lineNumber={anchor.lineNumber}
          lineEnd={anchor.lineEnd}
          onReply={(content) =>
            lineComments.post({
              file_path: filename,
              // The anchor is the first line either way; line_end is set only
              // when the comment covers a run, which is what GitHub expects.
              line_number: anchor.lineNumber,
              line_end: anchor.lineEnd,
              // A reply belongs on the side of the thread it answers; a new
              // thread on the side the reader clicked.
              side: items.length ? threadSide(items as CodeCommentRow[]) : anchor.side,
              content,
              parent_id: serverCommentId((items as CodeCommentRow[])[0]?._id),
              ...(pr?.state === "open" ? { pull_request_id: pr._id } : {}),
            })
          }
          onResolve={(resolved) => lineComments.setThreadResolved(items as CodeCommentRow[], resolved)}
          onClose={lineComments.closeComposer}
        />
      ),
      onComment: (filename, anchor) => {
        if (anchor) lineComments.openComposer(filename, anchor);
      },
    }),
    [lineComments, pr, repository, sha],
  );

  // Every thread, on the commit or on a line, for the header's count.
  const threadCount = useMemo(() => {
    let n = comments.filter((c) => !c.file_path && !c.parent_id).length;
    for (const byLine of lineComments.threadsByFile.values()) {
      for (const thread of byLine.values()) if (thread.length) n += 1;
    }
    return n;
  }, [comments, lineComments.threadsByFile]);

  const fileHref = useCallback(
    (path: string) => repoBlobHref(repository, sha, path, family),
    [repository, sha, family],
  );
  const openWholeFile = useCallback((path: string) => setOpenFile({ path }), []);
  const jumpToThread = useCallback((path: string) => {
    // A fresh value each time, so the same file can be jumped to twice.
    setFocusFile(null);
    requestAnimationFrame(() => setFocusFile(path));
  }, []);

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
        threadCount={threadCount}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((v) => !v)}
      />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0">
          {files.length === 0 ? (
            <CommitWithoutFiles repository={repository} sha={commit.sha} />
          ) : (
            <Group
              // Re-keyed when the file panel comes or goes, so the group lays
              // the two panels out afresh instead of squeezing the newcomer.
              key={openFile ? "with-file" : "diff-only"}
              orientation="horizontal"
              className="h-full"
              defaultLayout={openFile ? { "commit-diff": 54, "commit-file": 46 } : { "commit-diff": 100 }}
            >
              <Panel id="commit-diff" minSize={30}>
                <FileDiffLayout
                  files={files}
                  lineThreads={lineThreads}
                  focusFile={focusFile}
                  fileHref={fileHref}
                  onOpenFile={openWholeFile}
                />
              </Panel>
              {openFile && (
                <>
                  <Separator className="cc-split" />
                  <Panel id="commit-file" minSize={25}>
                    <div className="h-full flex flex-col bg-sol-bg border-l border-sol-border/40">
                      <BlobContent
                        key={openFile.path}
                        repository={repository}
                        refName={commit.sha}
                        path={openFile.path}
                        panel={{ onClose: () => setOpenFile(null), line: openFile.line }}
                      />
                    </div>
                  </Panel>
                </>
              )}
            </Group>
          )}
        </div>
        {railOpen && (
          <aside className="commit-rail w-[340px] shrink-0 border-l border-sol-border/50 bg-sol-bg-alt/20 min-h-0">
            <CommitRail
              repository={repository}
              sha={commit.sha}
              comments={comments}
              lineComments={lineComments}
              pullRequestId={pr?.state === "open" ? pr._id : undefined}
              onJump={jumpToThread}
            />
          </aside>
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
    <RepoPageShell repository={repository}>
      <CommitContent repository={repository} sha={sha} headRef={titlebarRef} />
    </RepoPageShell>
  );
}
