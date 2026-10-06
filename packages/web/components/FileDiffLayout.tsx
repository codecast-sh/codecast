import { useState, useMemo, useRef } from "react";
import Link from "next/link";
import { useMountEffect } from "../hooks/useMountEffect";
import { useDragGatedLayoutPersist } from "../hooks/useDragGatedLayoutPersist";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { Panel, Group, Separator } from "react-resizable-panels";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Keyboard,

  Copy,
  Check,
  X,
  ChevronsUpDown,
  ChevronsDownUp,
  PanelLeftClose,
  PanelLeft,
  LayoutList,
  SplitSquareVertical,
  Link2,
} from "lucide-react";
import { Button } from "./ui/button";
import { DiffView } from "./DiffView";
import { parsePatch, getFileStatus, type DiffLineAnchor } from "../lib/patchParser";
import { cn, copyToClipboard } from "../lib/utils";
import { copyText } from "../lib/copyText";
import { useTrackedStore } from "../store/inboxStore";
import { findCommonPrefix, shortenPrefix, stripCommonPrefix, treeOrder } from "../lib/diffFileTree";
import { FileSidebar } from "./FileDiffSidebar";
import { keyBelongsElsewhere } from "../shortcuts/keyOwnership";
import { usePaneShortcutAction, useShortcutContext } from "../shortcuts";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { useFollowSurface } from "../hooks/useFollowSurface";
import { landOn } from "../hooks/useDiffAddress";
import { notifyFollowView } from "../lib/follow";
import type { AnchorPlacement, CodeAnchorText } from "@codecast/shared/comments";

export interface DiffFile {
  filename: string;
  // Pre-strip path (stripCommonPrefix rewrites `filename` for display); anchors
  // like line comments need the real path, so keep the original alongside.
  originalFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export type FileLineThreads = {
  /** One file's threads, keyed by anchor (`diffLineKey`: the side and the FILE
   *  line number). An anchor mapped to an empty array still gets a row, which is
   *  how a surface opens a composer where no thread exists yet. */
  threadsFor: (filename: string) => ReadonlyMap<string, unknown[]> | undefined;
  /** Render one anchor's thread (and its composer, when the surface wants one). */
  render: (filename: string, anchor: DiffLineAnchor, items: unknown[], placement?: AnchorPlacement) => React.ReactNode;
  /** Hover handle click. Omit to leave the diff read only. `anchorLines` is
   *  the text to store with the comment (shared/comments/codeAnchor.ts). */
  onComment?: (filename: string, anchor: DiffLineAnchor | undefined, code: string, anchorLines?: CodeAnchorText) => void;
};

/** What a surface knows about one file beyond its diff, for the tree and header. */
export type FileMarks = {
  /** Open (unresolved) threads on the file. */
  open?: number;
  /** The reader's own notes on it in a review not yet submitted. */
  pending?: number;
  /** The reader has marked it viewed. */
  viewed?: boolean;
};

export interface FileDiffLayoutProps {
  files: DiffFile[];
  /** Marks for one file, by its ORIGINAL path. Absent means nothing to mark. */
  fileMarks?: (filename: string) => FileMarks | undefined;
  /** The viewed toggle, by ORIGINAL path. Omit to hide the control. */
  onToggleViewed?: (filename: string) => void;
  title?: string;
  subtitle?: React.ReactNode;
  /** Controls in the pane's header row, before the view buttons. */
  headerExtra?: React.ReactNode;
  /** What an empty tree says, in place of "No files changed". */
  emptyState?: React.ReactNode;
  sidebarHeader?: React.ReactNode;
  onFileComment?: (filename: string, lineNumber?: number) => void;
  renderFileExtra?: (file: DiffFile) => React.ReactNode;
  onCloseDiffPanel?: () => void;
  // Enables inline line comments (ephemeral review batch + durable file:line
  // threads) on each file's DiffView. Called with the file's ORIGINAL path.
  commentContextFor?: (filename: string) => { conversationId: string; anchorKey: string; filePath: string } | undefined;
  // Line threads the OWNER holds and renders (the PR page's code comments,
  // which are not conversation comments). DiffView only places them; every
  // callback here is called with the file's ORIGINAL path.
  lineThreads?: FileLineThreads;
  // External "open this file" request (raw pre-strip path, e.g. from a comment
  // rail jump). Honored whenever the value changes to a file in the list.
  focusFile?: string | null;
  // Where a file's own page is, when the surface has one (a commit at its sha,
  // a pull request at its head). The name in each file header becomes a link
  // there. Called with the file's ORIGINAL path.
  fileHref?: (filename: string) => string | undefined;
  // Lay the diff into the page instead of filling a pane. See DiffFlow.
  flow?: DiffFlow;
}

/**
 * The page form of the diff. The files stack in the page's own flow and the
 * page is the only scroller: no pane per column, no sideways scroll per file.
 * Every file and every line has an address the surface owns (it keeps them in
 * the URL), so a reader can link to anything they can see.
 *
 * Paths here are ORIGINAL paths, like every other callback on this layout.
 */
export type DiffFlow = {
  /** Pixels of sticky chrome above the diff; file headers pin under it. */
  stickyTop: number;
  /** The DOM id of a file's card, and of a line's row: the fragment targets. */
  fileId: (path: string) => string;
  rowId: (path: string, anchor: DiffLineAnchor) => string;
  /** The in-page address of a file and of a line or run of lines. */
  fileAnchorHref: (path: string) => string;
  lineHref: (path: string, anchor: DiffLineAnchor) => string;
  /** An address as someone else would open it (a full URL, outside any app). */
  shareUrl: (href: string) => string;
  /** What the address names now, if it names a file of this diff. */
  selected: { file: string; anchor?: DiffLineAnchor } | null;
  /** The reader picked lines, or asked for a file. */
  onSelectLines: (path: string, anchor: DiffLineAnchor) => void;
  onJumpFile: (path: string) => void;
};

type Layout = { [key: string]: number };
const DEFAULT_FILE_DIFF_LAYOUT = { tree: 25, content: 75 };

export function getFileExtension(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
  };
  return ext ? langMap[ext] : undefined;
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getFileDirectory(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
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

// The name in a file header: a link to the file's own page when the surface
// has one, plain text otherwise. Every diff layout shares it so a file is one
// click from its source wherever it is shown.
function FileHeaderName({
  file,
  fileHref,
  className,
}: {
  file: DiffFile;
  fileHref?: FileDiffLayoutProps["fileHref"];
  className?: string;
}) {
  const path = file.originalFilename ?? file.filename;
  const href = fileHref?.(path);
  const dir = getFileDirectory(file.filename);
  const name = getFileName(file.filename);
  const label = (
    <>
      {dir && <span className="text-sol-text-dim">{dir}/</span>}
      <span className="text-sol-text">{name}</span>
    </>
  );
  return (
    <>
      {href ? (
        <Link
          href={href}
          className={cn("font-mono text-xs truncate min-w-0 hover:underline decoration-sol-border underline-offset-2", className)}
          title={`Open ${path} at this revision`}
        >
          {label}
        </Link>
      ) : (
        // data-diff-file: a surface that knows where the file lives (the
        // conversation diff panel) gives the plain name a file menu.
        <span data-diff-file={path} className={cn("font-mono text-xs truncate min-w-0", className)}>{label}</span>
      )}
      <CopyButton text={path} />
    </>
  );
}

export function FilePatchDiff({ patch, ...props }: { patch: string } & Omit<React.ComponentProps<typeof DiffView>, "hunks">) {
  const { hunks } = useMemo(() => parsePatch(patch), [patch]);
  return <DiffView {...props} hunks={hunks} />;
}

function FileDiffContent({
  file,
  onComment,
  renderExtra,
  fileIndex,
  totalFiles,
  onToggleSidebar,
  sidebarOpen,
  commentContextFor,
  lineThreads,
  fileHref,
  fileMarks,
  onToggleViewed,
}: {
  file: DiffFile | null;
  onComment?: (filename: string, lineNumber?: number) => void;
  renderExtra?: (file: DiffFile) => React.ReactNode;
  fileIndex?: number;
  totalFiles?: number;
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  commentContextFor?: FileDiffLayoutProps["commentContextFor"];
  lineThreads?: FileLineThreads;
  fileHref?: FileDiffLayoutProps["fileHref"];
  fileMarks?: FileDiffLayoutProps["fileMarks"];
  onToggleViewed?: FileDiffLayoutProps["onToggleViewed"];
}) {
  if (!file) {
    return (
      <div className="h-full flex items-center justify-center text-sol-text-muted">
        <div className="text-center">
          <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Select a file to view changes</p>
        </div>
      </div>
    );
  }

  const status = getFileStatus(file.status);
  const language = getFileExtension(file.filename);
  const showNav = fileIndex !== undefined && totalFiles !== undefined;

  if (!file.patch) {
    return (
      <div className="h-full overflow-auto">
        <div className="sticky top-0 z-10 bg-sol-bg border-b border-sol-border px-4 py-3">
          <div className="flex items-center justify-between gap-x-3 gap-y-1 flex-wrap">
            <div className="flex items-center gap-2 min-w-[min(100%,10rem)] flex-1 basis-[10rem]">
              {onToggleSidebar && (
                <button
                  onClick={onToggleSidebar}
                  className="p-1 -ml-1 rounded hover:bg-sol-bg-alt/50 text-sol-text-dim hover:text-sol-text-muted transition-colors shrink-0"
                  title={sidebarOpen ? "Hide file tree (b)" : "Show file tree (b)"}
                >
                  {sidebarOpen ? (
                    <PanelLeftClose className="w-4 h-4" />
                  ) : (
                    <PanelLeft className="w-4 h-4" />
                  )}
                </button>
              )}
              <span
                className={cn(
                  "w-5 h-5 rounded text-[11px] font-bold flex items-center justify-center shrink-0",
                  status.bgColor,
                  status.color
                )}
              >
                {status.label}
              </span>
              <FileHeaderName file={file} fileHref={fileHref} className="text-sm font-medium" />
            </div>
            {showNav && (
              <div className="text-xs text-sol-text-dim shrink-0 ml-2">
                {fileIndex + 1} of {totalFiles}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-sol-text-muted">
            <span>
              <span className="text-sol-green">+{file.additions}</span>
              <span className="mx-1">/</span>
              <span className="text-sol-red">-{file.deletions}</span>
            </span>
          </div>
        </div>
        <div className="p-4">
          <div className="text-sol-text-muted text-sm">
            {file.status === "added"
              ? "Binary file or new file (no diff available)"
              : file.status === "removed" || file.status === "deleted"
              ? "File deleted"
              : "No changes to display"}
          </div>
        </div>
        {renderExtra && renderExtra(file)}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden" data-follow-diff-scroll>
      <div className="sticky top-0 z-10 bg-sol-bg-alt border-b border-sol-border/30 px-3 py-1 flex items-center justify-between gap-x-3 gap-y-1 flex-wrap">
        <div className="flex items-center gap-1.5 min-w-[min(100%,10rem)] flex-1 basis-[10rem]">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-0.5 -ml-0.5 rounded hover:bg-sol-bg-alt/50 text-sol-text-dim hover:text-sol-text-muted transition-colors shrink-0"
              title={sidebarOpen ? "Hide file tree (b)" : "Show file tree (b)"}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="w-3.5 h-3.5" />
              ) : (
                <PanelLeft className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          <span className={cn("text-[10px] font-bold shrink-0", status.color)}>
            {status.label}
          </span>
          <FileHeaderName file={file} fileHref={fileHref} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-sol-text-dim">
            <span className="text-sol-green">+{file.additions}</span>
            <span className="mx-0.5 text-sol-text-dim/30">/</span>
            <span className="text-sol-red">-{file.deletions}</span>
          </span>
          {showNav && (
            <span className="text-[11px] text-sol-text-dim/50">
              {fileIndex + 1}/{totalFiles}
            </span>
          )}
          <ViewedToggle file={file} fileMarks={fileMarks} onToggleViewed={onToggleViewed} />
        </div>
      </div>
      <FilePatchDiff
        patch={file.patch}
        language={language}
        maxLines={100}
        commentContext={commentContextFor?.(file.originalFilename ?? file.filename)}
        {...lineThreadProps(lineThreads, file)}
      />
      {renderExtra && renderExtra(file)}
    </div>
  );
}

// One file's owner-held threads, bound to that file's original path, in the
// shape DiffView takes.
//
// Line numbers come with them: a comment is anchored to a line, and the gutter
// is what the reader clicks to select one, so a diff that takes line threads
// has to show the numbers. A diff with no threads keeps its bare rows.
function lineThreadProps(lineThreads: FileLineThreads | undefined, file: DiffFile) {
  if (!lineThreads) return undefined;
  const path = file.originalFilename ?? file.filename;
  return {
    showLineNumbers: true,
    lineThreads: lineThreads.threadsFor(path),
    renderLineThread: (anchor: DiffLineAnchor, items: unknown[], placement?: AnchorPlacement) =>
      lineThreads.render(path, anchor, items, placement),
    onLineComment: lineThreads.onComment
      ? (anchor: DiffLineAnchor | undefined, code: string, anchorLines?: CodeAnchorText) =>
          lineThreads.onComment!(path, anchor, code, anchorLines)
      : undefined,
  };
}

/**
 * "Viewed": the reader's own mark that a file is done. It reads as a checkbox
 * because that is the gesture every reviewer already has, and a viewed file
 * dims in the tree so the eye goes to what is left.
 */
function ViewedToggle({
  file,
  fileMarks,
  onToggleViewed,
  className,
}: {
  file: DiffFile;
  fileMarks?: FileDiffLayoutProps["fileMarks"];
  onToggleViewed?: FileDiffLayoutProps["onToggleViewed"];
  className?: string;
}) {
  if (!onToggleViewed) return null;
  const path = file.originalFilename ?? file.filename;
  const viewed = !!fileMarks?.(path)?.viewed;
  return (
    <ShortcutTooltip label={viewed ? "Clear the viewed mark" : "Mark viewed: it folds until it changes again"} action="diff.toggleSeen">
    <label
      className={cn(
        "inline-flex items-center gap-1.5 cursor-pointer select-none text-[11px] transition-colors",
        viewed ? "text-sol-green" : "text-sol-text-dim hover:text-sol-text-muted",
        className,
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={viewed}
        onChange={() => onToggleViewed(path)}
      />
      <span
        className={cn(
          "flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors",
          viewed ? "border-sol-green bg-sol-green/20" : "border-sol-border",
        )}
      >
        {viewed && <Check className="w-2.5 h-2.5" />}
      </span>
      Viewed
    </label>
    </ShortcutTooltip>
  );
}

/** The file a keyboard gesture acts on, by ORIGINAL path: each view answers
 *  for itself (the card under the pinned header, the selected file). */
type InHand = React.MutableRefObject<(() => string | undefined) | null>;

function UnifiedDiffView({
  files,
  onComment,
  renderExtra,
  commentContextFor,
  lineThreads,
  fileHref,
  fileMarks,
  onToggleViewed,
  inHand,
}: {
  files: DiffFile[];
  onComment?: (filename: string, lineNumber?: number) => void;
  renderExtra?: (file: DiffFile) => React.ReactNode;
  commentContextFor?: FileDiffLayoutProps["commentContextFor"];
  lineThreads?: FileLineThreads;
  fileHref?: FileDiffLayoutProps["fileHref"];
  fileMarks?: FileDiffLayoutProps["fileMarks"];
  onToggleViewed?: FileDiffLayoutProps["onToggleViewed"];
  inHand: InHand;
}) {
  const pathOf = (f: DiffFile) => f.originalFilename ?? f.filename;
  // A viewed file folds to its header, the way a reader puts a finished page
  // face down; a click on the chevron wins either way until the mark moves.
  const [folded, setFolded] = useState<Map<string, boolean>>(new Map());
  const isFolded = (path: string) => folded.get(path) ?? !!fileMarks?.(path)?.viewed;
  const toggleViewed = onToggleViewed
    ? (path: string) => {
        setFolded((prev) => { const next = new Map(prev); next.delete(path); return next; });
        onToggleViewed(path);
      }
    : undefined;

  // The file in hand is the one whose header is pinned: the last card whose
  // top has reached the top of the scroller.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  inHand.current = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const top = scroller.getBoundingClientRect().top + 8;
    let current: string | undefined = files[0] && pathOf(files[0]);
    for (const el of scroller.querySelectorAll<HTMLElement>("[data-unified-file]")) {
      if (el.getBoundingClientRect().top <= top) current = el.dataset.unifiedFile;
      else break;
    }
    if (current) setFolded((prev) => { const next = new Map(prev); next.delete(current!); return next; });
    return current;
  };

  // Files sit a little apart, so the eye finds where one ends and the next
  // begins without reading the headers; each header stays pinned while its
  // own diff scrolls under it.
  return (
    <div ref={scrollerRef} className="h-full overflow-y-auto overflow-x-hidden pb-8" data-follow-diff-scroll>
      {files.map((file, index) => {
        const status = getFileStatus(file.status);
        const language = getFileExtension(file.filename);
        const path = pathOf(file);
        const shut = isFolded(path);
        const viewed = !!fileMarks?.(path)?.viewed;

        return (
          <div key={file.filename} data-unified-file={path} className="overflow-hidden mb-4 last:mb-0" id={`file-${index}`} style={{ contentVisibility: shut ? undefined : "auto", containIntrinsicBlockSize: "auto 500px" }}>
            <div className={cn("sticky top-0 z-10 bg-sol-bg-alt px-3 py-1.5 flex items-center justify-between gap-x-3 gap-y-1 flex-wrap border-y border-sol-border/30")}>
              <div className="flex items-center gap-1.5 min-w-[min(100%,10rem)] flex-1 basis-[10rem]">
                <button
                  type="button"
                  onClick={() => setFolded((prev) => new Map(prev).set(path, !shut))}
                  className="p-0.5 -ml-1 rounded text-sol-text-dim hover:text-sol-text transition-colors shrink-0"
                  title={shut ? "Show this file" : "Fold this file"}
                  aria-expanded={!shut}
                >
                  {shut ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                <span className={cn("text-[10px] font-bold shrink-0", status.color)}>
                  {status.label}
                </span>
                <FileHeaderName file={file} fileHref={fileHref} className={cn(shut && viewed && "opacity-60")} />
              </div>
              <span className="flex items-center gap-2 text-[11px] text-sol-text-dim shrink-0">
                <span>
                  <span className="text-sol-green">+{file.additions}</span>
                  <span className="mx-0.5 text-sol-text-dim/30">/</span>
                  <span className="text-sol-red">-{file.deletions}</span>
                </span>
                <ViewedToggle file={file} fileMarks={fileMarks} onToggleViewed={toggleViewed} />
              </span>
            </div>
            {shut ? null : file.patch ? (
              <FilePatchDiff
                patch={file.patch}
                language={language}
                maxLines={500}
                commentContext={commentContextFor?.(file.originalFilename ?? file.filename)}
                {...lineThreadProps(lineThreads, file)}
              />
            ) : (
              <div className="text-sol-text-muted text-sm py-4 text-center">
                {file.status === "added"
                  ? "Binary file or new file (no diff available)"
                  : file.status === "removed" || file.status === "deleted"
                  ? "File deleted"
                  : "No changes to display"}
              </div>
            )}
            {!shut && renderExtra && renderExtra(file)}
          </div>
        );
      })}
    </div>
  );
}


/** The label for a run of lines, the way the gutter reads it. */
function lineRunLabel(anchor: DiffLineAnchor): string {
  const letter = anchor.side === "LEFT" ? "L" : "R";
  return anchor.lineEnd !== undefined && anchor.lineEnd !== anchor.lineNumber
    ? `${letter}${anchor.lineNumber}–${anchor.lineEnd}`
    : `${letter}${anchor.lineNumber}`;
}

function CopyLinkButton({ url, label, children }: { url: string; label: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(url, "Link copied");
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded transition-colors",
        children
          ? "border border-sol-cyan/40 bg-sol-cyan/10 px-1.5 py-0.5 text-[11px] text-sol-cyan hover:bg-sol-cyan/20"
          : "p-1 text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60",
      )}
      title={label}
      aria-label={label}
    >
      <Link2 className="w-3 h-3" />
      {children}
    </button>
  );
}

/**
 * The files as the page's own content: a tree beside them that stays in view
 * while it fits the window (and scrolls with the page when it does not), and
 * one card per file, its header pinned under the page's sticky chrome.
 */
function FlowDiffView({
  commonPrefix,
  flow,
  sidebarHeader,
  renderExtra,
  commentContextFor,
  lineThreads,
  fileHref,
  fileMarks,
  onToggleViewed,
  sidebarOpen: wideTreeOpen,
  onToggleSidebar: toggleWideTree,
  files: givenFiles,
  inHand,
}: {
  files: DiffFile[];
  commonPrefix: string;
  flow: DiffFlow;
  sidebarHeader?: React.ReactNode;
  renderExtra?: (file: DiffFile) => React.ReactNode;
  commentContextFor?: FileDiffLayoutProps["commentContextFor"];
  lineThreads?: FileLineThreads;
  fileHref?: FileDiffLayoutProps["fileHref"];
  fileMarks?: FileDiffLayoutProps["fileMarks"];
  onToggleViewed?: FileDiffLayoutProps["onToggleViewed"];
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  inHand: InHand;
}) {
  const pathOf = (f: DiffFile) => f.originalFilename ?? f.filename;
  const files = useMemo(() => treeOrder(givenFiles), [givenFiles]);

  // Open or shut, per file. A viewed file folds by default, the way a reader
  // puts a finished page face down; their own click wins either way.
  const [folded, setFolded] = useState<Map<string, boolean>>(new Map());
  const isFolded = (path: string) => folded.get(path) ?? !!fileMarks?.(path)?.viewed;
  const setFold = (path: string, value: boolean) =>
    setFolded((prev) => new Map(prev).set(path, value));
  // An address that names a file opens it, even one the reader folded or
  // marked viewed: a link lands on what it points at.
  const selectedFile = flow.selected?.file;
  useWatchEffect(() => {
    if (selectedFile && (folded.get(selectedFile) ?? !!fileMarks?.(selectedFile)?.viewed)) setFold(selectedFile, false);
  }, [selectedFile, flow.selected?.anchor?.lineNumber]);

  // The file the reader is in: the topmost card under the sticky chrome.
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Narrow is the PAGE's width, not the window's: this page is often one
  // pane of a wide window. A narrow page stacks the tree over the cards and
  // keeps it folded until asked for; its own toggle, so a wide pane's choice
  // is left alone.
  const [narrow, setNarrow] = useState(false);
  const [narrowTreeOpen, setNarrowTreeOpen] = useState(false);
  useWatchEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setNarrow(el.clientWidth < 820));
    observer.observe(el);
    setNarrow(el.clientWidth < 820);
    return () => observer.disconnect();
  }, []);
  const sidebarOpen = narrow ? narrowTreeOpen : wideTreeOpen;
  const onToggleSidebar = narrow ? () => setNarrowTreeOpen((v) => !v) : toggleWideTree;
  const [active, setActive] = useState<string | null>(null);
  const stickyTop = flow.stickyTop;
  const fileKey = files.map(pathOf).join("\n");
  useWatchEffect(() => {
    const root = rootRef.current;
    const scroller = root?.closest<HTMLElement>("[data-main-scroll]");
    if (!root || !scroller) return;
    const measure = () => {
      // The card being read is the last one whose top has gone under the
      // sticky chrome; above the first card, it is the first.
      const line = scroller.getBoundingClientRect().top + stickyTop + 48;
      let current: string | null = null;
      for (const el of root.querySelectorAll<HTMLElement>("[data-flow-file]")) {
        if (el.getBoundingClientRect().top <= line) current = el.dataset.flowFile!;
        else break;
      }
      setActive(current ?? (files[0] ? pathOf(files[0]) : null));
    };
    // Measured on the scroll itself: the walk stops at the first card below
    // the line, so it is a handful of reads, and a frame callback would never
    // run in a background tab.
    scroller.addEventListener("scroll", measure, { passive: true });
    measure();
    // A landing moves the page by hand for a second or two (landOn); measure
    // again across that window, for the tab whose scroll events arrive late
    // or not at all.
    const settles = [400, 1600, 3000].map((ms) => setTimeout(measure, ms));
    return () => {
      scroller.removeEventListener("scroll", measure);
      settles.forEach(clearTimeout);
    };
  }, [fileKey, stickyTop, flow.selected?.file, flow.selected?.anchor?.lineNumber]);

  // The tree stays in view only while it fits under the chrome; a tree taller
  // than the window scrolls with the page, so every entry stays reachable
  // without a scroller of its own.
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [treeFits, setTreeFits] = useState(true);
  useWatchEffect(() => {
    const el = treeRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setTreeFits(el.offsetHeight <= window.innerHeight - stickyTop - 24);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [sidebarOpen, stickyTop]);

  // j and k walk the files, m marks the one in hand viewed and moves on: the
  // same keys as the pane form, moving the page instead of a selection.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!rootRef.current?.offsetParent) return;
    const el = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (keyBelongsElsewhere(el)) return;
    const order = files.map(pathOf);
    const at = Math.max(0, order.indexOf(active ?? flow.selected?.file ?? order[0]));
    if (e.key === "j" || e.key === "]") {
      e.preventDefault();
      if (at < order.length - 1) flow.onJumpFile(order[at + 1]);
    } else if (e.key === "k" || e.key === "[") {
      e.preventDefault();
      if (at > 0) flow.onJumpFile(order[at - 1]);
    } else if (e.key === "m" && onToggleViewed) {
      e.preventDefault();
      const path = order[at];
      const wasViewed = !!fileMarks?.(path)?.viewed;
      setFolded((prev) => { const next = new Map(prev); next.delete(path); return next; });
      onToggleViewed(path);
      if (!wasViewed && at < order.length - 1) flow.onJumpFile(order[at + 1]);
    }
  });

  inHand.current = () => {
    const path = active ?? flow.selected?.file ?? (files[0] && pathOf(files[0]));
    // The shortcut folds what it marks, like m.
    if (path) setFolded((prev) => { const next = new Map(prev); next.delete(path); return next; });
    return path;
  };

  const selectedTreePath = files.find((f) => pathOf(f) === (active ?? flow.selected?.file))?.filename ?? null;
  const allFolded = files.every((f) => isFolded(pathOf(f)));

  return (
    <div ref={rootRef} className={cn("cc-flow flex gap-4 px-4 pt-4 pb-16", narrow ? "flex-col" : "items-start")}>
      {sidebarOpen && (
        <aside
          ref={treeRef}
          className={cn("cc-flow-tree shrink-0", narrow ? "w-full" : "w-[272px]")}
          style={treeFits && !narrow ? { position: "sticky", top: stickyTop + 12 } : undefined}
        >
          <FileSidebar
            flow
            files={files}
            selectedFile={selectedTreePath}
            onSelectFile={(stripped) => {
              const file = files.find((f) => f.filename === stripped);
              if (!file) return;
              // A narrow page has no room beside the cards: the tree stacks
              // on top of them, and choosing from it puts it away.
              if (narrow) onToggleSidebar();
              setFold(pathOf(file), false);
              flow.onJumpFile(pathOf(file));
            }}
            header={sidebarHeader}
            commonPrefix={commonPrefix}
            fileMarks={fileMarks}
          />
        </aside>
      )}

      <div className="flex-1 min-w-0">
        <div className="mb-3 flex items-center gap-2 text-[12px] text-sol-text-muted">
          <button
            type="button"
            onClick={onToggleSidebar}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-sol-border/60 px-2 py-1 hover:text-sol-text hover:border-sol-border transition-colors"
            title={sidebarOpen ? "Hide the file tree (b)" : "Show the file tree (b)"}
          >
            {sidebarOpen ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeft className="w-3.5 h-3.5" />}
            Files
          </button>
          <span className="min-w-0 truncate">
            {files.length} {files.length === 1 ? "file" : "files"} changed
            {commonPrefix && (
              <span className="ml-2 font-mono text-[11px] text-sol-text-dim" title={commonPrefix}>
                in {shortenPrefix(commonPrefix)}/
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setFolded(new Map(files.map((f) => [pathOf(f), !allFolded])))}
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-sol-text-dim hover:text-sol-text transition-colors"
          >
            {allFolded ? <ChevronsUpDown className="w-3.5 h-3.5" /> : <ChevronsDownUp className="w-3.5 h-3.5" />}
            {allFolded ? "Expand all" : "Collapse all"}
          </button>
        </div>

        <div className="space-y-5">
          {files.map((file) => {
            const path = pathOf(file);
            const status = getFileStatus(file.status);
            const language = getFileExtension(file.filename);
            const shut = isFolded(path);
            const target = flow.selected?.file === path ? flow.selected : null;
            const selection = target?.anchor
              ? { side: target.anchor.side, range: { start: target.anchor.lineNumber, end: target.anchor.lineEnd ?? target.anchor.lineNumber } }
              : null;
            return (
              <section
                key={path}
                id={flow.fileId(path)}
                data-flow-file={path}
                className={cn(
                  "cc-flow-file rounded-lg border bg-sol-bg overflow-clip",
                  target ? "border-sol-cyan/60" : "border-sol-border/80",
                )}
                // Off screen a card is a placeholder of its last known height, which
                // keeps a big pull request light. The card an address points into
                // is always real, so the landing measures true geometry.
                style={{ scrollMarginTop: stickyTop + 12, contentVisibility: shut || target ? undefined : "auto", containIntrinsicBlockSize: "auto 480px" }}
              >
                <header
                  className={cn(
                    "sticky z-10 flex items-center gap-2 bg-sol-bg-alt px-3 py-2 flex-wrap",
                    shut ? "" : "border-b border-sol-border/60",
                  )}
                  style={{ top: stickyTop }}
                >
                  <button
                    type="button"
                    onClick={() => setFold(path, !shut)}
                    className="p-0.5 -ml-1 rounded text-sol-text-dim hover:text-sol-text transition-colors"
                    title={shut ? "Show this file" : "Fold this file"}
                    aria-expanded={!shut}
                  >
                    {shut ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                  <span className={cn("text-[10px] font-bold shrink-0", status.color)} title={file.status}>
                    {status.label}
                  </span>
                  <span className="flex items-center gap-1 min-w-0 flex-1 basis-[16rem]">
                    <FileHeaderName file={file} fileHref={fileHref} />
                    {target?.anchor ? (
                      <CopyLinkButton url={flow.shareUrl(flow.lineHref(path, target.anchor))} label="Copy a link to the selected lines">
                        {lineRunLabel(target.anchor)} · Copy link
                      </CopyLinkButton>
                    ) : (
                      <CopyLinkButton url={flow.shareUrl(flow.fileAnchorHref(path))} label="Copy a link to this file" />
                    )}
                  </span>
                  <span className="flex items-center gap-3 text-[11px] text-sol-text-dim shrink-0">
                    <span>
                      <span className="text-sol-green">+{file.additions}</span>
                      <span className="mx-0.5 text-sol-text-dim/40">/</span>
                      <span className="text-sol-red">-{file.deletions}</span>
                    </span>
                    <ViewedToggle
                      file={file}
                      fileMarks={fileMarks}
                      onToggleViewed={onToggleViewed ? (p) => {
                        // Marking a file viewed folds it; unmarking opens it.
                        setFolded((prev) => { const next = new Map(prev); next.delete(p); return next; });
                        onToggleViewed(p);
                      } : undefined}
                    />
                  </span>
                </header>
                {!shut && (file.patch ? (
                  <FilePatchDiff
                    patch={file.patch}
                    language={language}
                    // A long file shows its first stretch and a "show more": a
                    // big pull request stays light. The file an address points
                    // into shows whole, so the linked line has a row to land on.
                    maxLines={target ? 1_000_000 : 600}
                    wrap
                    // Every line has an address here, so every line shows its number.
                    showLineNumbers
                    selection={selection}
                    onSelectionChange={(next) => {
                      if (!next) return;
                      flow.onSelectLines(path, {
                        side: next.side,
                        lineNumber: next.range.start,
                        ...(next.range.end !== next.range.start ? { lineEnd: next.range.end } : {}),
                      });
                    }}
                    lineHref={(anchor) => flow.lineHref(path, anchor)}
                    rowId={(anchor) => flow.rowId(path, anchor)}
                    commentContext={commentContextFor?.(path)}
                    {...lineThreadProps(lineThreads, file)}
                  />
                ) : (
                  <div className="text-sol-text-muted text-[13px] py-5 text-center">
                    {file.status === "added"
                      ? "A binary or empty file, so there is no diff to show"
                      : file.status === "removed" || file.status === "deleted"
                      ? "This file was deleted"
                      : file.status === "renamed"
                      ? "Renamed without changes"
                      : "No changes to display"}
                  </div>
                ))}
                {!shut && renderExtra && renderExtra(file)}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const MOBILE_BREAKPOINT = 768;

type ViewMode = "split" | "unified";

export function FileDiffLayout({
  files,
  title,
  subtitle,
  headerExtra,
  emptyState,
  sidebarHeader,
  onFileComment,
  renderFileExtra,
  onCloseDiffPanel,
  commentContextFor,
  lineThreads,
  focusFile,
  fileHref,
  fileMarks,
  onToggleViewed,
  flow,
}: FileDiffLayoutProps) {
  // Strip common prefix once for consistent comparisons
  const commonPrefix = useMemo(() => findCommonPrefix(files.map(f => f.filename)), [files]);
  const strippedFiles = useMemo(() => stripCommonPrefix(files), [files]);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const s = useTrackedStore([
    s => s.clientState.layouts?.file_diff,
    s => s.clientState.ui?.file_diff_view_mode,
  ]);
  const layoutPref = s.clientState.layouts?.file_diff ?? DEFAULT_FILE_DIFF_LAYOUT;
  const viewMode = s.clientState.ui?.file_diff_view_mode ?? "unified";
  const layout: Layout = { "file-tree": layoutPref.tree, "diff-content": layoutPref.content };
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const selectedFileRef = useRef<HTMLButtonElement>(null);

  const toggleViewMode = () => {
    s.updateClientUI({ file_diff_view_mode: viewMode === "split" ? "unified" : "split" });
  };

  // Cmd+Option+Y marks the file in hand viewed, whichever form is showing.
  const inHand: InHand = useRef(null);
  useShortcutContext("diff", !!onToggleViewed);
  usePaneShortcutAction("diff.toggleSeen", () => {
    if (!onToggleViewed) return false;
    const current = strippedFiles[currentFileIndex];
    const path = !flow && viewMode === "split" ? current && (current.originalFilename ?? current.filename) : inHand.current?.();
    if (!path) return false;
    onToggleViewed(path);
    return true;
  });

  useMountEffect(() => {
    const mobile = window.innerWidth < MOBILE_BREAKPOINT;
    setIsMobile(mobile);
    if (mobile) setSidebarOpen(false);
  });

  useEventListener("resize", () => {
    const mobile = window.innerWidth < MOBILE_BREAKPOINT;
    setIsMobile(mobile);
    if (mobile) setSidebarOpen(false);
  });

  useWatchEffect(() => {
    if (strippedFiles.length > 0 && !selectedFile) {
      setSelectedFile(strippedFiles[0].filename);
      setCurrentFileIndex(0);
    }
  }, [strippedFiles, selectedFile]);

  // External focus (e.g. a comment-rail jump): select the file in split view
  // and scroll to its card in unified view.
  useWatchEffect(() => {
    if (!focusFile) return;
    const index = strippedFiles.findIndex(
      (f) => (f.originalFilename ?? f.filename) === focusFile,
    );
    if (index < 0) return;
    setSelectedFile(strippedFiles[index].filename);
    setCurrentFileIndex(index);
    document.getElementById(`file-${index}`)?.scrollIntoView({ block: "start" });
  }, [focusFile, strippedFiles]);

  useWatchEffect(() => {
    const index = strippedFiles.findIndex((f) => f.filename === selectedFile);
    if (index >= 0) {
      setCurrentFileIndex(index);
    }
  }, [selectedFile, strippedFiles]);

  useWatchEffect(() => {
    if (selectedFileRef.current) {
      selectedFileRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [currentFileIndex]);

  useEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInput = keyBelongsElsewhere(target);

    if (isInput) return;
    // The page form walks its files itself (FlowDiffView).
    if (flow && e.key !== "b" && e.key !== "?") return;

    switch (e.key) {
      case "j":
      case "]":
        e.preventDefault();
        if (currentFileIndex < strippedFiles.length - 1) {
          const nextFile = strippedFiles[currentFileIndex + 1];
          setSelectedFile(nextFile.filename);
          setCurrentFileIndex(currentFileIndex + 1);
        }
        break;
      case "k":
      case "[":
        e.preventDefault();
        if (currentFileIndex > 0) {
          const prevFile = strippedFiles[currentFileIndex - 1];
          setSelectedFile(prevFile.filename);
          setCurrentFileIndex(currentFileIndex - 1);
        }
        break;
      case "b":
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
        break;
      case "m": {
        // Mark the file in hand viewed and move on to the next one: the
        // reading gesture is "done with this, what is next".
        if (!onToggleViewed) break;
        e.preventDefault();
        const current = strippedFiles[currentFileIndex];
        if (!current) break;
        const path = current.originalFilename ?? current.filename;
        onToggleViewed(path);
        if (!fileMarks?.(path)?.viewed && currentFileIndex < strippedFiles.length - 1) {
          const nextFile = strippedFiles[currentFileIndex + 1];
          setSelectedFile(nextFile.filename);
          setCurrentFileIndex(currentFileIndex + 1);
        }
        break;
      }
      case "v":
        e.preventDefault();
        toggleViewMode();
        break;
      case "?":
        e.preventDefault();
        s.toggleShortcutsPanel();
        break;
    }
  });

  const handleLayoutChange = useDragGatedLayoutPersist((newLayout) => {
    s.updateClientLayout("file_diff", { tree: newLayout["file-tree"] || 25, content: newLayout["diff-content"] || 75 });
  });

  const handleSelectFile = (filename: string) => {
    setSelectedFile(filename);
    if (isMobile) setSidebarOpen(false);
  };

  const selectedFileData = strippedFiles.find((f) => f.filename === selectedFile) || null;

  // Follow mode (lib/follow.ts): a pane diff is a place, the file in hand and
  // the line at the top of its scroller. The page form reports through its
  // address instead (useDiffAddress).
  const paneRef = useRef<HTMLDivElement | null>(null);
  const landRef = useRef<(() => void) | null>(null);
  useFollowSurface(
    {
      read: () => {
        const root = paneRef.current;
        if (!root || root.offsetParent === null) return null;
        const at = topDiffRow(root);
        const file = viewMode === "unified" && at?.fileIndex !== undefined ? strippedFiles[at.fileIndex] : selectedFileData;
        return file ? { diff: { file: file.originalFilename ?? file.filename, line: at?.line } } : null;
      },
      apply: (view) => {
        const want = view.diff;
        const root = paneRef.current;
        if (!want || !root || root.offsetParent === null) return [];
        const index = strippedFiles.findIndex((f) => (f.originalFilename ?? f.filename) === want.file);
        if (index < 0) return [];
        setSelectedFile(strippedFiles[index].filename);
        setCurrentFileIndex(index);
        landRef.current?.();
        landRef.current = landOnDiffRow(paneRef, viewMode === "unified" ? index : null, want.line);
        return ["diff"];
      },
    },
    !flow,
    [selectedFile, viewMode, strippedFiles],
  );
  useWatchEffect(() => {
    const root = paneRef.current;
    if (flow || !root) return;
    root.addEventListener("scroll", notifyFollowView, { capture: true, passive: true });
    return () => {
      root.removeEventListener("scroll", notifyFollowView, { capture: true });
      landRef.current?.();
    };
  }, [flow, viewMode, isMobile, files.length === 0]);

  const showHeader = title || subtitle || headerExtra;

  if (files.length === 0) {
    return (
      <div className="h-full flex flex-col">
        {(title || subtitle) && (
          <div className="border-b border-sol-border px-4 py-3 bg-sol-bg">
            {title && <h1 className="text-lg font-semibold text-sol-text">{title}</h1>}
            {subtitle && <div className="mt-1">{subtitle}</div>}
          </div>
        )}
        {(headerExtra || onCloseDiffPanel) && !title && (
          <div className="px-4 py-2 border-b border-sol-border bg-sol-bg flex items-center justify-between shrink-0 gap-2">
            <div className="flex items-center gap-3 min-w-0">{headerExtra}</div>
            {onCloseDiffPanel && (
              <Button variant="ghost" size="icon" className="h-8 w-8 opacity-50 hover:opacity-100" onClick={onCloseDiffPanel} title="Close diff panel (d)">
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
        <div className="flex-1 flex items-center justify-center text-sol-text-muted">
          <div className="text-center">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
            {emptyState ?? <p>No files changed</p>}
          </div>
        </div>
      </div>
    );
  }

  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  if (flow) {
    return (
      <FlowDiffView
        files={strippedFiles}
        commonPrefix={commonPrefix}
        flow={flow}
        sidebarHeader={sidebarHeader}
        renderExtra={renderFileExtra}
        commentContextFor={commentContextFor}
        lineThreads={lineThreads}
        fileHref={fileHref}
       
        fileMarks={fileMarks}
        onToggleViewed={onToggleViewed}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        inHand={inHand}
      />
    );
  }

  const diffContentProps = {
    file: selectedFileData,
    onComment: onFileComment,
    renderExtra: renderFileExtra,
    fileIndex: currentFileIndex,
    totalFiles: files.length,
    onToggleSidebar: toggleSidebar,
    sidebarOpen,
    commentContextFor,
    lineThreads,
    fileHref,
    fileMarks,
    onToggleViewed,
  };

  const viewedCount = fileMarks ? files.filter((f) => fileMarks(f.originalFilename ?? f.filename)?.viewed).length : 0;
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const viewModeButton = (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1.5 text-xs"
      onClick={toggleViewMode}
      title={viewMode === "unified" ? "Switch to split view (v)" : "Switch to unified view (v)"}
    >
      {viewMode === "unified" ? (
        <>
          <SplitSquareVertical className="w-4 h-4" />
          <span className="hidden sm:inline">Split</span>
        </>
      ) : (
        <>
          <LayoutList className="w-4 h-4" />
          <span className="hidden sm:inline">Unified</span>
        </>
      )}
    </Button>
  );

  if (viewMode === "unified") {
    return (
      <div ref={paneRef} className="h-full flex flex-col">
        <div className="px-4 py-2 border-b border-sol-border bg-sol-bg flex items-center justify-between shrink-0 gap-2">
          <div className="flex items-center gap-3 text-sm min-w-0 truncate">
            {headerExtra}
            {/* Beside header controls the count drops "changed" and the
                folder moves to the tooltip, so the viewed tally stays in view. */}
            <span className="text-sol-text-muted shrink-0" title={headerExtra && commonPrefix ? `${commonPrefix}/` : undefined}>
              {files.length} {files.length === 1 ? "file" : "files"}{headerExtra ? "" : " changed"}
            </span>
            <span className="text-sol-green font-medium shrink-0">+{totalAdditions}</span>
            <span className="text-sol-red font-medium shrink-0">-{totalDeletions}</span>
            {viewedCount > 0 && (
              <span className="text-sol-green text-xs shrink-0">{viewedCount} of {files.length} viewed</span>
            )}
            {commonPrefix && !headerExtra && (
              <span className="font-mono text-sol-text-dim text-xs truncate" title={commonPrefix}>
                {shortenPrefix(commonPrefix)}/
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {viewModeButton}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 opacity-50 hover:opacity-100"
              onClick={s.toggleShortcutsPanel}
              title="Keyboard shortcuts (?)"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            {onCloseDiffPanel && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-50 hover:opacity-100"
                onClick={onCloseDiffPanel}
                title="Close diff panel (d)"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <UnifiedDiffView
            files={strippedFiles}
            onComment={onFileComment}
            renderExtra={renderFileExtra}
            commentContextFor={commentContextFor}
            lineThreads={lineThreads}
            fileHref={fileHref}
           
            fileMarks={fileMarks}
            onToggleViewed={onToggleViewed}
            inHand={inHand}
          />
        </div>
      </div>
    );
  }

  const headerContent = showHeader ? (
    <div className="border-b border-sol-border px-4 py-3 bg-sol-bg flex items-center justify-between shrink-0 gap-2">
      <div className="min-w-0 truncate">
        {title && <h1 className="text-lg font-semibold text-sol-text truncate">{title}</h1>}
        {subtitle && <div className={cn("truncate", title ? "mt-1" : "")}>{subtitle}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {headerExtra}
        {viewModeButton}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-50 hover:opacity-100"
          onClick={s.toggleShortcutsPanel}
          title="Keyboard shortcuts (?)"
        >
          <Keyboard className="h-4 w-4" />
        </Button>
        {onCloseDiffPanel && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-50 hover:opacity-100"
            onClick={onCloseDiffPanel}
            title="Close diff panel (d)"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  ) : (
    <div className={cn("px-4 py-2 border-b border-sol-border bg-sol-bg flex items-center shrink-0 gap-2", headerExtra ? "justify-between" : "justify-end")}>
      {headerExtra && <div className="flex items-center gap-3 min-w-0">{headerExtra}</div>}
      <div className="flex items-center gap-1 shrink-0">
        {viewModeButton}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-50 hover:opacity-100"
          onClick={s.toggleShortcutsPanel}
          title="Keyboard shortcuts (?)"
        >
          <Keyboard className="h-4 w-4" />
        </Button>
        {onCloseDiffPanel && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-50 hover:opacity-100"
            onClick={onCloseDiffPanel}
            title="Close diff panel (d)"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <div ref={paneRef} className="h-full flex flex-col">
        {headerContent}
        <div className="flex-1 min-h-0 relative">
          {sidebarOpen && (
            <div className="absolute inset-0 z-20 bg-sol-bg">
              <FileSidebar
                files={strippedFiles}
                selectedFile={selectedFile}
                onSelectFile={handleSelectFile}
                header={sidebarHeader}
                selectedFileRef={selectedFileRef}
                commonPrefix={commonPrefix}
                fileMarks={fileMarks}
              />
            </div>
          )}
          <FileDiffContent {...diffContentProps} />
        </div>
      </div>
    );
  }

  if (!sidebarOpen) {
    return (
      <div ref={paneRef} className="h-full flex flex-col">
        {headerContent}
        <div className="flex-1 min-h-0">
          <FileDiffContent {...diffContentProps} />
        </div>
      </div>
    );
  }

  return (
    <div ref={paneRef} className="h-full flex flex-col">
      {headerContent}
      <div className="flex-1 min-h-0">
        <Group
          orientation="horizontal"
          onLayoutChange={handleLayoutChange}
          defaultLayout={layout}
          className="h-full"
        >
          <Panel id="file-tree" minSize={10}>
            <FileSidebar
              files={strippedFiles}
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
              header={sidebarHeader}
              selectedFileRef={selectedFileRef}
              commonPrefix={commonPrefix}
              fileMarks={fileMarks}
            />
          </Panel>

          <Separator className="cc-split" />

          <Panel id="diff-content" minSize={30}>
            <FileDiffContent {...diffContentProps} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}

// Sticky file header height in a pane scroller: a row under it is not read.
const PANE_HEADER_PX = 32;

/** The diff row at the top of a pane's scroller: its new-side line, and the
 *  file card it sits in when every file is stacked (`file-<index>`). */
function topDiffRow(root: HTMLElement): { line?: number; fileIndex?: number } | null {
  const scroller = root.querySelector<HTMLElement>("[data-follow-diff-scroll]");
  if (!scroller) return null;
  const edge = scroller.getBoundingClientRect().top + PANE_HEADER_PX;
  for (const row of scroller.querySelectorAll<HTMLElement>("[data-ln^='R']")) {
    if (row.getBoundingClientRect().bottom <= edge) continue;
    const card = row.closest<HTMLElement>("[id^='file-']");
    const fileIndex = card ? Number(card.id.slice(5)) : undefined;
    return { line: Number(row.dataset.ln!.slice(1)), fileIndex: Number.isFinite(fileIndex) ? fileIndex : undefined };
  }
  return { line: undefined };
}

/** Bring a file (its card, when stacked) and a new-side line to the top of a
 *  pane's scroller, the nearest line before it when the diff leaves it out. */
function landOnDiffRow(paneRef: React.RefObject<HTMLElement | null>, fileIndex: number | null, line: number | undefined): () => void {
  return landOn(
    () => paneRef.current?.querySelector<HTMLElement>("[data-follow-diff-scroll]"),
    (scroller) => {
      const scope = fileIndex === null ? scroller : scroller.querySelector<HTMLElement>(`[id="file-${fileIndex}"]`);
      if (!scope || line === undefined) return scope === scroller ? (scroller.firstElementChild as HTMLElement | null) : scope;
      let best: HTMLElement | null = null;
      for (const row of scope.querySelectorAll<HTMLElement>("[data-ln^='R']")) {
        if (Number(row.dataset.ln!.slice(1)) > line) break;
        best = row;
      }
      return best ?? scope;
    },
    (el) => (el.matches("[data-ln]") ? PANE_HEADER_PX : 0),
  );
}
