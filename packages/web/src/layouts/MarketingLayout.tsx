import { useRef } from "react";
import { Outlet, useLocation } from "react-router";
import { ForceLightMode } from "@/components/force-light-mode";
import { ErrorBoundary } from "@/components/ErrorBoundary";

import { useWatchEffect } from "../../hooks/useWatchEffect";
export function MarketingLayout() {
  // This div (not the window) is the scroll container for every marketing
  // page, so in-app navigation would otherwise carry the previous page's
  // scroll position onto the next page. Reset it whenever the path changes;
  // same-page hash navigation keeps the pathname and is unaffected.
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useWatchEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [pathname]);

  return (
    <>
      <ForceLightMode />
      <div ref={scrollRef} className="light min-h-screen w-full fixed inset-0 overflow-auto" style={{ backgroundColor: '#fdf6e3' }}>
        <ErrorBoundary name="MarketingPage">
          <Outlet />
        </ErrorBoundary>
      </div>
    </>
  );
}
