// The route map and the one pane renderer.
//
// A pane is "a route rendered somewhere": the whole surface of a plain tab,
// or one cell of a split stage. Both feed a path through matchRoute and mount
// the lazy page under a TabParamsCtx — the pane-local `navigate` is what lets
// a page live in a split cell and keep its URL-driven state without knowing
// where it is mounted. Extracted from TabContent so the split renderer can
// reuse it without a cycle; the lazy registry itself stays in lib/tabLazyPages
// (the Fast Refresh boundary rule).

import { Suspense, useMemo } from "react";
import { lazyPage } from "../lib/tabLazyPages";
import { isFullWidthRoute, PageShell } from "../lib/pageLayout";
import { TabParamsCtx } from "../lib/tabParams";

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
const TriggerDetail = lazyPage("@/app/triggers/[id]/page", () => import("@/app/triggers/[id]/page"));
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
  { pattern: /^\/triggers\/([^/]+)$/, paramNames: ["id"], component: TriggerDetail },
  { pattern: /^\/schedules\/([^/]+)$/, paramNames: ["id"], component: TriggerDetail },
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

/**
 * One route, rendered as a pane. `navigate` makes the pane self-routing (the
 * TabParamsCtx contract): with it set, `useRouter().push` from inside re-points
 * this pane instead of moving the tab.
 */
export function RoutePane({
  tabId,
  path,
  isActive,
  navigate,
}: {
  tabId: string;
  path: string;
  isActive: boolean;
  navigate?: (path: string, mode: "push" | "replace") => void;
}) {
  const matched = useMemo(() => matchRoute(path), [path]);
  const ctxValue = useMemo(() => {
    const [pathAndHash, queryString] = path.split("?");
    return {
      tabId,
      pathname: pathAndHash.split("#")[0],
      params: matched?.params ?? {},
      searchParams: new URLSearchParams(queryString ?? ""),
      isActive,
      navigate,
    };
  }, [tabId, path, matched, isActive, navigate]);

  if (!matched) return null;
  const Component = matched.component;

  const page = (
    <TabParamsCtx.Provider value={ctxValue}>
      <Suspense>
        <Component />
      </Suspense>
    </TabParamsCtx.Provider>
  );

  // Full-width pages own their scroll/padding; everything else gets the shared
  // PageShell so it is padded and centered (the global "always pad views" rule).
  return isFullWidthRoute(ctxValue.pathname) ? (
    page
  ) : (
    <PageShell pathname={ctxValue.pathname}>{page}</PageShell>
  );
}
