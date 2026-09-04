// One file at one ref.
//
// The reading surface: highlighted source, line numbers that are anchors, an
// optional blame gutter, and comments written straight onto a line. A comment
// here is a codecast object first, so it carries the session the reader came
// from and shows up beside the code without a pull request existing.
import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Download, ExternalLink, UserSquare2 } from "lucide-react";
import { RepoRefPicker } from "../../../../../../components/repo/RepoRefPicker";
import { RepoPageShell } from "../../../../../../components/repo/RepoPageShell";
import { Breadcrumb } from "../../../../../../components/repo/TreeContent";
import { useRepoFamily, useRepoLocation } from "../../../../../../components/repo/useRepoFamily";
import { LoadingSkeleton } from "../../../../../../components/LoadingSkeleton";
import { PRLineThread } from "../../../../../../components/pr/PRThread";
import { BlobView } from "../../../../../../components/repo/BlobView";
import { RepoHeader } from "../../../../../../components/repo/RepoChrome";
import { useCodeComments, useSyncFileCodeComments } from "../../../../../../hooks/useSyncCodeComments";
import { useAttributedSession, useLineComments } from "../../../../../../hooks/useLineComments";
import { useEventListener } from "../../../../../../hooks/useEventListener";
import { useRepoBlame, useRepoBlob, useRepoLog } from "../../../../../../hooks/useRepoBrowse";
import { useTitlebarHead } from "../../../../../../hooks/useTitlebarHead";
import { useWatchEffect } from "../../../../../../hooks/useWatchEffect";
import { serverCommentId, type CodeCommentRow } from "../../../../../../lib/prView";
import {
  commentRangeEnd,
  extendLineRange,
  parseDiffLineKey,
  type DiffLineAnchor,
  type LineRange,
} from "../../../../../../lib/patchParser";
import {
  formatLineHash,
  formatSize,
  parseLineHash,
  repoTreeHref,
  repoBlobHref,
  repoCommitsHref,
} from "../../../../../../lib/repoView";
import { serverErrorText } from "../../../../../../lib/errorCause";
import { cn, copyToClipboard } from "../../../../../../lib/utils";
import "../../../../../../components/repo/repo.css";

import { KeyCap } from "../../../../../../components/KeyboardShortcutsHelp";
import { useRepoTransport } from "../../../../../../lib/repoTransport";
import { repoShortcutAllowed } from "../../../../../../lib/repoContent";

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
  const history = useRepoLog(repository, refName, undefined);
  const anchorRef = history.commits[0]?.sha;
  const { family, pathname, search, hash } = useRepoLocation();
  const mode = useRepoTransport();
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpLine, setJumpLine] = useState("");
  const [copied, setCopied] = useState(false);
  const [rawUrl, setRawUrl] = useState("");
  useWatchEffect(() => {
    if (!blob.data || blob.data.truncated) { setRawUrl(""); return; }
    const bytes = blob.data.base64 ? Uint8Array.from(atob(blob.data.base64), (c) => c.charCodeAt(0)) : blob.data.content;
    const url = URL.createObjectURL(new Blob([bytes], { type: "text/plain;charset=utf-8" }));
    setRawUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob.data]);
  const permalink = () => {
    if (anchorRef) router.replace(repoBlobHref(repository, anchorRef, path, family) + formatLineHash(selection));
  };

  // The URL names the selection, and selecting rewrites it in place: a line
  // anchor is a bookmark, not a step in the reader's history.
  //
  // Read on mount AND on every later hash change. Opening a second file in the
  // same tab keeps this component mounted, so a mount effect alone would leave
  // a `#L27-L31` link selecting nothing — which is what a shared link is FOR.
  useWatchEffect(() => setSelection(parseLineHash(hash)), [path, hash]);

  const selectLine = useCallback((line: number, extend: boolean) => {
    const next = extend ? extendLineRange(selection, line) : { start: line, end: line };
    setSelection(next);
    router.replace(`${pathname}${search}${formatLineHash(next)}`, { scroll: false });
  }, [selection, router, pathname, search]);

  // A deep link lands on its line once the file is on screen.
  //
  // Scroll the CODE column by hand rather than calling scrollIntoView, which
  // walks every scrollable ancestor: it dragged the shell's own scroller too
  // and pushed the page header up under the tab bar.
  const ready = blob.ready && !!blob.data;
  useWatchEffect(() => {
    if (!ready || !selection) return;
    const el = document.getElementById(`L${selection.start}`);
    const column = el?.closest(".repo-code") as HTMLElement | null;
    if (!el || !column) return;
    const offset = el.getBoundingClientRect().top - column.getBoundingClientRect().top;
    column.scrollTop += offset - column.clientHeight / 2;
  }, [ready, selection?.start]);

  useEventListener("keydown", (event: KeyboardEvent) => {
    if (!repoShortcutAllowed(rootRef.current, event)) return;
    if (event.key === "y" && anchorRef) { event.preventDefault(); permalink(); }
    if (event.key === "b") { event.preventDefault(); setBlameOn((value) => !value); }
    if (event.key === "l") { event.preventDefault(); setJumpOpen(true); }
  });

  if (blob.error) {
    return (
      <div className="px-6 py-10 text-[13px] text-sol-text-muted">
        <p className="mb-3">This file could not be read: {serverErrorText(blob.error)}</p>
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

  if (!blob.data) return blob.missing ? <p className="p-6 text-sm text-sol-text-muted">This file is unavailable at this ref.</p> : <LoadingSkeleton />;

  const lineCount = blob.data.content.split("\n").length;

  return (
    <div ref={rootRef} className="flex-1 min-h-0 flex flex-col">
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
            Blame <KeyCap size="xs">b</KeyCap>
          </ToolbarButton>
          <Link href={repoCommitsHref(repository, refName, { path, family })} className="text-xs text-sol-text-muted hover:text-sol-blue">History</Link>
          <ToolbarButton onClick={() => { void copyToClipboard(path).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy path"}</ToolbarButton>
          {anchorRef && <ToolbarButton onClick={permalink}>Permalink <KeyCap size="xs">y</KeyCap></ToolbarButton>}
          <ToolbarButton onClick={() => setJumpOpen(true)}>Jump to line <KeyCap size="xs">l</KeyCap></ToolbarButton>
          {rawUrl && <><a href={rawUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-sol-text-muted hover:text-sol-blue">Raw</a>
            <a href={rawUrl} download={path.split("/").pop()} className="flex items-center gap-1 text-xs text-sol-text-muted hover:text-sol-blue"><Download className="size-3" />Download</a></>}
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
          GitHub could not return the complete file. Raw and download are unavailable; open it on GitHub for the full content.
        </p>
      )}
      {blameOn && blame.error && (
        <p className="px-4 py-2 text-[11px] text-sol-red border-b border-sol-border/30 shrink-0">
          Blame could not be read: {serverErrorText(blame.error)}
        </p>
      )}
      {blameOn && !blame.ready && !blame.error && (
        <p className="px-4 py-2 text-[11px] text-sol-text-dim border-b border-sol-border/30 shrink-0">
          Reading blame.
        </p>
      )}

      <div className="flex-1 min-h-0">
        {mode === "convex" && anchorRef ? <CommentedBlobView repository={repository} path={path} anchorRef={anchorRef} content={blob.data.content}
          selection={selection} selectLine={selectLine} blameRanges={blame.data?.ranges} blameOn={blameOn} />
          : <BlobView repository={repository} path={path} content={blob.data.content} selection={selection} onSelectLine={selectLine} blameRanges={blame.data?.ranges} blameOn={blameOn} />}
        {jumpOpen && <div role="dialog" aria-modal="true" aria-label="Jump to line" className="absolute inset-0 z-50 flex items-start justify-center pt-20 bg-sol-bg/70" onClick={() => setJumpOpen(false)}>
          <form className="rounded-lg border border-sol-border bg-sol-card p-4 shadow-xl flex gap-2" onClick={(e) => e.stopPropagation()} onSubmit={(event) => {
            event.preventDefault(); const line = Number(jumpLine);
            if (Number.isInteger(line) && line >= 1 && line <= lineCount) { selectLine(line, false); setJumpOpen(false); }
          }}>
            <input autoFocus type="number" min="1" max={lineCount} aria-label="Line number" value={jumpLine} onChange={(e) => setJumpLine(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setJumpOpen(false); }} className="bg-sol-bg border border-sol-border rounded px-2 py-1 text-xs" />
            <button className="text-sol-blue text-xs">Go</button>
          </form>
        </div>}

      </div>
    </div>
  );
}

function CommentedBlobView({ repository, path, anchorRef, content, selection, selectLine, blameRanges, blameOn }: {
  repository: string; path: string; anchorRef: string; content: string; selection: LineRange | null;
  selectLine: (line: number, extend: boolean) => void;
  blameRanges: import("../../../../../../lib/repoView").RepoBlameRange[] | undefined; blameOn: boolean;
}) {
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
  // Source is the file as it stands at this ref, so every line is the RIGHT
  // side of the diff vocabulary the comment table speaks. Threads anchored to a
  // deleted line (LEFT) belong to a diff, not to this view, and stay out of it.
  const threadsByLine = useMemo(() => {
    const byAnchor = lineComments.threadsByFile.get(path);
    if (!byAnchor) return undefined;
    const byLine = new Map<number, CodeCommentRow[]>();
    for (const [key, thread] of byAnchor) {
      const anchor = parseDiffLineKey(key);
      if (anchor.side === "RIGHT") byLine.set(anchor.lineNumber, thread);
    }
    return byLine;
  }, [lineComments.threadsByFile, path]);

  const anchorFor = (line: number): DiffLineAnchor => ({ side: "RIGHT", lineNumber: line });

  return <BlobView repository={repository} path={path} content={content} selection={selection} onSelectLine={selectLine} blameRanges={blameRanges} blameOn={blameOn}
          threadsByLine={threadsByLine}
          onComment={(line) => lineComments.openComposer(path, anchorFor(line))}
          renderThread={(line, items) => (
            <PRLineThread
              comments={items as CodeCommentRow[]}
              authed={lineComments.authed}
              onReply={(content) =>
                lineComments.post({
                  file_path: path,
                  line_number: line,
                  side: "RIGHT",
                  content,
                  // Commenting from inside a selected range comments on the
                  // whole range, which is what selecting it was for.
                  ...(commentRangeEnd(selection, line) !== undefined
                    ? { line_end: commentRangeEnd(selection, line) }
                    : {}),
                  parent_id: serverCommentId((items as CodeCommentRow[])[0]?._id),
                })
              }
              onResolve={(resolved) =>
                lineComments.setThreadResolved(items as CodeCommentRow[], resolved)
              }
              onClose={lineComments.closeComposer}
            />
          )} />;
}

export default function RepoBlobPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const family = useRepoFamily();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.name as string}`;
  const refName = decodeURIComponent((params.ref as string) ?? "");
  const path = searchParams.get("path") ?? "";

  return (
    <RepoPageShell repository={repository}>
      <div
        className="repo-page h-full flex flex-col"
        style={{ ["--repo-accent" as string]: "var(--sol-blue)" }}
      >
        <RepoHeader
          headRef={titlebarRef}
          repository={repository}
          tab="code"
          refName={refName}
          family={family}
          middle={<RepoRefPicker repository={repository} refName={refName} path={path} family={family} blob />}
          below={<Breadcrumb repository={repository} refName={refName} path={path} family={family} />}
        />
        {path ? (
          <BlobContent repository={repository} refName={refName} path={path} />
        ) : (
          <p className="px-6 py-10 text-[13px] text-sol-text-muted">
            This link names no file. Pick one from{" "}
            <Link
              href={repoTreeHref(repository, refName, undefined, family)}
              className="text-sol-blue hover:underline"
            >
              the source tree
            </Link>
            .
          </p>
        )}
      </div>
    </RepoPageShell>
  );
}
