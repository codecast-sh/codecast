import { useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { History, ArrowUpRight, ExternalLink, Link2 } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { resolveRecentVisits, type ResolvedVisit } from "../lib/recentVisits";
import { useOpenRecentVisit } from "../hooks/useOpenRecentVisit";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader } from "./ui/context-menu";
import { RecentVisitRow } from "./RecentVisitRow";

// The standalone URL a visit maps to, when one exists. Label/project visits
// are store filters with no URL of their own, so they get null (menu items
// that need a URL don't render for them).
function visitHref(item: ResolvedVisit): string | null {
  if (item.sessionId) return `/conversation/${item.sessionId}`;
  if (item.bucketId || item.projectName) return null;
  return item.path ?? null;
}

const MENU_LIMIT = 10;


// Linear-style "recently viewed" dropdown next to the header back/forward
// buttons: the same unified recents list (sessions, label/project views,
// tasks, docs, plans, channels, pages) the Ctrl+Tab switcher walks and the
// command palette's top group renders.
export function RecentlyViewedMenu({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const ctxMenu = useContextMenu<ResolvedVisit>();
  const openVisit = useOpenRecentVisit(onSelectSession);
  // recentVisits bumps on every navigation, so resolving when it changes (or
  // the menu opens) keeps titles as fresh as the rail needs without
  // subscribing this always-mounted header button to session heartbeats.
  const recentVisits = useInboxStore((s) => s.recentVisits);
  const items = useMemo(
    () => (open ? resolveRecentVisits(useInboxStore.getState(), MENU_LIMIT) : []),
    [recentVisits, open],
  );

  useWatchEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSelect = (item: ResolvedVisit) => {
    setOpen(false);
    openVisit(item);
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`p-1.5 transition-colors rounded hover:bg-sol-bg-alt ${open ? "text-sol-text bg-sol-bg-alt" : "text-sol-text-muted hover:text-sol-text"}`}
        title="Recently viewed"
        aria-label="Recently viewed"
      >
        <History className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-[380px] max-h-[70vh] overflow-y-auto bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[200] py-1">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-sol-text-dim/70">
            Recently viewed
          </div>
          {items.length === 0 && (
            <div className="px-3 py-2 text-xs text-sol-text-dim">Nothing visited yet</div>
          )}
          {items.map((item) => (
            <button
              key={item.key}
              onClick={() => handleSelect(item)}
              onContextMenu={(e) => ctxMenu.open(e, item)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-sol-cyan/10 transition-colors"
            >
              <RecentVisitRow item={item} />
            </button>
          ))}
        </div>
      )}

      <ContextMenu state={ctxMenu}>
        {(item) => {
          const href = visitHref(item);
          return (
            <>
              <CtxHeader title={item.title} />
              <CtxItem icon={ArrowUpRight} onSelect={() => handleSelect(item)}>
                Open
              </CtxItem>
              {href && (
                <CtxItem icon={ExternalLink} onSelect={() => window.open(href, "_blank", "noopener")}>
                  Open in new tab
                </CtxItem>
              )}
              {href && (
                <CtxItem
                  icon={Link2}
                  onSelect={() => {
                    copyToClipboard(`${shareOrigin()}${href}`);
                    toast.success("Link copied");
                  }}
                >
                  Copy link
                </CtxItem>
              )}
            </>
          );
        }}
      </ContextMenu>
    </div>
  );
}
