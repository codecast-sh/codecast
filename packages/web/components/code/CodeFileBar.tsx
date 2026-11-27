// The breadcrumbs row above a code file: where it lives (each folder reveals
// itself in the explorer), then the symbol path at the cursor (class ›
// method), then the file's actions. The symbol path is written by the editor
// itself (lib/code/workspace/symbolPath.ts) into the span bound here, so the
// cursor moving never renders this component.

import { memo, useRef, type ReactNode } from "react";
import { ChevronRight, FolderOpen } from "lucide-react";
import { BookmarkToggle } from "../vault/VaultBookmarksPane";
import { RevealButton } from "../vault/VaultFileHeader";
import { useVaultStore } from "../../store/vaultStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { bindGroupCrumbs } from "../../lib/code/workspace/groupRegistry";
import { useCodeGroup } from "./workspace/groupContext";

const reveal = (path: string) => () => useVaultStore.getState().requestReveal(path);

export const CodeFileBar = memo(function CodeFileBar({ path, actions }: { path: string; actions?: ReactNode }) {
  const canReveal = useVaultStore((s) => !!s.endpoint && !s.isRemote);
  const group = useCodeGroup();
  const symbolsRef = useRef<HTMLSpanElement | null>(null);
  useWatchEffect(() => {
    const el = symbolsRef.current;
    if (!el || !group) return;
    return bindGroupCrumbs(group.key, el);
  }, [group?.key]);
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-b border-sol-border/30 pl-3 pr-2">
      <nav className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-meta text-sol-text-dim">
        {segments.slice(0, -1).map((seg, i) => (
          <span key={i} className="flex min-w-0 shrink items-center">
            <button type="button" className="truncate transition-colors hover:text-sol-text-muted" title="Reveal in explorer" onClick={reveal(segments.slice(0, i + 1).join("/"))}>
              {seg}
            </button>
            <ChevronRight className="mx-0.5 h-3 w-3 shrink-0 opacity-60" />
          </span>
        ))}
        <button type="button" className="shrink-0 text-sol-text-muted transition-colors hover:text-sol-text" title="Reveal in explorer" onClick={reveal(path)}>
          {name}
        </button>
        <span ref={symbolsRef} className="flex min-w-0 shrink items-center overflow-hidden" />
      </nav>
      <span className="flex shrink-0 items-center gap-2">
        <BookmarkToggle target={{ kind: "note", path }} label="Bookmark this file" size="h-3.5 w-3.5" />
        {canReveal && (
          <RevealButton path={path} className="text-sol-text-dim transition-colors hover:text-sol-text">
            <FolderOpen className="h-3.5 w-3.5" />
          </RevealButton>
        )}
        {actions}
      </span>
    </div>
  );
});
