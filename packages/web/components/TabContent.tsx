import { lazy, Suspense, createContext, useContext, useRef, useEffect, useMemo } from "react";
import { useInboxStore, useTrackedStore, type AppTab } from "../store/inboxStore";

// -- Tab params context: overrides next/navigation hooks when inside a tab --

export const TabParamsCtx = createContext<{
  pathname: string;
  params: Record<string, string>;
  searchParams: URLSearchParams;
} | null>(null);

export function useTabContext() {
  return useContext(TabParamsCtx);
}

// -- Route map: path pattern → lazy component --

const Tasks = lazy(() => import("@/app/tasks/page"));
const TaskDetail = lazy(() => import("@/app/tasks/[id]/page"));
const Docs = lazy(() => import("@/app/docs/page"));
const DocDetail = lazy(() => import("@/app/docs/[id]/page"));
const Plans = lazy(() => import("@/app/plans/page"));
const PlanDetail = lazy(() => import("@/app/plans/[id]/page"));
const Projects = lazy(() => import("@/app/projects/page"));
const ProjectDetail = lazy(() => import("@/app/projects/[id]/page"));
const Conversation = lazy(() => import("@/app/conversation/[id]/page"));
const ConversationDiff = lazy(() => import("@/app/conversation/[id]/diff/page"));
const Inbox = lazy(() => import("@/app/inbox/page"));
const Feed = lazy(() => import("@/app/feed/page"));
const Dashboard = lazy(() => import("@/app/dashboard/page"));
const Workflows = lazy(() => import("@/app/workflows/page"));
const Sessions = lazy(() => import("@/app/sessions/page"));
const Team = lazy(() => import("@/app/team/page"));
const TeamActivity = lazy(() => import("@/app/team/activity/page"));
const TeamMember = lazy(() => import("@/app/team/[username]/page"));
const Search = lazy(() => import("@/app/search/page"));
const Windows = lazy(() => import("@/app/windows/page"));
const ConfigPage = lazy(() => import("@/app/config/page"));
const Notifications = lazy(() => import("@/app/notifications/page"));

type RouteEntry = {
  pattern: RegExp;
  paramNames: string[];
  component: React.LazyExoticComponent<any>;
};

const ROUTES: RouteEntry[] = [
  // Parameterized routes first (more specific)
  { pattern: /^\/conversation\/([^/]+)\/diff$/, paramNames: ["id"], component: ConversationDiff },
  { pattern: /^\/conversation\/([^/]+)$/, paramNames: ["id"], component: Conversation },
  { pattern: /^\/tasks\/([^/]+)$/, paramNames: ["id"], component: TaskDetail },
  { pattern: /^\/docs\/([^/]+)$/, paramNames: ["id"], component: DocDetail },
  { pattern: /^\/plans\/([^/]+)$/, paramNames: ["id"], component: PlanDetail },
  { pattern: /^\/projects\/([^/]+)$/, paramNames: ["id"], component: ProjectDetail },
  { pattern: /^\/team\/activity$/, paramNames: [], component: TeamActivity },
  { pattern: /^\/team\/([^/]+)$/, paramNames: ["username"], component: TeamMember },
  // Static routes
  { pattern: /^\/tasks$/, paramNames: [], component: Tasks },
  { pattern: /^\/docs$/, paramNames: [], component: Docs },
  { pattern: /^\/plans$/, paramNames: [], component: Plans },
  { pattern: /^\/projects$/, paramNames: [], component: Projects },
  { pattern: /^\/inbox$/, paramNames: [], component: Inbox },
  { pattern: /^\/feed$/, paramNames: [], component: Feed },
  { pattern: /^\/dashboard$/, paramNames: [], component: Dashboard },
  { pattern: /^\/workflows$/, paramNames: [], component: Workflows },
  { pattern: /^\/sessions$/, paramNames: [], component: Sessions },
  { pattern: /^\/team$/, paramNames: [], component: Team },
  { pattern: /^\/search$/, paramNames: [], component: Search },
  { pattern: /^\/windows$/, paramNames: [], component: Windows },
  { pattern: /^\/config$/, paramNames: [], component: ConfigPage },
  { pattern: /^\/notifications$/, paramNames: [], component: Notifications },
];

function matchRoute(path: string): { component: React.LazyExoticComponent<any>; params: Record<string, string> } | null {
  const pathOnly = path.split("?")[0];
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

// -- TabPane: renders one tab's content with context --

function TabPane({ tab, isActive }: { tab: AppTab; isActive: boolean }) {
  const matched = useMemo(() => matchRoute(tab.path), [tab.path]);
  const ctxValue = useMemo(() => {
    const [pathOnly, queryString] = tab.path.split("?");
    return {
      pathname: pathOnly,
      params: matched?.params ?? {},
      searchParams: new URLSearchParams(queryString ?? ""),
    };
  }, [tab.path, matched]);

  // Sync browser URL when this tab is active
  useEffect(() => {
    if (!isActive) return;
    if (window.location.pathname !== ctxValue.pathname) {
      window.history.replaceState(null, "", tab.path);
    }
  }, [isActive, tab.path, ctxValue.pathname]);

  if (!matched) return null;
  const Component = matched.component;

  return (
    <div
      data-tab-id={tab.id}
      className="h-full"
      style={{ display: isActive ? "block" : "none" }}
    >
      <TabParamsCtx.Provider value={ctxValue}>
        <Suspense>
          <Component />
        </Suspense>
      </TabParamsCtx.Provider>
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

  // Sync stale activeTabId to store after render
  useEffect(() => {
    const { activeTabId: storeId, tabs } = useInboxStore.getState();
    if (tabs.length > 0 && (!storeId || !tabs.find((t: AppTab) => t.id === storeId))) {
      useInboxStore.getState().switchTab(tabs[0].id);
    }
  });

  // Lazy mount: only render tabs that have been active at least once
  const mountedRef = useRef(new Set<string>());
  for (const tab of tabs) {
    if (tab.id === activeTabId || mountedRef.current.has(tab.id)) {
      mountedRef.current.add(tab.id);
    }
  }
  // Clean up removed tabs
  for (const id of mountedRef.current) {
    if (!tabs.find((t: AppTab) => t.id === id)) {
      mountedRef.current.delete(id);
    }
  }

  return (
    <div className="h-full">
      {tabs.map((tab: AppTab) => {
        if (!mountedRef.current.has(tab.id)) return null;
        return (
          <TabPane
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
          />
        );
      })}
    </div>
  );
}
