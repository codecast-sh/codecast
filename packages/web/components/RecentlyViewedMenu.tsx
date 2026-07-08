import { useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useRouter } from "next/navigation";
import { useLocation } from "react-router";
import { History, MessageSquare, Tag, Folder, FileText, ListTodo, Map as MapIcon, Search, Inbox, LayoutGrid } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { resolveRecentVisits, visitTimeAgo, type ResolvedVisit } from "../lib/recentVisits";
import { getLabelColor } from "../lib/labelColors";
import { isNonTabRoute } from "../src/compat/tabRouting";

const MENU_LIMIT = 10;

export function PageIcon({ path, className }: { path: string; className: string }) {
  if (path.startsWith("/tasks")) return <ListTodo className={className} />;
  if (path.startsWith("/docs")) return <FileText className={className} />;
  if (path.startsWith("/plans")) return <MapIcon className={className} />;
  if (path.startsWith("/search")) return <Search className={className} />;
  if (path.startsWith("/inbox")) return <Inbox className={className} />;
  return <LayoutGrid className={className} />;
}

// Linear-style "recently viewed" dropdown next to the header back/forward
// buttons: the same unified recents list (sessions, label/project views,
// pages) the command palette's top group renders.
export function RecentlyViewedMenu({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const location = useLocation();
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
    if (item.sessionId) {
      onSelectSession(item.sessionId);
      return;
    }
    if (item.bucketId || item.projectName) {
      const store = useInboxStore.getState();
      if (item.bucketId) store.setActiveBucketFilter(item.bucketId);
      else store.setActiveProjectFilter(item.projectName!, item.projectPath ?? null);
      if (!store.sidePanelOpen) store.toggleSidePanel();
      // Views live in the session panel, which non-tab surfaces (Settings,
      // auth) don't render — head home to the inbox from those.
      if (isNonTabRoute(location.pathname)) router.push("/inbox");
      return;
    }
    if (item.path) router.push(item.path);
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
        <div className="absolute top-full left-0 mt-1 w-72 max-h-[60vh] overflow-y-auto bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[200] py-1">
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
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-sol-text-muted hover:bg-sol-cyan/10 hover:text-sol-text transition-colors"
            >
              {item.sessionId ? (
                <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
              ) : item.bucketId ? (
                <Tag className={`w-3.5 h-3.5 flex-shrink-0 ${getLabelColor(item.title).text}`} />
              ) : item.projectName ? (
                <Folder className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
              ) : (
                <PageIcon path={item.path!} className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />
              )}
              <span className="truncate flex-1">{item.title}</span>
              <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{visitTimeAgo(item.ts)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
