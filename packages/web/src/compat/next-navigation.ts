import { useMemo } from "react";
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

function isNonTabRoute(path: string): boolean {
  return path.startsWith("/settings");
}

function shouldUseTabRouting(targetPath: string): boolean {
  if (isNonTabRoute(targetPath)) return false;
  if (isNonTabRoute(window.location.pathname)) return false;
  const { tabs, activeTabId } = useInboxStore.getState();
  return tabs.length > 0 && !!activeTabId;
}

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (path: string) => {
        if (shouldUseTabRouting(path)) {
          useInboxStore.getState().updateTab(useInboxStore.getState().activeTabId!, { path, title: pathLabel(path) });
          window.history.replaceState(null, "", path);
        } else {
          navigate(path);
        }
      },
      replace: (path: string) => {
        if (shouldUseTabRouting(path)) {
          useInboxStore.getState().updateTab(useInboxStore.getState().activeTabId!, { path, title: pathLabel(path) });
          window.history.replaceState(null, "", path);
        } else {
          navigate(path, { replace: true });
        }
      },
      back: () => navigate(-1),
      forward: () => navigate(1),
      refresh: () => window.location.reload(),
      prefetch: (_path: string) => {},
    }),
    [navigate],
  );
}

export function useSearchParams(): URLSearchParams {
  const tabCtx = useTabContext();
  const [rrSearchParams] = useRRSearchParams();
  return tabCtx ? tabCtx.searchParams : rrSearchParams;
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const tabCtx = useTabContext();
  const rrParams = useRRParams();
  return (tabCtx ? tabCtx.params : rrParams) as T;
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
