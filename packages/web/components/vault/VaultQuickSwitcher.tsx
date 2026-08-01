// Vault quick switcher (Cmd+O): fuzzy-open any note. Obsidian semantics —
// empty query shows recent files, typing fuzzy-matches basename and full path
// (aliases join when the index engine lands), Enter opens, Cmd+Enter opens in
// a new tab, and a non-matching query offers "create note".
//
// Mounted globally (lazy, TerminalDock pattern) so Cmd+O works from any
// surface; the handler declines (returns false) when no vault is connected so
// the chord stays free for other uses in vault-less workspaces.

import { memo, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import fuzzysort from "fuzzysort";
import { CornerDownLeft, FilePlus2, FileText, Clock } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { useVaultStore } from "../../store/vaultStore";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { noteDisplayName } from "./VaultExplorer";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";

interface SwitchTarget {
  path: string;
  name: string;          // display name (no .md)
  prepName: Fuzzysort.Prepared;
  prepPath: Fuzzysort.Prepared;
  /** Frontmatter aliases — Obsidian's switcher matches them like names. */
  aliases: { text: string; prep: Fuzzysort.Prepared }[];
}

const RESULT_CAP = 40;
const RECENT_CAP = 12;

const EMPTY_TARGETS: SwitchTarget[] = [];

/** The fuzzy corpus is only built while the dialog is OPEN. This component is
 *  mounted globally, and files/indexVersion tick on every autosave anywhere in
 *  the vault — rebuilding thousands of fuzzysort.prepare() results on each
 *  keystroke of an unrelated note, for a closed dialog, is pure churn (review
 *  finding, R8; same class as the sidebar wake-gate incidents). Opening the
 *  dialog is the natural refresh point.
 */
function useSwitchTargets(open: boolean): SwitchTarget[] {
  const files = useVaultStore((s) => (open ? s.files : EMPTY_FILES));
  const indexVersion = useVaultIndexVersion();
  return useMemo(() => {
    if (!open) return EMPTY_TARGETS;
    return Object.keys(files)
      .filter((p) => !files[p].dir && isVaultMarkdownPath(p))
      .map((path) => {
        const name = noteDisplayName(path.split("/").pop()!);
        const aliases = (vaultIndex.note(path)?.parsed?.aliases ?? []).map((a) => ({
          text: a,
          prep: fuzzysort.prepare(a),
        }));
        return { path, name, aliases, prepName: fuzzysort.prepare(name), prepPath: fuzzysort.prepare(path) };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, files, indexVersion]);
}

const EMPTY_FILES: Record<string, never> = {};

interface RankedResult {
  target: SwitchTarget;
  nameResult: Fuzzysort.Result | null;
  pathResult: Fuzzysort.Result | null;
  /** Set when an alias outranked name and path — the row shows it. */
  aliasResult: { text: string; result: Fuzzysort.Result } | null;
  score: number;
}

function rank(targets: SwitchTarget[], query: string, recents: string[]): RankedResult[] {
  const recentBoost = new Map(recents.map((p, i) => [p, (RECENT_CAP - Math.min(i, RECENT_CAP)) / 100]));
  const out: RankedResult[] = [];
  for (const t of targets) {
    const nameResult = fuzzysort.single(query, t.prepName);
    const pathResult = fuzzysort.single(query, t.prepPath);
    let aliasBest: { text: string; result: Fuzzysort.Result } | null = null;
    for (const a of t.aliases) {
      const r = fuzzysort.single(query, a.prep);
      if (r && (!aliasBest || r.score > aliasBest.result.score)) aliasBest = { text: a.text, result: r };
    }
    const nameScore = nameResult?.score ?? 0;
    const pathScore = (pathResult?.score ?? 0) * 0.9;
    const aliasScore = (aliasBest?.result.score ?? 0) * 0.95;
    const base = Math.max(nameScore, pathScore, aliasScore);
    if (base <= 0) continue;
    out.push({
      target: t,
      nameResult,
      pathResult,
      aliasResult: aliasScore > nameScore && aliasScore >= pathScore ? aliasBest : null,
      score: base + (recentBoost.get(t.path) ?? 0),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, RESULT_CAP);
}

function Highlighted({ result, fallback }: { result: Fuzzysort.Result | null; fallback: string }) {
  if (!result) return <>{fallback}</>;
  return (
    <>
      {result.highlight((m, i) => (
        <span key={i} className="text-sol-cyan font-semibold">
          {m}
        </span>
      ))}
    </>
  );
}

export const VaultQuickSwitcher = memo(function VaultQuickSwitcher() {
  const open = useVaultStore((s) => s.quickSwitchOpen);
  const setOpen = useVaultStore((s) => s.setQuickSwitchOpen);
  const recentPaths = useVaultStore((s) => s.recentPaths);
  const noteOpened = useVaultStore((s) => s.noteOpened);
  const createFile = useVaultStore((s) => s.createFile);
  const connection = useVaultStore((s) => s.connection);
  const router = useRouter();

  const targets = useSwitchTargets(open);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useWatchEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      // Focus after the portal paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo<RankedResult[]>(() => {
    if (!query.trim()) {
      const byPath = new Map(targets.map((t) => [t.path, t]));
      const recent = recentPaths
        .map((p) => byPath.get(p))
        .filter((t): t is SwitchTarget => !!t)
        .slice(0, RECENT_CAP);
      const rest = targets
        .filter((t) => !recentPaths.includes(t.path))
        .slice(0, RESULT_CAP - recent.length);
      return [...recent, ...rest].map((t) => ({ target: t, nameResult: null, pathResult: null, aliasResult: null, score: 0 }));
    }
    return rank(targets, query.trim(), recentPaths);
  }, [query, targets, recentPaths]);

  const exactMatch = useMemo(
    () => results.some((r) => r.target.name.toLowerCase() === query.trim().toLowerCase()),
    [results, query],
  );
  const showCreate = query.trim().length > 0 && !exactMatch && connection === "connected";
  const rowCount = results.length + (showCreate ? 1 : 0);

  const openPath = (path: string, newTab: boolean) => {
    setOpen(false);
    noteOpened(path);
    const url = `/vault?f=${encodeURIComponent(path)}`;
    if (newTab) {
      useInboxStore.getState().openTab({ path: url, title: noteDisplayName(path.split("/").pop()!) });
    } else {
      router.push(url);
    }
  };

  const createAndOpen = () => {
    const name = query.trim();
    const path = `${name}.md`;
    setOpen(false);
    void createFile(path, `# ${name}\n\n`).then(() => {
      noteOpened(path);
      router.push(`/vault?f=${encodeURIComponent(path)}`);
    });
  };

  const activate = (index: number, newTab: boolean) => {
    if (index < results.length) openPath(results[index].target.path, newTab);
    else if (showCreate) createAndOpen();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setSelected((i) => Math.min(rowCount - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected, e.metaKey || e.ctrlKey);
    }
  };

  useWatchEffect(() => {
    // Keep the selected row visible as the selection moves.
    const el = listRef.current?.querySelector(`[data-row="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Open vault note"
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[18vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="absolute inset-0 bg-black/25" />
      <div className="relative w-[560px] max-w-[92vw] rounded-lg border border-sol-border/50 bg-sol-card shadow-2xl overflow-hidden">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Open note…"
          className="w-full px-4 py-3 bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim outline-none border-b border-sol-border/30"
          spellCheck={false}
        />
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1">
          {results.map((r, i) => (
            <button
              key={r.target.path}
              type="button"
              data-row={i}
              onClick={(e) => activate(i, e.metaKey || e.ctrlKey)}
              onMouseMove={() => setSelected(i)}
              className={`w-full flex items-center gap-2.5 px-4 py-1.5 text-left text-[13px] ${
                i === selected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"
              }`}
            >
              {!query && recentPaths.includes(r.target.path) ? (
                <Clock className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
              ) : (
                <FileText className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
              )}
              <span className="truncate">
                <Highlighted result={r.nameResult} fallback={r.target.name} />
                {r.aliasResult && (
                  <span className="ml-1.5 text-[11px] text-sol-text-dim">
                    via <Highlighted result={r.aliasResult.result} fallback={r.aliasResult.text} />
                  </span>
                )}
              </span>
              {r.target.path.includes("/") && (
                <span className="ml-auto truncate text-[11px] text-sol-text-dim max-w-[45%]">
                  {r.target.path.slice(0, r.target.path.lastIndexOf("/"))}
                </span>
              )}
            </button>
          ))}
          {showCreate && (
            <button
              type="button"
              data-row={results.length}
              onClick={createAndOpen}
              onMouseMove={() => setSelected(results.length)}
              className={`w-full flex items-center gap-2.5 px-4 py-1.5 text-left text-[13px] ${
                selected === results.length ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"
              }`}
            >
              <FilePlus2 className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
              <span>
                Create <span className="text-sol-text font-medium">{query.trim()}</span>
              </span>
            </button>
          )}
          {rowCount === 0 && (
            <div className="px-4 py-6 text-center text-xs text-sol-text-dim">No matching notes.</div>
          )}
        </div>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
          <span className="flex items-center gap-1">
            <KeyCap size="xs">↑</KeyCap>
            <KeyCap size="xs">↓</KeyCap> navigate
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">↵</KeyCap> open
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap>
            <KeyCap size="xs">↵</KeyCap> open in new tab
          </span>
        </div>
      </div>
    </div>
  );
});
