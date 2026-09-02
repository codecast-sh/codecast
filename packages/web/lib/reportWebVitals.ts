// Core Web Vitals forwarded to PostHog as "web_vital" events. The measuring
// and reporting was extracted into @platform/analytics/web-vitals, which
// captures through the same @platform/analytics/web module ./analytics
// configures — so these events carry codecast's super properties like any other.
export { measurePageLoad, reportWebVitals } from "@platform/analytics/web-vitals";
