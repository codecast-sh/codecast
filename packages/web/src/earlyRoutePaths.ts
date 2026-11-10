// The routes whose page module a cold load starts beside boot (src/earlyRoutes.ts),
// as paths and the page module each opens. Import-free data, because the build
// reads the same table (plugins/handoffBoot.ts) to preload a route's chunks from
// index.html only when the page opens on that route.

export const EARLY_ROUTES = [
  { path: /^\/flows\/?$/, module: "app/flows/page.tsx" },
  { path: /^\/flows\/settings\/?$/, module: "app/flows/settings/page.tsx" },
  { path: /^\/flows\/(?!settings\/?$|trace\/)[^/]+\/?$/, module: "app/flows/[flow]/page.tsx" },
] as const satisfies readonly { path: RegExp; module: string }[];

export type EarlyRouteModule = (typeof EARLY_ROUTES)[number]["module"];
