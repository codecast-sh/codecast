// Browser analytics: PostHog (posthog-js) plus Sentry (@sentry/react).
// Lifted from codecast packages/web/lib/analytics.ts. Behavior is unchanged;
// the project key, host, DSN, environment and platform come from the config
// passed to initAnalytics instead of import.meta.env.

import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import {
  createPreInitBuffer,
  resolveConfig,
  superProperties,
  type AnalyticsConfig,
  type ResolvedAnalyticsConfig,
} from "./index";
import {
  _resetErrorDeduperForTests,
  claimErrorKey,
  setupErrorToasts as setupBaseErrorToasts,
  type ErrorToastOptions as BaseErrorToastOptions,
} from "./errors";

let config: ResolvedAnalyticsConfig | null = null;
let initialized = false;

// Apps call identify and track from wherever the data arrives, which is not
// always after boot has initialized analytics. Those calls are held here and
// replayed in order once init runs, so a user id raised by a slow query still
// reaches Sentry and PostHog.
const preInit = createPreInitBuffer();

export function initAnalytics(input: AnalyticsConfig) {
  if (initialized) return;
  initialized = true;
  config = resolveConfig(input);

  const isDev = config.environment === "development";

  if (config.sentryDsn) {
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.environment,
      enabled: !isDev,
      tracesSampleRate: isDev ? 1.0 : 0.2,
      // No replayIntegration: even with replaysSessionSampleRate 0, the
      // on-error mode keeps an rrweb recorder buffering every DOM mutation so
      // the last seconds exist when an error fires. Apps that mutate the DOM
      // continuously (heartbeats, streaming text) pay for it in keystroke CPU.
      // Error stacks and breadcrumbs remain; only the replay goes.
      integrations: [
        Sentry.browserTracingIntegration(),
      ],
      initialScope: {
        tags: { platform: config.platform, ...(config.appName ? { app: config.appName } : {}) },
      },
    });
  }

  if (config.posthogKey) {
    posthog.init(config.posthogKey, {
      api_host: config.posthogHost,
      autocapture: true,
      // "history_change" also fires $pageview on SPA navigations (pushState,
      // popstate). Plain `true` only captures the initial load.
      capture_pageview: "history_change",
      capture_pageleave: true,
      persistence: "localStorage",
      // Session recording is off everywhere, not just dev: rrweb serializes
      // every DOM mutation, which costs typing latency in busy UIs. Dead click
      // detection rides the same instrumentation. Product events (pageviews,
      // captures, autocapture clicks) all stay.
      disable_session_recording: true,
      capture_dead_clicks: false,
    });
    // Dev and prod share one PostHog project; the environment super property
    // is what keeps local dev traffic filterable out of product metrics.
    posthog.register(superProperties(config));
  }

  // Last: both SDKs are up and the super properties are registered, so a held
  // call lands exactly as it would have if the app had called it here.
  preInit.flush();
}

/** distinct_id convention: pass the app's own user id (codecast: Convex users._id). */
export function identifyUser(userId: string, traits?: Record<string, unknown>) {
  if (!initialized) {
    preInit.add(() => identifyUser(userId, traits));
    return;
  }
  if (config?.sentryDsn) {
    Sentry.setUser({ id: userId, ...traits });
  }
  if (config?.posthogKey) {
    posthog.identify(userId, traits);
  }
}

export function resetUser() {
  // Held too, and in the same queue: a sign out before init must not be
  // reordered behind the identify it cancels.
  if (!initialized) {
    preInit.add(() => resetUser());
    return;
  }
  if (config?.sentryDsn) {
    Sentry.setUser(null);
  }
  if (config?.posthogKey) {
    posthog.reset();
  }
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (!initialized) {
    preInit.add(() => track(event, properties));
    return;
  }
  if (config?.posthogKey) {
    posthog.capture(event, properties);
  }
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  if (config?.sentryDsn) {
    Sentry.captureException(error, { extra: context });
  }
}

export type ErrorToastOptions = Omit<BaseErrorToastOptions, "captureError">;

export function setupErrorToasts(options: ErrorToastOptions) {
  setupBaseErrorToasts({ ...options, captureError });
}

/** Test hook: forget config so initAnalytics can run again. */
export function _resetForTests() {
  config = null;
  initialized = false;
  preInit.clear();
  _resetErrorDeduperForTests();
}

export { claimErrorKey, Sentry, posthog };
