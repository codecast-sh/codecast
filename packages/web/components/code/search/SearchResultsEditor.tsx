// The results editor (Zed's project search multibuffer): every match of the
// current project search as an excerpt of its file, stacked in one CodeMirror
// view and editable in place, vim included. Saving (Cmd-S, :w) writes each
// touched file back through the editor's compare-and-swap path; a file that
// changed under its excerpts is refused whole and listed.
//
// It is a workspace tab (SearchResultsEditorHost). Opening a location
// (Cmd-Enter, a header click) opens the file in a tab beside it, and its state
// outlives the component: coming back to the tab, or opening it again in the
// same vault on the same results or with edits not yet saved, brings back the
// same document, undo history and cursor. Edits never follow the person into
// another vault.
//
// This file is the editor chunk's: it loads only when the results editor opens.

import { useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { FileStack, RefreshCw, X } from "lucide-react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useCodeStore, workspaceFor } from "../../../store/codeStore";
import { registerUnsavedCheck } from "../../../lib/code/fileSync";
import { SEARCH_RESULTS_TAB } from "../../../lib/code/workspace/virtualTabs";
import { useVaultStore } from "../../../store/vaultStore";
import { readVaultFile } from "../../../lib/vault/client";
import { bufferKey, codeBuffers, currentState } from "../../../lib/code/buffers";
import { registerCodeCommands, runCodeCommand, type CodeCommandContext } from "../../../lib/code/commands";
import { attachFeatureHost, syncEditorFeatures } from "../../../lib/code/features";
import { registerVimFeature } from "../../../lib/code/vimFeature";
import { observeCodeTheme } from "../../../lib/code/theme";
import { projectSearch } from "../../../lib/code/search/controller";
import { compileQuery } from "../../../lib/code/search/query";
import type { SearchResults } from "../../../lib/code/search/model";
import type { ExcerptSource } from "../../../lib/code/search/excerpts";
import {
  multibufferDirty,
  multibufferState,
  multibufferVault,
  refreshMultibufferTheme,
  regionsField,
  saveMultibuffer,
  type SourceLocation,
} from "../../../lib/code/search/multibuffer";
import type { FileEditOutcome } from "../../../lib/code/search/writeBack";
import { FileFailures, needsAttention } from "./FileFailures";
import { codeMirrorUndoGuard } from "../../vault/codeMirrorUndo";
import { KeyCap } from "../../KeyCap";
import { isMac } from "../../../shortcuts/registry";

/** Files a results editor opens at most; the rest stay in the list. */
const MAX_FILES = 300;
const READ_CONCURRENCY = 8;

/** What the state's own extensions call. A kept state outlives the component
 *  that built it, so its listeners reach whichever instance is mounted now
 *  through these, never through a closure over the first one. */
const live: { onDirty: ((dirty: boolean) => void) | null; onOpen: ((loc: SourceLocation) => void) | null } = { onDirty: null, onOpen: null };
/** One undo guard for every results editor: its extension lives in kept states. */
const undoGuard = codeMirrorUndoGuard();

/** What a closed results editor left behind, per vault: edits made in one
 *  checkout come back only there, and save only there. */
const kept = new Map<string, { results: SearchResults; state: EditorState; files: number; skipped: number; query: string }>();
// Closing the page with kept edits warns, as an unsaved file does.
registerUnsavedCheck(() => [...kept.values()].some((k) => multibufferDirty(k.state)));

/** The current text of every result file: an open buffer's document (unsaved
 *  edits included), else disk. */
async function loadSources(results: SearchResults): Promise<{ sources: ExcerptSource[]; skipped: number }> {
  const { endpoint, activeVaultId } = useVaultStore.getState();
  if (!endpoint || !activeVaultId) throw new Error("Files is not connected to this machine");
  const files = results.files.map((f) => ({ path: f.path, lines: [...new Set(results.matchesOf(f).map((m) => m.line.line))] })).filter((f) => f.lines.length);
  const take = files.slice(0, MAX_FILES);
  const out: (ExcerptSource | null)[] = new Array(take.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < take.length) {
      const i = next++;
      const f = take[i];
      const b = codeBuffers.get(bufferKey(activeVaultId, f.path));
      const text = b ? currentState(b).doc.toString() : (await readVaultFile(endpoint, activeVaultId, f.path).catch(() => null))?.content.replace(/^﻿/, "");
      if (text !== undefined && text !== null) out[i] = { path: f.path, text, lines: f.lines };
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, take.length) }, worker));
  return { sources: out.filter((s): s is ExcerptSource => !!s), skipped: files.length - take.length };
}

export default function SearchResultsEditor({ onClose, onRebuild }: { onClose(): void; onRebuild(): void }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const resultsRef = useRef<SearchResults | null>(null);
  const [status, setStatus] = useState<{ loading: boolean; error?: string; files: number; excerpts: number; skipped: number }>({ loading: true, files: 0, excerpts: 0, skipped: 0 });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // The commands registered at mount read this, never the state above.
  const savingRef = useRef(false);
  const [failed, setFailed] = useState<FileEditOutcome[]>([]);
  const [stale, setStale] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);
  /** Set when the person threw the kept edits away: unmount keeps nothing. */
  const discardRef = useRef(false);
  /** What the shown excerpts were built from: the query may have moved on. */
  const metaRef = useRef({ files: 0, skipped: 0, query: "" });
  const [query, setQuery] = useState(() => projectSearch.get().text);
  // The tab carries the unsaved dot, as a file's does.
  useWatchEffect(() => {
    const vaultId = useVaultStore.getState().activeVaultId;
    if (vaultId) useCodeStore.getState().setDirty(bufferKey(vaultId, SEARCH_RESULTS_TAB), dirty);
  }, [dirty]);

  const keep = () => {
    const view = viewRef.current;
    if (!view || !resultsRef.current || discardRef.current) return;
    kept.set(multibufferVault(view.state) ?? "", { results: resultsRef.current, state: view.state, ...metaRef.current });
  };

  const close = () => {
    keep();
    onClose();
  };

  const save = async () => {
    const view = viewRef.current;
    if (!view || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const { outcomes } = await saveMultibuffer(view);
      setFailed(outcomes.filter(needsAttention));
      setDirty(multibufferDirty(view.state));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /** Throw the earlier search's edits away and show the current search. */
  const discard = () => {
    const view = viewRef.current;
    if (view) kept.delete(multibufferVault(view.state) ?? "");
    discardRef.current = true;
    onRebuild();
  };

  useMountEffect(() => {
    registerVimFeature();
    let mounted = true;
    let detach: (() => void) | null = null;
    let unregisterUndo: (() => void) | null = null;

    const open = (loc: SourceLocation) => {
      keep();
      if (!runCodeCommand("file.open", { path: loc.path, line: loc.line, column: loc.column })) projectSearch.navigate?.(loc.path, loc.line, loc.column);
    };

    const mount = (state: EditorState, files: number, skipped: number, query: string) => {
      if (!mounted || !parentRef.current) return;
      const view = new EditorView({ state, parent: parentRef.current });
      viewRef.current = view;
      detach = attachFeatureHost(view);
      syncEditorFeatures(view);
      unregisterUndo = undoGuard.register(view);
      metaRef.current = { files, skipped, query };
      setQuery(query);
      const regions = state.field(regionsField);
      setStatus({ loading: false, files, skipped, excerpts: regions.filter((r) => r.kind === "excerpt").length });
      setDirty(multibufferDirty(state));
      view.focus();
    };

    const build = async (results: SearchResults) => {
      const { sources, skipped } = await loadSources(results);
      if (!mounted) return;
      const s = projectSearch.get();
      const vaultId = results.vaultId ?? "";
      const state = multibufferState(sources, {
        vaultId,
        matcher: compileQuery(results.query ?? { text: s.text, ...s.options }).re ?? null,
        onOpen: (loc) => live.onOpen?.(loc),
        extensions: [
          undoGuard.extension,
          // Chrome follows clean/dirty transitions only, never each keystroke.
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.transactions.some((t) => t.effects.length)) {
              live.onDirty?.(multibufferDirty(u.state));
            }
          }),
        ],
      });
      mount(state, sources.length, skipped, results.query?.text ?? s.text);
    };

    live.onDirty = (d) => setDirty((prev) => (prev === d ? prev : d));
    live.onOpen = open;
    const results = projectSearch.get().results;
    resultsRef.current = results;
    const activeVault = useVaultStore.getState().activeVaultId ?? "";
    const held = kept.get(activeVault);
    if (held && (held.results === results || multibufferDirty(held.state))) {
      setStale(held.results !== results);
      resultsRef.current = held.results;
      mount(held.state, held.files, held.skipped, held.query);
    } else if (results && !projectSearch.current()) {
      setStatus((st) => ({ ...st, loading: false, error: "These results are from another folder: search again" }));
    } else if (results) {
      kept.delete(activeVault);
      build(results).catch((e) => mounted && setStatus((st) => ({ ...st, loading: false, error: e instanceof Error ? e.message : String(e) })));
    } else setStatus((st) => ({ ...st, loading: false }));

    const stopTheme = observeCodeTheme(() => viewRef.current?.dispatch({ effects: refreshMultibufferTheme() }));
    const mine = (ctx: CodeCommandContext) => !!viewRef.current && ctx.view === viewRef.current;
    const unregister = registerCodeCommands({
      "file.save": (_a, ctx) => (mine(ctx) ? void save() : false),
      "file.saveAll": (_a, ctx) => (mine(ctx) ? void save() : false),
      "file.close": (_a, ctx) => (mine(ctx) ? void close() : false),
      "file.saveAndClose": (_a, ctx) => (mine(ctx) ? void save().then(close) : false),
    });

    return () => {
      mounted = false;
      live.onDirty = null;
      live.onOpen = null;
      unregister();
      stopTheme();
      unregisterUndo?.();
      detach?.();
      keep();
      const view = viewRef.current;
      view?.destroy();
      viewRef.current = null;
      // Closed, not just hidden behind another tab: no tab carries the dot.
      // Kept edits stay guarded (registerUnsavedCheck) and come back with it.
      const vaultId = useVaultStore.getState().activeVaultId;
      if (vaultId && !workspaceFor(vaultId).groups.some((g) => g.tabs.some((t) => t.path === SEARCH_RESULTS_TAB))) {
        useCodeStore.getState().setDirty(bufferKey(vaultId, SEARCH_RESULTS_TAB), false);
      }
    };
  });

  const mod = isMac ? "⌘" : "Ctrl";
  return (
    <div className="flex h-full min-h-0 flex-col bg-sol-bg">
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-sol-border/40 px-2 text-meta">
        <FileStack className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
        <span className="min-w-0 truncate rounded-sm bg-sol-yellow/15 px-1 font-mono text-[11.5px] text-sol-text" title={query}>
          {query}
        </span>
        {!status.loading && !status.error && (
          <span className="shrink-0 tabular-nums text-sol-text-dim">
            {status.files} {status.files === 1 ? "file" : "files"} · {status.excerpts} {status.excerpts === 1 ? "excerpt" : "excerpts"}
            {status.skipped > 0 && <span className="text-sol-orange"> · {status.skipped} not shown</span>}
          </span>
        )}
        {status.loading && <span className="text-sol-text-dim">Loading</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {stale && (
            // Two presses: the first arms it, since it throws unsaved edits away.
            <button
              type="button"
              title={discardArmed ? "Discard unsaved edits and show the current search" : "These excerpts are from an earlier search"}
              onClick={() => (discardArmed ? discard() : setDiscardArmed(true))}
              onBlur={() => setDiscardArmed(false)}
              className={`flex items-center gap-1 rounded-sm px-1.5 py-0.5 ${discardArmed ? "bg-sol-red/15 text-sol-red" : "text-sol-orange hover:bg-sol-bg-alt"}`}
            >
              <RefreshCw className="h-3 w-3" />
              {discardArmed ? "Discard edits" : "Earlier search"}
            </button>
          )}
          <span className="flex items-center gap-1 text-sol-text-dim">
            <KeyCap>{mod}</KeyCap>
            <KeyCap>↵</KeyCap>
            open
          </span>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save()}
            className="flex items-center gap-1.5 rounded-sm border border-sol-border/50 px-1.5 py-0.5 text-sol-text enabled:hover:bg-sol-bg-alt disabled:text-sol-text-dim disabled:opacity-60"
          >
            {dirty && <i aria-label="Unsaved" className="h-1.5 w-1.5 rounded-full bg-sol-orange" />}
            {saving ? "Saving" : "Save"}
            <span className="flex gap-0.5">
              <KeyCap>{mod}</KeyCap>
              <KeyCap>S</KeyCap>
            </span>
          </button>
          <button type="button" aria-label="Close results editor" title="Close" onClick={close} className="rounded-sm p-0.5 text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <FileFailures outcomes={failed} className="shrink-0 border-b border-sol-orange/30 bg-sol-orange/5" />
      {status.error && <div className="px-3 py-2 text-meta text-sol-red">{status.error}</div>}
      <div ref={parentRef} data-owns-keys data-code-editor className="min-h-0 flex-1 [&_.cm-editor]:h-full" onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()} />
    </div>
  );
}
