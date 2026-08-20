// Read-only view for everything that isn't markdown: images, code and plain
// text, and an honest dead end for the rest.
//
// READ-ONLY IS DELIBERATE, not a stage on the way to an editor. Markdown keeps
// the whole reading/live/source experience because the linked-notes layer is
// what this surface is for; source files are here so the tree tells the truth
// about the folder you opened, and competing with someone's real editor is a
// losing game. There is no write path from this component — no autosave, no
// CodeMirror, no PUT — and the daemon refuses writes to these paths anyway
// (vaultScope.isVaultDocumentPath).

import { memo, useMemo } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { FileQuestion, FileWarning } from "lucide-react";
import { VAULT_MAX_PREVIEW_BYTES, vaultFileKind } from "@codecast/shared/contracts";
import { highlightCode, languageForPath } from "../../lib/codeLanguage";
import { vaultAssetUrl } from "../../lib/vault/client";
import { useVaultStore } from "../../store/vaultStore";
import { VaultFileHeader, RevealButton } from "./VaultFileHeader";

/** Bytes, in the unit a person would say out loud. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** A centered dead end with one honest sentence and a way out to Finder. */
function NoPreview({
  path,
  icon,
  title,
  detail,
}: {
  path: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  const canReveal = useVaultStore((s) => !!s.endpoint && !s.isRemote);
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
      {icon}
      <div className="text-sm text-sol-text-muted">{title}</div>
      <div className="text-xs text-sol-text-dim">{detail}</div>
      {canReveal && (
        <RevealButton
          path={path}
          className="sol-btn text-xs px-3 py-1.5 mt-2"
        >
          Show in Finder
        </RevealButton>
      )}
    </div>
  );
}

/** Code with a line-number gutter. Prism does the highlighting — the same
 *  grammars the app's code blocks use, so a `.ts` file reads identically here
 *  and in a conversation. */
const CodeText = memo(function CodeText({ content, path }: { content: string; path: string }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const html = useMemo(
    () => highlightCode(content, languageForPath(path)),
    [content, path],
  );
  // Highlighting spans lines, so the gutter is a separate column beside ONE
  // <pre> rather than a per-line grid — a multi-line template literal or block
  // comment would otherwise have its markup cut at every line boundary.
  return (
    <div className="flex text-[12.5px] leading-[1.55] font-mono overflow-x-auto rounded border border-sol-border/30 bg-sol-bg-alt/40">
      <div
        aria-hidden
        className="flex-shrink-0 select-none text-right py-3 px-3 text-sol-text-dim/50 border-r border-sol-border/30 tabular-nums"
      >
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="flex-1 min-w-0 py-3 px-3 !m-0 !border-0 !bg-transparent">
        {html ? (
          <code className="text-sol-text-secondary" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code className="text-sol-text-secondary">{content}</code>
        )}
      </pre>
    </div>
  );
});

export const VaultFileView = memo(function VaultFileView({ path }: { path: string }) {
  const entry = useVaultStore((s) => s.files[path]);
  const body = useVaultStore((s) => s.bodies[path]);
  const loading = useVaultStore((s) => !!s.loadingPaths[path]);
  const endpoint = useVaultStore((s) => s.endpoint);
  const vaultId = useVaultStore((s) => s.activeVaultId);

  const kind = vaultFileKind(path);
  const size = entry?.size ?? 0;
  const tooLarge = size > VAULT_MAX_PREVIEW_BYTES;
  const title = path.slice(path.lastIndexOf("/") + 1);

  // Text arrives on demand — unlike notes, which are all held from the scan.
  // The store declines above the cap on its own, so this asks unconditionally.
  // `endpoint` is a dep on purpose: a cached boot paints this view before the
  // daemon handshake lands, and the store can't fetch without an endpoint —
  // the ask has to repeat once there is one.
  useWatchEffect(() => {
    if (kind === "text" && !body && endpoint) void useVaultStore.getState().loadTextBody(path);
  }, [kind, path, !!body, endpoint]);

  if (!entry) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-sol-text-muted">
        <FileQuestion className="w-8 h-8 opacity-30" />
        <div className="text-sm">This file does not exist.</div>
      </div>
    );
  }

  const assetSrc =
    endpoint && vaultId && kind === "asset" ? vaultAssetUrl(endpoint, vaultId, path) : null;

  const renderBody = () => {
    if (tooLarge) {
      return (
        <NoPreview
          path={path}
          icon={<FileWarning className="w-8 h-8 text-sol-text-dim opacity-40" />}
          title="Too large to preview"
          detail={`${formatSize(size)} — open it in your editor instead.`}
        />
      );
    }
    // Attachments the browser can play or draw by itself, given the URL the
    // loopback route serves them from.
    if (assetSrc) {
      if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)) {
        return <img src={assetSrc} alt={title} className="max-w-full rounded border border-sol-border/30" />;
      }
      if (/\.(mp4|webm|mov)$/i.test(path)) {
        return <video src={assetSrc} controls className="max-w-full rounded border border-sol-border/30" />;
      }
      if (/\.(mp3|wav|m4a)$/i.test(path)) return <audio src={assetSrc} controls className="w-full" />;
      if (/\.pdf$/i.test(path)) {
        return <iframe src={assetSrc} title={title} className="w-full h-[70vh] rounded border border-sol-border/30" />;
      }
    }
    if (kind === "text") {
      if (body) return <CodeText content={body.content} path={path} />;
      if (loading) return <div className="text-sm text-sol-text-dim py-8">Loading file…</div>;
      // No body and not loading means the fetch never ran or came back empty.
      // Only the scan's own size can tell "empty" from "we don't have it" —
      // calling a failed read "empty" would be a quiet lie about the file.
      return (
        <div className="text-sm text-sol-text-dim py-8">
          {size === 0 ? "This file is empty." : "Couldn't read this file."}
        </div>
      );
    }
    return (
      <NoPreview
        path={path}
        icon={<FileQuestion className="w-8 h-8 text-sol-text-dim opacity-40" />}
        title="No preview for this file type"
        detail={formatSize(size)}
      />
    );
  };

  return (
    <div className="h-full overflow-y-auto" data-vault-note-scroll>
      {/* Code fills the pane: lines are wide and nobody reads them as prose.
          Notes (VaultNoteView) keep a measured reading column. */}
      <div className={kind === "text" ? "px-6 pr-10 py-5" : "max-w-4xl mx-auto px-8 py-6"}>
        <VaultFileHeader path={path} title={title} />

        {renderBody()}

        {kind === "text" && body && !tooLarge && (
          <div className="mt-4 pt-2 border-t border-sol-border/20 flex items-center gap-3 text-[10px] text-sol-text-dim">
            <span className="tabular-nums">{formatSize(size)}</span>
            <span>Read-only</span>
          </div>
        )}
      </div>
    </div>
  );
});
