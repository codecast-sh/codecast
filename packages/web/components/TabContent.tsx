import { isNonTabRoute } from "../lib/tabRoutes";
import { lazy, Suspense, useEffect } from "react";
import { useInboxStore, useTrackedStore, type AppTab } from "../store/inboxStore";
import { isPrewarmTab, clearPrewarmTab } from "../lib/openIntent";
import { tabSessionId } from "../lib/tabTitle";
import { tabNeedsUrlRestore } from "../lib/pathLabel";
import { useConversationMessages } from "../hooks/useConversationMessages";
import { tabStageLayout } from "../lib/stage";
import { RoutePane } from "./RoutePane";
import { useNarrowStage } from "../hooks/useNarrowStage";
import { useStageShortcuts } from "../hooks/useStageShortcuts";
import { StageDropLayer } from "./stage/StageDropLayer";

// Only a tab that is actually split pays for the split renderer (and the
// conversation pane it can host); a plain tab's import graph stays as it was.
const StageSplitView = lazy(() => import("./stage/StageSplitView"));

// -- Route map: path pattern → lazy component --
//
// The registry and the warm-up live in lib/tabLazyPages; matchRoute and the
// pane renderer live in components/RoutePane (shared with the split stage).
// This module keeps the tab lifecycle: which tabs mount, which is visible,
// the one-shot entry-URL adoption.

// The entry URL, adopted into the active tab ONCE PER DOCUMENT LOAD — not once
// per TabContent mount. The component remounts when the layout around it
// changes, and a remount is not a navigation: consuming the address bar again
// there stamped whatever URL the previous tab had written into the tab being
// switched to, corrupting stored tab paths (and, via clientState sync, the
// server's copy of them). Document scope on globalThis for the same reason the
// lazy pages live there: a dev hot update re-executes this module.
// Only a shell path is worth adopting: the desktop enters at the app root `/`
// (which then redirects to the inbox), and adopting that entry URL pinned the
// active tab to a path no pane renders — a blank stage on every launch.
const navBoot: { url: string | null } = ((globalThis as any).__codecastTabNavBoot ??= {
  url: typeof window !== "undefined" && window.location && !isNonTabRoute(window.location.pathname)
    ? window.location.pathname + window.location.search
    : null,
});

// Which tabs have mounted panes, document-scoped for the same reason: when
// TabContent itself remounts, a surviving set means every previously visited
// tab remounts warm (hidden) instead of silently losing its pane.
const mountedTabs: Set<string> = ((globalThis as any).__codecastMountedTabs ??= new Set());

// -- SessionPrewarm: warms a background session tab's messages --
//
// A background inbox pane cannot show its own `?s=` session — it paints the
// GLOBAL current conversation and only re-asserts its param once active (a
// background tab must never reach into global state). So mounting the pane
// alone leaves the target session cold. This subscribes the same message hook
// the conversation view uses, so the store already holds the session's window
// when the tab is switched to; the view's own subscription then takes over
// (Convex dedupes identical subscriptions across hooks — no refetch).
function SessionPrewarm({ sessionId }: { sessionId: string }) {
  useConversationMessages(sessionId);
  return null;
}

// -- TabPane: renders one tab's content with context --

function TabPane({ tab, isActive, children }: { tab: AppTab; isActive: boolean; children?: React.ReactNode }) {
  const pathname = tab.path.split("?")[0].split("#")[0];

  // Sync browser URL when this tab is active. tabNeedsUrlRestore stands down
  // when the live URL is this tab's own content in the other spelling — an
  // inbox tab's session select canonicalizes the URL to /conversation/<id> and
  // PUSHES a { inboxId } history entry (QueuePageClient), then updates the
  // tab's /inbox?s=<id> path (syncActiveInboxTabPath). Rewriting the URL here
  // on that path change was clobbering the just-pushed entry (null state, ?s=
  // spelling), which collapsed browser back/forward across viewed sessions.
  useEffect(() => {
    if (!isActive) return;
    if (window.location.pathname !== pathname) {
      if (!tabNeedsUrlRestore(window.location.pathname, tab.path)) return;
      window.history.replaceState(null, "", tab.path);
    }
  }, [isActive, tab.path, pathname]);

  // The stage: one route, or a split of them. A narrow screen renders the
  // focused pane only — the layout survives untouched for a wider window.
  const narrow = useNarrowStage();
  const layout = narrow ? null : tabStageLayout(tab);

  return (
    <div
      data-tab-id={tab.id}
      className="h-full"
      style={{ display: isActive ? "block" : "none" }}
    >
      <StageDropLayer tab={tab} enabled={isActive && !narrow}>
        {layout ? (
          <Suspense fallback={null}>
            <StageSplitView tab={tab} layout={layout} isTabActive={isActive} />
          </Suspense>
        ) : (
          <RoutePane tabId={tab.id} path={tab.path} isActive={isActive} />
        )}
      </StageDropLayer>
      {children}
    </div>
  );
}

// -- TabContent: renders all mounted tabs, toggles visibility --

export function TabContent() {
  const s = useTrackedStore([
    (s) => s.tabs,
    (s) => s.activeTabId,
  ]);
  // The pane chords live with the stage they act on.
  useStageShortcuts();

  const { tabs } = s;
  let { activeTabId } = s;

  if (tabs.length === 0) return null;

  // Fix stale activeTabId — use local override for this render,
  // then schedule the store update for next tick to avoid setState-during-render
  if (!activeTabId || !tabs.find((t: AppTab) => t.id === activeTabId)) {
    activeTabId = tabs[0].id;
  }

  // On full-page navigation (address bar, external link), the active tab's
  // stored path may differ from the browser URL. Override it at render time so
  // TabPanes immediately render the correct content (no effect-timing race).
  // The store is updated in the effect below. Full-path compare: an entry URL
  // that differs only in query (e.g. /search?q=new vs a restored /search?q=old)
  // must also win, or the restored tab silently clobbers the typed query.
  // navBoot is consumed once per document load (see its declaration) — a
  // TabContent remount must never re-adopt the address bar.
  let renderTabs = tabs;
  if (navBoot.url && activeTabId) {
    const active = tabs.find((t: AppTab) => t.id === activeTabId);
    if (active && active.path !== navBoot.url) {
      const url = navBoot.url;
      renderTabs = tabs.map((t: AppTab) =>
        t.id === activeTabId ? { ...t, path: url } : t
      );
    }
  }
  useEffect(() => {
    if (!navBoot.url) return;
    const url = navBoot.url;
    navBoot.url = null;
    const store = useInboxStore.getState();
    if (!store.activeTabId) return;
    const active = store.tabs.find((t: AppTab) => t.id === store.activeTabId);
    if (active && active.path !== url) {
      store.updateTab(store.activeTabId, { path: url });
    }
  }, []);

  // Sync stale activeTabId to store after render
  useEffect(() => {
    const { activeTabId: storeId, tabs } = useInboxStore.getState();
    if (tabs.length > 0 && (!storeId || !tabs.find((t: AppTab) => t.id === storeId))) {
      useInboxStore.getState().switchTab(tabs[0].id);
    }
  });

  // Lazy mount: only render tabs that have been active at least once — plus
  // tabs opened in the background by a Cmd-click (lib/openIntent), which mount
  // hidden so they are warm on first switch. A prewarm tab stops being one the
  // moment it is shown; from then on it is an ordinary visited tab.
  for (const tab of tabs) {
    if (tab.id === activeTabId) clearPrewarmTab(tab.id);
    if (tab.id === activeTabId || mountedTabs.has(tab.id) || isPrewarmTab(tab.id)) {
      mountedTabs.add(tab.id);
    }
  }
  // Clean up removed tabs
  for (const id of mountedTabs) {
    if (!tabs.find((t: AppTab) => t.id === id)) {
      mountedTabs.delete(id);
    }
  }

  return (
    <div className="h-full">
      {renderTabs.map((tab: AppTab) => {
        if (!mountedTabs.has(tab.id)) return null;
        const isActive = tab.id === activeTabId;
        const prewarmSession = !isActive && isPrewarmTab(tab.id) ? tabSessionId(tab) : null;
        return (
          <TabPane
            key={tab.id}
            tab={tab}
            isActive={isActive}
          >
            {prewarmSession && <SessionPrewarm sessionId={prewarmSession} />}
          </TabPane>
        );
      })}
    </div>
  );
}
