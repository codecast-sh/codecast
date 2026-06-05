import { Loader2 } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";

/**
 * Tiny, unobtrusive "syncing N" indicator shown while a full reconcile crawl is
 * streaming in the rest of the list (see reconcileCrawl.ts). Reads
 * `syncProgress[scope]`, so the same component serves the tasks and docs pages.
 * Deliberately low-key — dim mono text, no border/background — so it never
 * crowds or covers the page title.
 */
export function SyncProgressBadge({ scope }: { scope: string }) {
  const progress = useInboxStore((s) => s.syncProgress[scope]);
  if (!progress?.loading) return null;
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] font-mono text-sol-text-dim/70 whitespace-nowrap flex-shrink-0"
      title="Syncing the full list for this team — older items are still streaming in"
    >
      <Loader2 className="w-3 h-3 animate-spin opacity-60" />
      syncing{progress.loaded > 0 ? ` ${progress.loaded.toLocaleString()}` : ""}
    </span>
  );
}
