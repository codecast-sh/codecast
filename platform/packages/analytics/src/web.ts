// Browser analytics: PostHog (posthog-js) plus Sentry (@sentry/react).
// Lifted from codecast packages/web/lib/analytics.ts. Behavior is unchanged;
// the project key, host, DSN, environment and platform come from the config
// passed to initAnalytics instead of import.meta.env.

import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { resolveConfig, superProperties, type AnalyticsConfig, type ResolvedAnalyticsConfig } from "./index";

let config: ResolvedAnalyticsConfig | null = null;
let initialized = false;

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
}

/** distinct_id convention: pass the app's own user id (codecast: Convex users._id). */
export function identifyUser(userId: string, traits?: Record<string, unknown>) {
  if (config?.sentryDsn) {
    Sentry.setUser({ id: userId, ...traits });
  }
  if (config?.posthogKey) {
    posthog.identify(userId, traits);
  }
}

export function resetUser() {
  if (config?.sentryDsn) {
    Sentry.setUser(null);
  }
  if (config?.posthogKey) {
    posthog.reset();
  }
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (config?.posthogKey) {
    posthog.capture(event, properties);
  }
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  if (config?.sentryDsn) {
    Sentry.captureException(error, { extra: context });
  }
}

const _seenGlobalErrors = new Set<string>();

/**
 * One report per distinct error per 30 seconds. Exported because an app also
 * reports from paths this module does not own — React's onRecoverableError, an
 * error boundary — and all of them must share the one window, or a failure
 * that arrives on two paths toasts twice.
 */
export function claimErrorKey(key: string): boolean {
  if (_seenGlobalErrors.has(key)) return false;
  _seenGlobalErrors.add(key);
  setTimeout(() => _seenGlobalErrors.delete(key), 30_000);
  return true;
}

const defaultToError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));
const defaultSummarize = (value: unknown): string => defaultToError(value).message;
const defaultDescribe = (value: unknown): string => {
  const err = defaultToError(value);
  return `${err.message}\n\n${err.stack || ""}`;
};

export interface ErrorToastOptions {
  /** Renders the toast. The app owns the toast library and recovery actions. */
  showErrorToast: (title: string, fullTrace: string) => void;
  /**
   * Known benign errors thrown from third party internals. Matching errors are
   * neither toasted nor reported, and the browser's default "Uncaught" console
   * logging is suppressed.
   */
  ignoredErrorPatterns?: RegExp[];
  /**
   * The one line summary used as the toast title, the ignore test and the
   * dedupe key. Defaults to the error's own message. An app whose errors carry
   * the real failure in `cause` (React hides a render throw there) passes a
   * reader that walks the chain, so every one of those three reads the failure
   * rather than the wrapper.
   */
  summarize?: (error: unknown) => string;
  /** The trace shown in the toast body. Defaults to message and stack. */
  describe?: (error: unknown) => string;
  /** The error handed to Sentry. Defaults to the value itself when it is an Error. */
  toError?: (error: unknown) => Error;
}

export function setupErrorToasts(options: ErrorToastOptions) {
  const {
    showErrorToast,
    ignoredErrorPatterns = [],
    summarize = defaultSummarize,
    describe = defaultDescribe,
    toError = defaultToError,
  } = options;
  const isIgnoredError = (message: string | undefined): boolean =>
    !!message && ignoredErrorPatterns.some((re) => re.test(message));

  window.addEventListener("error", (e) => {
    const key = e.error ? summarize(e.error) : e.message;
    if (isIgnoredError(key)) {
      e.preventDefault();
      return;
    }
    if (!e.error) return;
    if (!claimErrorKey(key)) return;

    captureError(toError(e.error), { source: "window.onerror" });
    showErrorToast(`Uncaught: ${key}`, describe(e.error));
  });

  window.addEventListener("unhandledrejection", (e) => {
    const key = summarize(e.reason);
    if (isIgnoredError(key)) {
      e.preventDefault();
      return;
    }
    if (!claimErrorKey(key)) return;

    captureError(toError(e.reason), { source: "unhandledrejection" });
    showErrorToast(`Unhandled rejection: ${key}`, describe(e.reason));
  });
}

/** Test hook: forget config so initAnalytics can run again. */
export function _resetForTests() {
  config = null;
  initialized = false;
  _seenGlobalErrors.clear();
}

export { Sentry, posthog };
