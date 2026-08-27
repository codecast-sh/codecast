import { isNonTabRoute } from "../lib/tabRoutes";
import { lazy, Suspense, useEffect, useMemo, type ComponentType, type LazyExoticComponent } from "react";
import { useInboxStore, useTrackedStore, type AppTab } from "../store/inboxStore";
import { isFullWidthRoute, PageShell } from "../lib/pageLayout";
import { TabParamsCtx } from "../lib/tabParams";
import { isPrewarmTab, clearPrewarmTab } from "../lib/openIntent";
import { tabSessionId } from "../lib/tabTitle";
import { tabNeedsUrlRestore } from "../lib/pathLabel";
import { useConversationMessages } from "../hooks/useConversationMessages";

// -- Route map: path pattern → lazy component --
//
// The lazy wrappers are cached on globalThis rather than recreated on every
// module execution. In dev, a hot update that re-executes this module would
// otherwise mint new lazy components: React sees a new element type for every
// pane, unmounts the page through its Suspense fallback and mounts it again —
// a blank flash and lost page state (open dialogs, scroll) on an unrelated
// edit. Keyed by page path, so a genuinely new route still gets a fresh lazy.
const lazyPages: Map<string, LazyExoticComponent<ComponentType<any>>> =
  ((globalThis as any).__codecastLazyPages ??= new Map());
const lazyLoaders = new Map<string, () => Promise<unknown>>();
function lazyPage(key: string, loader: () => Promise<{ default: ComponentType<any> }>) {
  lazyLoaders.set(key, loader);
  let c = lazyPages.get(key);
  if (!c) { c = lazy(loader); lazyPages.set(key, c); }
  return c;
}

// Import every shell route's module now. A route this window never imported is
// a landmine after a deploy: the SW swap purges the old-hash chunk, the first
// navigation to it fails, and ErrorBoundary heals with a full reload that
// loses the destination. Once imported, the module registry keeps the route
// for the window's lifetime, so navigation never fetches at click time.
// Failures are ignored — the route's own lazy() retries the fetch on visit.
export function warmTabRoutes(): void {
  for (const load of lazyLoaders.values()) void load().catch(() => {});
}

const Tasks = lazyPage("@/app/tasks/page", () => import("@/app/tasks/page"));
const Docs = lazyPage("@/app/docs/page", () => import("@/app/docs/page"));
const Capabilities = lazyPage("@/app/capabilities/page", () => import("@/app/capabilities/page"));
const DocDetail = lazyPage("@/app/docs/[id]/page", () => import("@/app/docs/[id]/page"));
const Plans = lazyPage("@/app/plans/page", () => import("@/app/plans/page"));
const Calls = lazyPage("@/app/calls/page", () => import("@/app/calls/page"));
const PlanDetail = lazyPage("@/app/plans/[id]/page", () => import("@/app/plans/[id]/page"));
const Projects = lazyPage("@/app/projects/page", () => import("@/app/projects/page"));
const ProjectDetail = lazyPage("@/app/projects/[id]/page", () => import("@/app/projects/[id]/page"));
const Conversation = lazyPage("@/app/conversation/[id]/page", () => import("@/app/conversation/[id]/page"));
const ConversationDiff = lazyPage("@/app/conversation/[id]/diff/page", () => import("@/app/conversation/[id]/diff/page"));
const Inbox = lazyPage("@/app/inbox/page", () => import("@/app/inbox/page"));
const Feed = lazyPage("@/app/feed/page", () => import("@/app/feed/page"));
const Crosstalk = lazyPage("@/app/crosstalk/page", () => import("@/app/crosstalk/page"));
const Timeline = lazyPage("@/app/timeline/page", () => import("@/app/timeline/page"));
const Chat = lazyPage("@/app/chat/page", () => import("@/app/chat/page"));
const Workflows = lazyPage("@/app/workflows/dashboard", () => import("@/app/workflows/dashboard"));
const Routines = lazyPage("@/app/workflows/page", () => import("@/app/workflows/page"));
// Triggers (renamed from "Schedules"; /schedules stays routable as an alias).
const Triggers = lazyPage("@/app/triggers/page", () => import("@/app/triggers/page"));
const Sessions = lazyPage("@/app/sessions/page", () => import("@/app/sessions/page"));
const Anchor = lazyPage("@/app/anchor/page", () => import("@/app/anchor/page"));
const Team = lazyPage("@/app/team/page", () => import("@/app/team/page"));
const TeamActivity = lazyPage("@/app/team/activity/page", () => import("@/app/team/activity/page"));
const TeamCharts = lazyPage("@/app/team/charts/page", () => import("@/app/team/charts/page"));
const TeamMember = lazyPage("@/app/team/[username]/page", () => import("@/app/team/[username]/page"));
const Search = lazyPage("@/app/search/page", () => import("@/app/search/page"));
const Windows = lazyPage("@/app/windows/page", () => import("@/app/windows/page"));
const ConfigPage = lazyPage("@/app/config/page", () => import("@/app/config/page"));
const Vault = lazyPage("@/app/vault/page", () => import("@/app/vault/page"));
const Artifacts = lazyPage("@/app/artifacts/page", () => import("@/app/artifacts/page"));
const Notifications = lazyPage("@/app/notifications/page", () => import("@/app/notifications/page"));
// The decision queue: one question at a time, full width.
const Questions = lazyPage("@/app/questions/page", () => import("@/app/questions/page"));
// The Threads inbox: every conversation the viewer is in, one page.
const Threads = lazyPage("@/app/threads/page", () => import("@/app/threads/page"));
const AdminDaemonLogs = lazyPage("@/app/admin/daemon-logs/page", () => import("@/app/admin/daemon-logs/page"));

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

type RouteEntry = {
  pattern: RegExp;
  paramNames: string[];
  component: React.LazyExoticComponent<any>;
};

const ROUTES: RouteEntry[] = [
  // Parameterized routes first (more specific)
  { pattern: /^\/conversation\/([^/]+)\/diff$/, paramNames: ["id"], component: ConversationDiff },
  { pattern: /^\/conversation\/([^/]+)$/, paramNames: ["id"], component: Conversation },
  // Same component as the list: /tasks and /tasks/<id> share one <Tasks> so
  // selecting a task reconciles (instant) instead of swapping components (re-mount).
  { pattern: /^\/tasks\/([^/]+)$/, paramNames: ["id"], component: Tasks },
  // Same component for list and detail (the /tasks/<id> trick): selecting a
  // call reconciles beside the list instead of remounting the page.
  { pattern: /^\/calls\/([^/]+)$/, paramNames: ["id"], component: Calls },
  { pattern: /^\/docs\/([^/]+)$/, paramNames: ["id"], component: DocDetail },
  { pattern: /^\/plans\/([^/]+)$/, paramNames: ["id"], component: PlanDetail },
  // A task opened from inside a project keeps the project mounted, same trick
  // as /tasks/<id>: one component for both URLs, so selecting a task
  // reconciles beside the project's list instead of navigating away from it.
  { pattern: /^\/projects\/([^/]+)\/([^/]+)$/, paramNames: ["id", "taskId"], component: ProjectDetail },
  { pattern: /^\/projects\/([^/]+)$/, paramNames: ["id"], component: ProjectDetail },
  // Same component as the bare route, so opening a channel reconciles in place
  // instead of remounting the whole surface and losing the scroll position.
  { pattern: /^\/chat\/([^/]+)$/, paramNames: ["channelId"], component: Chat },
  { pattern: /^\/team\/activity$/, paramNames: [], component: TeamActivity },
  { pattern: /^\/team\/charts$/, paramNames: [], component: TeamCharts },
  { pattern: /^\/team\/([^/]+)$/, paramNames: ["username"], component: TeamMember },
  // Static routes
  { pattern: /^\/tasks$/, paramNames: [], component: Tasks },
  { pattern: /^\/docs$/, paramNames: [], component: Docs },
  { pattern: /^\/capabilities$/, paramNames: [], component: Capabilities },
  { pattern: /^\/plans$/, paramNames: [], component: Plans },
  { pattern: /^\/calls$/, paramNames: [], component: Calls },
  { pattern: /^\/projects$/, paramNames: [], component: Projects },
  { pattern: /^\/inbox$/, paramNames: [], component: Inbox },
  { pattern: /^\/feed$/, paramNames: [], component: Feed },
  { pattern: /^\/crosstalk$/, paramNames: [], component: Crosstalk },
  { pattern: /^\/timeline$/, paramNames: [], component: Timeline },
  { pattern: /^\/chat$/, paramNames: [], component: Chat },
  { pattern: /^\/workflows$/, paramNames: [], component: Workflows },
  { pattern: /^\/routines$/, paramNames: [], component: Routines },
  { pattern: /^\/triggers$/, paramNames: [], component: Triggers },
  { pattern: /^\/schedules$/, paramNames: [], component: Triggers },
  { pattern: /^\/sessions$/, paramNames: [], component: Sessions },
  { pattern: /^\/anchor$/, paramNames: [], component: Anchor },
  { pattern: /^\/team$/, paramNames: [], component: Team },
  { pattern: /^\/search$/, paramNames: [], component: Search },
  { pattern: /^\/files$/, paramNames: [], component: Vault },
  { pattern: /^\/vault$/, paramNames: [], component: Vault }, // permanent pre-rename alias for /files
  { pattern: /^\/pages$/, paramNames: [], component: Artifacts },
  { pattern: /^\/artifacts$/, paramNames: [], component: Artifacts }, // pre-rename alias for /pages
  { pattern: /^\/windows$/, paramNames: [], component: Windows },
  { pattern: /^\/config$/, paramNames: [], component: ConfigPage },
  { pattern: /^\/notifications$/, paramNames: [], component: Notifications },
  { pattern: /^\/questions$/, paramNames: [], component: Questions },
  { pattern: /^\/threads$/, paramNames: [], component: Threads },
  { pattern: /^\/admin\/daemon-logs$/, paramNames: [], component: AdminDaemonLogs },
];

function matchRoute(path: string): { component: React.LazyExoticComponent<any>; params: Record<string, string> } | null {
  const pathOnly = path.split("?")[0].split("#")[0];
  for (const route of ROUTES) {
    const match = pathOnly.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
      return { component: route.component, params };
    }
  }
  return null;
}

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
  const matched = useMemo(() => matchRoute(tab.path), [tab.path]);
  const ctxValue = useMemo(() => {
    const [pathAndHash, queryString] = tab.path.split("?");
    const pathname = pathAndHash.split("#")[0];
    return {
      tabId: tab.id,
      pathname,
      params: matched?.params ?? {},
      searchParams: new URLSearchParams(queryString ?? ""),
      isActive,
    };
  }, [tab.id, tab.path, matched, isActive]);

  // Sync browser URL when this tab is active. tabNeedsUrlRestore stands down
  // when the live URL is this tab's own content in the other spelling — an
  // inbox tab's session select canonicalizes the URL to /conversation/<id> and
  // PUSHES a { inboxId } history entry (QueuePageClient), then updates the
  // tab's /inbox?s=<id> path (syncActiveInboxTabPath). Rewriting the URL here
  // on that path change was clobbering the just-pushed entry (null state, ?s=
  // spelling), which collapsed browser back/forward across viewed sessions.
  useEffect(() => {
    if (!isActive) return;
    if (window.location.pathname !== ctxValue.pathname) {
      if (!tabNeedsUrlRestore(window.location.pathname, tab.path)) return;
      window.history.replaceState(null, "", tab.path);
    }
  }, [isActive, tab.path, ctxValue.pathname]);

  if (!matched) return null;
  const Component = matched.component;

  // Full-width pages own their scroll/padding; everything else gets the shared
  // PageShell so it is padded and centered (the global "always pad views" rule).
  const page = (
    <TabParamsCtx.Provider value={ctxValue}>
      <Suspense>
        <Component />
      </Suspense>
    </TabParamsCtx.Provider>
  );

  return (
    <div
      data-tab-id={tab.id}
      className="h-full"
      style={{ display: isActive ? "block" : "none" }}
    >
      {isFullWidthRoute(ctxValue.pathname) ? (
        page
      ) : (
        <PageShell pathname={ctxValue.pathname}>{page}</PageShell>
      )}
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
