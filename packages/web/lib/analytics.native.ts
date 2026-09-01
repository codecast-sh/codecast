// Hermes-safe twin of analytics.ts (same pattern as idbCache.native.ts /
// featureFlags): Metro resolves `.native.ts` first, so the mobile bundle never
// parses the web file's `import.meta` (a Hermes parse error) or pulls in
// posthog-js/@sentry/react. Mobile has its own crash reporting; shared hooks
// that call track() (e.g. the synclog crawl healed metric) become no-ops here —
// the prod removal signal is measured on web/desktop, where the crawls run
// against the full workspace anyway.
export function initAnalytics() {}
export function identifyUser(_userId: string, _traits?: Record<string, unknown>) {}
export function resetUser() {}
export function track(_event: string, _properties?: Record<string, unknown>) {}
export type AnalyticsPlatform = "desktop" | "web" | "mobile";
export function getPlatform(): AnalyticsPlatform { return "mobile"; }
export function captureError(_error: Error, _context?: Record<string, unknown>) {}
export function setupErrorToasts() {}
export const Sentry = undefined as any;
export const posthog = undefined as any;
