// Route modules a cold load starts fetching alongside boot (main.tsx), rather than once the shell has mounted and
// reached the route: /flows's graph is ~350 modules, and fetched only after boot it left the page blank for seconds.
// App.tsx's lazy routes read the same loaders, so the route renders from the promise boot already started.

const once = <T>(load: () => Promise<T>) => {
  let started: Promise<T> | null = null;
  return () => (started ??= load());
};

export const loadFlowsPage = once(() => import("@/app/flows/page"));
export const loadFlowSettingsPage = once(() => import("@/app/flows/settings/page"));
export const loadFlowPage = once(() => import("@/app/flows/[flow]/page"));

const EARLY: [RegExp, () => Promise<unknown>][] = [
  [/^\/flows\/?$/, loadFlowsPage],
  [/^\/flows\/settings\/?$/, loadFlowSettingsPage],
  [/^\/flows\/(?!settings\/?$|trace\/)[^/]+\/?$/, loadFlowPage],
];

/** Starts the module of the route `path` opens on, when it is one worth starting early. */
export function startRouteModule(path: string): void {
  for (const [opensOn, load] of EARLY) if (opensOn.test(path)) void load();
}
