// Quick open (Cmd-P, vim's CtrlP / :Files / Telescope find_files): every file
// in the vault, fuzzy matched, recent files first, then files near the one
// being edited. `dir name` narrows by folder. A pasted location opens where it
// points (`name:42:5`, `path:L42-50`, `#L42`, `(42,5)`, an absolute path, a
// diff's `a/` path); a bare `:42` goes to the line in the current file.
// Enter opens in a preview tab, Cmd-Enter in a split. A file with unsaved
// edits carries the tab's dirty dot, closed tab or not.

import { FileStateMark } from "./FileStateMark";
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
import { usePickerAria } from "./pickerAria";
import { parseQuickOpenQuery, queryAt, targetAt, quickOpenIndex, rankFiles } from "../../../lib/code/workspace/quickOpen";

export interface QuickOpenProps {
  vaultId: string;
  /** The vault's absolute root, for pasted absolute paths. */
  root: string | null;
  /** The file being edited, which nearby files rank around. */
  activePath: string | null;
  initialQuery?: string;
  /** Files opened lately in this workspace, most recent first. */
  recent: string[];
  onOpen(path: string, at: string | undefined, split: boolean): void;
  /** An absolute path outside this folder. */
  onOpenLocal(absPath: string, at: string | undefined): void;
  onGotoLine(at: string): void;
  /** `@name` (this file's symbols) or `#name` (the project's): the symbol
   *  picker takes over with the rest as its filter. */
  onSymbols(scope: "file" | "project", query: string): void;
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

export const QuickOpen = memo(function QuickOpen({ vaultId, root, activePath, initialQuery = "", recent, onOpen, onOpenLocal, onGotoLine, onSymbols, onClose }: QuickOpenProps) {
  // The index is the same array while the vault names the same files, so a
  // save or a watcher event re-renders nothing here.
  const targets = useVaultStore((s) => quickOpenIndex(s.files));
  const dirty = useCodeStore((s) => s.dirty);
  const conflicts = useCodeStore((s) => s.conflicts);
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const parsed = useMemo(() => {
    const files = useVaultStore.getState().files;
    return parseQuickOpenQuery(query, { root, isFile: (p) => !!files[p] && !files[p].dir });
  }, [query, root]);
  // An exact path is the answer, ahead of anything fuzzy.
  const exact = parsed.text ? targetAt(targets, parsed.text) : undefined;
  const results = useMemo(
    () => (parsed.outside ? [] : exact ? [{ target: exact, nameIndexes: null, pathIndexes: null, score: 2 }] : rankFiles(targets, parsed.text, recent, { activePath })),
    [targets, parsed.text, parsed.outside, exact, recent, activePath],
  );
  const at = queryAt(parsed);
  const gotoOnly = !parsed.text && !!parsed.line;
  // A path the scan does not list (ignored, generated, past the cap) still
  // opens by name: the file view asks the daemon for it. One outside this
  // folder opens through Files' local-path link.
  const openTyped = results.length === 0 && (parsed.outside || parsed.text.includes("/")) ? parsed.text : null;

  useWatchEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);
  useWatchEffect(() => {
    listRef.current?.querySelector(`[data-row="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const activate = (i: number, split: boolean) => {
    if (gotoOnly) return onGotoLine(at!);
    if (openTyped) return parsed.outside ? onOpenLocal(openTyped, at) : onOpen(openTyped, at, split);
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
  const aria = usePickerAria(gotoOnly ? null : openTyped ? "typed" : results.length ? selected : null);
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
            const v = e.target.value;
            if (v.startsWith("@") || v.startsWith("#")) return onSymbols(v[0] === "@" ? "file" : "project", v.slice(1));
            setQuery(v);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          {...aria.field}
          placeholder="Go to file"
          aria-label="File name, or name:line"
          className="w-full border-b border-sol-border/30 bg-transparent px-4 py-2.5 text-sm text-sol-text outline-none placeholder:text-sol-text-dim"
          spellCheck={false}
          autoComplete="off"
        />
        <div ref={listRef} {...aria.list()} aria-label="Files" className="max-h-[52vh] overflow-y-auto py-1">
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
                  {...aria.option(i, i === selected)}
                  tabIndex={-1}
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
                      <Marked text={t.dir} indexes={r.pathIndexes} />
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {at && i === selected && <span className="text-meta tabular-nums text-sol-cyan">:{at}</span>}
                    <FileStateMark conflict={conflicts[bufferKey(vaultId, t.path)]} dirty={!!dirty[bufferKey(vaultId, t.path)]} />
                  </span>
                </button>
              );
            })
          )}
          {openTyped ? (
            <button
              type="button"
              data-row={0}
              {...aria.option("typed", true)}
              tabIndex={-1}
              onClick={(e) => activate(0, e.metaKey || e.ctrlKey)}
              className="flex w-full items-center gap-2.5 bg-sol-bg-highlight px-4 py-1 text-left text-[13px] text-sol-text"
            >
              <File className="h-3.5 w-3.5 shrink-0 opacity-50" />
              <span className="shrink-0 text-sol-text-dim">Open</span>
              <span className="min-w-0 truncate">{openTyped}</span>
              <span className="ml-auto">
                <KeyCap size="xs">↵</KeyCap>
              </span>
            </button>
          ) : (
            !gotoOnly && results.length === 0 && <div className="px-4 py-3 text-center text-meta text-sol-text-dim">No match</div>
          )}
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
          <span className="flex items-center gap-1">
            <KeyCap size="xs">@</KeyCap> symbol
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">#</KeyCap> project
          </span>
        </div>
      </div>
    </div>
  );
});
