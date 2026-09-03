// One file at one ref.
//
// The reading surface: highlighted source, line numbers that are anchors, an
// optional blame gutter, and comments written straight onto a line. A comment
// here is a codecast object first, so it carries the session the reader came
// from and shows up beside the code without a pull request existing.
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Download, ExternalLink, UserSquare2 } from "lucide-react";
import { AuthGuard } from "../../../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../../../components/DashboardLayout";
import { LoadingSkeleton } from "../../../../../../components/LoadingSkeleton";
import { PRLineThread } from "../../../../../../components/pr/PRThread";
import { BlobView } from "../../../../../../components/repo/BlobView";
import { RepoHeader } from "../../../../../../components/repo/RepoChrome";
import { useCodeComments, useSyncFileCodeComments } from "../../../../../../hooks/useSyncCodeComments";
import { useAttributedSession, useLineComments } from "../../../../../../hooks/useLineComments";
import { useMountEffect } from "../../../../../../hooks/useMountEffect";
import { useRepoBlame, useRepoBlob, useRepoBranches } from "../../../../../../hooks/useRepoBrowse";
import { useTitlebarHead } from "../../../../../../hooks/useTitlebarHead";
import { useWatchEffect } from "../../../../../../hooks/useWatchEffect";
import type { CodeCommentRow } from "../../../../../../lib/prView";
import {
  breadcrumbTrail,
  extendLineRange,
  formatLineHash,
  formatSize,
  parseLineHash,
  repoHistoryHref,
  repoTreeHref,
  type LineRange,
} from "../../../../../../lib/repoView";
import { cn } from "../../../../../../lib/utils";
import "../../../../../../components/repo/repo.css";

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** The end of a comment's anchor: the selection's last line when the composer
 *  opened inside a multi-line selection, and nothing when it is one line. */
function commentRangeEnd(selection: LineRange | null, line: number): number | undefined {
  if (!selection || selection.start === selection.end) return undefined;
  return line >= selection.start && line <= selection.end ? selection.end : undefined;
}

function FileCrumb({
  repository,
  refName,
  path,
}: {
  repository: string;
  refName: string;
  path: string;
}) {
  const trail = breadcrumbTrail(path);
  return (
    <div className="flex items-center gap-1 px-4 pb-2 text-[12px] flex-wrap">
      <Link href={repoTreeHref(repository, refName)} className="text-sol-text-muted hover:text-sol-text">
        {repository.split("/")[1]}
      </Link>
      {trail.map((crumb, i) => (
        <span key={crumb.path} className="flex items-center gap-1">
          <span className="text-sol-text-dim">/</span>
          {i === trail.length - 1 ? (
            <span className="text-sol-text">{crumb.name}</span>
          ) : (
            <Link
              href={repoTreeHref(repository, refName, crumb.path)}
              className="text-sol-text-muted hover:text-sol-text"
            >
              {crumb.name}
            </Link>
          )}
        </span>
      ))}
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1.5 h-7 rounded-md border px-2 text-[12px] transition-colors",
        active
          ? "border-transparent text-sol-bg"
          : "border-sol-border/60 text-sol-text-muted hover:text-sol-text hover:border-sol-border",
      )}
      style={active ? { background: "var(--repo-accent)" } : undefined}
    >
      {children}
    </button>
  );
}

function BlobContent({
  repository,
  refName,
  path,
}: {
  repository: string;
  refName: string;
  path: string;
}) {
  const [blameOn, setBlameOn] = useState(false);
  const [selection, setSelection] = useState<LineRange | null>(null);

  const blob = useRepoBlob(repository, refName, path);
  const blame = useRepoBlame(repository, refName, path, blameOn);
  const branches = useRepoBranches(repository);

  // The commit a comment is anchored to. A ref that is already a sha is its own
  // answer; a branch name resolves to the tip we last read.
  const anchorRef = useMemo(() => {
    if (FULL_SHA.test(refName)) return refName;
    return branches.data?.branches.find((b) => b.name === refName)?.sha ?? refName;
  }, [refName, branches.data]);

  const searchParams = useSearchParams();
  const conversationId = useAttributedSession(searchParams.get("session"));

  useSyncFileCodeComments(repository, path);
  const comments = useCodeComments(
    useCallback(
      (c: CodeCommentRow) => c.repository === repository && c.file_path === path,
      [repository, path],
    ),
  );

  const lineComments = useLineComments({
    repository,
    ref: anchorRef,
    comments,
    conversationId,
  });
  const threadsByLine = lineComments.threadsByFile.get(path);

  // The URL names the selection, and selecting rewrites it in place: a line
  // anchor is a bookmark, not a step in the reader's history.
  useMountEffect(() => {
    setSelection(parseLineHash(window.location.hash));
  });

  const selectLine = useCallback((line: number, extend: boolean) => {
    setSelection((current) => {
      const next = extend ? extendLineRange(current, line) : { start: line, end: line };
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${formatLineHash(next)}`,
      );
      return next;
    });
  }, []);

  // A deep link lands on its line once the file is on screen.
  const ready = blob.ready && !!blob.data;
  useWatchEffect(() => {
    if (!ready || !selection) return;
    const el = document.getElementById(`L${selection.start}`);
    el?.scrollIntoView({ block: "center" });
  }, [ready]);

  if (blob.error) {
    return (
      <div className="px-6 py-10 text-[13px] text-sol-text-muted">
        <p className="mb-3">This file could not be read: {blob.error.message}</p>
        <a
          href={`https://github.com/${repository}/blob/${refName}/${path}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sol-blue hover:underline"
        >
          Open it on GitHub
        </a>
      </div>
    );
  }

  if (!blob.data) return <LoadingSkeleton />;

  const lineCount = blob.data.content.split("\n").length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30 shrink-0 flex-wrap">
        <span className="text-[11px] text-sol-text-dim tabular-nums">
          {lineCount} lines · {formatSize(blob.data.size)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ToolbarButton
            active={blameOn}
            onClick={() => setBlameOn((v) => !v)}
            title="Who last touched each line"
          >
            <UserSquare2 className="w-3.5 h-3.5" />
            Blame
          </ToolbarButton>
          <a
            href={`https://raw.githubusercontent.com/${repository}/${refName}/${path}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-muted hover:text-sol-text hover:border-sol-border transition-colors"
          >
            <Download className="w-3 h-3" />
            Raw
          </a>
          <a
            href={`https://github.com/${repository}/blob/${refName}/${path}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-muted hover:text-sol-text hover:border-sol-border transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            GitHub
          </a>
        </div>
      </div>

      {blob.data.truncated && (
        <p className="px-4 py-2 text-[11px] text-sol-yellow border-b border-sol-border/30 shrink-0">
          This file is too large to fetch whole, so nothing below is the file. Open it on GitHub or
          fetch it raw.
        </p>
      )}
      {blameOn && blame.error && (
        <p className="px-4 py-2 text-[11px] text-sol-red border-b border-sol-border/30 shrink-0">
          Blame could not be read: {blame.error.message}
        </p>
      )}
      {blameOn && !blame.ready && !blame.error && (
        <p className="px-4 py-2 text-[11px] text-sol-text-dim border-b border-sol-border/30 shrink-0">
          Reading blame.
        </p>
      )}

      <div className="flex-1 min-h-0">
        <BlobView
          repository={repository}
          path={path}
          content={blob.data.content}
          selection={selection}
          onSelectLine={selectLine}
          blameRanges={blame.data?.ranges}
          blameOn={blameOn}
          threadsByLine={threadsByLine}
          onComment={(line) => lineComments.openComposer(path, line)}
          renderThread={(line, items) => (
            <PRLineThread
              comments={items as CodeCommentRow[]}
              authed={lineComments.authed}
              onReply={(content) =>
                lineComments.post({
                  file_path: path,
                  line_number: line,
                  content,
                  // Commenting from inside a selected range comments on the
                  // whole range, which is what selecting it was for.
                  ...(commentRangeEnd(selection, line) !== undefined
                    ? { line_end: commentRangeEnd(selection, line) }
                    : {}),
                  parent_id: (items as CodeCommentRow[])[0]?._id,
                })
              }
              onResolve={(resolved) =>
                lineComments.setThreadResolved(items as CodeCommentRow[], resolved)
              }
              onClose={lineComments.closeComposer}
            />
          )}
        />
      </div>
    </div>
  );
}

export default function RepoBlobPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.name as string}`;
  const refName = decodeURIComponent((params.ref as string) ?? "");
  const path = searchParams.get("path") ?? "";

  return (
    <AuthGuard>
      <DashboardLayout>
        <div
          className="repo-page h-[calc(100vh-56px)] flex flex-col"
          style={{ ["--repo-accent" as string]: "var(--sol-blue)" }}
        >
          <RepoHeader
            headRef={titlebarRef}
            repository={repository}
            tab="code"
            historyHref={repoHistoryHref(repository, refName)}
            codeHref={repoTreeHref(repository, refName)}
            middle={
              <span className="h-7 flex items-center rounded-md border border-sol-border/60 bg-sol-card px-2 font-mono text-[12px] text-sol-text">
                {refName}
              </span>
            }
            below={<FileCrumb repository={repository} refName={refName} path={path} />}
          />
          {path ? (
            <BlobContent repository={repository} refName={refName} path={path} />
          ) : (
            <p className="px-6 py-10 text-[13px] text-sol-text-muted">
              This link names no file. Pick one from{" "}
              <Link href={repoTreeHref(repository, refName)} className="text-sol-blue hover:underline">
                the source tree
              </Link>
              .
            </p>
          )}
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
