import { useMemo, useRef, useState, useCallback } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { History, ArrowUpRight, ExternalLink, Link2, Search } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { resolveRecentVisits, type ResolvedVisit } from "../lib/recentVisits";
import { paletteItemScore } from "../lib/paletteActions";
import { useOpenRecentVisit } from "../hooks/useOpenRecentVisit";
import { useShortcutAction } from "../shortcuts";
import { useTipActions } from "../tips";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader } from "./ui/context-menu";
import { RecentVisitRow } from "./RecentVisitRow";
import { visitDetailParts } from "../lib/recentVisitDetails";
import { ShortcutTooltip, KeyCap, MenuKeyCaps } from "./KeyboardShortcutsHelp";

// The standalone URL a visit maps to, when one exists. Label/project visits
// are store filters with no URL of their own, so they get null (menu items
// that need a URL don't render for them).
function visitHref(item: ResolvedVisit): string | null {
  if (item.sessionId) return `/conversation/${item.sessionId}`;
  if (item.bucketId || item.projectName) return null;
  return item.path ?? null;
}

// Searching wants the whole window the Ctrl+Tab walk covers, not the ten rows
// a glance needs: a query is how you reach the eleventh.
const MENU_LIMIT = 30;

// cmdk matches on the text before `|||` (lib/paletteActions.paletteItemScore)
// and needs the whole value unique, so the visit key rides after the marker.
function itemValue(item: ResolvedVisit, teams: any[]): string {
  return `${item.title} ${visitDetailParts(item, teams).join(" ")}|||${item.key}`;
}

// Linear-style "recently viewed" dropdown next to the header back/forward
// buttons: the same unified recents list (sessions, label/project views,
// tasks, docs, plans, channels, pages) the Ctrl+Tab switcher walks and the
// command palette's top group renders. Ctrl+R opens it with the search box
// focused; typing filters, arrows move, Enter opens. It is the searchable half
// of the Ctrl+Tab walk: the held walk hands off here on R, and Ctrl+Tab from
// here hands back.
export function RecentlyViewedMenu({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Where focus was before the chord opened the list (the composer, usually):
  // Escape and a pick put it back so the chord never strands the caret.
  const returnFocus = useRef<HTMLElement | null>(null);
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
  // Snapshot at open, like the rows themselves: the search text is derived
  // from the same store the rows were resolved from.
  const values = useMemo(() => {
    const teams = useInboxStore.getState().teams;
    return items.map((item) => itemValue(item, teams));
  }, [items]);

  const toggle = useCallback(() => {
    setOpen((o) => {
      if (!o) returnFocus.current = document.activeElement as HTMLElement | null;
      return !o;
    });
  }, []);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    const el = returnFocus.current;
    returnFocus.current = null;
    if (restoreFocus && el && el.isConnected) el.focus();
  }, []);

  useShortcutAction("recents.open", toggle);

  useWatchEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(true); return; }
      // Ctrl+Tab hands back to the held walk (hooks/useRecentSwitcher).
      if (e.key === "Tab" && e.ctrlKey) close(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const handleSelect = (item: ResolvedVisit) => {
    close(false);
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
        <CommandPrimitive
          filter={paletteItemScore}
          // Enter with nothing typed goes where Ctrl+Tab would: the view before
          // this one. The first row is where you already are.
          defaultValue={values[1] ?? values[0]}
          loop
          className="absolute top-full left-0 mt-1 w-[400px] max-h-[min(560px,75vh)] flex flex-col bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[200] overflow-hidden"
        >
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-sol-text-dim/70">
              Recently viewed
            </span>
            <span className="ml-auto flex items-center gap-2.5 text-[10px] text-sol-text-dim/60">
              <span className="flex items-center gap-1">
                <MenuKeyCaps action="recents.open" className="flex items-center gap-[2px]" />
                <span>search</span>
              </span>
              <span className="flex items-center gap-1">
                <MenuKeyCaps action="session.mruSwitch" className="flex items-center gap-[2px]" />
                <span>switch</span>
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2 mx-2 mb-1 px-2 h-8 rounded-md bg-sol-bg-alt/60 border border-sol-border/40 focus-within:border-sol-cyan/50 transition-colors">
            <Search className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
            <CommandPrimitive.Input
              autoFocus
              placeholder="Search recent…"
              className="flex-1 min-w-0 bg-transparent text-[13px] text-sol-text placeholder:text-sol-text-dim/60 outline-none"
            />
          </div>
          <CommandPrimitive.List className="flex-1 overflow-y-auto overscroll-contain py-1 scrollbar-auto">
            <CommandPrimitive.Empty className="px-3 py-4 text-center text-xs text-sol-text-dim">
              {items.length === 0 ? "Nothing visited yet" : "No recent view matches"}
            </CommandPrimitive.Empty>
            {items.map((item, i) => (
              <CommandPrimitive.Item
                key={item.key}
                value={values[i]}
                onSelect={() => handleSelect(item)}
                onContextMenu={(e) => ctxMenu.open(e, item)}
                className="mx-1 px-2 py-1.5 rounded-md flex items-center gap-2.5 cursor-default border border-transparent data-[selected=true]:bg-sol-cyan/15 data-[selected=true]:border-sol-cyan/30 transition-colors"
              >
                <RecentVisitRow
                  item={item}
                  trailing={i === 0 ? <span className="text-[10px] text-sol-text-dim/50 flex-shrink-0">current</span> : undefined}
                />
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.List>
          <div className="flex items-center gap-3 px-3 py-1.5 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
            <span className="flex items-center gap-1">
              <KeyCap size="xs">&uarr;</KeyCap>
              <KeyCap size="xs">&darr;</KeyCap>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <KeyCap size="xs">&#9166;</KeyCap>
              open
            </span>
            <span className="flex items-center gap-1">
              <KeyCap size="xs">Esc</KeyCap>
              close
            </span>
          </div>
        </CommandPrimitive>
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
