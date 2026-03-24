import * as Sentry from "@sentry/react";
import posthog from "posthog-js";

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
const IS_DEV = import.meta.env.DEV;

function getPlatform(): "desktop" | "web" {
  return typeof window !== "undefined" && !!(window as any).__CODECAST_ELECTRON__
    ? "desktop"
    : "web";
}

let initialized = false;

export function initAnalytics() {
  if (initialized) return;
  initialized = true;

  const platform = getPlatform();

  if (SENTRY_DSN) {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: IS_DEV ? "development" : "production",
      enabled: !IS_DEV,
      tracesSampleRate: IS_DEV ? 1.0 : 0.2,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1.0,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration(),
      ],
      initialScope: {
        tags: { platform },
      },
    });
  }

  if (POSTHOG_KEY) {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      autocapture: true,
      capture_pageview: true,
      capture_pageleave: true,
      persistence: "localStorage",
      disable_session_recording: IS_DEV,
    });
    posthog.register({ platform });
  }
}

export function identifyUser(userId: string, traits?: Record<string, unknown>) {
  if (SENTRY_DSN) {
    Sentry.setUser({ id: userId, ...traits });
  }
  if (POSTHOG_KEY) {
    posthog.identify(userId, traits);
  }
}

export function resetUser() {
  if (SENTRY_DSN) {
    Sentry.setUser(null);
  }
  if (POSTHOG_KEY) {
    posthog.reset();
  }
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (POSTHOG_KEY) {
    posthog.capture(event, properties);
  }
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  if (SENTRY_DSN) {
    Sentry.captureException(error, { extra: context });
  }
}

export { Sentry, posthog };
