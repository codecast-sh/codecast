// The project search that is running or last ran, outside React: the pane
// draws it, and `search.next`/`search.prev` (F4, vim's :cnext) walk it even
// while the Search tab is closed. One search at a time: every new query aborts
// the one before it, so the daemon kills that ripgrep.
//
// Streaming: each NDJSON event lands in the results model in place, and
// listeners hear about it at most once a frame. No CodeMirror here; this loads
// with the Files page.

import { useVaultStore } from "../../../store/vaultStore";
import { registerCodeCommands, runCodeCommand, type CodeCommandContext } from "../commands";
import { searchCode } from "../daemonClient";
import { SearchResults, matchColumn, type MatchRef } from "./model";
import { EMPTY_PROJECT_QUERY, globList, type ProjectQuery } from "./query";

export const SEARCH_DEBOUNCE_MS = 120;

type Options = Omit<ProjectQuery, "text">;

export interface ProjectSearchState {
  options: Options;
  /** The text the running (or last) search asked for. */
  text: string;
  /** What the list shows: the last search that answered. A new search keeps
   *  these on screen until its first event lands. */
  results: SearchResults | null;
  running: boolean;
  /** `results` belong to an earlier search than the one running. */
  stale: boolean;
  /** Key of the match F4 and the list's selection are on. */
  active: string | null;
  replaceOpen: boolean;
  replaceText: string;
  preserveCase: boolean;
  /** The include/exclude fields are showing. */
  scopeOpen: boolean;
}

const OPTIONS_KEY = "codecast:code-search-options";

const DEFAULT_OPTIONS: Options = {
  regex: EMPTY_PROJECT_QUERY.regex,
  caseSensitive: EMPTY_PROJECT_QUERY.caseSensitive,
  word: EMPTY_PROJECT_QUERY.word,
  include: EMPTY_PROJECT_QUERY.include,
  exclude: EMPTY_PROJECT_QUERY.exclude,
  ignored: EMPTY_PROJECT_QUERY.ignored,
};

function loadOptions(): { options: Options; preserveCase: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") as Record<string, unknown>;
    const options = { ...DEFAULT_OPTIONS };
    for (const k of Object.keys(DEFAULT_OPTIONS) as (keyof Options)[]) {
      if (typeof raw[k] === typeof DEFAULT_OPTIONS[k]) (options as Record<string, unknown>)[k] = raw[k];
    }
    return { options, preserveCase: raw.preserveCase === true };
  } catch {
    return { options: { ...DEFAULT_OPTIONS }, preserveCase: false };
  }
}

export type Navigator = (path: string, line: number, column: number) => void;

class ProjectSearch {
  private state: ProjectSearchState;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The text waiting out the debounce, until its search starts. */
  private pending: string | null = null;
  /** Cancels the pending once-a-frame notification. */
  private frame: (() => void) | null = null;
  /** Bumped on every change listeners should see; the snapshot React reads. */
  version = 0;
  /** How a match opens when no workspace shell handles `file.open`. */
  navigate: Navigator | null = null;
  /** Set when a command asked for the search box while the pane was closed. */
  focusRequest = 0;
  /** The last request the pane answered. */
  focusHandled = 0;

  constructor() {
    const { options: opts, preserveCase } = typeof localStorage === "undefined" ? { options: { ...DEFAULT_OPTIONS }, preserveCase: false } : loadOptions();
    this.state = { options: opts, text: "", results: null, running: false, stale: false, active: null, replaceOpen: false, replaceText: "", preserveCase, scopeOpen: !!(opts.include || opts.exclude || opts.ignored) };
  }

  get(): ProjectSearchState {
    return this.state;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  /** The text the box last asked for: waiting out the debounce, else running
   *  or done. What a caller compares against to know whether to search. */
  wanted(): string {
    return this.pending ?? this.state.text;
  }

  /** Whether the results belong to the vault Files shows now. */
  current(): boolean {
    const results = this.state.results;
    return !!results && results.vaultId === useVaultStore.getState().activeVaultId;
  }

  private notify(): void {
    this.frame?.();
    this.frame = null;
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  /** Coalesce a burst of streamed events into one notification a frame. */
  private notifySoon(): void {
    if (this.frame) return;
    const fire = () => {
      this.frame = null;
      this.version++;
      this.listeners.forEach((fn) => fn());
    };
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(fire);
      this.frame = () => cancelAnimationFrame(id);
    } else {
      const id = setTimeout(fire, 16);
      this.frame = () => clearTimeout(id);
    }
  }

  /** The results changed in place (collapse, dismiss, replace): redraw. */
  touch(): void {
    this.notify();
  }

  /** `persist: false` changes the options for this page only (an ex
   *  command's flag), leaving the person's saved choice alone. */
  set(
    patch: Partial<Pick<ProjectSearchState, "replaceOpen" | "replaceText" | "preserveCase" | "active" | "scopeOpen">> & { options?: Partial<Options> },
    { persist = true }: { persist?: boolean } = {},
  ): void {
    const { options, ...rest } = patch;
    this.state = { ...this.state, ...rest, options: options ? { ...this.state.options, ...options } : this.state.options };
    if (persist && (options || patch.preserveCase !== undefined)) {
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify({ ...this.state.options, preserveCase: this.state.preserveCase }));
      } catch {
        // Storage blocked: options last for this page.
      }
    }
    this.notify();
  }

  /** Search for `text` after the debounce, aborting whatever runs now. */
  schedule(text: string, opts: { immediate?: boolean } = {}): void {
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    this.abort = null;
    this.timer = null;
    this.pending = null;
    if (!text) {
      this.state = { ...this.state, text, results: null, running: false, stale: false, active: null };
      this.notify();
      return;
    }
    if (opts.immediate) void this.run(text);
    else {
      this.pending = text;
      this.timer = setTimeout(() => void this.run(text), SEARCH_DEBOUNCE_MS);
    }
  }

  /** Search again with what was last asked (after the options changed). */
  rerun(): void {
    this.schedule(this.wanted(), { immediate: true });
  }

  /** Stop searching (the pane left code mode). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.abort?.abort();
    this.abort = null;
    if (this.state.running) {
      this.state = { ...this.state, running: false, stale: false };
      this.notify();
    }
  }

  private async run(text: string): Promise<void> {
    this.timer = null;
    this.pending = null;
    const { endpoint, activeVaultId } = useVaultStore.getState();
    const ctrl = new AbortController();
    this.abort?.abort();
    this.abort = ctrl;
    const o = this.state.options;
    const next = new SearchResults(activeVaultId, { text, ...o });
    // The rows on screen stay until the new search says something, so typing
    // never blanks the list or drops its scroll and selection.
    const hasOld = !!this.state.results;
    this.state = { ...this.state, text, running: true, stale: hasOld, ...(hasOld ? {} : { results: next }) };
    this.notify();
    let shown = !hasOld;
    const show = () => {
      if (shown) return;
      shown = true;
      this.state = { ...this.state, results: next, stale: false };
    };
    if (!endpoint || !activeVaultId) {
      next.fail("Files is not connected to this machine");
      show();
      this.state = { ...this.state, running: false };
      this.notify();
      return;
    }
    try {
      for await (const event of searchCode(
        endpoint,
        activeVaultId,
        text,
        { regex: o.regex, caseSensitive: o.caseSensitive, word: o.word, include: globList(o.include), exclude: globList(o.exclude), ignored: o.ignored },
        ctrl.signal,
      )) {
        if (ctrl.signal.aborted) return;
        next.add(event);
        if (!shown) {
          show();
          this.notify();
        } else this.notifySoon();
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      next.fail(e instanceof Error ? e.message : String(e));
    } finally {
      if (this.abort === ctrl) {
        this.abort = null;
        show();
        // The selection stays on a match the new results still hold.
        const active = this.state.active;
        const keep = active && (next.rows().some((r) => r.key === active) || next.matches().some((m) => m.key === active));
        this.state = { ...this.state, running: false, ...(keep ? {} : { active: null }) };
        this.notify();
      }
    }
  }

  // ── navigation ────────────────────────────────────────────────────────────

  /** Open a match in the editor: through the workspace's tabs when the shell
   *  handles `file.open`, else the page's own navigation. */
  open(m: MatchRef): void {
    // Results from another vault name paths that mean nothing here.
    if (!this.current()) return;
    this.state = { ...this.state, active: m.key };
    this.notify();
    const line = m.line.line;
    const column = matchColumn(m.line, m.range) + 1;
    if (!runCodeCommand("file.open", { path: m.file.path, line, column })) this.navigate?.(m.file.path, line, column);
  }

  /** Walk to the next (1) or previous (-1) match across files, wrapping. */
  step(dir: 1 | -1): boolean {
    if (!this.current()) return false;
    const matches = this.state.results?.matches() ?? [];
    if (!matches.length) return false;
    const at = this.state.active ? matches.findIndex((m) => m.key === this.state.active) : -1;
    const next = at < 0 ? (dir === 1 ? 0 : matches.length - 1) : (at + dir + matches.length) % matches.length;
    this.open(matches[next]);
    return true;
  }
}

export const projectSearch = new ProjectSearch();

/** The selection, when it is one short line: what a search seeds itself with. */
function selectedText(ctx: CodeCommandContext): string | null {
  const view = ctx.view;
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to || to - from > 200) return null;
  const text = view.state.sliceDoc(from, to);
  return text.includes("\n") ? null : text;
}

let registered = false;

/** `search.project`, `search.next`, `search.prev`, once per page. */
export function registerProjectSearchCommands(): void {
  if (registered) return;
  registered = true;
  registerCodeCommands({
    "search.project": (args, ctx) => {
      const vault = useVaultStore.getState();
      const query = typeof args?.query === "string" ? args.query : selectedText(ctx);
      // An ex command's regex flag (:grep, :Rg) holds for this page, not
      // for the person's saved choice.
      const flip = typeof args?.regex === "boolean" && args.regex !== projectSearch.get().options.regex;
      if (flip) projectSearch.set({ options: { regex: args.regex as boolean } }, { persist: false });
      if (args?.replace === true) projectSearch.set({ replaceOpen: true });
      if (query !== null) vault.openSearch(query);
      else vault.setLeftPaneTab("search");
      // The box only searches when its text changes: same text, new flag
      // searches here.
      const text = projectSearch.wanted();
      if (flip && text && (query === null || query === text)) projectSearch.rerun();
      projectSearch.focusRequest++;
      projectSearch.touch();
    },
    "search.next": () => projectSearch.step(1),
    "search.prev": () => projectSearch.step(-1),
  });
}

// Console access, as the inbox store has (`__projectSearch.get().results`).
if (typeof window !== "undefined") (window as unknown as { __projectSearch: ProjectSearch }).__projectSearch = projectSearch;
