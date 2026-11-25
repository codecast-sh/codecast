// Quick open (Cmd-P, vim's CtrlP / :Files / Telescope find_files): every file
// in the vault, fuzzy matched, recent files first. `name:42` or `name:42:5`
// opens at the line; a bare `:42` goes to the line in the current file.
// Enter opens in a preview tab, Cmd-Enter in a split. A file with unsaved
// edits carries the tab's dirty dot, closed tab or not.

import { memo, useMemo, useRef, useState } from "react";
import { Clock, File, FileText } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { useVaultStore } from "../../../store/vaultStore";
import { bufferKey, useCodeStore } from "../../../store/codeStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { KeyCap } from "../../KeyCap";
import { isMac } from "../../../shortcuts";
import { hoverFocus } from "../../../shortcuts/focusSource";
import { modernDialog, modernScrim } from "../../ui/modernLook";
import { useGroupAnchor } from "./groupAnchor";
import { parseQuickOpenQuery, quickOpenIndex, rankFiles } from "../../../lib/code/workspace/quickOpen";

export interface QuickOpenProps {
  vaultId: string;
  initialQuery?: string;
  /** Files opened lately in this workspace, most recent first. */
  recent: string[];
  onOpen(path: string, at: string | undefined, split: boolean): void;
  onGotoLine(at: string): void;
  onClose(): void;
}

function Marked({ text, indexes, offset = 0 }: { text: string; indexes: readonly number[] | null; offset?: number }) {
  if (!indexes?.length) return <>{text}</>;
  const marks = new Set(indexes.map((i) => i - offset));
  const out: React.ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    out.push(runMarked ? <span key={key} className="text-sol-cyan">{run}</span> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = marks.has(i);
    if (m !== runMarked) {
      flush(i);
      runMarked = m;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

export const QuickOpen = memo(function QuickOpen({ vaultId, initialQuery = "", recent, onOpen, onGotoLine, onClose }: QuickOpenProps) {
  // The index is the same array while the vault names the same files, so a
  // save or a watcher event re-renders nothing here.
  const targets = useVaultStore((s) => quickOpenIndex(s.files));
  const dirty = useCodeStore((s) => s.dirty);
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const parsed = useMemo(() => parseQuickOpenQuery(query), [query]);
  const results = useMemo(() => rankFiles(targets, parsed.text, recent), [targets, parsed.text, recent]);
  const at = parsed.line ? (parsed.column ? `${parsed.line}:${parsed.column}` : `${parsed.line}`) : undefined;
  const gotoOnly = !parsed.text && !!parsed.line;

  useWatchEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);
  useWatchEffect(() => {
    listRef.current?.querySelector(`[data-row="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const activate = (i: number, split: boolean) => {
    if (gotoOnly) return onGotoLine(at!);
    const r = results[i];
    if (r) onOpen(r.target.path, at, split);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"))) {
      e.preventDefault();
      setSelected((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"))) {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected, e.metaKey || e.ctrlKey);
    }
  };

  const recentSet = useMemo(() => new Set(recent), [recent]);
  const anchor = useGroupAnchor<HTMLDivElement>(620);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Open a file"
      ref={anchor.ref}
      className="fixed inset-0 z-[70]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`absolute inset-0 bg-black/20 ${modernScrim}`} onMouseDown={onClose} />
      <div style={anchor.style} className={`overflow-hidden rounded-lg border border-sol-border/50 bg-sol-card shadow-2xl ${modernDialog({ scroll: false })}`}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Go to file"
          aria-label="File name, or name:line"
          className="w-full border-b border-sol-border/30 bg-transparent px-4 py-2.5 text-sm text-sol-text outline-none placeholder:text-sol-text-dim"
          spellCheck={false}
          autoComplete="off"
        />
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {gotoOnly ? (
            <div className="flex items-center gap-2 px-4 py-2 text-[13px] text-sol-text">
              Line <span className="tabular-nums text-sol-cyan">{at}</span>
            </div>
          ) : (
            results.map((r, i) => {
              const t = r.target;
              const isRecent = !parsed.text && recentSet.has(t.path);
              const Icon = isRecent ? Clock : isVaultMarkdownPath(t.path) ? FileText : File;
              return (
                <button
                  key={t.path}
                  type="button"
                  data-row={i}
                  onClick={(e) => activate(i, e.metaKey || e.ctrlKey)}
                  {...hoverFocus(() => setSelected(i))}
                  className={`flex w-full items-center gap-2.5 px-4 py-1 text-left text-[13px] ${i === selected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 opacity-50" />
                  <span className="shrink-0 truncate">
                    <Marked text={t.name} indexes={r.nameIndexes ?? r.pathIndexes} offset={r.nameIndexes || !t.dir ? 0 : t.dir.length + 1} />
                  </span>
                  {t.dir && (
                    <span className="min-w-0 truncate text-meta text-sol-text-dim">
                      <Marked text={t.dir} indexes={r.nameIndexes ? null : r.pathIndexes} />
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {at && i === selected && <span className="text-meta tabular-nums text-sol-cyan">:{at}</span>}
                    {dirty[bufferKey(vaultId, t.path)] && <span aria-label="Unsaved" className="size-2 rounded-full bg-sol-text-muted" />}
                  </span>
                </button>
              );
            })
          )}
          {!gotoOnly && results.length === 0 && <div className="px-4 py-5 text-center text-meta text-sol-text-dim">No matching files</div>}
        </div>
        <div className="flex items-center gap-4 border-t border-sol-border/30 px-4 py-1.5 text-meta text-sol-text-dim">
          <span className="flex items-center gap-1">
            <KeyCap size="xs">↵</KeyCap> open
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap>
            <KeyCap size="xs">↵</KeyCap> split
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">:</KeyCap> line
          </span>
        </div>
      </div>
    </div>
  );
});
