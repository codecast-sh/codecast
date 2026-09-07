// One file's contents at one ref: the reading surface.
//
// Highlighted source, line numbers that are anchors, an optional blame gutter
// (git's commit per line, or the codecast session that wrote it), and
// comments written straight onto a line. The blob page mounts it as its
// body; the commit page mounts it beside a diff. The two differ in one thing:
// on its own page a selected line is written to the URL (a bookmark), while in
// a panel the selection stays local and the toolbar offers the file's own page
// instead of a permalink.
import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, ExternalLink, UserSquare2, X } from "lucide-react";
import { codeThreadRootKey } from "@codecast/shared/comments";
import { useRepoLocation } from "./useRepoFamily";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { PRLineThread } from "../pr/PRThread";
import { BlobView } from "./BlobView";
import { useCodeComments, useSyncFileCodeComments } from "../../hooks/useSyncCodeComments";
import { useAttributedSession, useLineComments } from "../../hooks/useLineComments";
import { useEventListener } from "../../hooks/useEventListener";
import { useRepoBlame, useRepoBlameSessions, useRepoBlob, useRepoLog } from "../../hooks/useRepoBrowse";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { serverCommentId, type CodeCommentRow } from "../../lib/prView";
import {
  commentRangeEnd,
  extendLineRange,
  parseDiffLineKey,
  type DiffLineAnchor,
  type LineRange,
} from "../../lib/patchParser";
import {
  BLAME_MODES,
  foldSessionBlame,
  formatLineHash,
  formatSize,
  nextBlameMode,
  parseLineHash,
  repoBlobHref,
  repoCommitsHref,
  sessionBlameColors,
  summarizeSessionBlame,
  type BlameMode,
  type RepoBlameRange,
  type SessionBlameRange,
} from "../../lib/repoView";
import { SessionBlameStrip } from "./SessionBlame";
import { serverErrorText } from "../../lib/errorCause";
import { cn, copyToClipboard } from "../../lib/utils";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useRepoTransport } from "../../lib/repoTransport";
import { repoShortcutAllowed } from "../../lib/repoContent";
import "./repo.css";

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

export type BlobPanel = {
  /** Close the panel. */
  onClose: () => void;
  /** The line to land on when the panel opens. */
  line?: number;
};

export function BlobContent({
  repository,
  refName,
  path,
  panel,
}: {
  repository: string;
  refName: string;
  path: string;
  /** Mounted beside another surface rather than as a page of its own. */
  panel?: BlobPanel;
}) {
  const [blameMode, setBlameMode] = useState<BlameMode>("off");
  const [selection, setSelection] = useState<LineRange | null>(null);
  // A session lit up in the gutter: hovered in the strip, or pinned by a click.
  const [focusSession, setFocusSession] = useState<string | null>(null);
  const [pinnedSession, setPinnedSession] = useState<string | null>(null);

  const blob = useRepoBlob(repository, refName, path);
  const blame = useRepoBlame(repository, refName, path, blameMode !== "off");
  // Session blame is a join over the git blame, so it waits for that to land.
  const sessions = useRepoBlameSessions(repository, refName, path, blameMode === "session" && blame.ready && !!blame.data);
  const content = blob.data?.content;
  const sessionRanges = useMemo<SessionBlameRange[] | undefined>(
    () => (blameMode === "session" && content !== undefined && blame.data ? foldSessionBlame(blame.data.ranges, content.split("\n"), sessions.data) : undefined),
    [blameMode, content, blame.data, sessions.data],
  );
  const sessionSummary = useMemo(() => (sessionRanges ? summarizeSessionBlame(sessionRanges) : undefined), [sessionRanges]);
  const sessionColors = useMemo(() => (sessionSummary ? sessionBlameColors(sessionSummary) : undefined), [sessionSummary]);
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
  // The file's own page, carrying the selection, for a reader in a panel.
  const pageHref = repoBlobHref(repository, refName, path, family) + formatLineHash(selection);

  // On its own page the URL names the selection, and selecting rewrites it in
  // place: a line anchor is a bookmark, not a step in the reader's history.
  // In a panel the selection is the panel's own, so the host page's URL is
  // left alone and the opening line is the first selection.
  //
  // Read on mount AND on every later hash change. Opening a second file in the
  // same tab keeps this component mounted, so a mount effect alone would leave
  // a `#L27-L31` link selecting nothing — which is what a shared link is FOR.
  useWatchEffect(() => {
    if (panel) setSelection(panel.line ? { start: panel.line, end: panel.line } : null);
    else setSelection(parseLineHash(hash));
  }, [path, hash, panel?.line]);

  const selectLine = useCallback((line: number, extend: boolean) => {
    const next = extend ? extendLineRange(selection, line) : { start: line, end: line };
    setSelection(next);
    if (!panel) router.replace(`${pathname}${search}${formatLineHash(next)}`, { scroll: false });
  }, [selection, router, pathname, search, panel]);

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
    if (event.key === "y" && anchorRef && !panel) { event.preventDefault(); permalink(); }
    if (event.key === "b") { event.preventDefault(); setBlameMode(nextBlameMode); }
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

  if (!blob.data) {
    if (blob.missing) return <p className="p-6 text-sm text-sol-text-muted">This file is unavailable at this ref.</p>;
    // No GitHub App covers this repository: a teammate's machine that holds
    // a checkout is answering, which takes a moment and needs it awake.
    if (blob.pending) return <p className="p-6 text-sm text-sol-text-muted">Reading this file from a checkout of this repository. It arrives as soon as that machine answers.</p>;
    return <LoadingSkeleton />;
  }

  const lineCount = blob.data.content.split("\n").length;

  return (
    <div ref={rootRef} className="flex-1 min-h-0 flex flex-col relative">
      {panel && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-sol-border/30 shrink-0 min-w-0">
          <Link
            href={pageHref}
            className="font-mono text-xs text-sol-text truncate hover:underline decoration-sol-border underline-offset-2"
            title="Open this file on its own page"
          >
            {path}
          </Link>
          <span className="text-[11px] text-sol-text-dim tabular-nums shrink-0">
            {lineCount} lines · {formatSize(blob.data.size)}
          </span>
          <button
            type="button"
            onClick={panel.onClose}
            className="ml-auto p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/50 transition-colors shrink-0"
            title="Close the file"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30 shrink-0 flex-wrap">
        {!panel && (
          <span className="text-[11px] text-sol-text-dim tabular-nums">
            {lineCount} lines · {formatSize(blob.data.size)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center h-7 rounded-md border border-sol-border/60 overflow-hidden text-[12px]" role="radiogroup" aria-label="Blame" title="Who is behind each line: the commit, or the codecast session that wrote it">
            <span className="flex items-center gap-1 pl-2 pr-1.5 text-sol-text-dim"><UserSquare2 className="w-3.5 h-3.5" />Blame</span>
            {BLAME_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={blameMode === mode}
                onClick={() => setBlameMode(mode)}
                className={cn(
                  "h-full px-2 transition-colors",
                  blameMode === mode ? "text-sol-bg" : "text-sol-text-muted hover:text-sol-text",
                )}
                style={blameMode === mode ? { background: "var(--repo-accent)" } : undefined}
              >
                {mode === "off" ? "Off" : mode === "git" ? "Git" : "Sessions"}
              </button>
            ))}
            <span className="pl-1 pr-1.5"><KeyCap size="xs">b</KeyCap></span>
          </div>
          <Link href={repoCommitsHref(repository, refName, { path, family })} className="text-xs text-sol-text-muted hover:text-sol-blue">History</Link>
          <ToolbarButton onClick={() => { void copyToClipboard(path).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy path"}</ToolbarButton>
          {panel ? (
            <Link href={pageHref} className="text-xs text-sol-text-muted hover:text-sol-blue">Open page</Link>
          ) : (
            anchorRef && <ToolbarButton onClick={permalink}>Permalink <KeyCap size="xs">y</KeyCap></ToolbarButton>
          )}
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
      {blameMode !== "off" && blame.error && (
        <p className="px-4 py-2 text-[11px] text-sol-red border-b border-sol-border/30 shrink-0">
          Blame could not be read: {serverErrorText(blame.error)}
        </p>
      )}
      {blameMode !== "off" && !blame.ready && !blame.error && (
        <p className="px-4 py-2 text-[11px] text-sol-text-dim border-b border-sol-border/30 shrink-0">
          Reading blame.
        </p>
      )}
      {blameMode === "session" && blame.ready && sessions.error && (
        <p className="px-4 py-2 text-[11px] text-sol-red border-b border-sol-border/30 shrink-0">
          Sessions could not be traced: {serverErrorText(sessions.error)}
        </p>
      )}
      {blameMode === "session" && blame.ready && !sessions.ready && !sessions.error && (
        <p className="px-4 py-2 text-[11px] text-sol-text-dim border-b border-sol-border/30 shrink-0">
          Tracing lines to sessions.
        </p>
      )}
      {blameMode === "session" && sessions.ready && sessionSummary && sessionColors && (
        <SessionBlameStrip
          summary={sessionSummary}
          colors={sessionColors}
          focus={focusSession}
          pinned={pinnedSession}
          onFocus={setFocusSession}
          onPick={(id, firstLine) => {
            setPinnedSession((current) => (current === id ? null : id));
            selectLine(firstLine, false);
          }}
        />
      )}

      <div className="flex-1 min-h-0">
        {mode === "convex" && anchorRef ? <CommentedBlobView repository={repository} path={path} anchorRef={anchorRef} content={blob.data.content}
          selection={selection} selectLine={selectLine} blameRanges={blame.data?.ranges} blameMode={blameMode}
          sessionRanges={sessionRanges} sessionColors={sessionColors} focusSession={focusSession ?? pinnedSession} />
          : <BlobView repository={repository} path={path} content={blob.data.content} selection={selection} onSelectLine={selectLine} blameRanges={blame.data?.ranges} blameMode={blameMode}
          sessionRanges={sessionRanges} sessionColors={sessionColors} focusSession={focusSession ?? pinnedSession} />}
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

function CommentedBlobView({ repository, path, anchorRef, content, selection, selectLine, blameRanges, blameMode, sessionRanges, sessionColors, focusSession }: {
  repository: string; path: string; anchorRef: string; content: string; selection: LineRange | null;
  selectLine: (line: number, extend: boolean) => void;
  blameRanges: RepoBlameRange[] | undefined; blameMode: BlameMode;
  sessionRanges: SessionBlameRange[] | undefined; sessionColors: ReadonlyMap<string, string> | undefined; focusSession: string | null;
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

  return <BlobView repository={repository} path={path} content={content} selection={selection} onSelectLine={selectLine} blameRanges={blameRanges} blameMode={blameMode}
          sessionRanges={sessionRanges} sessionColors={sessionColors} focusSession={focusSession}
          threadsByLine={threadsByLine}
          onComment={(line) => lineComments.openComposer(path, anchorFor(line))}
          renderThread={(line, items) => (
            <PRLineThread
              repository={repository}
              threadKey={codeThreadRootKey(repository, anchorRef, { file_path: path, line_number: line })}
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

