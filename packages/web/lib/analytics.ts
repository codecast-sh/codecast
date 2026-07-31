import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { showErrorToast } from "./errorToast";

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

const _seenGlobalErrors = new Set<string>();

// Known-benign errors thrown from third-party internals that don't affect the
// app — surfacing them as "Uncaught" toasts (and Sentry events) is pure noise.
//
//  • react-resizable-panels throws "Could not find data for Group with id …"
//    from its document-level pointerup/pointermove listeners when a divider
//    drag's module-global state outlives the PanelGroup that owns it (the group
//    unmounts/remounts while a sibling group keeps the shared, ref-counted
//    listeners alive — both the tasks and docs DetailSplitLayouts live in the
//    persistent tab shell). The throw aborts only that one listener call; the
//    divider and panels keep working. The lookup uses throwOnMissing=true
//    internally, so we can't fix it short of forking the library (4.11.2 still
//    has it) — we just decline to report it. See components/DetailSplitLayout.
const IGNORED_ERROR_PATTERNS: RegExp[] = [
  /Could not find data for Group with id/,
  // StaleDispatchBindingError: a dispatch settling after its binding was
  // fenced (token refresh, principal switch). Expected lifecycle — the durable
  // outbox copy redelivers under the current binding — not a failure.
  /Dispatch binding changed while work was in flight/,
  // DispatchNotWiredError (parked): an asyncAction fired in the window where
  // no dispatch binding exists; the write is parked in the outbox and delivers
  // on the next drain. Same "redelivers, not a failure" rationale as above.
  // The dropped (no-outbox) variant is NOT ignored — that write really is gone.
  /Dispatch not wired — .* parked for later delivery/,
];

function isIgnoredError(message: string | undefined): boolean {
  return !!message && IGNORED_ERROR_PATTERNS.some((re) => re.test(message));
}

export function setupErrorToasts() {
  window.addEventListener("error", (e) => {
    const ignoreKey = e.error?.message || e.message;
    if (isIgnoredError(ignoreKey)) {
      // Suppress the browser's default "Uncaught" console logging too.
      e.preventDefault();
      return;
    }
    if (!e.error) return;
    const key = e.error?.message || e.message;
    if (_seenGlobalErrors.has(key)) return;
    _seenGlobalErrors.add(key);
    setTimeout(() => _seenGlobalErrors.delete(key), 30_000);

    const stack = e.error?.stack || "";
    captureError(e.error, { source: "window.onerror" });
    showErrorToast(`Uncaught: ${key}`, `${key}\n\n${stack}`);
  });

  window.addEventListener("unhandledrejection", (e) => {
    const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
    const key = err.message;
    if (isIgnoredError(key)) {
      e.preventDefault();
      return;
    }
    if (_seenGlobalErrors.has(key)) return;
    _seenGlobalErrors.add(key);
    setTimeout(() => _seenGlobalErrors.delete(key), 30_000);

    captureError(err, { source: "unhandledrejection" });
    showErrorToast(`Unhandled rejection: ${key}`, `${key}\n\n${err.stack || ""}`);
  });
}

export { Sentry, posthog };
