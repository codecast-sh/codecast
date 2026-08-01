// Vault note reading view: breadcrumbs, title, typed properties, rendered
// markdown body with live wiki links, embeds, callouts, and vault-served
// images. Link behavior (resolution, navigation, embeds, tags) comes from the
// shared useVaultLinkCtx hook so hover-preview cards behave identically.

import { memo, useMemo } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ChevronRight, FileText } from "lucide-react";
import { noteDisplayName } from "./VaultExplorer";
import { VaultLinkContext, VaultMarkdown } from "./VaultMarkdown";
import { useVaultLinkCtx } from "./useVaultLinkCtx";
import { splitFrontmatter } from "../../lib/vault/frontmatter";
import { useVaultStore } from "../../store/vaultStore";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import { headingSlugs } from "../../lib/vault/parseNote";
import { VaultProperties } from "./VaultProperties";

// Compat re-export: several vault modules import this from here.
export { splitFrontmatter };

export const VaultNoteView = memo(function VaultNoteView({
  path,
  targetLine,
  onNavigate,
}: {
  path: string;
  /** Source line to bring into view (search hits carry it via ?l=). Rendered
   *  markdown has no per-line anchors, so we scroll to the nearest heading at
   *  or above the line — the same section the hit lives in. */
  targetLine?: number;
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
              <span>{seg}</span>
              <ChevronRight className="w-3 h-3" />
            </span>
          ))}
          <span className="text-sol-text-muted">{title}</span>
        </nav>
        <h1 className="text-2xl font-semibold text-sol-text mb-3 break-words">{title}</h1>

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
              <VaultMarkdown content={markdown} />
            </div>
          ) : loading ? (
            <div className="text-sm text-sol-text-dim py-8">Loading note…</div>
          ) : (
            <div className="text-sm text-sol-text-dim py-8">Empty note.</div>
          )}
        </VaultLinkContext.Provider>
      </div>
    </div>
  );
});
