import { useMemo, useRef, useState, useCallback } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { History, ArrowUpRight, ExternalLink, Link2 } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { resolveRecentVisits, type ResolvedVisit } from "../lib/recentVisits";
import { useOpenRecentVisit } from "../hooks/useOpenRecentVisit";
import { useTipActions } from "../tips";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader } from "./ui/context-menu";
import { RecentsPanel } from "./RecentsPanel";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";

// The standalone URL a visit maps to, when one exists. Label/project visits
// are store filters with no URL of their own, so they get null (menu items
// that need a URL don't render for them).
function visitHref(item: ResolvedVisit): string | null {
  if (item.sessionId) return `/conversation/${item.sessionId}`;
  if (item.bucketId || item.projectName) return null;
  return item.path ?? null;
}

// The whole window the Ctrl+Tab walk covers: a query is how you reach the
// eleventh row.
const MENU_LIMIT = 30;

// Linear-style "recently viewed" dropdown next to the header back/forward
// buttons: the mouse path onto the same panel the Ctrl+Tab walk and Ctrl+R
// search render (RecentsPanel), anchored under the button with the chords in
// its header.
export function RecentlyViewedMenu({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const ctxMenu = useContextMenu<ResolvedVisit>();
  const openVisit = useOpenRecentVisit(onSelectSession);
  const tipActions = useTipActions();
  // recentVisits bumps on every navigation, so resolving when it changes (or
  // the menu opens) keeps titles as fresh as the rail needs without
  // subscribing this always-mounted header button to session heartbeats.
  const recentVisits = useInboxStore((s) => s.recentVisits);
  const items = useMemo(
    () => (open ? resolveRecentVisits(useInboxStore.getState(), MENU_LIMIT) : []),
    [recentVisits, open],
  );

  const toggle = useCallback(() => {
    setOpen((o) => !o);
    // Enter with nothing typed goes where Ctrl+Tab would: the view before
    // this one. The first row is where you already are.
    setSelectedIndex(1);
  }, []);

  useWatchEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); return; }
      // The keyboard surface is the overlay (hooks/useRecentSwitcher): Ctrl+Tab
      // and the search chord open it, so this one steps aside.
      if ((e.ctrlKey && e.key === "Tab") || ((e.ctrlKey || e.altKey) && e.key.toLowerCase() === "r")) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const handleSelect = (item: ResolvedVisit) => {
    setOpen(false);
    openVisit(item);
  };

  return (
    <div ref={menuRef} className="relative">
      <ShortcutTooltip label="Recently viewed" action="recents.open">
        <button
          onClick={(e) => { toggle(); tipActions.whisper("recents.open", e); }}
          className={`p-1.5 transition-colors rounded hover:bg-sol-bg-alt ${open ? "text-sol-text bg-sol-bg-alt" : "text-sol-text-muted hover:text-sol-text"}`}
          aria-label="Recently viewed"
          aria-expanded={open}
        >
          <History className="w-4 h-4" />
        </button>
      </ShortcutTooltip>
      {open && (
        <RecentsPanel
          items={items}
          selectedIndex={selectedIndex}
          onSelectedIndexChange={setSelectedIndex}
          onSelect={handleSelect}
          onItemContextMenu={(e, item) => ctxMenu.open(e, item)}
          mode="menu"
          className="absolute top-full left-0 mt-1 w-[420px] max-h-[min(560px,75vh)] bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[200]"
        />
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
