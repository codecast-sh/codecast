// Codecast's mobile analytics surface. The PostHog and Sentry wiring was
// extracted into @platform/analytics/native; codecast's Expo env values and its
// "mobile" platform label are what stay here. Every consumer (app/_layout.tsx)
// keeps importing from this module.
//
// The package keeps the lazy requires this file was built around: Sentry and
// PostHog are NATIVE modules, and an OTA ships JS only, so it can land on a
// binary built before those deps existed (the 1.0.2 App Store build predates
// them). A static import would resolve the native module at module eval and
// throw "Cannot find native module", crashing the app on every launch before
// expo-updates can mark it launched — which auto-rolls the update back. Absent
// native modules degrade to no-ops instead; telemetry resumes once users get a
// build that bundles them.
import { initAnalytics as initPlatformAnalytics, posthog, Sentry } from "@platform/analytics/native";
import { CODECAST_EVENTS, POSTHOG_REPLAY_SAMPLE_RATE } from "@codecast/shared/analytics";
import { MOBILE_EVENTS } from "./mobileEvents";
import { teamsHoldRegulatedData } from "@codecast/shared/contracts";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { watchRegulatedData } from "@codecast/web/lib/regulatedData";

// Regulated health data (HIPAA), as on web (packages/web/lib/analytics.ts): a
// person in a team whose policy sets regulated_data sends PostHog and Sentry
// nothing. The teams list is persisted, so a returning launch knows before
// init; one that learns it later shuts both down on the spot.
export function initAnalytics() {
  const regulated = teamsHoldRegulatedData(useInboxStore.getState().teams as any) === true;
  initPlatformAnalytics({
    optedOut: regulated || undefined,
    // Same catalog and same per-session cap as web and Convex (ct-49565), so a
    // funnel that spans surfaces cannot disagree with itself about property
    // names. Mobile sends screens today; a named event added here is checked.
    // The shared catalog plus the events only the phone sends.
    catalog: { ...CODECAST_EVENTS, ...MOBILE_EVENTS },
    posthogKey: process.env.EXPO_PUBLIC_POSTHOG_KEY,
    posthogHost: process.env.EXPO_PUBLIC_POSTHOG_HOST,
    sentryDsn: regulated ? undefined : process.env.EXPO_PUBLIC_SENTRY_DSN,
    environment: __DEV__ ? "development" : "production",
    platform: "mobile",
    appName: "codecast",
    // Replay walks the view tree on the JS thread (and masks every text
    // input); for everyone it froze taps for seconds, so only a sample records.
    sessionReplaySampleRate: POSTHOG_REPLAY_SAMPLE_RATE,
  });
  watchRegulatedData((on) => {
    if (!on) return;
    try { void posthog?.optOut(); } catch {}
    try { void (Sentry as any)?.close?.(); } catch {}
  });
}

// posthog is a live binding: the package assigns it inside initAnalytics, and
// `export ... from` keeps re-exported bindings live, so a consumer reading it
// after init sees the client rather than null.
export {
  captureError,
  identifyUser,
  posthog,
  resetUser,
  Sentry,
  track,
  trackScreen,
  wrapRoot,
} from "@platform/analytics/native";
