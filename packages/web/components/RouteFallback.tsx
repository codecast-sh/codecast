import { useEffect } from "react";
import NProgress from "nprogress";
import { AppLoader } from "./AppLoader";

/**
 * What a route host shows while a lazy page's chunk is still loading: the
 * top progress bar plus the app loader filling the host. The mark is delayed
 * so a warm chunk never flashes it; a cold or stalled fetch shows a holding
 * state instead of an empty pane.
 */
export function RouteFallback() {
  useEffect(() => {
    NProgress.start();
    return () => { NProgress.done(); };
  }, []);
  return <AppLoader className="min-h-0 h-full bg-transparent" deferIndicator />;
}
