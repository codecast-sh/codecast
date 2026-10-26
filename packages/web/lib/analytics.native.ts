// Hermes-safe twin of analytics.ts (same pattern as idbCache.native.ts /
// featureFlags): Metro resolves `.native.ts` first, so the mobile bundle never
// parses the web file's `import.meta` (a Hermes parse error) or pulls in
// posthog-js/@sentry/react. Shared hooks' track() calls (the inbox drift
// compare's heartbeat and drift events, the synclog crawl metrics) go to the
// app's PostHog client, which packages/mobile/lib/analytics.ts initialises
// with the same event catalog as web; calls before init are queued there.
// Init, identity and crash reporting stay with the mobile app.
import { track as trackNative } from "@platform/analytics/native";
import type { CodecastEventName, CodecastEventProps } from "@codecast/shared/analytics";

export function initAnalytics() {}
export function identifyUser(_userId: string, _traits?: Record<string, unknown>) {}
export function resetUser() {}
// Same signature as the web twin so a shared hook typechecks in both programs.
export function track<N extends CodecastEventName>(event: N, properties: CodecastEventProps<N>) {
  trackNative(event, properties as Record<string, string | number | boolean>);
}
export type AnalyticsPlatform = "desktop" | "web" | "mobile";
export function getPlatform(): AnalyticsPlatform { return "mobile"; }
export function captureError(_error: Error, _context?: Record<string, unknown>) {}
export function setupErrorToasts() {}
export const Sentry = undefined as any;
export const posthog = undefined as any;
