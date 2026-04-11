import { lazy, Suspense, useEffect, useRef, useState, ReactNode } from "react";
import { createMemoryRouter, RouterProvider, UNSAFE_LocationContext, UNSAFE_RouteContext } from "react-router";
import { useInboxStore, useTrackedStore, type AppTab } from "../store/inboxStore";
import { ErrorBoundary } from "./ErrorBoundary";
import { pathLabel } from "./TabBar";

// Lazy-load page components — same imports as App.tsx
const Dashboard = lazy(() => import("@/app/dashboard/page"));
const Inbox = lazy(() => import("@/app/inbox/page"));
const Feed = lazy(() => import("@/app/feed/page"));
const Search = lazy(() => import("@/app/search/page"));
const Explore = lazy(() => import("@/app/explore/page"));
const Timeline = lazy(() => import("@/app/timeline/page"));
const Notifications = lazy(() => import("@/app/notifications/page"));

const Conversation = lazy(() => import("@/app/conversation/[id]/page"));
const ConversationDiff = lazy(() => import("@/app/conversation/[id]/diff/page"));

const DocsLayout = lazy(() => import("@/app/docs/layout"));
const Docs = lazy(() => import("@/app/docs/page"));
const DocDetail = lazy(() => import("@/app/docs/[id]/page"));
const Plans = lazy(() => import("@/app/plans/page"));
const PlanDetail = lazy(() => import("@/app/plans/[id]/page"));
const Tasks = lazy(() => import("@/app/tasks/page"));
const TaskDetail = lazy(() => import("@/app/tasks/[id]/page"));
const Projects = lazy(() => import("@/app/projects/page"));
const ProjectDetail = lazy(() => import("@/app/projects/[id]/page"));
const Workflows = lazy(() => import("@/app/workflows/page"));

const Team = lazy(() => import("@/app/team/page"));
const TeamActivity = lazy(() => import("@/app/team/activity/page"));
const TeamMember = lazy(() => import("@/app/team/[username]/page"));

const Sessions = lazy(() => import("@/app/sessions/page"));
const Windows = lazy(() => import("@/app/windows/page"));
const ConfigPage = lazy(() => import("@/app/config/page"));

function E({ name, children }: { name: string; children: ReactNode }) {
  return <ErrorBoundary name={name} level="panel">{children}</ErrorBoundary>;
}

/** Route definitions for tab content — mirrors App.tsx routes */
const TAB_ROUTES = [
  { path: "/dashboard", element: <E name="Dashboard"><Suspense><Dashboard /></Suspense></E> },
  { path: "/inbox", element: <E name="Inbox"><Suspense><Inbox /></Suspense></E> },
  { path: "/feed", element: <E name="Feed"><Suspense><Feed /></Suspense></E> },
  { path: "/search", element: <E name="Search"><Suspense><Search /></Suspense></E> },
  { path: "/explore", element: <E name="Explore"><Suspense><Explore /></Suspense></E> },
  { path: "/timeline", element: <E name="Timeline"><Suspense><Timeline /></Suspense></E> },
  { path: "/notifications", element: <E name="Notifications"><Suspense><Notifications /></Suspense></E> },

  { path: "/conversation/:id", element: <E name="Conversation"><Suspense><Conversation /></Suspense></E> },
  { path: "/conversation/:id/diff", element: <E name="ConversationDiff"><Suspense><ConversationDiff /></Suspense></E> },

  {
    path: "/docs",
    element: <E name="DocsLayout"><Suspense><DocsLayout /></Suspense></E>,
    children: [
      { index: true, element: <E name="Docs"><Suspense><Docs /></Suspense></E> },
      { path: ":id", element: <E name="DocDetail"><Suspense><DocDetail /></Suspense></E> },
    ],
  },
  { path: "/plans", element: <E name="Plans"><Suspense><Plans /></Suspense></E> },
  { path: "/plans/:id", element: <E name="PlanDetail"><Suspense><PlanDetail /></Suspense></E> },
  { path: "/tasks", element: <E name="Tasks"><Suspense><Tasks /></Suspense></E> },
  { path: "/tasks/:id", element: <E name="TaskDetail"><Suspense><TaskDetail /></Suspense></E> },
  { path: "/projects", element: <E name="Projects"><Suspense><Projects /></Suspense></E> },
  { path: "/projects/:id", element: <E name="ProjectDetail"><Suspense><ProjectDetail /></Suspense></E> },
  { path: "/workflows", element: <E name="Workflows"><Suspense><Workflows /></Suspense></E> },

  { path: "/team", element: <E name="Team"><Suspense><Team /></Suspense></E> },
  { path: "/team/activity", element: <E name="TeamActivity"><Suspense><TeamActivity /></Suspense></E> },
  { path: "/team/:username", element: <E name="TeamMember"><Suspense><TeamMember /></Suspense></E> },

  { path: "/sessions", element: <E name="Sessions"><Suspense><Sessions /></Suspense></E> },
  { path: "/windows", element: <E name="Windows"><Suspense><Windows /></Suspense></E> },
  { path: "/config", element: <E name="ConfigPage"><Suspense><ConfigPage /></Suspense></E> },
];

/**
 * Escape the outer BrowserRouter context so RouterProvider can create
 * an independent routing tree for each tab.
 */
function RouterIsolator({ children }: { children: ReactNode }) {
  return (
    <UNSAFE_LocationContext.Provider value={null as any}>
      <UNSAFE_RouteContext.Provider value={{ outlet: null, matches: [], isDataRoute: false }}>
        {children}
      </UNSAFE_RouteContext.Provider>
    </UNSAFE_LocationContext.Provider>
  );
}

function TabPane({ tab, isActive }: { tab: AppTab; isActive: boolean }) {
  const [router] = useState(() => createMemoryRouter(TAB_ROUTES, {
    initialEntries: [tab.path],
  }));

  // Sync browser URL when active tab navigates internally
  useEffect(() => {
    if (!isActive) return;
    const unsubscribe = router.subscribe((state) => {
      if (window.location.pathname !== state.location.pathname) {
        window.history.replaceState(null, "", state.location.pathname + state.location.search);
      }
      useInboxStore.getState().updateTab(tab.id, {
        path: state.location.pathname,
        title: pathLabel(state.location.pathname),
      });
    });
    // Sync browser URL immediately on activation
    const loc = router.state.location;
    if (window.location.pathname !== loc.pathname) {
      window.history.replaceState(null, "", loc.pathname + loc.search);
    }
    return unsubscribe;
  }, [isActive, router, tab.id]);

  return (
    <div
      style={{ display: isActive ? "contents" : "none" }}
      data-tab-id={tab.id}
    >
      <RouterIsolator>
        <RouterProvider router={router} />
      </RouterIsolator>
    </div>
  );
}

/**
 * Renders all tab contents simultaneously. Active tab is visible,
 * inactive tabs stay mounted but hidden via display:none.
 */
export function TabPanes() {
  const s = useTrackedStore([
    (s) => s.tabs,
    (s) => s.activeTabId,
  ]);

  const { tabs } = s;
  let { activeTabId } = s;

  if (tabs.length === 0) return null;

  // Fix stale activeTabId
  if (!activeTabId || !tabs.find((t: AppTab) => t.id === activeTabId)) {
    activeTabId = tabs[0].id;
    (useInboxStore.getState() as any)._applyTabs(tabs, activeTabId);
  }

  // Track which tabs have been mounted (once mounted, stay mounted)
  const mountedRef = useRef(new Set<string>());
  for (const tab of tabs) {
    if (tab.id === activeTabId || mountedRef.current.has(tab.id)) {
      mountedRef.current.add(tab.id);
    }
  }
  for (const id of mountedRef.current) {
    if (!tabs.find((t: AppTab) => t.id === id)) {
      mountedRef.current.delete(id);
    }
  }

  return (
    <>
      {tabs.map((tab: AppTab) => {
        const isActive = tab.id === activeTabId;
        if (!mountedRef.current.has(tab.id)) return null;
        return <TabPane key={tab.id} tab={tab} isActive={isActive} />;
      })}
    </>
  );
}
