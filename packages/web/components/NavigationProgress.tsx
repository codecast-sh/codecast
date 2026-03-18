import { usePathname, useSearchParams } from "next/navigation";
import NProgress from "nprogress";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";

NProgress.configure({ showSpinner: false, trickleSpeed: 200, minimum: 0.1 });

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useWatchEffect(() => { NProgress.done(); }, [pathname, searchParams]);

  useEventListener("click", (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:")) return;
    try {
      const targetUrl = new URL(href, window.location.href);
      const currentUrl = new URL(window.location.href);
      if (targetUrl.pathname !== currentUrl.pathname || targetUrl.search !== currentUrl.search) {
        NProgress.start();
      }
    } catch {}
  }, document);

  return null;
}
