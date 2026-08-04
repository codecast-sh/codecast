// The chrome every open file wears: breadcrumbs that reveal in the explorer, a
// title, a bookmark toggle, and "show in Finder" when the bytes are on this
// machine. Shared by the markdown reading view and the read-only code viewer so
// the two read as one surface — a note and a source file differ in their BODY,
// not in how you got there.

import { memo, type ReactNode } from "react";
import { ChevronRight, FolderOpen } from "lucide-react";
import { BookmarkToggle } from "./VaultBookmarksPane";
import { fileManagerName, revealVaultPath } from "../../lib/vault/reveal";
import { useVaultStore } from "../../store/vaultStore";

export const VaultFileHeader = memo(function VaultFileHeader({
  path,
  title,
  /** Trailing controls — the note view's edit toggle, nothing for a code file. */
  actions,
}: {
  path: string;
  title: string;
  actions?: ReactNode;
}) {
  const isRemote = useVaultStore((s) => s.isRemote);
  const hasEndpoint = useVaultStore((s) => !!s.endpoint);
  // Only offer Finder when the bytes are on this machine.
  const showReveal = hasEndpoint && !isRemote;
  const segments = path.split("/");

  return (
    <>
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
          label="Bookmark this file"
          className="mt-1.5 flex-shrink-0"
        />
        {showReveal && <RevealButton path={path} />}
        {actions}
      </div>
    </>
  );
});

/** "Show in <file manager>". Also the only action a file with no preview has,
 *  so it lives here rather than inline in the header. */
export const RevealButton = memo(function RevealButton({
  path,
  className = "mt-1.5 flex-shrink-0 text-sol-text-dim hover:text-sol-text transition-colors",
  children,
}: {
  path: string;
  className?: string;
  children?: ReactNode;
}) {
  const fileManager = fileManagerName();
  return (
    <button
      type="button"
      onClick={() => {
        void revealVaultPath(path, "reveal").then((err) => {
          if (err) useVaultStore.setState({ opError: err });
        });
      }}
      title={`Show this file in ${fileManager}`}
      className={className}
    >
      {children ?? <FolderOpen className="w-4 h-4" />}
    </button>
  );
});
