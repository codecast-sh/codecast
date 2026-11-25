// Vault search pane: the left sidebar's second tab.
//
// Two searches behind one box. A vault on this machine (the daemon reachable)
// searches every file with ripgrep: components/code/search/ProjectSearchPanel
// draws that, with replace and the results editor. A remote mirror, or a
// query written with the notes operators (`tag:x`, `path:x`, `file:x`), runs
// the notes search below. The box stays mounted across the switch, so typing
// an operator never drops focus.
//
// The notes search has three layers, deliberately separate: the operator parser (lib/vault/
// searchQuery) turns the typed string into a plain query plus filters, the
// block-granular index (lib/vault/searchIndex) ranks and returns matches with
// their line and snippet, and this file only arranges and paints them. A
// result is grouped by file because that's the unit the reader navigates in;
// the lines under it are why the file is there.

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  ChevronsDownUp,
  FileText,
  Search,
  X,
} from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { useDebounce } from "../../hooks/useDebounce";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { vaultIndex, vaultSearch, useVaultIndexVersion } from "../../lib/vault/indexHost";
import type { FileSearchResult, SearchMatch } from "../../lib/vault/searchIndex";
import {
  blockMatchesPhrases,
  fileMatchesQuery,
  hasRankableText,
  parseVaultQuery,
} from "../../lib/vault/searchQuery";
import { useVaultStore } from "../../store/vaultStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { filesHref } from "../../lib/vault/vaultHref";
import { projectSearch, registerProjectSearchCommands } from "../../lib/code/search/controller";
import { usesNoteOperators } from "../../lib/code/search/query";
import { whenIdle } from "../../lib/code/idle";
import {
  CodeSearchToggles,
  ProjectSearchPanel,
  ReplaceDisclosure,
  handleSearchOptionKey,
  openActiveOrFirst,
  useProjectSearch,
} from "../code/search/ProjectSearchPanel";
import { KeyCap } from "../KeyCap";
import { BookmarkToggle } from "./VaultBookmarksPane";
import { noteDisplayName } from "./VaultExplorer";

// `search.project` (vim's :grep/:Rg, Cmd-Shift-H), `search.next` and
// `search.prev` work wherever Files is open, Search tab shown or not.
registerProjectSearchCommands();
// The editor's own search keys (F4, Cmd-Shift-H) ride the editor chunk.
if (typeof window !== "undefined") {
  void whenIdle(() => import("../../lib/code/search/editorKeys").then((m) => m.registerSearchEditorKeys()), 4000).catch(() => {});
}

/** Matches shown per file before the "N more" toggle. Obsidian shows a similar
 *  handful — enough to judge relevance, short enough that ten files still fit. */
const COLLAPSED_MATCHES = 3;

/** Frontmatter/H1 title when the index has one, otherwise the filename — never
 *  the path, and never the `.md`. */
function displayTitle(path: string, title?: string): string {
  return title || noteDisplayName(path.split("/").pop() ?? path);
}

function Highlighted({ match }: { match: SearchMatch }) {
  const { snippet, highlights } = match;
  if (!highlights.length) return <>{snippet}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  highlights.forEach(([start, end], i) => {
    if (start < at) return;
    if (start > at) parts.push(snippet.slice(at, start));
    parts.push(
      <mark key={i} className="bg-sol-yellow/25 text-sol-text rounded-[2px] px-[1px]">
        {snippet.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < snippet.length) parts.push(snippet.slice(at));
  return <>{parts}</>;
}

const FileGroup = memo(function FileGroup({
  result,
  active,
  collapsed,
  onToggleCollapse,
  onNavigate,
}: {
  result: FileSearchResult;
  active: boolean;
  collapsed: boolean;
  onToggleCollapse: (path: string) => void;
  onNavigate: (path: string, line?: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = collapsed
    ? []
    : showAll
      ? result.matches
      : result.matches.slice(0, COLLAPSED_MATCHES);
  const hidden = result.matches.length - shown.length;

  return (
    <div className="mb-0.5">
      <div
        className={`flex items-center gap-1 pr-2 rounded-sm ${
          active ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt"
        }`}
      >
        <button
          type="button"
          aria-label={collapsed ? "Expand matches" : "Collapse matches"}
          onClick={() => onToggleCollapse(result.path)}
          className="pl-2 py-1 text-sol-text-dim hover:text-sol-text"
        >
          <ChevronRight
            className={`w-3 h-3 transition-transform ${collapsed ? "" : "rotate-90"}`}
          />
        </button>
        <button
          type="button"
          onClick={() => onNavigate(result.path)}
          title={result.path}
          className="flex-1 min-w-0 flex items-center gap-1.5 py-1 text-left"
        >
          <FileText className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
          <span className="truncate text-[12px] font-medium text-sol-text">
            {displayTitle(result.path, result.title)}
          </span>
        </button>
        {result.matches.length > 0 && (
          <span className="text-meta text-sol-text-dim tabular-nums">{result.matches.length}</span>
        )}
      </div>
      {shown.map((match, i) => (
        <button
          key={`${match.line}-${i}`}
          type="button"
          onClick={() => onNavigate(result.path, match.line)}
          title={match.headingPath.join(" › ") || undefined}
          className="w-full text-left pl-7 pr-2 py-[3px] text-meta leading-[1.45] text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text rounded-sm"
        >
          <span className="line-clamp-3">
            <Highlighted match={match} />
          </span>
        </button>
      ))}
      {!collapsed && hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="pl-7 pr-2 py-[3px] text-meta text-sol-text-dim hover:text-sol-cyan"
        >
          {hidden} more match{hidden === 1 ? "" : "es"}
        </button>
      )}
      {!collapsed && showAll && result.matches.length > COLLAPSED_MATCHES && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="pl-7 pr-2 py-[3px] text-meta text-sol-text-dim hover:text-sol-cyan"
        >
          Show less
        </button>
      )}
    </div>
  );
});

function TeachingState() {
  return (
    <div className="px-3 py-6 text-meta leading-5 text-sol-text-dim">
      <div className="text-sol-text-muted mb-2">Search every note in this vault.</div>
      <div className="mb-1">Narrow it with operators:</div>
      <ul className="space-y-0.5">
        <li>
          <code className="text-sol-cyan">path:</code>projects — path contains
        </li>
        <li>
          <code className="text-sol-cyan">file:</code>meeting — filename contains
        </li>
        <li>
          <code className="text-sol-cyan">tag:</code>#status/draft — tag or a nested one
        </li>
        <li>
          <code className="text-sol-cyan">&quot;exact phrase&quot;</code> — words together
        </li>
        <li>
          <code className="text-sol-cyan">-draft</code> — exclude
        </li>
      </ul>
    </div>
  );
}

/** The notes index's search: a remote mirror's, or a query with operators. */
function NotesSearch({
  raw,
  activePath,
  onNavigate,
  enterRef,
}: {
  raw: string;
  activePath: string | null;
  onNavigate: (path: string, line?: number) => void;
  enterRef: React.MutableRefObject<(() => boolean) | null>;
}) {
  const query = useDebounce(raw, 150);
  const version = useVaultIndexVersion();
  const bodies = useVaultStore((s) => s.bodies);
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});

  const results = useMemo(() => {
    const q = parseVaultQuery(query);
    if (q.isEmpty) return null;

    const proseOf = (path: string) => vaultIndex.note(path)?.parsed?.plainText ?? "";

    // Tags come from the index (nested tags included); repeats intersect.
    const tagSets = q.tags.map((tag) => new Set(vaultIndex.filesWithTag(tag)));
    const tagged: Set<string> | null = tagSets.length
      ? tagSets.reduce((acc, files) => new Set([...acc].filter((f) => files.has(f))))
      : null;

    if (!hasRankableText(q)) {
      // A filter with nothing to rank (`tag:draft`, `path:work`) is a listing,
      // not a search — every file that passes, sorted by name.
      const candidates = tagged ? [...tagged] : vaultIndex.paths();
      return candidates
        .filter((p) => isVaultMarkdownPath(p) && fileMatchesQuery(q, p, proseOf(p)))
        .map<FileSearchResult>((p) => ({
          path: p,
          title: displayTitle(p, vaultIndex.note(p)?.title),
          score: 0,
          matches: [],
        }))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    }

    const found = vaultSearch.search(q.text, { limit: 200, matchesPerFile: 20 });
    const filtered: FileSearchResult[] = [];
    for (const file of found) {
      if (tagged && !tagged.has(file.path)) continue;
      if (!fileMatchesQuery(q, file.path, proseOf(file.path))) continue;
      if (!q.phrases.length) {
        filtered.push(file);
        continue;
      }
      // A phrase is checked against the block's SOURCE lines, not the snippet —
      // the snippet is a window around one term and can cut the phrase in half.
      const lines = bodies[file.path]?.content.split("\n") ?? [];
      const matches = file.matches.filter((m) =>
        blockMatchesPhrases(lines.slice(m.line - 1, m.endLine).join(" "), q.phrases),
      );
      if (matches.length) filtered.push({ ...file, matches });
    }
    return filtered;
    // `version` looks unused to the linter and is the whole point: the index is
    // a mutable singleton read during render, so its counter is what tells this
    // memo the answers changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, version, bodies]);

  // A new query invalidates which groups the user had collapsed.
  useWatchEffect(() => {
    setCollapsed({});
  }, [query]);

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[path]) delete next[path];
      else next[path] = true;
      return next;
    });
  }, []);

  const allCollapsed = !!results?.length && results.every((r) => collapsed[r.path]);
  const collapseAll = useCallback(() => {
    if (!results) return;
    setCollapsed(allCollapsed ? {} : Object.fromEntries(results.map((r) => [r.path, true as const])));
  }, [results, allCollapsed]);

  const totalMatches = results?.reduce((acc, r) => acc + r.matches.length, 0) ?? 0;

  enterRef.current = () => {
    const top = results?.[0];
    if (!top) return false;
    onNavigate(top.path, top.matches[0]?.line);
    return true;
  };

  return (
    <>
      {results && results.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-sol-border/20 text-mark uppercase tracking-wide text-sol-text-dim">
          <span className="tabular-nums">
            {totalMatches > 0 ? `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ` : ""}
            {results.length} note{results.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={collapseAll}
            title={allCollapsed ? "Expand all" : "Collapse all"}
            className="ml-auto text-sol-text-dim hover:text-sol-text"
          >
            <ChevronsDownUp className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {results === null ? (
          <TeachingState />
        ) : results.length === 0 ? (
          <div className="px-3 py-6 text-meta leading-5 text-sol-text-dim text-center">
            No notes match <span className="text-sol-text-muted">{query.trim()}</span>.
            <div className="mt-1">Try fewer words, or drop an operator.</div>
          </div>
        ) : (
          results.map((r) => (
            <FileGroup
              // Keyed by query too: a group's "show all matches" state belongs
              // to the query that produced it, not to the file.
              key={`${query} ${r.path}`}
              result={r}
              active={r.path === activePath}
              collapsed={!!collapsed[r.path]}
              onToggleCollapse={toggleCollapse}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
    </>
  );
}

/** Small key legend for an empty code search. */
function CodeSearchKeys() {
  const rows: [string[], string][] = [
    [["↵"], "Open"],
    [["F4"], "Next match"],
    [["⇧", "F4"], "Previous"],
    [["⌥", "C"], "Case"],
    [["⌥", "W"], "Word"],
    [["⌥", "R"], "Regex"],
  ];
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 px-4 py-5 text-meta text-sol-text-dim">
      {rows.map(([keys, label]) => (
        <div key={label} className="contents">
          <span className="flex justify-end gap-0.5">
            {keys.map((k) => (
              <KeyCap key={k}>{k}</KeyCap>
            ))}
          </span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

export const VaultSearchPane = memo(function VaultSearchPane({
  activePath,
  onNavigate,
  inputRef,
}: {
  activePath: string | null;
  onNavigate: (path: string, line?: number) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  // The query lives in the store so a saved-search bookmark can put one here.
  const raw = useVaultStore((s) => s.searchQuery);
  const setRaw = useVaultStore((s) => s.setSearchQuery);
  const local = useVaultStore((s) => !!s.endpoint && !s.isRemote);
  const vaultId = useVaultStore((s) => s.activeVaultId);
  const codeMode = local && !usesNoteOperators(raw);
  const search = useProjectSearch();
  const ownRef = useRef<HTMLInputElement | null>(null);
  const boxRef = inputRef ?? ownRef;
  const paneRef = useRef<HTMLDivElement | null>(null);
  const enterRef = useRef<(() => boolean) | null>(null);
  const router = useRouter();

  // Until the workspace shell handles `file.open`, a match opens through the
  // page's own ?f=&l= navigation, column included.
  useMountEffect(() => {
    projectSearch.navigate = (path, line, column) => router.push(`${filesHref({ path })}&l=${line}:${column}`);
  });

  // Every change to the box (or the vault) searches again, debounced, aborting
  // the search before; a remount with the same text keeps the results.
  useWatchEffect(() => {
    if (!codeMode) {
      projectSearch.cancel();
      return;
    }
    const text = raw.trim() ? raw : "";
    // Against what was last asked, not what last ran: typing a character and
    // deleting it inside the debounce must cancel the search in between.
    if (text !== projectSearch.wanted() || !projectSearch.get().results) projectSearch.schedule(text);
  }, [codeMode, raw]);
  useWatchEffect(() => {
    if (codeMode && projectSearch.get().text) projectSearch.rerun();
  }, [vaultId]);

  // `search.project` asked for the box (vim's :grep with no pattern, Cmd-Shift-H).
  useWatchEffect(() => {
    if (projectSearch.focusRequest <= projectSearch.focusHandled) return;
    projectSearch.focusHandled = projectSearch.focusRequest;
    requestAnimationFrame(() => boxRef.current?.select());
  }, [projectSearch.focusRequest]);

  const focusList = () => {
    const list = paneRef.current?.querySelector<HTMLElement>('[role="tree"]');
    if (!list) return;
    const first = projectSearch.get().results?.rows()[0];
    if (first && !projectSearch.get().active) projectSearch.set({ active: first.key });
    list.focus();
  };

  return (
    <div ref={paneRef} className="h-full flex flex-col min-h-0">
      <div className={`${codeMode ? "pl-0.5 pr-2 pt-2 pb-1.5" : "px-2 py-2 border-b border-sol-border/30"}`}>
        <div className="flex items-center gap-0.5">
          {codeMode && <ReplaceDisclosure state={search} />}
          <div
            className={`flex flex-1 min-w-0 items-center gap-1.5 px-2 py-1 rounded bg-sol-bg border transition-colors focus-within:border-sol-cyan ${
              codeMode && search.results?.error ? "border-sol-red/60" : "border-sol-border/40"
            }`}
          >
            {!codeMode && <Search className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />}
            <input
              ref={boxRef}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              onKeyDown={(e) => {
                if (codeMode && handleSearchOptionKey(e)) return;
                if (codeMode && e.key.toLowerCase() === "h" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  projectSearch.set({ replaceOpen: !search.replaceOpen });
                } else if (e.key === "Escape" && raw) {
                  e.stopPropagation();
                  setRaw("");
                } else if (e.key === "Enter") {
                  if (codeMode) openActiveOrFirst(search);
                  else enterRef.current?.();
                } else if (e.key === "ArrowDown" && codeMode) {
                  e.preventDefault();
                  focusList();
                }
              }}
              placeholder={codeMode ? "Search files" : "Search vault"}
              spellCheck={false}
              autoComplete="off"
              aria-label="Search"
              className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-sol-text placeholder:text-sol-text-dim"
            />
            {raw.trim() && !codeMode && (
              <BookmarkToggle
                target={{ kind: "search", query: raw.trim() }}
                label="Bookmark this search"
                size="w-3.5 h-3.5"
                className="flex-shrink-0"
              />
            )}
            {raw && !codeMode && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setRaw("")}
                className="text-sol-text-dim hover:text-sol-text"
              >
                <X className="w-3 h-3" />
              </button>
            )}
            {codeMode && <CodeSearchToggles state={search} />}
          </div>
        </div>
      </div>

      {codeMode ? (
        raw.trim() || search.replaceOpen ? (
          <ProjectSearchPanel state={search} inputRef={boxRef} />
        ) : (
          <CodeSearchKeys />
        )
      ) : (
        <NotesSearch raw={raw} activePath={activePath} onNavigate={onNavigate} enterRef={enterRef} />
      )}
    </div>
  );
});
