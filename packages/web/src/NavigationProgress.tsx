import { useLocation } from "react-router";
import NProgress from "nprogress";
import { useMountEffect } from "@/hooks/useMountEffect";
import { useEventListener } from "@/hooks/useEventListener";

NProgress.configure({ showSpinner: false, trickleSpeed: 200, minimum: 0.1 });

let lastPathname = "";

export function NavigationProgress() {
  const { pathname, search } = useLocation();

  const key = pathname + search;
  if (key !== lastPathname) {
    lastPathname = key;
    NProgress.done();
  }

  useEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:")) {
      return;
    }

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
