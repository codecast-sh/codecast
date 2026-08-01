// The VaultLinkContext value builder plus the embed components it renders —
// shared by the note reading view AND the hover preview card, so links, tags,
// images, and transclusions behave identically wherever a note body renders
// (review finding R5: preview cards rendered without a provider, leaving every
// link inside them dead).

import { createContext, memo, useContext, useMemo } from "react";
import { FileText } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { noteDisplayName } from "./VaultExplorer";
import { VaultMarkdown, type VaultLinkContextValue } from "./VaultMarkdown";
import type { WikiLinkParts } from "../../lib/vault/remarkWikiLink";
import { vaultAssetUrl } from "../../lib/vault/client";
import { splitFrontmatter } from "../../lib/vault/frontmatter";
import { useVaultStore } from "../../store/vaultStore";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import { headingSlugs } from "../../lib/vault/parseNote";

export const EmbedDepthContext = createContext(0);
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

export function EmbedCard({
  parts,
  resolvedPath,
  onOpen,
}: {
  parts: WikiLinkParts;
  resolvedPath: string | null;
  onOpen: (path: string) => void;
}) {
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

/** Scroll a heading into view by its DEDUPED slug — the id the renderer's
 *  rehype pass stamped. Duplicate heading texts get -2/-3 suffixes in document
 *  order; a bare heading link targets the first occurrence (Obsidian rule). */
export function scrollToHeading(headingText: string, notePath: string, delayMs = 0) {
  const headings = vaultIndex.note(notePath)?.parsed?.headings ?? [];
  const slugs = headingSlugs(headings);
  const idx = headings.findIndex((h) => h.text.toLowerCase() === headingText.toLowerCase());
  const slug = idx >= 0 ? slugs[idx] : null;
  if (!slug) return;
  const go = () => {
    const el = document.getElementById(`vh-${slug}`);
    el?.scrollIntoView({ block: "start", behavior: delayMs ? "smooth" : "auto" });
  };
  if (delayMs) setTimeout(go, delayMs);
  else go();
}

/** Build the link-context value for a note body rendered at `path`.
 *  `onNavigate` receives vault-relative paths; the same hook serves the main
 *  reading view and hover preview cards. */
export function useVaultLinkCtx(
  path: string,
  onNavigate: (path: string) => void,
): VaultLinkContextValue {
  const files = useVaultStore((s) => s.files);
  const endpoint = useVaultStore((s) => s.endpoint);
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const createFile = useVaultStore((s) => s.createFile);
  const indexVersion = useVaultIndexVersion();

  return useMemo<VaultLinkContextValue>(
    () => ({
      resolve: (target) => {
        const info = vaultIndex.resolveLinkInfo(target, path);
        return { path: info.path, ambiguous: info.isAmbiguous };
      },
      navigate: (p, subpath, subpathType) => {
        onNavigate(p);
        if (subpath && subpathType === "heading") scrollToHeading(subpath, p, 350);
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
        <EmbedCard parts={parts} resolvedPath={resolvedPath} onOpen={onNavigate} />
      ),
    }),
    // indexVersion is deliberately a dep: resolution results change with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, path, onNavigate, createFile, endpoint, activeVaultId, indexVersion],
  );
}

/** Asset resolution over the raw file table (markdown goes through the real
 *  VaultIndex): exact path first, then unique basename. */
export function resolveAssetPath(
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
