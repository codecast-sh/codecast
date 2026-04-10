import { useCallback, useRef, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X, Plus } from "lucide-react";
import { useInboxStore, useTrackedStore, type AppTab } from "../store/inboxStore";

function tabTitle(tab: AppTab, sessions: Record<string, any>): string {
  if (tab.sessionId && sessions[tab.sessionId]) {
    const s = sessions[tab.sessionId];
    return s.title || s.session_id?.slice(0, 12) || "Session";
  }
  return tab.title || pathLabel(tab.path);
}

export function pathLabel(path: string): string {
  if (path.startsWith("/conversation/")) return "Conversation";
  if (path.startsWith("/tasks/")) return "Task";
  if (path.startsWith("/docs/")) return "Doc";
  if (path.startsWith("/plans/")) return "Plan";
  const segments: Record<string, string> = {
    "/tasks": "Tasks",
    "/docs": "Docs",
    "/plans": "Plans",
    "/projects": "Projects",
    "/inbox": "Inbox",
    "/feed": "Feed",
    "/settings": "Settings",
    "/dashboard": "Dashboard",
  };
  return segments[path] || path.split("/").pop() || "Tab";
}

export function TabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const s = useTrackedStore([
    (s) => s.tabs,
    (s) => s.activeTabId,
    (s) => s.sessions,
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tabs = s.tabs;
  const activeTabId = s.activeTabId;

  // Bootstrap: create initial tab if none exist
  useEffect(() => {
    if (tabs.length === 0 && pathname) {
      s.openTab({ path: pathname, title: pathLabel(pathname) });
    }
  }, [tabs.length, pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync current path into active tab on navigation
  useEffect(() => {
    if (!activeTabId || !pathname) return;
    const { tabs } = useInboxStore.getState();
    const active = tabs.find((t: AppTab) => t.id === activeTabId);
    if (active && active.path !== pathname) {
      useInboxStore.getState().updateTab(activeTabId, { path: pathname, title: pathLabel(pathname) });
    }
  }, [pathname, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts: Cmd+T, Cmd+W, Cmd+Shift+[, Cmd+Shift+]
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    function switchToTab(id: string) {
      const state = useInboxStore.getState();
      state.saveCurrentTabState();
      state.switchTab(id);
      const tab = state.tabs.find((t: AppTab) => t.id === id);
      if (tab) routerRef.current.push(tab.path);
    }

    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      if (e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        const state = useInboxStore.getState();
        state.saveCurrentTabState();
        state.openTab({ path: window.location.pathname, title: pathLabel(window.location.pathname), makeActive: true });
        return;
      }

      if (e.key === "w" && !e.shiftKey) {
        const state = useInboxStore.getState();
        if (state.tabs.length <= 1) return;
        e.preventDefault();
        const curId = state.activeTabId;
        if (curId) {
          const idx = state.tabs.findIndex((t: AppTab) => t.id === curId);
          state.closeTab(curId);
          const remaining = state.tabs.filter((t: AppTab) => t.id !== curId);
          const next = remaining[Math.min(idx, remaining.length - 1)];
          if (next) routerRef.current.push(next.path);
        }
        return;
      }

      if ((e.code === "BracketLeft" || e.key === "{" || e.key === "[") && e.shiftKey) {
        e.preventDefault();
        const state = useInboxStore.getState();
        if (state.tabs.length <= 1) return;
        const idx = state.tabs.findIndex((t: AppTab) => t.id === state.activeTabId);
        const prev = state.tabs[(idx - 1 + state.tabs.length) % state.tabs.length];
        if (prev) switchToTab(prev.id);
        return;
      }

      if ((e.code === "BracketRight" || e.key === "}" || e.key === "]") && e.shiftKey) {
        e.preventDefault();
        const state = useInboxStore.getState();
        if (state.tabs.length <= 1) return;
        const idx = state.tabs.findIndex((t: AppTab) => t.id === state.activeTabId);
        const next = state.tabs[(idx + 1) % state.tabs.length];
        if (next) switchToTab(next.id);
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleSwitch = useCallback(
    (tab: AppTab) => {
      if (tab.id === activeTabId) return;
      s.saveCurrentTabState();
      s.switchTab(tab.id);
      router.push(tab.path);
    },
    [activeTabId, router, s],
  );

  const handleClose = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      const { tabs, activeTabId } = useInboxStore.getState();
      if (tabs.length <= 1) return;
      const idx = tabs.findIndex((t: AppTab) => t.id === id);
      const wasActive = activeTabId === id;
      useInboxStore.getState().closeTab(id);
      if (wasActive) {
        const remaining = tabs.filter((t: AppTab) => t.id !== id);
        const next = remaining[Math.min(idx, remaining.length - 1)];
        if (next) router.push(next.path);
      }
    },
    [router],
  );

  const handleNewTab = useCallback(() => {
    s.saveCurrentTabState();
    s.openTab({ path: pathname, title: pathLabel(pathname), makeActive: true });
  }, [pathname, s]);

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.button === 1) handleClose(e, id);
    },
    [handleClose],
  );

  // Only show tab bar when there are 2+ tabs
  if (tabs.length <= 1) return null;

  return (
    <div className="flex-shrink-0 bg-sol-bg-alt/30 border-b border-sol-border/20 flex items-center h-[30px] pl-2 pr-1 gap-0.5 overflow-hidden">
      <div
        ref={scrollRef}
        className="flex items-center gap-0.5 overflow-x-auto scrollbar-none flex-1 min-w-0"
      >
        {tabs.map((tab: AppTab) => {
          const isActive = tab.id === activeTabId;
          const title = tabTitle(tab, s.sessions);
          return (
            <button
              key={tab.id}
              onClick={() => handleSwitch(tab)}
              onMouseDown={(e) => handleMiddleClick(e, tab.id)}
              className={`
                group flex items-center gap-1 px-2.5 h-[24px] rounded text-[11px] leading-none
                max-w-[200px] min-w-[60px] flex-shrink-0 transition-all duration-100
                ${
                  isActive
                    ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/30"
                    : "text-sol-text-dim/70 hover:text-sol-text-muted hover:bg-sol-bg/50"
                }
              `}
            >
              <span className="truncate flex-1 text-left">{title}</span>
              <span
                onClick={(e) => handleClose(e, tab.id)}
                className={`
                  flex-shrink-0 rounded-sm p-0.5 -mr-1 transition-colors
                  ${
                    isActive
                      ? "text-sol-text-dim/50 hover:text-sol-text hover:bg-sol-text-dim/15"
                      : "opacity-0 group-hover:opacity-100 text-sol-text-dim/40 hover:text-sol-text-dim hover:bg-sol-text-dim/15"
                  }
                `}
              >
                <X className="w-3 h-3" />
              </span>
            </button>
          );
        })}
      </div>
      <button
        onClick={handleNewTab}
        className="flex-shrink-0 p-1 rounded text-sol-text-dim/40 hover:text-sol-text-dim hover:bg-sol-bg/50 transition-colors"
        title="New tab (⌘T)"
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}
