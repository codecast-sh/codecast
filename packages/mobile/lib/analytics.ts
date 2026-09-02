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
import { initAnalytics as initPlatformAnalytics } from "@platform/analytics/native";

export function initAnalytics() {
  initPlatformAnalytics({
    posthogKey: process.env.EXPO_PUBLIC_POSTHOG_KEY,
    posthogHost: process.env.EXPO_PUBLIC_POSTHOG_HOST,
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    environment: __DEV__ ? "development" : "production",
    platform: "mobile",
    appName: "codecast",
    // Needs the posthog-react-native-session-replay NATIVE module, so it only
    // takes effect on binaries built with it (2026-08+). The SDK guards its own
    // require, so an OTA landing on an older binary degrades to no replay
    // instead of the crash-and-rollback this header warns about.
    enableSessionReplay: true,
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
