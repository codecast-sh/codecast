// Project search results: a virtualized list of file headers and match rows.
// Rows are fixed height, so the list never measures; only what is on screen
// renders, whatever the result count. With a replacement typed, each match
// row previews its change in place (the old text struck, the new text after).

import { memo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Replace, ReplaceAll, X } from "lucide-react";
import type { ResultRow } from "../../../lib/code/search/model";
import { previewLine, type ReplaceOptions } from "../../../lib/code/search/replace";
import { useWatchEffect } from "../../../hooks/useWatchEffect";

export const FILE_ROW_HEIGHT = 24;
export const MATCH_ROW_HEIGHT = 22;
/** Characters of a line shown before its match, at most. */
const LEAD_CHARS = 14;
/** Characters a match row shows at the Search pane's default width. */
const ROW_CHARS = 20;

/**
 * Where a row's text starts: up to `budget` characters before the match, moved
 * forward to the start of a word so the row never opens mid-word, and never
 * into the indentation. A window with no word start shows no lead at all.
 */
export function leadStart(text: string, start: number, budget: number): number {
  const indent = /^\s*/.exec(text)![0].length;
  if (start - budget <= indent) return Math.min(indent, start);
  for (let i = start - budget; i < start; i++) {
    if (/\W/.test(text[i - 1]) && /\w/.test(text[i])) return i;
  }
  return start;
}

export interface ReplacePreview {
  re: RegExp;
  replacement: string;
  opts: ReplaceOptions;
}

export interface ResultsListActions {
  onOpen: (row: Extract<ResultRow, { kind: "match" }>, focusEditor: boolean) => void;
  onToggle: (path: string) => void;
  onDismiss: (key: string) => void;
  onReplaceMatch: (row: Extract<ResultRow, { kind: "match" }>) => void;
  onReplaceFile: (path: string) => void;
  onSelect: (key: string) => void;
}

const iconButton = "flex h-[18px] w-[18px] items-center justify-center rounded-sm text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text disabled:opacity-40 disabled:hover:bg-transparent";

function splitPath(path: string): [string, string] {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? ["", path] : [path.slice(0, slash), path.slice(slash + 1)];
}

const FileRow = memo(function FileRow({
  row,
  active,
  replacing,
  locked,
  actions,
}: {
  row: Extract<ResultRow, { kind: "file" }>;
  active: boolean;
  replacing: boolean;
  locked: boolean;
  actions: ResultsListActions;
}) {
  const [dir, name] = splitPath(row.file.path);
  return (
    <div
      role="treeitem"
      aria-expanded={!row.collapsed}
      aria-selected={active}
      onClick={() => {
        actions.onSelect(row.key);
        actions.onToggle(row.file.path);
      }}
      title={row.file.path}
      className={`group flex h-full cursor-pointer items-center gap-1 pl-1.5 pr-1.5 text-[12px] ${active ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt"}`}
    >
      <ChevronRight className={`h-3 w-3 shrink-0 text-sol-text-dim transition-transform ${row.collapsed ? "" : "rotate-90"}`} />
      <span className="min-w-0 truncate font-medium text-sol-text">{name}</span>
      {/* Basis 0: the directory takes only what the name leaves, so it gives up its space first. */}
      <span className="min-w-0 flex-1 basis-0 truncate text-sol-text-dim">{dir}</span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <span className={`hidden items-center gap-0.5 group-hover:flex ${active ? "!flex" : ""}`}>
          {replacing && (
            <button
              type="button"
              aria-label="Replace in this file"
              title="Replace in this file"
              disabled={locked}
              className={iconButton}
              onClick={(e) => {
                e.stopPropagation();
                actions.onReplaceFile(row.file.path);
              }}
            >
              <ReplaceAll className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss file"
            title="Dismiss"
            className={iconButton}
            onClick={(e) => {
              e.stopPropagation();
              actions.onDismiss(row.file.path);
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
        <span className="min-w-[2ch] rounded-sm bg-sol-bg-alt px-1 text-center text-mark tabular-nums text-sol-text-muted">{row.count}</span>
      </span>
    </div>
  );
});

const MatchRow = memo(function MatchRow({
  row,
  active,
  preview,
  locked,
  actions,
}: {
  row: Extract<ResultRow, { kind: "match" }>;
  active: boolean;
  preview: ReplacePreview | null;
  locked: boolean;
  actions: ResultsListActions;
}) {
  const { text, ranges, line } = row.line;
  const { start, end } = ranges[row.range];
  const indent = /^\s*/.exec(text)![0].length;
  const hit = text.slice(start, end);
  let insert: string | null = null;
  if (preview) {
    const p = previewLine(preview.re, text, preview.replacement, preview.opts, start);
    insert = p.inserts[0] ?? null;
  }
  // The hit and its replacement must fit the narrow pane (about ROW_CHARS
  // wide at its default width): the lead gets only what they leave.
  const budget = Math.max(0, Math.min(LEAD_CHARS, ROW_CHARS - hit.length - (insert?.length ?? 0)));
  const from = leadStart(text, start, budget);
  return (
    <div
      role="treeitem"
      aria-selected={active}
      onClick={() => actions.onOpen(row, false)}
      onDoubleClick={() => actions.onOpen(row, true)}
      className={`group relative flex h-full cursor-pointer items-center pl-5 pr-1.5 font-mono text-[11.5px] [font-variant-ligatures:none] ${active ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt"}`}
    >
      <span className="min-w-[4ch] shrink-0 pr-1.5 text-right text-mark tabular-nums text-sol-text-dim">{line}</span>
      <span className="min-w-0 flex-1 truncate whitespace-pre text-sol-text-muted">
        {from > indent && <span className="text-sol-text-dim">…</span>}
        {text.slice(from, start)}
        {insert === null ? (
          <mark className="rounded-[2px] bg-sol-yellow/25 text-sol-text">{hit}</mark>
        ) : (
          <>
            <del className="rounded-[2px] bg-sol-red/20 text-sol-red decoration-sol-red/70">{hit}</del>
            <ins className="rounded-[2px] bg-sol-green/20 text-sol-green no-underline">{insert.replace(/\r?\n|\r/g, "↵")}</ins>
          </>
        )}
        {text.slice(end, end + 240)}
      </span>
      <span className={`absolute right-1 hidden items-center gap-0.5 rounded-sm bg-sol-bg-alt pl-0.5 group-hover:flex ${active ? "!flex bg-sol-bg-highlight" : ""}`}>
        {preview && (
          <button
            type="button"
            aria-label="Replace this match"
            title="Replace"
            disabled={locked}
            className={iconButton}
            onClick={(e) => {
              e.stopPropagation();
              actions.onReplaceMatch(row);
            }}
          >
            <Replace className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss match"
          title="Dismiss"
          className={iconButton}
          onClick={(e) => {
            e.stopPropagation();
            actions.onDismiss(row.key);
          }}
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    </div>
  );
});

export function SearchResultsList({
  rows,
  activeKey,
  preview,
  replacing,
  stale,
  busy,
  actions,
  onKeyDown,
  listRef,
}: {
  rows: ResultRow[];
  activeKey: string | null;
  preview: ReplacePreview | null;
  replacing: boolean;
  /** The rows are an earlier search's, shown until the next one answers. */
  stale: boolean;
  /** A replace is writing: replace buttons wait for it. */
  busy: boolean;
  actions: ResultsListActions;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "file" ? FILE_ROW_HEIGHT : MATCH_ROW_HEIGHT),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 16,
  });

  // Keep the active row on screen as F4 or the arrow keys move it.
  const activeIndex = activeKey ? rows.findIndex((r) => r.key === activeKey) : -1;
  useWatchEffect(() => {
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex]);

  return (
    <div
      ref={(el) => {
        scrollRef.current = el;
        listRef.current = el;
      }}
      role="tree"
      aria-label="Search results"
      tabIndex={0}
      data-owns-keys
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sol-cyan/40"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }} className={stale ? "opacity-50" : undefined}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div key={item.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` }}>
              {row.kind === "file" ? (
                <FileRow row={row} active={row.key === activeKey} replacing={replacing} locked={busy || stale} actions={actions} />
              ) : (
                <MatchRow row={row} active={row.key === activeKey} preview={preview} locked={busy || stale} actions={actions} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
