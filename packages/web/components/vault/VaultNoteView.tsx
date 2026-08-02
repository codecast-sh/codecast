// Vault note reading view: breadcrumbs, title, typed properties, rendered
// markdown body with live wiki links, embeds, callouts, and vault-served
// images. Link behavior (resolution, navigation, embeds, tags) comes from the
// shared useVaultLinkCtx hook so hover-preview cards behave identically.

import { lazy, memo, Suspense, useMemo } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { BookOpen, ChevronRight, FileText, Pencil } from "lucide-react";
import { noteDisplayName } from "./VaultExplorer";
import { MenuKeyCaps } from "../KeyboardShortcutsHelp";
import { BookmarkToggle } from "./VaultBookmarksPane";
import { VaultLinkContext, VaultMarkdown, FoldScopeContext } from "./VaultMarkdown";
import { useVaultLinkCtx } from "./useVaultLinkCtx";
import { splitFrontmatter } from "../../lib/vault/frontmatter";
import { useVaultStore } from "../../store/vaultStore";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import { headingSlugs } from "../../lib/vault/parseNote";
import { VaultProperties } from "./VaultProperties";
import type { VaultViewMode } from "../../lib/vault/viewMode";

// Compat re-export: several vault modules import this from here.
export { splitFrontmatter };

// CodeMirror and the markdown grammar are ~100kB that reading a note never
// needs; the editor loads the first time someone actually edits.
const VaultEditor = lazy(() =>
  import("./VaultEditor").then((m) => ({ default: m.VaultEditor })),
);

// Per-note scroll positions, session-lived. Restored when a note reopens;
// a search-hit targetLine wins over memory.
const scrollMemory = new Map<string, number>();

export const VaultNoteView = memo(function VaultNoteView({
  path,
  targetLine,
  mode = "reading",
  onToggleEdit,
  onNavigate,
}: {
  path: string;
  /** Source line to bring into view (search hits carry it via ?l=). Rendered
   *  markdown has no per-line anchors, so we scroll to the nearest heading at
   *  or above the line — the same section the hit lives in. */
  targetLine?: number;
  /** Reading, live preview, or raw source. The breadcrumbs and title stay put
   *  across every switch so the three read as one note rather than three
   *  screens. */
  mode?: VaultViewMode;
  onToggleEdit?: () => void;
  onNavigate: (path: string | null) => void;
}) {
  const body = useVaultStore((s) => s.bodies[path]);
  const loading = useVaultStore((s) => !!s.loadingPaths[path]);
  const exists = useVaultStore((s) => !!s.files[path]);

  const segments = path.split("/");
  const fileName = segments[segments.length - 1];
  const title = noteDisplayName(fileName);

  const [frontmatter, markdown] = useMemo(
    () => splitFrontmatter(body?.content ?? ""),
    [body?.content],
  );

  // Re-render (and re-resolve every wiki link) whenever the index changes — a
  // new note can turn a dangling link live without this note re-parsing.
  useVaultIndexVersion();

  const linkCtx = useVaultLinkCtx(path, (p) => onNavigate(p));

  // Capture scroll position (rAF-throttled) and restore it when the note
  // reopens without an explicit target.
  useWatchEffect(() => {
    const container = document.querySelector("[data-vault-note-scroll]");
    if (!container || !body) return;
    if (!targetLine) {
      const saved = scrollMemory.get(path);
      if (saved !== undefined) container.scrollTop = saved;
      else container.scrollTop = 0;
    }
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        scrollMemory.set(path, container.scrollTop);
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
     
  }, [path, !!body]);

  // Scroll a search hit's section into view once the body has rendered, using
  // the DEDUPED slug for that occurrence (duplicate heading texts get -2/-3).
  useWatchEffect(() => {
    if (!targetLine || !body) return;
    const headings = vaultIndex.note(path)?.parsed?.headings ?? [];
    const slugs = headingSlugs(headings);
    let idx = -1;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].line <= targetLine) idx = i;
    }
    if (idx === -1) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`vh-${slugs[idx]}`);
      el?.scrollIntoView({ block: "start" });
      el?.classList.add("vault-flash");
      setTimeout(() => el?.classList.remove("vault-flash"), 1400);
    });
    return () => cancelAnimationFrame(raf);
  }, [targetLine, path, !!body]);

  if (!exists && !body) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-sol-text-muted">
        <FileText className="w-8 h-8 opacity-30" />
        <div className="text-sm">This note does not exist.</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-vault-note-scroll>
      <div className="max-w-3xl mx-auto px-8 py-6">
        <nav className="flex items-center gap-1 text-[11px] text-sol-text-dim mb-1 flex-wrap">
          {segments.slice(0, -1).map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              <button
                type="button"
                className="hover:text-sol-text-muted transition-colors"
                title="Reveal in explorer"
                onClick={() => useVaultStore.getState().requestReveal(segments.slice(0, i + 1).join("/"))}
              >
                {seg}
              </button>
              <ChevronRight className="w-3 h-3" />
            </span>
          ))}
          <button
            type="button"
            className="text-sol-text-muted hover:text-sol-text transition-colors"
            title="Reveal in explorer"
            onClick={() => useVaultStore.getState().requestReveal(path)}
          >
            {title}
          </button>
        </nav>
        <div className="flex items-start gap-3 mb-3">
          <h1 className="flex-1 text-2xl font-semibold text-sol-text break-words">{title}</h1>
          <BookmarkToggle
            target={{ kind: "note", path }}
            label="Bookmark this note"
            className="mt-1.5 flex-shrink-0"
          />
          {onToggleEdit && (
            <button
              type="button"
              onClick={onToggleEdit}
              aria-pressed={mode !== "reading"}
              title={
                mode === "reading"
                  ? "Edit (Ctrl+E) · raw source with Ctrl+Shift+E"
                  : `Read (Ctrl+E) — editing in ${mode === "live" ? "live preview" : "source"}`
              }
              className={`mt-1.5 flex-shrink-0 transition-colors ${
                mode !== "reading" ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text"
              }`}
            >
              {mode === "reading" ? <Pencil className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
            </button>
          )}
        </div>

        {mode !== "reading" ? (
          <Suspense
            fallback={<div className="text-sm text-sol-text-dim py-8">Loading editor…</div>}
          >
            {/* Keyed by path: an editor instance owns one note's document,
                undo history and save timer. Handing it a different note would
                keep the old text on screen and flush it to the new path. */}
            <VaultEditor
              key={path}
              path={path}
              mode={mode}
              onExit={() => onToggleEdit?.()}
              onNavigate={onNavigate}
            />
          </Suspense>
        ) : (
          <VaultLinkContext.Provider value={linkCtx}>
            {frontmatter && (
              <VaultProperties
                frontmatter={vaultIndex.note(path)?.parsed?.frontmatter ?? null}
                raw={frontmatter}
                onTagClick={(t) => useVaultStore.getState().openTagPane(t.replace(/^#/, ""))}
              />
            )}

            {body ? (
              <div className="vault-prose prose prose-sm max-w-none">
                <FoldScopeContext.Provider value={path}>
                  <VaultMarkdown content={markdown} />
                </FoldScopeContext.Provider>
              </div>
            ) : loading ? (
              <div className="text-sm text-sol-text-dim py-8">Loading note…</div>
            ) : (
              <div className="text-sm text-sol-text-dim py-8">
                This note is empty. Press <MenuKeyCaps action="vault.toggleEdit" /> to write in it.
              </div>
            )}
          </VaultLinkContext.Provider>
        )}

        {body && mode === "reading" && (
          <div className="mt-8 pt-2 border-t border-sol-border/20 flex items-center gap-3 text-[10px] text-sol-text-dim">
            <span className="tabular-nums">{vaultIndex.note(path)?.parsed?.wordCount ?? 0} words</span>
            <span className="tabular-nums">{vaultIndex.backlinks(path).length} backlinks</span>
          </div>
        )}
      </div>
    </div>
  );
});
