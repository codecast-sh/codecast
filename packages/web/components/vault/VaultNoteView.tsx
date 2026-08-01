// Vault note reading view: breadcrumbs, title, rendered markdown body with
// live wiki links, embeds, callouts, and vault-served images.
// Frontmatter is carved off before rendering (a typed properties table lands
// in a later phase; until then it shows as a subtle collapsed strip).

import { createContext, memo, useContext, useMemo, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ChevronRight, FileText } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { noteDisplayName } from "./VaultExplorer";
import { VaultLinkContext, VaultMarkdown, type VaultLinkContextValue } from "./VaultMarkdown";
import type { WikiLinkParts } from "../../lib/vault/remarkWikiLink";
import { vaultAssetUrl } from "../../lib/vault/client";
import { useVaultStore } from "../../store/vaultStore";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import { slugifyHeading } from "../../lib/vault/parseNote";
import { VaultProperties } from "./VaultProperties";

/** Split YAML frontmatter off a markdown body. Returns [frontmatter|null, rest].
 *  The closing fence must be a FULL line of `---` (or `...`), matching the
 *  index engine's parser — a value line containing "--- draft" is not a fence,
 *  and the two parsers disagreeing would render frontmatter as body. */
export function splitFrontmatter(content: string): [string | null, string] {
  if (!content.startsWith("---\n") && content !== "---") return [null, content];
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) {
      return [lines.slice(1, i).join("\n"), lines.slice(i + 1).join("\n")];
    }
  }
  return [null, content];
}

/** Asset resolution over the raw file table (markdown goes through the real
 *  VaultIndex): exact path first, then unique basename. */
function resolveAssetPath(
  files: Record<string, { path: string; dir?: boolean }>,
  target: string,
): string | null {
  if (files[target] && !files[target].dir) return target;
  const lowerBase = target.toLowerCase().split("/").pop()!;
  const matches = Object.keys(files).filter(
    (p) => !files[p].dir && p.toLowerCase().split("/").pop() === lowerBase,
  );
  return matches.length ? matches.sort()[0] : null;
}

const EmbedDepthContext = createContext(0);
const MAX_EMBED_DEPTH = 2;

function EmbeddedNote({ path }: { path: string }) {
  const body = useVaultStore((s) => s.bodies[path]);
  const depth = useContext(EmbedDepthContext);
  const [, markdown] = useMemo(() => splitFrontmatter(body?.content ?? ""), [body?.content]);
  if (!body) {
    return <span className="block text-xs text-sol-text-dim italic">Embedded note unavailable: {path}</span>;
  }
  return (
    <EmbedDepthContext.Provider value={depth + 1}>
      <span className="block vault-prose prose prose-sm max-w-none">
        <VaultMarkdown content={markdown} />
      </span>
    </EmbedDepthContext.Provider>
  );
}

function EmbedCard({ parts, resolvedPath, onOpen }: { parts: WikiLinkParts; resolvedPath: string | null; onOpen: (path: string) => void }) {
  const depth = useContext(EmbedDepthContext);
  if (!resolvedPath) {
    return (
      <span className="wiki-link wiki-link-unresolved" title={`"${parts.target}" does not exist`}>
        {parts.target}
      </span>
    );
  }
  if (depth >= MAX_EMBED_DEPTH) {
    return (
      <span className="wiki-link" onClick={() => onOpen(resolvedPath)} role="link">
        {parts.target}
      </span>
    );
  }
  return (
    <span className="block my-3 rounded border border-sol-border/40 overflow-hidden" data-vault-embed>
      <span
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-sol-text-muted bg-sol-bg-alt/60 cursor-pointer hover:text-sol-text"
        onClick={() => onOpen(resolvedPath)}
        role="link"
      >
        <FileText className="w-3 h-3" />
        {noteDisplayName(resolvedPath.split("/").pop()!)}
        {parts.subpath && <span className="text-sol-text-dim">› {parts.subpath}</span>}
      </span>
      <span className="block px-3 py-2">
        <EmbeddedNote path={resolvedPath} />
      </span>
    </span>
  );
}

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
  const files = useVaultStore((s) => s.files);
  const endpoint = useVaultStore((s) => s.endpoint);
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const createFile = useVaultStore((s) => s.createFile);

  const segments = path.split("/");
  const fileName = segments[segments.length - 1];
  const title = noteDisplayName(fileName);

  const [frontmatter, markdown] = useMemo(
    () => splitFrontmatter(body?.content ?? ""),
    [body?.content],
  );

  // Re-render (and re-resolve every wiki link) whenever the index changes — a
  // new note can turn a dangling link live without this note re-parsing.
  const indexVersion = useVaultIndexVersion();

  // Scroll a search hit's section into view once the body has rendered.
  useWatchEffect(() => {
    if (!targetLine || !body) return;
    const headings = vaultIndex.note(path)?.parsed?.headings ?? [];
    const section = [...headings].reverse().find((h) => h.line <= targetLine);
    const raf = requestAnimationFrame(() => {
      if (!section) return;
      const el = document.getElementById(`vh-${slugifyHeading(section.text)}`);
      el?.scrollIntoView({ block: "start" });
      el?.classList.add("vault-flash");
      setTimeout(() => el?.classList.remove("vault-flash"), 1400);
    });
    return () => cancelAnimationFrame(raf);
  }, [targetLine, path, !!body]);

  const linkCtx = useMemo<VaultLinkContextValue>(
    () => ({
      resolve: (target) => {
        const info = vaultIndex.resolveLinkInfo(target, path);
        return { path: info.path, ambiguous: info.isAmbiguous };
      },
      navigate: (p, subpath, subpathType) => {
        onNavigate(p);
        if (subpath && subpathType === "heading") {
          // Scroll after the target note renders.
          const slug = slugifyHeading(subpath);
          setTimeout(() => {
            document.getElementById(`vh-${slug}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
          }, 350);
        }
      },
      createNote: (target) => {
        const newPath = isVaultMarkdownPath(target) ? target : `${target}.md`;
        createFile(newPath, `# ${target}\n\n`)
          .then(() => onNavigate(newPath))
          .catch(() => {});
      },
      assetUrl: (p) => {
        if (!endpoint || !activeVaultId) return null;
        const assetPath = resolveAssetPath(files, p);
        return assetPath ? vaultAssetUrl(endpoint, activeVaultId, assetPath) : null;
      },
      openTag: (tag) => useVaultStore.getState().openTagPane(tag),
      renderEmbed: (parts, resolvedPath) => (
        <EmbedCard parts={parts} resolvedPath={resolvedPath} onOpen={(p) => onNavigate(p)} />
      ),
    }),
    // indexVersion is deliberately a dep: resolution results change with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, path, onNavigate, createFile, endpoint, activeVaultId, indexVersion],
  );

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
