// Hosted mode's pages, fetched while the browser is idle so a first visit to
// To-dos, Notes, Routines or Approvals paints the page rather than a skeleton.
// The specifiers are the route table's (src/routes.manifest.ts), so the
// bundler hands both the same chunk.

let started = false;

/** Warms the hosted pages' chunks once per window, when the browser is idle. */
export function preloadHostedPages(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const load = () => {
    void import("@/app/tasks/page");
    void import("@/app/docs/page");
    void import("@/app/triggers/page");
    void import("@/app/questions/page");
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(load, { timeout: 4000 });
  else window.setTimeout(load, 1500);
}
