// Project search in the Files Search tab, for a vault on this machine: ripgrep
// over every file through the daemon, streamed into a virtualized list, with
// replace. The search itself runs in lib/code/search/controller (it outlives
// this pane: F4 walks results with the tab closed); this file draws it and
// turns keys and clicks into controller calls.
//
// Writes (replace) load lib/code/search/runReplace on demand, which reaches the
// editor's buffers; nothing CodeMirror joins the Files page bundle.

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CaseSensitive, ChevronRight, ChevronsDownUp, ChevronsUpDown, EyeOff, FileStack, ListFilter, Regex, ReplaceAll, WholeWord, X } from "lucide-react";
import { ShortcutTooltip } from "../../KeyboardShortcutsHelp";
import { SwitchReview, type SwitchLedger } from "../../consequential/ConsequentialSwitch";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { projectSearch, type ProjectSearchState } from "../../../lib/code/search/controller";
import { runCodeCommand } from "../../../lib/code/commands";
import { SEARCH_RESULTS_TAB } from "../../../lib/code/workspace/virtualTabs";
import { useCodeStore } from "../../../store/codeStore";
import { useVaultStore } from "../../../store/vaultStore";
import { matchColumn, type ResultRow } from "../../../lib/code/search/model";
import { compileQuery, searchErrorText, type ProjectQuery } from "../../../lib/code/search/query";
import type { MatchTarget } from "../../../lib/code/search/replace";
import type { ReplaceOutcome } from "../../../lib/code/search/runReplace";
import { SearchResultsList, type ReplacePreview, type ResultsListActions } from "./SearchResultsList";
import { FileFailures, needsAttention } from "./FileFailures";

type MatchRow = Extract<ResultRow, { kind: "match" }>;

/** The controller's state, re-read whenever it notifies. */
export function useProjectSearch(): ProjectSearchState {
  useSyncExternalStore(projectSearch.subscribe, projectSearch.getVersion, projectSearch.getVersion);
  return projectSearch.get();
}

const loadReplace = () => import("../../../lib/code/search/runReplace");

/** Alt-C, Alt-W, Alt-R toggle case, word and regex from any search field
 *  (VS Code's keys; `code` because Option on a Mac types a character). */
export function handleSearchOptionKey(e: React.KeyboardEvent): boolean {
  if (!e.altKey || e.metaKey || e.ctrlKey) return false;
  const o = projectSearch.get().options;
  const flip = { KeyC: { caseSensitive: !o.caseSensitive }, KeyW: { word: !o.word }, KeyR: { regex: !o.regex } }[e.code];
  if (!flip) return false;
  e.preventDefault();
  projectSearch.set({ options: flip });
  projectSearch.rerun();
  return true;
}

const toggleClass = (on: boolean) =>
  `flex h-[20px] w-[20px] items-center justify-center rounded-sm transition-colors ${
    on ? "bg-sol-cyan/20 text-sol-cyan" : "text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"
  }`;

function OptionToggle({ on, label, accel, onPress, children }: { on: boolean; label: string; accel?: string; onPress: () => void; children: React.ReactNode }) {
  const button = (
    <button type="button" aria-label={label} aria-pressed={on} onClick={onPress} className={toggleClass(on)}>
      {children}
    </button>
  );
  return accel ? (
    <ShortcutTooltip label={label} accel={accel}>
      {button}
    </ShortcutTooltip>
  ) : (
    button
  );
}

/** Case, whole word and regex, inside the search box. */
export function CodeSearchToggles({ state }: { state: ProjectSearchState }) {
  const o = state.options;
  const flip = (patch: Partial<ProjectSearchState["options"]>) => {
    projectSearch.set({ options: patch });
    projectSearch.rerun();
  };
  return (
    <span className="flex shrink-0 items-center gap-px">
      <OptionToggle on={o.caseSensitive} label="Match case" accel="alt+c" onPress={() => flip({ caseSensitive: !o.caseSensitive })}>
        <CaseSensitive className="h-3.5 w-3.5" />
      </OptionToggle>
      <OptionToggle on={o.word} label="Whole word" accel="alt+w" onPress={() => flip({ word: !o.word })}>
        <WholeWord className="h-3.5 w-3.5" />
      </OptionToggle>
      <OptionToggle on={o.regex} label="Regular expression" accel="alt+r" onPress={() => flip({ regex: !o.regex })}>
        <Regex className="h-3.5 w-3.5" />
      </OptionToggle>
      <OptionToggle on={state.scopeOpen || scopeIsSet(o)} label="Files to include and exclude" onPress={() => projectSearch.set({ scopeOpen: !state.scopeOpen })}>
        <ListFilter className="h-3.5 w-3.5" />
      </OptionToggle>
    </span>
  );
}

/** The chevron left of the search box that shows the replace field. */
export function ReplaceDisclosure({ state }: { state: ProjectSearchState }) {
  return (
    <ShortcutTooltip label={state.replaceOpen ? "Hide replace" : "Replace"} accel="meta+shift+h">
      <button
        type="button"
        aria-label="Toggle replace"
        aria-expanded={state.replaceOpen}
        onClick={() => {
          projectSearch.set({ replaceOpen: !state.replaceOpen });
          if (!state.replaceOpen) requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[aria-label="Replace with"]')?.focus());
        }}
        className="flex h-[26px] w-4 shrink-0 items-center justify-center rounded-sm text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${state.replaceOpen ? "rotate-90" : ""}`} />
      </button>
    </ShortcutTooltip>
  );
}

const fieldClass =
  "flex min-w-0 flex-1 items-center gap-1 rounded border border-sol-border/40 bg-sol-bg px-1.5 py-[3px] transition-colors focus-within:border-sol-cyan";
const inputClass = "min-w-0 flex-1 bg-transparent text-[12px] text-sol-text outline-none placeholder:text-sol-text-dim";

function scopeIsSet(o: ProjectSearchState["options"]): boolean {
  return !!o.include.trim() || !!o.exclude.trim() || o.ignored;
}

/** Search query as the controller holds it, with the box's text. */
function currentQuery(state: ProjectSearchState): ProjectQuery {
  return { text: state.text, ...state.options };
}

interface ReplaceReport {
  replaced: number;
  files: number;
  failed: ReplaceOutcome[];
}

export function ProjectSearchPanel({
  state,
  inputRef,
}: {
  state: ProjectSearchState;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const results = state.results;
  // The results grow in place as the stream lands; the controller's version
  // is what says they changed.
  const version = projectSearch.version;
  const rows = useMemo(() => results?.rows() ?? [], [results, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => results?.counts() ?? { matches: 0, files: 0 }, [results, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const listRef = useRef<HTMLDivElement | null>(null);
  const replaceRef = useRef<HTMLInputElement | null>(null);
  const [review, setReview] = useState<{ ledger: SwitchLedger; targets: Map<string, MatchTarget[]> } | null>(null);
  const [report, setReport] = useState<ReplaceReport | null>(null);
  const [busy, setBusy] = useState(false);
  // The results editor is a workspace tab: pressed while one is open.
  const resultsTabOpen = useCodeStore((s) => {
    const vaultId = useVaultStore.getState().activeVaultId;
    return !!vaultId && !!s.workspaces[vaultId]?.groups.some((g) => g.tabs.some((t) => t.path === SEARCH_RESULTS_TAB));
  });

  // A new search ends the last replace's report.
  useWatchEffect(() => setReport(null), [results]);

  // What the box holds (for its regex error), and what the rows on screen
  // were searched with (for their preview and replace): they differ while a
  // new search has not answered yet.
  const compiled = useMemo(() => compileQuery(currentQuery(state)), [state.text, state.options]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownQuery = results?.query ?? null;
  const shownRe = useMemo(() => (shownQuery ? compileQuery(shownQuery).re : null), [shownQuery]);
  const preview: ReplacePreview | null = useMemo(
    () =>
      state.replaceOpen && shownRe && shownQuery
        ? { re: shownRe, replacement: state.replaceText, opts: { regex: shownQuery.regex, preserveCase: state.preserveCase } }
        : null,
    [state.replaceOpen, shownRe, shownQuery, state.replaceText, state.preserveCase],
  );

  const runTargets = useCallback(
    async (targets: Map<string, MatchTarget[]>) => {
      // Rows from an earlier search are dimmed until the next one answers.
      if (!targets.size || !results?.query || projectSearch.get().stale) return;
      setBusy(true);
      try {
        const { runReplace } = await loadReplace();
        const s = projectSearch.get();
        const outcomes = await runReplace({ vaultId: results.vaultId, query: results.query, replacement: s.replaceText, preserveCase: s.preserveCase, targets });
        // Another replace is still writing: its targets are about to move.
        if (!outcomes) return;
        let replaced = 0;
        let files = 0;
        const failed: ReplaceOutcome[] = [];
        for (const o of outcomes) {
          if ((o.status === "saved" || o.status === "unsaved") && o.edits) {
            replaced += o.edits.length;
            files++;
            results.replaced(o.path, o.edits.map((e) => ({ line: e.line, column: e.column, length: e.to - e.from, insert: e.insert })));
          }
          if (needsAttention(o)) failed.push(o);
        }
        setReport({ replaced, files, failed });
        projectSearch.touch();
      } finally {
        setBusy(false);
      }
    },
    [results],
  );

  const replaceAll = useCallback(async () => {
    if (!results?.query || projectSearch.get().stale || busy) return;
    const targets = results.targets();
    if (targets.size === 1 && !results.summary?.truncated) return void runTargets(targets);
    const { openPaths } = await loadReplace();
    const paths = [...targets.keys()];
    const open = openPaths(results.vaultId, paths);
    const n = [...targets.values()].reduce((a, t) => a + t.length, 0);
    const s = projectSearch.get();
    // A capped search holds only part of the matches: Replace all reaches those.
    const capped = !!results.summary?.truncated;
    setReview({
      targets,
      ledger: {
        name: "Replace all",
        subject: `${results.query.text} → ${s.replaceText || "(empty)"}`,
        shift: null,
        figures: [
          { value: n.toLocaleString(), label: n === 1 ? "match" : "matches" },
          { value: paths.length.toLocaleString(), label: "files" },
          { value: String(paths.length - open.length), label: "written now", tone: paths.length - open.length ? "warn" : undefined },
          ...(capped ? [{ value: "capped", label: "more not replaced", tone: "warn" as const }] : []),
        ],
        rows: [
          { k: "Open in editor", v: open.length ? `${open.length} · undo there` : "None" },
          { k: "Not open", v: paths.length - open.length ? "Written, no undo" : "None", ...(paths.length - open.length ? { tone: "warn" as const } : {}) },
          { k: "Changed since", v: "Skipped, listed" },
          { k: "Files", v: String(paths.length), list: paths.slice(0, 12).concat(paths.length > 12 ? [`+${paths.length - 12}`] : []) },
        ],
        confirm: `Replace ${n.toLocaleString()}`,
        keep: "Cancel",
      },
    });
  }, [results, runTargets, busy]);

  const actions: ResultsListActions = useMemo(
    () => ({
      onOpen: (row, focusEditor) => {
        projectSearch.open(row);
        if (!focusEditor) requestAnimationFrame(() => listRef.current?.focus());
      },
      onToggle: (path) => {
        results?.toggleCollapsed(path);
        projectSearch.touch();
      },
      onDismiss: (key) => {
        results?.dismiss(key);
        projectSearch.touch();
      },
      onReplaceMatch: (row) => void runTargets(new Map([[row.file.path, [{ line: row.line.line, column: matchColumn(row.line, row.range) }]]])),
      onReplaceFile: (path) => void runTargets(results?.targets(path) ?? new Map()),
      onSelect: (key) => projectSearch.set({ active: key }),
    }),
    [results, runTargets],
  );

  const activeIndex = state.active ? rows.findIndex((r) => r.key === state.active) : -1;
  const select = (i: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (row) projectSearch.set({ active: row.key });
  };

  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const row = rows[activeIndex];
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "ArrowDown":
      case "j":
        stop();
        select(activeIndex + 1);
        break;
      case "ArrowUp":
      case "k":
        stop();
        if (activeIndex <= 0) inputRef?.current?.focus();
        else select(activeIndex - 1);
        break;
      case "Home":
        stop();
        select(0);
        break;
      case "End":
        stop();
        select(rows.length - 1);
        break;
      case "Enter":
      case " ":
        stop();
        if (row?.kind === "match") actions.onOpen(row, e.key === "Enter");
        else if (row) actions.onToggle(row.file.path);
        break;
      case "ArrowLeft":
      case "h":
        stop();
        if (row?.kind === "match") projectSearch.set({ active: row.file.path });
        else if (row && !row.collapsed) actions.onToggle(row.file.path);
        break;
      case "ArrowRight":
      case "l":
        stop();
        if (row?.kind === "file" && row.collapsed) actions.onToggle(row.file.path);
        else select(activeIndex + 1);
        break;
      case "Delete":
      case "Backspace":
      case "x":
        stop();
        if (row) {
          actions.onDismiss(row.key);
          select(activeIndex);
        }
        break;
      case "Escape":
        stop();
        inputRef?.current?.focus();
        break;
    }
  };

  const error = results?.error ? searchErrorText(results.error) : null;
  const summary = results?.summary ?? null;
  const allCollapsed = !!results && results.files.length > 0 && results.collapsed.size >= results.files.length;
  const regexError = state.options.regex && compiled.error && state.text ? compiled.error : null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key === "F4" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          projectSearch.step(e.shiftKey ? -1 : 1);
        }
      }}
    >
      {state.replaceOpen && (
        <div className="flex items-center gap-1 px-2 pb-1.5 pl-[20px]">
          <div className={fieldClass}>
            <input
              ref={replaceRef}
              value={state.replaceText}
              onChange={(e) => projectSearch.set({ replaceText: e.target.value })}
              onKeyDown={(e) => {
                if (handleSearchOptionKey(e)) return;
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void replaceAll();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  projectSearch.set({ replaceOpen: false });
                  inputRef?.current?.focus();
                }
              }}
              placeholder="Replace"
              spellCheck={false}
              autoComplete="off"
              aria-label="Replace with"
              className={inputClass}
            />
            <OptionToggle on={state.preserveCase} label="Preserve case" onPress={() => projectSearch.set({ preserveCase: !state.preserveCase })}>
              <span className="text-[10px] font-semibold leading-none">AB</span>
            </OptionToggle>
          </div>
          <ShortcutTooltip label="Replace all" accel="meta+enter">
            <button
              type="button"
              aria-label="Replace all"
              disabled={!counts.matches || busy || !shownRe || state.stale}
              onClick={() => void replaceAll()}
              className="flex h-[24px] w-[24px] items-center justify-center rounded-sm text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text disabled:opacity-40"
            >
              <ReplaceAll className="h-3.5 w-3.5" />
            </button>
          </ShortcutTooltip>
        </div>
      )}

      {state.scopeOpen && (
        <div className="flex flex-col gap-1 px-2 pb-1.5 pl-[20px]">
          <div className={fieldClass}>
            <input
              value={state.options.include}
              onChange={(e) => {
                projectSearch.set({ options: { include: e.target.value } });
                projectSearch.schedule(projectSearch.get().text);
              }}
              placeholder="Include  src, *.ts"
              spellCheck={false}
              aria-label="Files to include"
              className={inputClass}
            />
          </div>
          <div className={fieldClass}>
            <input
              value={state.options.exclude}
              onChange={(e) => {
                projectSearch.set({ options: { exclude: e.target.value } });
                projectSearch.schedule(projectSearch.get().text);
              }}
              placeholder="Exclude  **/*.test.ts"
              spellCheck={false}
              aria-label="Files to exclude"
              className={inputClass}
            />
            <OptionToggle
              on={state.options.ignored}
              label="Search ignored files"
              onPress={() => {
                projectSearch.set({ options: { ignored: !state.options.ignored } });
                projectSearch.rerun();
              }}
            >
              <EyeOff className="h-3.5 w-3.5" />
            </OptionToggle>
          </div>
        </div>
      )}

      {(regexError || error) && (
        <div role="alert" className="mx-2 mb-1.5 truncate rounded-sm bg-sol-red/10 px-1.5 py-0.5 font-mono text-[11px] text-sol-red" title={error ?? regexError ?? undefined}>
          {error ?? regexError}
        </div>
      )}

      {report && (
        <div className="mx-2 mb-1.5 rounded-sm border border-sol-border/40 text-meta">
          <div className="flex items-center gap-2 px-1.5 py-0.5">
            {report.replaced > 0 && (
              <span className="tabular-nums text-sol-green">
                {report.replaced} replaced · {report.files} {report.files === 1 ? "file" : "files"}
              </span>
            )}
            {report.failed.length > 0 && <span className="tabular-nums text-sol-orange">{report.failed.length} not written</span>}
            <button type="button" aria-label="Dismiss" onClick={() => setReport(null)} className="ml-auto text-sol-text-dim hover:text-sol-text">
              <X className="h-3 w-3" />
            </button>
          </div>
          <FileFailures
            outcomes={report.failed}
            className="border-t border-sol-border/30"
            onOpen={(path) => {
              const r = projectSearch.get().results;
              const file = r?.file(path);
              const m = file && r!.matchesOf(file)[0];
              if (m) projectSearch.open(m);
            }}
          />
        </div>
      )}

      {results && rows.length > 0 ? (
        <SearchResultsList rows={rows} activeKey={state.active} preview={preview} replacing={state.replaceOpen} stale={state.stale} busy={busy} actions={actions} onKeyDown={onListKey} listRef={listRef} />
      ) : (
        <div className="flex-1 px-3 py-6 text-center text-meta text-sol-text-dim">
          {!state.text ? null : state.running ? "" : error ? null : results ? "No results" : null}
        </div>
      )}

      {results && (
        <div className="flex h-[24px] shrink-0 items-center gap-1 border-t border-sol-border/30 px-2 text-mark tabular-nums text-sol-text-dim">
          {/* One line tall: what does not fit wraps out of sight, elapsed first, then capped. */}
          <div className="flex h-[24px] min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden whitespace-nowrap leading-[24px]">
            <span className="min-w-0 truncate" title={countsTitle(counts, results.firstResultMs)}>
              {compactCount(counts.matches)}
              <span className="text-sol-text-dim/70"> in </span>
              {compactCount(counts.files)}
              {counts.files < 1000 && (counts.files === 1 ? " file" : " files")}
            </span>
            {summary?.truncated && (
              <span className="rounded-sm bg-sol-orange/15 px-1 leading-[16px] text-sol-orange" title="The search stopped at its result cap">
                capped
              </span>
            )}
            {state.running ? <span className="text-sol-cyan">searching</span> : summary && <span>{summary.elapsedMs} ms</span>}
          </div>
          <span className="ml-auto flex items-center gap-0.5">
            <button
              type="button"
              aria-label="Open results in editor"
              title="Open results in editor"
              disabled={!counts.matches}
              onClick={() => runCodeCommand("search.openEditor")}
              className={`${toggleClass(resultsTabOpen)} disabled:opacity-40`}
            >
              <FileStack className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={allCollapsed ? "Expand all" : "Collapse all"}
              title={allCollapsed ? "Expand all" : "Collapse all"}
              onClick={() => {
                results.setAllCollapsed(!allCollapsed);
                projectSearch.touch();
              }}
              className={toggleClass(false)}
            >
              {allCollapsed ? <ChevronsUpDown className="h-3 w-3" /> : <ChevronsDownUp className="h-3 w-3" />}
            </button>
          </span>
        </div>
      )}

      {review && (
        <SwitchReview
          ledger={review.ledger}
          onClose={() => setReview(null)}
          onConfirm={() => {
            const targets = review.targets;
            setReview(null);
            void runTargets(targets);
          }}
        />
      )}
    </div>
  );
}

const compactFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Counts past 999 read as 5K, so the footer fits the pane's default width. */
function compactCount(n: number): string {
  return n < 1000 ? String(n) : compactFormat.format(n);
}

function countsTitle(counts: { matches: number; files: number }, firstResultMs: number | null): string {
  const base = `${counts.matches.toLocaleString()} matches in ${counts.files.toLocaleString()} files`;
  return firstResultMs !== null ? `${base} · first result ${Math.round(firstResultMs)} ms` : base;
}

/** Enter in the search box: open the selected match, else the first. */
export function openActiveOrFirst(state: ProjectSearchState): boolean {
  const matches = state.results?.matches() ?? [];
  const m = matches.find((x) => x.key === state.active) ?? matches[0];
  if (!m) return false;
  projectSearch.open(m as MatchRow);
  return true;
}
