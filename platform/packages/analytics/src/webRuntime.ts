import {
  captureException as captureSentryException,
  init as initSentry,
  setUser as setSentryUser,
} from "@sentry/react";
import posthog from "posthog-js/dist/module.slim.js";
import { AnalyticsExtensions } from "posthog-js/dist/extension-bundles.js";
import {
  createPreInitBuffer,
  resolveConfig,
  superProperties,
  type AnalyticsConfig,
  type ResolvedAnalyticsConfig,
} from "./index";
import { createTrackGate, resolveOptOut, type TrackGate } from "./catalog";

let config: ResolvedAnalyticsConfig | null = null;
let initialized = false;
let optedOut = false;
let gate: TrackGate | null = null;
const preInit = createPreInitBuffer();

/**
 * The browser's Do Not Track signal. A browser has no env, so this is the whole
 * opt-out surface here; the env vars (CI and friends) belong to the node
 * surfaces. `navigator.webdriver` is deliberately NOT read: automation is how
 * the team verifies that capture works at all, and a headless run already
 * stamps environment=development.
 */
function browserDoNotTrack(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { msDoNotTrack?: string };
  const win = typeof window !== "undefined" ? (window as Window & { doNotTrack?: string }) : undefined;
  return nav.doNotTrack === "1" || nav.msDoNotTrack === "1" || win?.doNotTrack === "1";
}

export function initAnalytics(input: AnalyticsConfig) {
  if (initialized) return;
  initialized = true;
  config = resolveConfig(input);
  optedOut = input.optedOut || resolveOptOut({ doNotTrack: browserDoNotTrack() }).optedOut;
  gate = createTrackGate({
    catalog: config.catalog,
    sessionCap: config.sessionEventCap,
    optedOut,
  });

  const isDev = config.environment === "development";

  if (config.sentryDsn) {
    initSentry({
      dsn: config.sentryDsn,
      environment: config.environment,
      enabled: !isDev,
      initialScope: {
        tags: { platform: config.platform, ...(config.appName ? { app: config.appName } : {}) },
      },
    });
  }

  // An opted-out browser never loads PostHog at all: no init, no persistence
  // written, no autocapture listeners. Sentry stays up — a crash report is not
  // the behavioural tracking DO_NOT_TRACK asks us to stop.
  if (config.posthogKey && !optedOut) {
    posthog.init(config.posthogKey, {
      api_host: config.posthogHost,
      autocapture: true,
      capture_pageview: "history_change",
      capture_pageleave: true,
      persistence: "localStorage",
      __extensionClasses: AnalyticsExtensions,
      disable_session_recording: true,
      capture_dead_clicks: false,
    });
    posthog.register(superProperties(config));
  }

  preInit.flush();
}

export function identifyUser(userId: string, traits?: Record<string, unknown>) {
  if (!initialized) {
    preInit.add(() => identifyUser(userId, traits));
    return;
  }
  if (config?.sentryDsn) setSentryUser({ id: userId, ...traits });
  if (config?.posthogKey && !optedOut) posthog.identify(userId, traits);
}

export function resetUser() {
  if (!initialized) {
    preInit.add(() => resetUser());
    return;
  }
  if (config?.sentryDsn) setSentryUser(null);
  if (config?.posthogKey && !optedOut) posthog.reset();
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (!initialized) {
    preInit.add(() => track(event, properties));
    return;
  }
  // The gate is the whole boundary: opt out, then the per-session cap, then the
  // catalog. A held call replays through it too, so nothing skips the check by
  // arriving early.
  const allowed = gate?.check(event, properties);
  if (!allowed?.ok) return;
  if (config?.posthogKey) posthog.capture(event, allowed.properties);
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  if (config?.sentryDsn) captureSentryException(error, { extra: context });
}

export function _resetRuntimeForTests() {
  config = null;
  initialized = false;
  optedOut = false;
  gate = null;
  preInit.clear();
}

export { posthog };
