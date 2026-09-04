import { useState, useMemo, useCallback, useEffect, useRef, memo, lazy, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { genCommentId } from "../lib/reviewActions";
import { useFileComments } from "../hooks/useConversationComments";
import { KeyCap } from "./KeyboardShortcutsHelp";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-css";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-yaml";
import {
  anchorEndLine,
  commentRangeEnd,
  diffLineKey,
  extendLineRange,
  isLineSelected,
  parseDiffLineKey,
  type DiffLineAnchor,
  type DiffSide,
  type LineRange,
  type PatchHunk,
} from "../lib/patchParser";
import type { PendingComment } from "../lib/quoteFormat";

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

// The LCS matrix below is O(m*n) in time and memory; past this many cells we
// give up on a minimal diff and render the changed region as remove-all/add-all.
const MAX_LCS_CELLS = 500_000;

export function computeDiff(oldLines: string[], newLines: string[]): Array<{ type: 'added' | 'removed' | 'context'; content: string }> {
  const totalOld = oldLines.length;
  const totalNew = newLines.length;

  // Trim common prefix/suffix so the quadratic LCS only sees the changed
  // middle. Identical inputs (e.g. a Read result rendered through DiffView)
  // resolve here in linear time with no matrix at all.
  const minLen = Math.min(totalOld, totalNew);
  let prefix = 0;
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[totalOld - 1 - suffix] === newLines[totalNew - 1 - suffix]
  ) suffix++;

  const result: Array<{ type: 'added' | 'removed' | 'context'; content: string }> = [];
  for (let k = 0; k < prefix; k++) result.push({ type: 'context', content: oldLines[k] });

  const m = totalOld - prefix - suffix;
  const n = totalNew - prefix - suffix;

  if (m > 0 && n > 0 && m * n > MAX_LCS_CELLS) {
    for (let k = 0; k < m; k++) result.push({ type: 'removed', content: oldLines[prefix + k] });
    for (let k = 0; k < n; k++) result.push({ type: 'added', content: newLines[prefix + k] });
  } else if (m > 0 || n > 0) {
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[prefix + i - 1] === newLines[prefix + j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    let i = m, j = n;
    const temp: typeof result = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[prefix + i - 1] === newLines[prefix + j - 1]) {
        temp.push({ type: 'context', content: oldLines[prefix + i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        temp.push({ type: 'added', content: newLines[prefix + j - 1] });
        j--;
      } else {
        temp.push({ type: 'removed', content: oldLines[prefix + i - 1] });
        i--;
      }
    }
    for (let k = temp.length - 1; k >= 0; k--) result.push(temp[k]);
  }

  for (let k = suffix; k > 0; k--) result.push({ type: 'context', content: oldLines[totalOld - k] });
  return result;
}

function highlightCode(code: string, language?: string): string {
  if (!language) return escapeHtml(code);

  try {
    const grammar = Prism.languages[language];
    if (!grammar) return escapeHtml(code);
    return Prism.highlight(code, grammar, language);
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface WordDiffToken {
  text: string;
  highlighted: boolean;
}

function computeWordDiff(oldLine: string, newLine: string): { oldTokens: WordDiffToken[]; newTokens: WordDiffToken[] } {
  let prefixLen = 0;
  const minLen = Math.min(oldLine.length, newLine.length);
  while (prefixLen < minLen && oldLine[prefixLen] === newLine[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldLine[oldLine.length - 1 - suffixLen] === newLine[newLine.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldPrefix = oldLine.slice(0, prefixLen);
  const oldMiddle = oldLine.slice(prefixLen, oldLine.length - suffixLen);
  const oldSuffix = oldLine.slice(oldLine.length - suffixLen);

  const newPrefix = newLine.slice(0, prefixLen);
  const newMiddle = newLine.slice(prefixLen, newLine.length - suffixLen);
  const newSuffix = newLine.slice(newLine.length - suffixLen);

  const oldTokens: WordDiffToken[] = [];
  if (oldPrefix) oldTokens.push({ text: oldPrefix, highlighted: false });
  if (oldMiddle) oldTokens.push({ text: oldMiddle, highlighted: true });
  if (oldSuffix) oldTokens.push({ text: oldSuffix, highlighted: false });

  const newTokens: WordDiffToken[] = [];
  if (newPrefix) newTokens.push({ text: newPrefix, highlighted: false });
  if (newMiddle) newTokens.push({ text: newMiddle, highlighted: true });
  if (newSuffix) newTokens.push({ text: newSuffix, highlighted: false });

  return { oldTokens, newTokens };
}

function renderTokensWithHighlight(
  tokens: WordDiffToken[],
  highlightClass: string,
  language?: string
): string {
  return tokens.map(t => {
    const html = language ? highlightCode(t.text, language) : escapeHtml(t.text);
    if (t.highlighted) {
      return `<span class="${highlightClass}">${html}</span>`;
    }
    return html;
  }).join("");
}

type DiffLineType = 'added' | 'removed' | 'context';

interface FlatDiffLine {
  type: DiffLineType;
  content: string;
  oldNum?: number;
  newNum?: number;
  wordDiffHtml?: string;
  html?: string;
  // Stable index across the full (un-truncated) line list, used to anchor line
  // comments so they stay attached when the diff expands/collapses.
  lineKey?: number;
}

interface HunkSeparator {
  type: 'separator';
}

type DisplayItem = FlatDiffLine | HunkSeparator;

// Assign each durably-commented FILE line to one visible diff row: the row
// showing that line on the new side, falling back to the old side (a comment on
// a since-deleted line). One row per line so a comment never renders twice when
// old and new numbering overlap. Exported for tests.
export function placeDurableThreads(
  displayItems: DisplayItem[],
  commentedLines: ReadonlySet<number>,
): Map<number, number> {
  const rows = new Map<number, number>(); // display index → file line number
  const placed = new Set<number>();
  const tryPlace = (num: number | undefined, index: number) => {
    if (num !== undefined && commentedLines.has(num) && !placed.has(num) && !rows.has(index)) {
      rows.set(index, num);
      placed.add(num);
    }
  };
  displayItems.forEach((item, i) => { if (item.type !== 'separator') tryPlace(item.newNum, i); });
  displayItems.forEach((item, i) => { if (item.type !== 'separator') tryPlace(item.oldNum, i); });
  return rows;
}

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

// The anchors one row can carry. A context row exists on both sides, so it can
// hold either; an added row is only on the right, a removed row only on the left.
function lineAnchors(line: FlatDiffLine): DiffLineAnchor[] {
  const anchors: DiffLineAnchor[] = [];
  if (line.newNum !== undefined && line.type !== "removed") {
    anchors.push({ side: "RIGHT", lineNumber: line.newNum });
  }
  if (line.oldNum !== undefined && line.type !== "added") {
    anchors.push({ side: "LEFT", lineNumber: line.oldNum });
  }
  return anchors;
}

function hunksToDisplayItems(
  hunks: PatchHunk[],
  language?: string
): { items: DisplayItem[]; maxLineNum: number } {
  const items: DisplayItem[] = [];
  let maxLineNum = 0;

  for (let h = 0; h < hunks.length; h++) {
    if (h > 0) {
      items.push({ type: 'separator' });
    }

    const hunk = hunks[h];
    const lines = hunk.lines;

    const processed = lines.map(l => ({
      type: (l.type === 'addition' ? 'added' : l.type === 'deletion' ? 'removed' : 'context') as DiffLineType,
      content: l.content,
      oldNum: l.oldLineNumber,
      newNum: l.newLineNumber,
    }));

    const withWordDiff = applyWordDiffToBlock(processed, language);

    for (const line of withWordDiff) {
      if (line.oldNum && line.oldNum > maxLineNum) maxLineNum = line.oldNum;
      if (line.newNum && line.newNum > maxLineNum) maxLineNum = line.newNum;
      items.push(line);
    }
  }

  return { items, maxLineNum };
}

function diffToDisplayItems(
  changes: Array<{ type: 'added' | 'removed' | 'context'; content: string }>,
  startLine: number,
  contextLines: number,
  language?: string,
  // Also emit a separator for hidden context at the very top/bottom of the file
  // (not just between visible regions), so an expandable diff offers a handle
  // even when the only change sits at one end. Off for inert diffs, whose
  // appearance shouldn't change.
  edgeSeparators = false
): { items: DisplayItem[]; maxLineNum: number; totalCodeLines: number } {
  const allLines: FlatDiffLine[] = [];
  let oldLineNum = startLine;
  let newLineNum = startLine;

  for (const change of changes) {
    if (change.type === 'added') {
      allLines.push({ type: 'added', content: change.content, newNum: newLineNum++ });
    } else if (change.type === 'removed') {
      allLines.push({ type: 'removed', content: change.content, oldNum: oldLineNum++ });
    } else {
      allLines.push({ type: 'context', content: change.content, oldNum: oldLineNum++, newNum: newLineNum++ });
    }
  }

  const hasChanges = allLines.some(l => l.type !== 'context');
  const showLine = new Set<number>();
  if (!hasChanges) {
    for (let i = 0; i < allLines.length; i++) showLine.add(i);
  } else {
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].type !== 'context') {
        for (let j = Math.max(0, i - contextLines); j <= Math.min(allLines.length - 1, i + contextLines); j++) {
          showLine.add(j);
        }
      }
    }
  }

  // lineKey = index into the FULL line list, assigned before context collapsing,
  // so a comment's anchor survives a contextLines change (expanding hidden
  // context must not shift the keys of lines already on screen).
  for (let i = 0; i < allLines.length; i++) allLines[i].lineKey = i;

  const items: DisplayItem[] = [];
  let lastShown = -1;

  const visibleLines: FlatDiffLine[] = [];
  const visibleIndices: number[] = [];
  for (let i = 0; i < allLines.length; i++) {
    if (showLine.has(i)) {
      if (lastShown >= 0 && i > lastShown + 1) {
        items.push({ type: 'separator' });
      } else if (lastShown < 0 && edgeSeparators && i > 0) {
        items.push({ type: 'separator' });
      }
      visibleLines.push(allLines[i]);
      visibleIndices.push(items.length);
      items.push(allLines[i]);
      lastShown = i;
    }
  }
  if (edgeSeparators && lastShown >= 0 && lastShown < allLines.length - 1) {
    items.push({ type: 'separator' });
  }

  const withWordDiff = applyWordDiffToBlock(visibleLines, language);
  for (let k = 0; k < withWordDiff.length; k++) {
    items[visibleIndices[k]] = withWordDiff[k];
  }

  const maxLineNum = Math.max(oldLineNum, newLineNum) - 1;
  const totalCodeLines = items.filter(i => i.type !== 'separator').length;

  return { items, maxLineNum, totalCodeLines };
}

function applyWordDiffToBlock(lines: FlatDiffLine[], language?: string): FlatDiffLine[] {
  const result = [...lines];

  let i = 0;
  while (i < result.length) {
    if (result[i].type === 'removed') {
      const removeStart = i;
      while (i < result.length && result[i].type === 'removed') i++;
      const removeEnd = i;

      const addStart = i;
      while (i < result.length && result[i].type === 'added') i++;
      const addEnd = i;

      const removeCount = removeEnd - removeStart;
      const addCount = addEnd - addStart;
      const pairCount = Math.min(removeCount, addCount);

      for (let p = 0; p < pairCount; p++) {
        const ri = removeStart + p;
        const ai = addStart + p;
        const { oldTokens, newTokens } = computeWordDiff(result[ri].content, result[ai].content);

        if (oldTokens.some(t => t.highlighted) || newTokens.some(t => t.highlighted)) {
          result[ri] = {
            ...result[ri],
            wordDiffHtml: renderTokensWithHighlight(oldTokens, "diff-word-removed", language),
          };
          result[ai] = {
            ...result[ai],
            wordDiffHtml: renderTokensWithHighlight(newTokens, "diff-word-added", language),
          };
        }
      }
      continue;
    }
    i++;
  }

  return result;
}

interface DiffViewProps {
  oldStr?: string;
  newStr?: string;
  hunks?: PatchHunk[];
  contextLines?: number;
  startLine?: number;
  maxLines?: number;
  language?: string;
  showLineNumbers?: boolean;
  // When provided, each line gets a hover affordance to attach an inline comment.
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
  renderLineThread?: (anchor: DiffLineAnchor, items: unknown[]) => React.ReactNode;
  // When set, the hover handle calls this instead of starting a review-batch
  // comment, and the handle appears even with no commentContext. The anchor is
  // the side and line of the row the handle was on.
  onLineComment?: (anchor: DiffLineAnchor | undefined, code: string) => void;
  // When provided, the ⋯ hidden-context separators become clickable and invoke
  // this (the owner responds by raising contextLines). Only meaningful in
  // oldStr/newStr mode, where the full text is present to expand into.
  onExpandContext?: () => void;
}

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
  onExpandContext,
}: DiffViewProps) {
  const [fullyExpanded, setFullyExpanded] = useState(false);
  // Hover affordance and per-row wiring turn on for either comment model.
  const interactive = !!commentContext || !!onLineComment;

  const { items, totalCodeLines, gutterCh } = useMemo(() => {
    let items: DisplayItem[];
    let maxLineNum: number;
    if (hunks && hunks.length > 0) {
      ({ items, maxLineNum } = hunksToDisplayItems(hunks, language));
    } else {
      const oldLines = (oldStr || "").split('\n');
      const newLines = (newStr || "").split('\n');
      const changes = computeDiff(oldLines, newLines);
      ({ items, maxLineNum } = diffToDisplayItems(changes, startLine, contextLines, language, !!onExpandContext));
    }
    // Highlight once here, not in render — this component sits inside the
    // frequently re-rendering conversation tree, and Prism per line per render
    // froze the page whenever a large block was open. Assign a stable lineKey to
    // each code line in the same pass so comment anchors survive truncation.
    // Lines from the oldStr/newStr path already carry a collapse-stable key
    // (see diffToDisplayItems); the positional fallback covers the hunks path.
    let lineKey = 0;
    items = items.map(item =>
      item.type === 'separator'
        ? item
        : { ...item, lineKey: item.lineKey ?? lineKey++, html: item.wordDiffHtml ?? highlightCode(item.content, language) },
    );
    const totalCodeLines = items.filter(i => i.type !== 'separator').length;
    return { items, totalCodeLines, gutterCh: String(Math.max(maxLineNum, 1)).length };
  }, [hunks, oldStr, newStr, startLine, contextLines, language, onExpandContext]);

  const needsTruncation = totalCodeLines > maxLines && !fullyExpanded;

  const displayItems = useMemo(() => {
    if (!needsTruncation) return items;
    let lineCount = 0;
    const truncated: DisplayItem[] = [];
    for (const item of items) {
      if (item.type === 'separator') {
        truncated.push(item);
      } else {
        if (lineCount < maxLines) {
          truncated.push(item);
          lineCount++;
        }
      }
    }
    return truncated;
  }, [items, needsTruncation, maxLines]);

  // Line comments (opt-in): grouped by their anchor line so each row can render
  // its own thread. Only subscribes when commentContext is set, so inert diffs
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
  const commentsByLine = useMemo(() => {
    if (myComments.length === 0) return EMPTY_LINE_COMMENTS;
    const map: Record<number, PendingComment[]> = {};
    for (const c of myComments) (map[c.blockIndex] ??= []).push(c);
    return map;
  }, [myComments]);
  const [editingLine, setEditingLine] = useState<number | null>(null);

  // The rows the reader has selected to comment on. A selection lives on ONE
  // side, because the two sides are different files and a run across them
  // names no code. Shift clicking the other side starts over there.
  const [selection, setSelection] = useState<{ side: DiffSide; range: LineRange } | null>(null);

  const selectLine = useCallback((anchor: DiffLineAnchor, extend: boolean) => {
    setSelection((current) => {
      const sameSide = extend && current?.side === anchor.side;
      return {
        side: anchor.side,
        range: extendLineRange(sameSide ? current!.range : null, anchor.lineNumber),
      };
    });
  }, []);

  // Durable code-anchored comments (real `comments` rows keyed file:line, shared
  // with the team) rendered under their diff line. Anchored to FILE line numbers,
  // not diff row indices, so they survive re-rendering the file in a different
  // diff.
  const durableByLine = useFileComments(commentContext?.conversationId, commentContext?.filePath);
  const durableRowByIndex = useMemo(
    () => durableByLine.size === 0
      ? null
      : placeDurableThreads(displayItems, new Set(durableByLine.keys())),
    [displayItems, durableByLine],
  );

  // Owner-held threads get the same placement: a file line number resolved to
  // the display row that shows it.
  const explicitRowByIndex = useMemo(
    () => !lineThreads || lineThreads.size === 0
      ? null
      : placeSidedThreads(displayItems, new Set(lineThreads.keys())),
    [displayItems, lineThreads],
  );

  const closeEditor = useCallback(() => {
    setEditingLine(null);
    useInboxStore.getState().setReviewEditingId(null);
  }, []);

  const addLineComment = useCallback(
    (lineKey: number, lineNum: number | undefined, code: string, anchor?: DiffLineAnchor) => {
      if (onLineComment) {
        onLineComment(anchor, code);
        return;
      }
      if (!commentContext) return;
      const s = useInboxStore.getState();
      const id = genCommentId();
      const quote = `${commentContext.filePath}:${lineNum ?? "?"}\n${code}`;
      s.addReviewComment(commentContext.conversationId, {
        id, messageId: commentContext.anchorKey, blockIndex: lineKey, quote, body: "", createdAt: Date.now(),
        filePath: commentContext.filePath, fileLine: lineNum,
      });
      s.setReviewEditingId(id);
      setEditingLine(lineKey);
    },
    [commentContext, onLineComment],
  );

  // One comment handle for the whole block instead of one per row, sitting in the
  // left margin OUTSIDE the code — the same `.cc-block-quote` handle a message
  // block gets (MessageReview), at the same gutter offset. It glides to whatever
  // row the cursor is on, so only a single mark is ever on screen and sweeping
  // the diff no longer flashes a chip down every line.
  //
  // Moving it is imperative (a delegated mouseover writes `top` and a data
  // attribute) rather than React state: hover state would re-render every row of
  // the diff on each row the cursor crosses, and this sits inside the
  // frequently-rendering conversation tree.
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const hoveredLine = useRef<FlatDiffLine | null>(null);
  const hoverClear = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The handle sits in the margin with a gap between it and the code, so the
  // cursor leaves the block on its way over — hide on a delay and cancel that
  // when it arrives, or the handle would vanish before it could be clicked.
  // Same grace as the message-block handle in MessageReview.
  const cancelClear = useCallback(() => {
    if (hoverClear.current) {
      clearTimeout(hoverClear.current);
      hoverClear.current = null;
    }
  }, []);

  const trackRow = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    cancelClear();
    const btn = handleRef.current;
    if (!btn) return;
    const rowEl = (e.target as HTMLElement | null)?.closest?.("[data-diff-row]") as HTMLElement | null;
    // Separators, comment threads and the handle itself report no row: keep the
    // handle where it is rather than snapping it away mid-gesture.
    if (!rowEl) return;
    const line = displayItems[Number(rowEl.dataset.diffRow)];
    if (!line || line.type === "separator") return;
    hoveredLine.current = line;
    // The handle lives outside the horizontal scroller, so it can't use the
    // row's offsetTop (that's measured inside it). Measure against the block.
    const host = btn.offsetParent as HTMLElement | null;
    const top = host ? rowEl.getBoundingClientRect().top - host.getBoundingClientRect().top : 0;
    // Appearing and moving are different gestures. Sliding into place from the
    // row you last left looks like a glitch, so only animate `top` while the
    // handle is already visible.
    btn.dataset.moving = btn.dataset.on === "yes" ? "yes" : "no";
    btn.style.top = `${top}px`;
    btn.dataset.on = "yes";
  }, [displayItems, cancelClear]);

  const untrackRow = useCallback(() => {
    cancelClear();
    hoverClear.current = setTimeout(() => {
      hoveredLine.current = null;
      if (handleRef.current) handleRef.current.dataset.on = "no";
    }, 140);
  }, [cancelClear]);

  useEffect(() => cancelClear, [cancelClear]);

  const commentOnHoveredRow = useCallback(() => {
    const line = hoveredLine.current;
    if (!line) return;
    // A row the reader can comment on is on one side or the other; a context
    // row counts as the new side, which is what a reader is reading.
    const anchor = lineAnchors(line)[0];
    if (!anchor) return;
    // Commenting from inside a selection comments on the whole run; commenting
    // anywhere else is about that row alone.
    const range = selection?.side === anchor.side ? selection.range : null;
    const end = commentRangeEnd(range, anchor.lineNumber);
    addLineComment(line.lineKey ?? 0, line.newNum ?? line.oldNum, line.content, {
      ...anchor,
      ...(end === undefined ? {} : { lineNumber: range!.start, lineEnd: end }),
    });
  }, [addLineComment, selection]);

  return (
    <div
      className={`code-block-resizable group font-mono text-[13px] leading-[22px] ${interactive ? "relative" : ""}`}
      onMouseOver={interactive ? trackRow : undefined}
      onMouseLeave={interactive ? untrackRow : undefined}
    >
      {interactive && (
        <button
          ref={handleRef}
          type="button"
          data-cc-gutter
          data-on="no"
          tabIndex={-1}
          className="cc-block-quote cc-diff-quote"
          title="Comment on this line"
          aria-label="Comment on this line"
          onMouseEnter={cancelClear}
          onMouseDown={(e) => e.preventDefault()}
          onClick={commentOnHoveredRow}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9.6 6C7 7.5 5.2 9.9 5.2 13.1c0 2.4 1.5 4 3.5 4 1.8 0 3.1-1.3 3.1-3 0-1.6-1.1-2.8-2.7-2.8-.3 0-.6 0-.7.1.3-1.6 1.6-3.2 3-4.1L9.6 6zm8 0c-2.6 1.5-4.4 3.9-4.4 7.1 0 2.4 1.5 4 3.5 4 1.8 0 3.1-1.3 3.1-3 0-1.6-1.1-2.8-2.7-2.8-.3 0-.6 0-.7.1.3-1.6 1.6-3.2 3-4.1L17.6 6z" />
          </svg>
        </button>
      )}
      <div className="cb-hscroll">
        <div className="min-w-fit">
        {displayItems.map((item, i) => {
          if (item.type === 'separator') {
            if (onExpandContext) {
              return (
                <button
                  key={`sep-${i}`}
                  type="button"
                  onClick={onExpandContext}
                  className="block w-full text-center text-[11px] text-sol-blue/60 hover:text-sol-cyan hover:bg-sol-bg-highlight/40 select-none transition-colors"
                  title="Show hidden context"
                >
                  &#8943;
                </button>
              );
            }
            return (
              <div key={`sep-${i}`} className="text-center text-[11px] text-sol-text-dim/40 select-none">
                &#8943;
              </div>
            );
          }

          const line = item as FlatDiffLine;
          const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
          const rowBg = line.type === 'added'
            ? 'diff-line-added'
            : line.type === 'removed'
            ? 'diff-line-removed'
            : '';
          const prefixColor = line.type === 'added'
            ? 'text-sol-green/60'
            : line.type === 'removed'
            ? 'text-sol-red/60'
            : 'text-transparent';

          const lk = line.lineKey ?? i;
          const lineComments = commentContext ? commentsByLine[lk] : undefined;
          const durableLine = durableRowByIndex?.get(i);
          const durableComments = durableLine !== undefined ? durableByLine.get(durableLine) : undefined;
          const explicitKeys = explicitRowByIndex?.get(i);
          const explicitThreads = explicitKeys
            ?.map((key) => [key, lineThreads?.get(key)] as const)
            .filter(([, items]) => items !== undefined);

          // The row's own anchor, and whether the reader has it selected.
          const rowAnchor = lineAnchors(line)[0];
          const selected =
            !!rowAnchor &&
            selection?.side === rowAnchor.side &&
            isLineSelected(selection.range, rowAnchor.lineNumber);

          const row = (
            <div
              data-diff-row={interactive ? i : undefined}
              className={`${rowBg} whitespace-pre ${selected ? "cc-diff-selected" : ""}`}
            >
              {showLineNumbers && (
                <span
                  className={`select-none inline-block text-right font-medium text-sol-text-dim opacity-55 pl-1 pr-3 mr-3 border-r border-sol-border/30 ${
                    interactive && rowAnchor ? "cursor-pointer hover:text-sol-cyan hover:opacity-100" : ""
                  }`}
                  style={{ minWidth: `calc(${gutterCh}ch + 1rem)` }}
                  title={interactive && rowAnchor ? "Click to select this line, shift click to select a range" : undefined}
                  onMouseDown={interactive && rowAnchor ? (e) => e.preventDefault() : undefined}
                  onClick={interactive && rowAnchor ? (e) => selectLine(rowAnchor, e.shiftKey) : undefined}
                >
                  {line.newNum ?? line.oldNum ?? ''}
                </span>
              )}
              <span className={`select-none ${prefixColor}`}>{prefix} </span>
              <span dangerouslySetInnerHTML={{ __html: line.html || ' ' }} />
            </div>
          );

          if (!explicitThreads?.length && (!commentContext || (!lineComments?.length && editingLine !== lk && !durableComments?.length))) {
            return <div key={i}>{row}</div>;
          }
          return (
            <div key={i}>
              {row}
              {renderLineThread
                ? explicitThreads?.map(([key, items]) => (
                    <div key={key}>{renderLineThread(parseDiffLineKey(key), items!)}</div>
                  ))
                : null}
              {commentContext && (lineComments?.length || editingLine === lk) ? (
                <DiffLineThread
                  conversationId={commentContext.conversationId}
                  comments={lineComments ?? EMPTY_COMMENT_LIST}
                  onCloseEditor={closeEditor}
                />
              ) : null}
              {commentContext && durableComments?.length ? (
                <Suspense fallback={null}>
                  <FileLineThread
                    conversationId={commentContext.conversationId}
                    filePath={commentContext.filePath}
                    lineNumber={durableLine}
                    comments={durableComments}
                  />
                </Suspense>
              ) : null}
            </div>
          );
        })}
        </div>
      </div>
      {needsTruncation && (
        <button
          onClick={() => setFullyExpanded(true)}
          className="block w-full text-center py-2 sm:py-1 text-xs sm:text-[11px] text-sol-blue hover:text-sol-cyan transition-colors"
        >
          show {totalCodeLines - maxLines} more lines
        </button>
      )}
      {fullyExpanded && totalCodeLines > maxLines && (
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
    }).catch((error) => {
      if (!isParkedDispatchError(error)) throw error;
    });
    s.removeReviewComment(conversationId, comment.id);
    onDone();
  }, [value, conversationId, comment.id, comment.filePath, comment.fileLine, onDone]);
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
