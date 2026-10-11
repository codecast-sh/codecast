import { useState, useMemo, useCallback, memo, lazy, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileDiff, useStableCallback, type DiffLineAnnotation, type FileDiffOptions, type SelectedLineRange } from "@pierre/diffs/react";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { genCommentId } from "../lib/reviewActions";
import { useFileComments } from "../hooks/useConversationComments";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { useTheme } from "./ThemeProvider";
import { DIFF_THEME } from "./diff/pierre";
import {
  anchorEndLine,
  diffLineKey,
  parseDiffLineKey,
  type DiffLineAnchor,
  type DiffSide,
  type LineRange,
  type PatchHunk,
} from "../lib/patchParser";
import { buildDiffMetadata, diffRows, type DiffRow } from "../lib/diffMetadata";
import type { PendingComment } from "../lib/quoteFormat";
import type { CodeAnchorText } from "@codecast/shared/comments";
import { captureDiffAnchor, placeInDiff, type DiffPlacement } from "../lib/diffAnchorPlacement";

// Lazy on purpose, not just for bundle size: FileLineThread pulls the comment
// rail machinery (CommentComposer → ConversationView's MessageInput), and this
// module sits under MarkdownRenderer, which ConversationView itself imports. A
// static import here closes that cycle and TDZ-crashes whichever page evaluates
// MarkdownRenderer first. The dynamic edge keeps diff rendering outside the
// ConversationView module graph; the thread only loads when a diff actually has
// durable comments.
const FileLineThread = lazy(() =>
  import("./comments/FileLineThread").then((m) => ({ default: m.FileLineThread })),
);

// Stable empty references so the comment selector/props don't churn renders when
// a diff has no line comments (the common case).
const EMPTY_LINE_COMMENTS: Record<number, PendingComment[]> = {};
const EMPTY_COMMENT_LIST: PendingComment[] = [];

// Row height, matching the line height set on diffs-container in globals.css.
// A long diff shows its first `maxLines` rows and a "show more".
const ROW_PX = 22;

// Rows plus the hidden-context separators a test may hand the placement code.
type DisplayItem = DiffRow | { type: "separator" };

// Assign each owner-held thread to the row that shows ITS side of the line: a
// LEFT thread (a comment on deleted code) goes under the row carrying that old
// line number, a RIGHT thread under the row carrying that new one. A thread
// covering a run of lines hangs under the LAST line it covers, so it sits below
// the code it is about instead of splitting it.
//
// A row can host more than one thread: a comment on line 13 and a comment on
// lines 10 to 13 end on the same row, and a context row IS both an old line and
// a new one, so a thread on either side belongs there. Each thread is placed
// once, so none renders twice where the two numberings overlap.
// Exported for tests.
export function placeSidedThreads(
  displayItems: DisplayItem[],
  keys: ReadonlySet<string>,
): Map<number, string[]> {
  // Every thread reduced to the one row it wants: its side and its end line.
  const wantedByEnd = new Map<string, string[]>();
  for (const key of keys) {
    const anchor = parseDiffLineKey(key);
    const at = `${anchor.side}:${anchorEndLine(anchor)}`;
    const here = wantedByEnd.get(at);
    if (here) here.push(key);
    else wantedByEnd.set(at, [key]);
  }

  const rows = new Map<number, string[]>(); // display index → anchor keys
  const placed = new Set<string>();
  displayItems.forEach((item, i) => {
    if (item.type === "separator") return;
    for (const anchor of lineAnchors(item)) {
      const here = wantedByEnd.get(diffLineKey(anchor));
      if (!here) continue;
      const unplaced = here.filter((key) => !placed.has(key));
      if (unplaced.length === 0) continue;
      rows.set(i, [...(rows.get(i) ?? []), ...unplaced]);
      for (const key of unplaced) placed.add(key);
    }
  });
  return rows;
}

// Threads placed where their passage is NOW. Each thread is relocated by its
// stored text against the whole diff (lib/diffAnchorPlacement), then hung on
// the display row showing the new spot, on the side the passage was found.
// A thread whose passage is outside every hunk has no row.
// Exported for tests.
export function placeRelocatedThreads<K>(
  allItems: DisplayItem[],
  displayItems: DisplayItem[],
  threads: Array<{ key: K; comment: Parameters<typeof placeInDiff>[1] }>,
): Map<number, Array<{ key: K; placement: DiffPlacement }>> {
  const byPlacedKey = new Map<string, Array<{ key: K; placement: DiffPlacement }>>();
  for (const { key, comment } of threads) {
    const placement = placeInDiff(allItems, comment);
    if (!placement) continue;
    const placedKey = diffLineKey({ side: placement.side, lineNumber: placement.line, lineEnd: placement.lineEnd });
    byPlacedKey.set(placedKey, [...(byPlacedKey.get(placedKey) ?? []), { key, placement }]);
  }
  const rows = new Map<number, Array<{ key: K; placement: DiffPlacement }>>();
  for (const [index, keys] of placeSidedThreads(displayItems, new Set(byPlacedKey.keys()))) {
    rows.set(index, keys.flatMap((k) => byPlacedKey.get(k) ?? []));
  }
  return rows;
}

// The anchors one row can carry. A context row exists on both sides, so it can
// hold either; an added row is only on the right, a removed row only on the left.
function lineAnchors(line: DiffRow): DiffLineAnchor[] {
  const anchors: DiffLineAnchor[] = [];
  if (line.newNum !== undefined && line.type !== "removed") {
    anchors.push({ side: "RIGHT", lineNumber: line.newNum });
  }
  if (line.oldNum !== undefined && line.type !== "added") {
    anchors.push({ side: "LEFT", lineNumber: line.oldNum });
  }
  return anchors;
}

// Pierre names the two sides by what they hold; a comment names them as GitHub
// does. A context line is drawn as an addition-side line.
const toPierreSide = (side: DiffSide) => (side === "LEFT" ? "deletions" : "additions");
const fromPierreSide = (side: string | undefined): DiffSide => (side === "deletions" ? "LEFT" : "RIGHT");

// Fence labels and Prism grammar names that Shiki spells differently.
const SHIKI_LANGUAGE: Record<string, string> = { markup: "html" };

interface DiffViewProps {
  oldStr?: string;
  newStr?: string;
  hunks?: PatchHunk[];
  contextLines?: number;
  startLine?: number;
  maxLines?: number;
  language?: string;
  showLineNumbers?: boolean;
  // When provided, each line gets a gutter affordance to attach an inline comment.
  // Comments accumulate in the shared review batch keyed by `conversationId`
  // (under this `anchorKey`), so they auto-attach to the user's next reply just
  // like message/plan annotations. Omit it (the default) and the diff is inert.
  commentContext?: { conversationId: string; anchorKey: string; filePath: string };
  // Threads the OWNER holds, keyed by FILE line number, rendered by its own
  // callback under the matching line. This is the escape hatch for comments
  // that are not conversation comments — the PR page's code comments live in
  // their own table — so the placement logic stays here and is not copied.
  // A line with an empty array still gets a row, which is how a surface opens
  // a composer on a line that has no thread yet.
  lineThreads?: ReadonlyMap<string, unknown[]>;
  // `placement` says where the thread's passage is now when it moved or is
  // gone (lib/diffAnchorPlacement), for the thread's header.
  renderLineThread?: (anchor: DiffLineAnchor, items: unknown[], placement?: DiffPlacement) => React.ReactNode;
  // When set, the comment affordance calls this instead of starting a
  // review-batch comment, and appears even with no commentContext. The anchor
  // is the side and line (or run of lines) it was used on; `anchorLines` the
  // text to store with the comment so it can be found again after the code moves.
  onLineComment?: (anchor: DiffLineAnchor | undefined, code: string, anchorLines?: CodeAnchorText) => void;
  // Wrap long lines instead of scrolling the block sideways. A page that is
  // one scroller (the pull request page) wants this: a second, horizontal
  // scroller per file is exactly the nesting it exists to avoid.
  wrap?: boolean;
  // The selected run of lines, owned by the surface when it keeps it in the
  // URL. Omit both to keep the selection inside the diff.
  selection?: DiffSelection | null;
  onSelectionChange?: (selection: DiffSelection | null) => void;
}

export type DiffSelection = { side: DiffSide; range: LineRange };

type AnnotationMeta = { row: number };

export const DiffView = memo(function DiffView({
  oldStr,
  newStr,
  hunks,
  contextLines = 3,
  startLine = 1,
  maxLines = 10,
  language,
  showLineNumbers = false,
  commentContext,
  lineThreads,
  renderLineThread,
  onLineComment,
  wrap = false,
  selection: selectionProp,
  onSelectionChange,
}: DiffViewProps) {
  const { theme } = useTheme();
  const [fullyExpanded, setFullyExpanded] = useState(false);
  // The comment affordance turns on for either comment model.
  const interactive = !!commentContext || !!onLineComment;
  const filePath = commentContext?.filePath;

  // Pierre's model of the diff, and the rows it shows with their line numbers
  // on each side. Comment placement and anchor capture read the rows, so they
  // agree with what is drawn by construction.
  const { fileDiff, rows } = useMemo(() => {
    const lang = language ? SHIKI_LANGUAGE[language] ?? language : undefined;
    const fileDiff = buildDiffMetadata({ oldStr, newStr, hunks, startLine, contextLines, name: filePath ?? "snippet", lang });
    return { fileDiff, rows: diffRows(fileDiff) };
  }, [hunks, oldStr, newStr, startLine, contextLines, language, filePath]);

  const needsTruncation = rows.length > maxLines && !fullyExpanded;

  // Line comments (opt-in): grouped by their row so each row can render its
  // own thread. Only subscribes when commentContext is set, so inert diffs
  // (Read results, etc.) pay nothing.
  //
  // The store subscription MUST return a flat array, not the grouped map: the map
  // would hold freshly-allocated sub-arrays every render, which `useShallow`'s
  // value-by-value comparison can never see as equal, so the useSyncExternalStore
  // snapshot would never stabilize and React would loop ("Maximum update depth
  // exceeded"). A flat filtered list shallow-compares by stable comment refs, so
  // it settles. Group into the map afterward in a plain useMemo.
  const myComments = useInboxStore(
    useShallow((s) =>
      commentContext
        ? (s.reviewComments[commentContext.conversationId] ?? []).filter(
            (c) => c.messageId === commentContext.anchorKey,
          )
        : EMPTY_COMMENT_LIST,
    ),
  );
  const commentsByRow = useMemo(() => {
    if (myComments.length === 0) return EMPTY_LINE_COMMENTS;
    const map: Record<number, PendingComment[]> = {};
    for (const c of myComments) (map[c.blockIndex] ??= []).push(c);
    return map;
  }, [myComments]);
  const [editingRow, setEditingRow] = useState<number | null>(null);

  // The lines the reader has selected to comment on. A selection lives on ONE
  // side, because the two sides are different files and a run across them
  // names no code.
  const [ownSelection, setOwnSelection] = useState<DiffSelection | null>(null);
  const controlled = selectionProp !== undefined;
  const selection = controlled ? selectionProp : ownSelection;
  const selectable = interactive || !!onSelectionChange;
  const selectedLines = useMemo<SelectedLineRange | null>(
    () => selection ? { start: selection.range.start, end: selection.range.end, side: toPierreSide(selection.side) } : null,
    [selection],
  );
  const onLineSelected = useStableCallback((range: SelectedLineRange | null) => {
    if (!range) return;
    const side = fromPierreSide(range.side);
    // A drag that crosses to the other side keeps only where it started.
    const end = range.endSide && range.endSide !== range.side ? range.start : range.end;
    const next = { side, range: { start: Math.min(range.start, end), end: Math.max(range.start, end) } };
    if (!controlled) setOwnSelection(next);
    onSelectionChange?.(next);
  });

  // Durable code-anchored comments (real `comments` rows keyed file:line, shared
  // with the team) rendered under their diff line. Anchored to FILE line numbers,
  // not diff row indices, so they survive re-rendering the file in a different
  // diff.
  const durableByLine = useFileComments(commentContext?.conversationId, filePath);
  const durableByRow = useMemo(
    () => durableByLine.size === 0
      ? null
      : placeRelocatedThreads(rows, rows, [...durableByLine].map(([line, comments]) => ({
          key: line,
          comment: { line_number: line, anchor_lines: comments.find((c) => c.anchor_lines)?.anchor_lines },
        }))),
    [rows, durableByLine],
  );

  // Owner-held threads get the same placement: a file line number resolved to
  // the row that shows it.
  const explicitByRow = useMemo(
    () => !lineThreads || lineThreads.size === 0
      ? null
      : placeRelocatedThreads(rows, rows, [...lineThreads].map(([key, thread]) => {
          const anchor = parseDiffLineKey(key);
          return {
            key,
            comment: {
              line_number: anchor.lineNumber,
              line_end: anchor.lineEnd,
              side: anchor.side,
              anchor_lines: (thread as Array<{ anchor_lines?: CodeAnchorText }>).find((c) => c?.anchor_lines)?.anchor_lines,
            },
          };
        })),
    [rows, lineThreads],
  );

  // One annotation per row that carries anything: a thread of any kind, or the
  // composer for a comment being written. Pierre draws each under its line.
  const lineAnnotations = useMemo(() => {
    const hosts = new Set<number>();
    if (commentContext) {
      for (const row of Object.keys(commentsByRow)) hosts.add(Number(row));
      if (editingRow !== null) hosts.add(editingRow);
      for (const row of durableByRow?.keys() ?? []) hosts.add(row);
    }
    for (const row of explicitByRow?.keys() ?? []) hosts.add(row);
    const out: DiffLineAnnotation<AnnotationMeta>[] = [];
    for (const row of [...hosts].sort((a, b) => a - b)) {
      const anchor = rows[row] && lineAnchors(rows[row])[0];
      if (anchor) out.push({ side: toPierreSide(anchor.side), lineNumber: anchor.lineNumber, metadata: { row } });
    }
    return out;
  }, [commentContext, commentsByRow, editingRow, durableByRow, explicitByRow, rows]);

  const closeEditor = useCallback(() => {
    setEditingRow(null);
    useInboxStore.getState().setReviewEditingId(null);
  }, []);

  // The comment affordance in the gutter: on one line, or on the run the reader
  // selected or dragged down the gutter. The comment hangs under the run's last line.
  const onGutterUtilityClick = useStableCallback((range: SelectedLineRange) => {
    const side = fromPierreSide(range.side);
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    const row = rows.findIndex((r) => lineAnchors(r).some((a) => a.side === side && a.lineNumber === end));
    if (row < 0) return;
    const anchor: DiffLineAnchor = { side, lineNumber: start, ...(end !== start ? { lineEnd: end } : {}) };
    const anchorLines = captureDiffAnchor(rows, side, start, end === start ? undefined : end);
    const code = rows[row].content;
    if (onLineComment) {
      onLineComment(anchor, code, anchorLines);
      return;
    }
    if (!commentContext) return;
    const s = useInboxStore.getState();
    const id = genCommentId();
    const quote = `${commentContext.filePath}:${end}\n${code}`;
    s.addReviewComment(commentContext.conversationId, {
      id, messageId: commentContext.anchorKey, blockIndex: row, quote, body: "", createdAt: Date.now(),
      filePath: commentContext.filePath, fileLine: end, anchorLines,
    });
    s.setReviewEditingId(id);
    setEditingRow(row);
  });

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<AnnotationMeta>) => {
    const row = annotation.metadata.row;
    const explicit = explicitByRow?.get(row)
      ?.map(({ key, placement }) => ({ key, placement, items: lineThreads?.get(key) }))
      .filter((t) => t.items !== undefined);
    const pending = commentContext ? commentsByRow[row] : undefined;
    const durable = commentContext
      ? durableByRow?.get(row)
          ?.map(({ key, placement }) => ({ line: key, placement, comments: durableByLine.get(key) }))
          .filter((t) => t.comments?.length)
      : undefined;
    return (
      <div className="font-sans text-sol-text">
        {renderLineThread
          ? explicit?.map(({ key, placement, items }) => (
              <div key={key}>{renderLineThread(parseDiffLineKey(key), items!, placement)}</div>
            ))
          : null}
        {commentContext && (pending?.length || editingRow === row) ? (
          <DiffLineThread
            conversationId={commentContext.conversationId}
            comments={pending ?? EMPTY_COMMENT_LIST}
            onCloseEditor={closeEditor}
          />
        ) : null}
        {commentContext && durable?.length ? (
          <Suspense fallback={null}>
            {durable.map(({ line, placement, comments }) => (
              <FileLineThread
                key={line}
                conversationId={commentContext.conversationId}
                filePath={commentContext.filePath}
                lineNumber={line}
                comments={comments!}
                placement={placement}
              />
            ))}
          </Suspense>
        ) : null}
      </div>
    );
  }, [explicitByRow, lineThreads, commentContext, commentsByRow, durableByRow, durableByLine, renderLineThread, editingRow, closeEditor]);

  const options = useMemo<FileDiffOptions<AnnotationMeta, undefined>>(() => ({
    theme: DIFF_THEME,
    themeType: theme,
    diffStyle: "unified",
    diffIndicators: "classic",
    lineDiffType: "word-alt",
    // A whole file can open what it hides; a snippet or a patch has nothing
    // beyond its hunks, so its gaps are only marked.
    hunkSeparators: fileDiff.isPartial ? "simple" : "line-info",
    overflow: wrap ? "wrap" : "scroll",
    disableLineNumbers: !showLineNumbers,
    disableFileHeader: true,
    enableLineSelection: selectable,
    onLineSelected: selectable ? onLineSelected : undefined,
    enableGutterUtility: interactive,
    onGutterUtilityClick: interactive ? onGutterUtilityClick : undefined,
  }), [theme, fileDiff.isPartial, wrap, showLineNumbers, selectable, interactive, onLineSelected, onGutterUtilityClick]);

  return (
    <div className="code-block-resizable">
      <div style={needsTruncation ? { maxHeight: maxLines * ROW_PX, overflow: "hidden" } : undefined}>
        <FileDiff<AnnotationMeta, undefined>
          fileDiff={fileDiff}
          options={options}
          selectedLines={selectable ? selectedLines : undefined}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
        />
      </div>
      {needsTruncation && (
        <button
          onClick={() => setFullyExpanded(true)}
          className="block w-full text-center py-2 sm:py-1 text-xs sm:text-[11px] text-sol-blue hover:text-sol-cyan transition-colors"
        >
          show {rows.length - maxLines} more lines
        </button>
      )}
      {fullyExpanded && rows.length > maxLines && (
        <button
          onClick={() => setFullyExpanded(false)}
          className="block w-full text-center py-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
        >
          collapse
        </button>
      )}
    </div>
  );
});

// The inline comment thread rendered directly under a diff line. Each comment is
// the one being edited (a textarea) or a saved chip. Comments live in the shared
// review batch, so they ride out to the agent on the user's next reply.
function DiffLineThread({
  conversationId,
  comments,
  onCloseEditor,
}: {
  conversationId: string;
  comments: PendingComment[];
  onCloseEditor: () => void;
}) {
  const editingId = useInboxStore((s) => s.reviewEditingId);
  return (
    <div className="ml-2 my-1 border-l-2 border-sol-blue/40 pl-2.5 space-y-1 font-sans text-sol-text">
      {comments.map((c) =>
        c.id === editingId ? (
          <LineCommentEditor key={c.id} conversationId={conversationId} comment={c} onDone={onCloseEditor} />
        ) : (
          <LineCommentChip key={c.id} conversationId={conversationId} comment={c} />
        ),
      )}
    </div>
  );
}

function LineCommentChip({ conversationId, comment }: { conversationId: string; comment: PendingComment }) {
  return (
    <div className="group/chip flex items-start gap-2 rounded-md bg-sol-blue/5 border border-sol-blue/20 px-2 py-1">
      <span className="text-sol-blue/70 text-xs mt-0.5 select-none">💬</span>
      <div className="flex-1 min-w-0 text-[13px]">
        {comment.body ? (
          <span className="whitespace-pre-wrap break-words">{comment.body}</span>
        ) : (
          <span className="italic text-sol-text-dim">Flagged this line (no note)</span>
        )}
      </div>
      <div className="flex items-center gap-2 opacity-0 group-hover/chip:opacity-100 transition-opacity">
        <button
          type="button"
          className="text-[11px] text-sol-text-dim hover:text-sol-cyan"
          onClick={() => useInboxStore.getState().setReviewEditingId(comment.id)}
        >
          {comment.body ? "Edit" : "Add note"}
        </button>
        <button
          type="button"
          className="text-[11px] text-sol-text-dim hover:text-sol-red"
          onClick={() => useInboxStore.getState().removeReviewComment(conversationId, comment.id)}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function LineCommentEditor({
  conversationId,
  comment,
  onDone,
}: {
  conversationId: string;
  comment: PendingComment;
  onDone: () => void;
}) {
  const [value, setValue] = useState(comment.body);
  const save = useCallback(() => {
    useInboxStore.getState().commitReviewComment(conversationId, comment.id, value.trim());
    onDone();
  }, [value, conversationId, comment.id, onDone]);
  // Post as a DURABLE team comment anchored to this file:line (a real `comments`
  // row teammates see, with its own thread + agent reply) instead of the
  // ephemeral batch that rides the next reply. The pending row converts.
  const canPost = !!comment.filePath && comment.fileLine !== undefined;
  const post = useCallback(() => {
    const body = value.trim();
    if (!body || !comment.filePath) return;
    const s = useInboxStore.getState();
    void s.addComment(conversationId, body, {
      filePath: comment.filePath,
      lineNumber: comment.fileLine,
      anchorLines: comment.anchorLines,
    }).catch((error) => {
      if (!isParkedDispatchError(error)) throw error;
    });
    s.removeReviewComment(conversationId, comment.id);
    onDone();
  }, [value, conversationId, comment.id, comment.filePath, comment.fileLine, comment.anchorLines, onDone]);
  // Cancel an as-yet-unsaved (empty) comment by removing it, so a stray click on
  // the + button doesn't leave an empty flag behind; keep existing notes intact.
  const cancel = useCallback(() => {
    if (!comment.body.trim() && !value.trim()) {
      useInboxStore.getState().removeReviewComment(conversationId, comment.id);
    }
    onDone();
  }, [comment.body, value, conversationId, comment.id, onDone]);

  return (
    <div className="rounded-md bg-sol-bg-highlight/40 border border-sol-blue/30 p-1.5 font-sans">
      <textarea
        autoFocus
        value={value}
        placeholder="Comment on this line…"
        className="w-full bg-transparent text-[13px] text-sol-text placeholder:text-sol-text-dim outline-none resize-none"
        rows={2}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        }}
      />
      <div className="flex items-center justify-end gap-2 mt-1">
        <button type="button" className="text-[11px] text-sol-text-dim hover:text-sol-text" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
          Cancel <KeyCap size="xs">Esc</KeyCap>
        </button>
        {canPost && (
          <button
            type="button"
            className="text-[11px] text-sol-cyan hover:text-sol-blue font-medium"
            title="Post as a team comment on this line — teammates see it, and the agent can reply in its thread"
            onMouseDown={(e) => e.preventDefault()}
            onClick={post}
          >
            Post
          </button>
        )}
        <button
          type="button"
          className="text-[11px] text-sol-blue hover:text-sol-cyan font-medium"
          title="Attach to your next reply to the agent"
          onMouseDown={(e) => e.preventDefault()}
          onClick={save}
        >
          Save <KeyCap size="xs">⌘</KeyCap><KeyCap size="xs">↵</KeyCap>
        </button>
      </div>
    </div>
  );
}
