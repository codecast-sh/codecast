import { useCallback, useRef, useEffect, useState } from "react";
import { activePaneDrag, dragCarriesPane, readPaneDrop, stageMoveLeafToTab, startPaneDrag } from "../lib/stage";
import { X, Plus, XCircle, ArrowRightToLine, Copy as CopyIcon, ExternalLink, AppWindow, PanelsTopLeft } from "lucide-react";
import { useInboxStore, useTrackedStore, type AppTab } from "../store/inboxStore";
import { useShortcutAction, formatShortcutLabel } from "../shortcuts";
import { tabTitle, tabSessionId, chatTabTitle } from "../lib/tabTitle";
import { pathLabel } from "../lib/pathLabel";
import { detachTab } from "../lib/openIntent";
import { bridge, isDesktop, isDetachedTabWindow } from "../lib/desktop";
import { PageIcon } from "./RecentVisitRow";
import { LivenessDot } from "./LivenessDot";
import { sessionLivenessState } from "../lib/liveness";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "./ui/context-menu";
import { useTitlebarHead } from "../hooks/useTitlebarHead";

export function TabBar() {
  // A detached tab window (desktop breakout) renders its one surface with no
  // tab strip; the shared tabs it hydrates belong to the main window. Keep the
  // flag above every hook so handlers can stand aside without reordering hooks.
  const detached = isDetachedTabWindow();
  const s = useTrackedStore([
    (s) => s.tabs,
    (s) => s.activeTabId,
    // Only tab TITLES and liveness STATES are read off sessions — depending on
    // the whole collection re-rendered the bar on every ~1s liveness heartbeat
    // of any session. A joined signature only changes when a referenced
    // session's title or computed dot state changes.
    (s) => s.tabs.map((t) => { const id = tabSessionId(t); return id ? s.sessions[id]?.title ?? "" : ""; }).join("\x1f"),
    (s) => s.tabs.map((t) => { const id = tabSessionId(t); const row = id ? s.sessions[id] : null; return row ? sessionLivenessState(row) : ""; }).join("\x1f"),
    // Same rule for a channel tab's name: a signature over the referenced
    // channels only, never the whole collection. The full derivation IS the
    // signature, so a DM tab also wakes when its counterpart's name loads.
    (s) => s.tabs.map((t) => chatTabTitle(t.path, s.chatChannels, s.teamMembers, (s as any).currentUser?._id) ?? "").join("\x1f"),
  ]);
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement>(null);

  const tabs = s.tabs;
  const activeTabId = s.activeTabId;

  // Bootstrap: create initial tab if none exist
  useEffect(() => {
    if (detached) return;
    if (tabs.length === 0) {
      const path = window.location.pathname;
      s.openTab({ path, title: pathLabel(path) });
    }
  }, [tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Adopt a tab handed back by a detached window ("move into main window").
  // Registered here because the bar is always mounted in the shell.
  useEffect(() => {
    if (detached) return;
    bridge("onAdoptTab")?.((path: string) => {
      const state = useInboxStore.getState();
      state.saveCurrentTabState();
      state.openTab({ path, title: pathLabel(path), makeActive: true });
    });
  }, [detached]);

  // Key bindings live in shortcuts/registry.ts (tab.*) — handlers return false
  // when there's a single tab so Cmd+W falls through to close the window.
  useShortcutAction('tab.new', useCallback(() => {
    if (detached) return false;
    const state = useInboxStore.getState();
    state.saveCurrentTabState();
    const path = window.location.pathname;
    state.openTab({ path, title: pathLabel(path), makeActive: true });
  }, [detached]));

  useShortcutAction('tab.close', useCallback(() => {
    if (detached) return false;
    const state = useInboxStore.getState();
    if (state.tabs.length <= 1) return false;
    if (state.activeTabId) state.closeTab(state.activeTabId);
  }, [detached]));

  useShortcutAction('tab.prev', useCallback(() => {
    if (detached) return false;
    const state = useInboxStore.getState();
    if (state.tabs.length <= 1) return false;
    const idx = state.tabs.findIndex((t: AppTab) => t.id === state.activeTabId);
    const prev = state.tabs[(idx - 1 + state.tabs.length) % state.tabs.length];
    if (prev) { state.saveCurrentTabState(); state.switchTab(prev.id); }
  }, [detached]));

  useShortcutAction('tab.next', useCallback(() => {
    if (detached) return false;
    const state = useInboxStore.getState();
    if (state.tabs.length <= 1) return false;
    const idx = state.tabs.findIndex((t: AppTab) => t.id === state.activeTabId);
    const next = state.tabs[(idx + 1) % state.tabs.length];
    if (next) { state.saveCurrentTabState(); state.switchTab(next.id); }
  }, [detached]));

  const handleSwitch = useCallback(
    (tab: AppTab) => {
      if (tab.id === activeTabId) return;
      s.saveCurrentTabState();
      s.switchTab(tab.id);
    },
    [activeTabId, s],
  );

  const handleClose = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      const state = useInboxStore.getState();
      if (state.tabs.length <= 1) return;
      state.closeTab(id);
    },
    [],
  );

  const handleNewTab = useCallback(() => {
    const state = useInboxStore.getState();
    state.saveCurrentTabState();
    const path = window.location.pathname;
    state.openTab({ path, title: pathLabel(path), makeActive: true });
  }, []);

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.button === 1) handleClose(e, id);
    },
    [handleClose],
  );

  // Browser-convention right-click menu; one instance serves the whole strip.
  const ctxMenu = useContextMenu<AppTab>();
  const closeOthers = useCallback((keep: AppTab) => {
    const state = useInboxStore.getState();
    for (const t of state.tabs.filter((t: AppTab) => t.id !== keep.id)) state.closeTab(t.id);
  }, []);
  const closeToRight = useCallback((from: AppTab) => {
    const state = useInboxStore.getState();
    const idx = state.tabs.findIndex((t: AppTab) => t.id === from.id);
    if (idx < 0) return;
    for (const t of state.tabs.slice(idx + 1)) state.closeTab(t.id);
  }, []);
  const duplicateTab = useCallback((tab: AppTab) => {
    const state = useInboxStore.getState();
    state.saveCurrentTabState();
    state.openTab({ path: tab.path, title: tab.title, makeActive: true });
  }, []);
  // Desktop: break the tab out into its own OS window (lib/openIntent
  // detachTab, shared with Cmd+N). Available only when the shell knows the verb.
  const canDetach = isDesktop() && !!bridge("detachTab");

  // The strip is a drop target: a pane, session or section dropped here opens
  // as a new tab (a dragged pane leaves its split). Tabs themselves are drag
  // sources — onto the stage they split in, and a background tab dissolves
  // into the pane it becomes (lib/stage).
  const [dropHot, setDropHot] = useState(false);
  const stripDragOver = useCallback((e: React.DragEvent) => {
    if (!dragCarriesPane(e.dataTransfer)) return;
    if (activePaneDrag()?.from?.kind === "tab") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropHot(true);
  }, []);
  const stripDrop = useCallback((e: React.DragEvent) => {
    setDropHot(false);
    if (!dragCarriesPane(e.dataTransfer)) return;
    const payload = readPaneDrop(e.dataTransfer);
    if (!payload || payload.from?.kind === "tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (payload.from?.kind === "leaf") {
      stageMoveLeafToTab(payload.from.leafId);
      return;
    }
    const state = useInboxStore.getState();
    state.saveCurrentTabState();
    state.openTab({ path: payload.path, title: payload.title ?? pathLabel(payload.path), makeActive: true });
  }, []);

  if (detached) return null;
  // Only show tab bar when there are 2+ tabs
  if (tabs.length <= 1) return null;

  return (
    <div
      ref={titlebarRef}
      onDragOver={stripDragOver}
      onDragLeave={() => setDropHot(false)}
      onDrop={stripDrop}
      className={`flex-shrink-0 border-b flex items-center h-[32px] pl-2 pr-1 gap-1 overflow-hidden transition-colors ${
        dropHot ? "bg-sol-cyan/10 border-sol-cyan/40" : "bg-sol-bg-alt/50 border-sol-border/20"
      }`}
    >
      <div
        ref={scrollRef}
        className="flex items-center gap-1 overflow-x-auto scrollbar-none flex-1 min-w-0"
      >
        {tabs.map((tab: AppTab, i: number) => {
          const isActive = tab.id === activeTabId;
          const title = tabTitle(tab, s.sessions, s.chatChannels, s.teamMembers, (s as any).currentUser?._id);
          const sid = tabSessionId(tab);
          const sessionRow = sid ? s.sessions[sid] : null;
          const prevActive = i > 0 && tabs[i - 1].id === activeTabId;
          return (
            <button
              key={tab.id}
              onClick={() => handleSwitch(tab)}
              onMouseDown={(e) => handleMiddleClick(e, tab.id)}
              onContextMenu={(e) => ctxMenu.open(e, tab)}
              draggable
              onDragStart={(e) => startPaneDrag(e, { path: tab.path, title, from: { kind: "tab", tabId: tab.id } })}
              title={title}
              className={`
                group relative flex items-center gap-1.5 pl-2.5 pr-1.5 h-[25px] rounded-md text-[11px] leading-none
                max-w-[220px] min-w-[76px] flex-shrink-0 transition-colors duration-100
                ${
                  isActive
                    ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/30"
                    : "text-sol-text-dim/70 hover:text-sol-text-muted hover:bg-sol-bg/50 border border-transparent"
                }
              `}
            >
              {/* Hairline between adjacent inactive tabs, Chrome-style; hidden
                  around the active tab and while hovering. */}
              {i > 0 && !isActive && !prevActive && (
                <span aria-hidden className="absolute -left-[3px] top-1/2 -translate-y-1/2 h-3 w-px bg-sol-border/30 group-hover:opacity-0" />
              )}
              {sessionRow ? (
                <LivenessDot state={sessionLivenessState(sessionRow)} size="xs" className="flex-shrink-0" />
              ) : (
                <PageIcon path={tab.path} className={`w-3 h-3 flex-shrink-0 ${isActive ? "text-sol-text-dim" : "text-sol-text-dim/50"}`} />
              )}
              <span className="truncate flex-1 text-left">{title}</span>
              {/* Fixed-size close slot so the label doesn't shift on hover. */}
              <span
                onClick={(e) => handleClose(e, tab.id)}
                className={`
                  flex-shrink-0 rounded-sm p-0.5 transition-colors
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
        title={`New tab (${formatShortcutLabel('tab.new')})`}
      >
        <Plus className="w-3 h-3" />
      </button>
      <ContextMenu state={ctxMenu}>
        {(tab) => (
          <>
            <CtxItem icon={Plus} shortcut="tab.new" onSelect={handleNewTab}>New tab</CtxItem>
            <CtxItem icon={CopyIcon} onSelect={() => duplicateTab(tab)}>Duplicate tab</CtxItem>
            {canDetach && (
              <CtxItem icon={AppWindow} onSelect={() => detachTab(tab)}>
                Move to new window
              </CtxItem>
            )}
            <CtxItem
              icon={ExternalLink}
              onSelect={() => window.open(tab.path, "_blank")}
            >
              Open in browser tab
            </CtxItem>
            <CtxSeparator />
            <CtxItem
              icon={X}
              shortcut="tab.close"
              disabled={tabs.length <= 1}
              onSelect={() => {
                const state = useInboxStore.getState();
                if (state.tabs.length > 1) state.closeTab(tab.id);
              }}
            >
              Close tab
            </CtxItem>
            <CtxItem
              icon={XCircle}
              disabled={tabs.length <= 1}
              onSelect={() => {
                // Chrome convention: the clicked tab survives and takes focus.
                if (tab.id !== activeTabId) handleSwitch(tab);
                closeOthers(tab);
              }}
            >
              Close other tabs
            </CtxItem>
            <CtxItem
              icon={ArrowRightToLine}
              disabled={tabs.findIndex((t: AppTab) => t.id === tab.id) >= tabs.length - 1}
              onSelect={() => closeToRight(tab)}
            >
              Close tabs to the right
            </CtxItem>
          </>
        )}
      </ContextMenu>
    </div>
  );
}

/** Header affordance shown ONLY inside a detached tab window: merge this
 *  window's surface back into the main window as a tab. Lives beside the other
 *  header actions (DashboardLayout renders it). */
export function AttachTabButton() {
  if (!isDetachedTabWindow()) return null;
  const attach = bridge("attachTab");
  if (!attach) return null;
  return (
    <button
      onClick={() => void attach(window.location.pathname + window.location.search)}
      className="flex items-center p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
      title="Move into main window"
    >
      <PanelsTopLeft className="w-[18px] h-[18px]" />
    </button>
  );
}
