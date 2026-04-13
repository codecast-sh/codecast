import {
  useNavigate,
  useLocation,
  useSearchParams as useRRSearchParams,
  useParams as useRRParams,
} from "react-router";
import { useTabContext } from "../../components/TabContent";
import { useInboxStore } from "../../store/inboxStore";

/**
 * Returns the current pathname. When tabs are active, reads from the active
 * tab's path so the sidebar and other components outside TabParamsCtx
 * reflect the tab's current route.
 */
export function usePathname(): string {
  const tabCtx = useTabContext();
  const tabPath = useInboxStore((s) => {
    if (s.tabs.length > 0 && s.activeTabId) {
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      return tab?.path?.split("?")[0].split("#")[0] ?? null;
    }
    return null;
  });
  const routerPath = useLocation().pathname;

  if (tabCtx) return tabCtx.pathname;
  if (tabPath) return tabPath;
  return routerPath;
}

export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (path: string) => {
      const { tabs, activeTabId } = useInboxStore.getState();
      if (tabs.length > 0 && activeTabId) {
        useInboxStore.getState().updateTab(activeTabId, { path, title: pathLabel(path) });
        window.history.replaceState(null, "", path);
      } else {
        navigate(path);
      }
    },
    replace: (path: string) => {
      const { tabs, activeTabId } = useInboxStore.getState();
      if (tabs.length > 0 && activeTabId) {
        useInboxStore.getState().updateTab(activeTabId, { path, title: pathLabel(path) });
        window.history.replaceState(null, "", path);
      } else {
        navigate(path, { replace: true });
      }
    },
    back: () => navigate(-1),
    forward: () => navigate(1),
    refresh: () => window.location.reload(),
    prefetch: (_path: string) => {},
  };
}

export function useSearchParams(): URLSearchParams {
  const tabCtx = useTabContext();
  if (tabCtx) return tabCtx.searchParams;
  const [searchParams] = useRRSearchParams();
  return searchParams;
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const tabCtx = useTabContext();
  if (tabCtx) return tabCtx.params as T;
  return useRRParams() as T;
}

export function redirect(path: string): never {
  window.location.href = path;
  throw new Error("redirect");
}

export function notFound(): never {
  throw new Response("Not Found", { status: 404 });
}

function pathLabel(path: string): string {
  if (path.startsWith("/conversation/")) return "Conversation";
  if (path.startsWith("/tasks/")) return "Task";
  if (path.startsWith("/docs/")) return "Doc";
  if (path.startsWith("/plans/")) return "Plan";
  const segments: Record<string, string> = {
    "/tasks": "Tasks", "/docs": "Docs", "/plans": "Plans",
    "/projects": "Projects", "/inbox": "Inbox", "/feed": "Feed",
    "/settings": "Settings", "/dashboard": "Dashboard",
  };
  return segments[path] || path.split("/").pop() || "Tab";
}
