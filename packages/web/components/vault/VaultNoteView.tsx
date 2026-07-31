// Vault note reading view: breadcrumbs, title, rendered markdown body with
// live wiki links, embeds, callouts, and vault-served images.
// Frontmatter is carved off before rendering (a typed properties table lands
// in a later phase; until then it shows as a subtle collapsed strip).

import { createContext, memo, useCallback, useContext, useMemo, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { noteDisplayName } from "./VaultExplorer";
import { VaultLinkContext, VaultMarkdown, type VaultLinkContextValue } from "./VaultMarkdown";
import type { WikiLinkParts } from "../../lib/vault/remarkWikiLink";
import { vaultAssetUrl } from "../../lib/vault/client";
import { useVaultStore } from "../../store/vaultStore";

/** Split YAML frontmatter off a markdown body. Returns [frontmatter|null, rest]. */
export function splitFrontmatter(content: string): [string | null, string] {
  if (!content.startsWith("---\n") && content !== "---") return [null, content];
  const end = content.indexOf("\n---", 3);
  if (end === -1) return [null, content];
  const after = content.indexOf("\n", end + 4);
  return [content.slice(4, end), after === -1 ? "" : content.slice(after + 1)];
}

/** Interim link resolution over the raw file table: exact path first, then
 *  case-insensitive unique-basename, preferring the source note's folder.
 *  Swapped for VaultIndex.resolveLink when the index engine lands. */
function resolveAgainstFiles(
  files: Record<string, { path: string; dir?: boolean }>,
  target: string,
  fromPath: string,
): { path: string | null; ambiguous?: boolean } {
  if (!target) return { path: fromPath };
  const withMd = target.endsWith(".md") ? target : `${target}.md`;
  if (files[target] && !files[target].dir) return { path: target };
  if (files[withMd]) return { path: withMd };
  const lowerBase = withMd.toLowerCase().split("/").pop()!;
  const matches = Object.keys(files).filter(
    (p) => !files[p].dir && p.toLowerCase().split("/").pop() === lowerBase,
  );
  if (matches.length === 0) return { path: null };
  if (matches.length === 1) return { path: matches[0] };
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const sibling = matches.find((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === fromDir);
  return { path: sibling ?? matches.sort()[0], ambiguous: true };
}

const EmbedDepthContext = createContext(0);
const MAX_EMBED_DEPTH = 2;

function EmbeddedNote({ path }: { path: string }) {
  const body = useVaultStore((s) => s.bodies[path]);
  const depth = useContext(EmbedDepthContext);
  const [, markdown] = useMemo(() => splitFrontmatter(body?.content ?? ""), [body?.content]);
  if (!body) {
    return <div className="text-xs text-sol-text-dim italic">Embedded note unavailable: {path}</div>;
  }
  return (
    <EmbedDepthContext.Provider value={depth + 1}>
      <div className="vault-prose prose prose-sm max-w-none">
        <VaultMarkdown content={markdown} />
      </div>
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
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string | null) => void;
}) {
  const body = useVaultStore((s) => s.bodies[path]);
  const loading = useVaultStore((s) => !!s.loadingPaths[path]);
  const exists = useVaultStore((s) => !!s.files[path]);
  const files = useVaultStore((s) => s.files);
  const endpoint = useVaultStore((s) => s.endpoint);
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const createFile = useVaultStore((s) => s.createFile);
  const [showProps, setShowProps] = useState(false);

  const segments = path.split("/");
  const fileName = segments[segments.length - 1];
  const title = noteDisplayName(fileName);

  const [frontmatter, markdown] = useMemo(
    () => splitFrontmatter(body?.content ?? ""),
    [body?.content],
  );

  const linkCtx = useMemo<VaultLinkContextValue>(
    () => ({
      resolve: (target) => resolveAgainstFiles(files, target, path),
      navigate: (p, _subpath) => onNavigate(p),
      createNote: (target) => {
        const newPath = isVaultMarkdownPath(target) ? target : `${target}.md`;
        void createFile(newPath, `# ${target}\n\n`).then(() => onNavigate(newPath));
      },
      assetUrl: (p) => {
        if (!endpoint || !activeVaultId) return null;
        const res = resolveAgainstFiles(files, p.replace(/\.md$/i, ""), path);
        const assetPath = files[p] ? p : res.path;
        return assetPath ? vaultAssetUrl(endpoint, activeVaultId, assetPath) : null;
      },
      renderEmbed: (parts, resolvedPath) => (
        <EmbedCard parts={parts} resolvedPath={resolvedPath} onOpen={(p) => onNavigate(p)} />
      ),
    }),
    [files, path, onNavigate, createFile, endpoint, activeVaultId],
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

        {frontmatter && (
          <div className="mb-4 border border-sol-border/30 rounded">
            <button
              type="button"
              onClick={() => setShowProps((v) => !v)}
              className="w-full text-left px-3 py-1.5 text-[11px] text-sol-text-dim hover:text-sol-text-muted"
            >
              Properties
            </button>
            {showProps && (
              <pre className="px-3 pb-2 text-[11px] text-sol-text-muted whitespace-pre-wrap font-mono">
                {frontmatter}
              </pre>
            )}
          </div>
        )}

        <VaultLinkContext.Provider value={linkCtx}>
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
