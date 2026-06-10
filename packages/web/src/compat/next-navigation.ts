import { useMemo } from "react";
import {
  useNavigate,
  useLocation,
  useSearchParams as useRRSearchParams,
  useParams as useRRParams,
} from "react-router";
import { useTabContext } from "@/components/TabContent";
import { useInboxStore } from "@/store/inboxStore";
import { shouldUseTabRouting, tabNavigate } from "./tabRouting";

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
  return useMemo(
    () => ({
      // The second arg mirrors Next.js's `NavigateOptions` (e.g. `{ scroll }`).
      // We don't act on it, but accepting it keeps `router.push/replace(path,
      // { scroll: false })` call sites type-checking against this shim.
      push: (path: string, _options?: { scroll?: boolean }) => {
        if (shouldUseTabRouting(path)) {
          tabNavigate(path, "push");
        } else {
          navigate(path);
        }
      },
      replace: (path: string, _options?: { scroll?: boolean }) => {
        if (shouldUseTabRouting(path)) {
          tabNavigate(path, "replace");
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
