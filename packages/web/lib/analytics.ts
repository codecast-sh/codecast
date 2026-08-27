import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { describeError, errorChain, errorSummary, rootError } from "./errorCause";
import { showErrorToast } from "./errorToast";

// Indirect access so this file also TYPECHECKS inside the mobile program (its
// tsconfig has no vite/client ImportMeta.env). The cast erases at compile time,
// leaving a bare `import.meta.env` access, which Vite replaces with its env
// object in builds (destructuring/indirect access is supported since Vite 5);
// mobile never RUNS this file (analytics.native.ts is the Metro-resolved twin —
// Hermes cannot even parse `import.meta`).
const META_ENV = (import.meta as any).env ?? {};
const SENTRY_DSN = META_ENV.VITE_SENTRY_DSN;
const POSTHOG_KEY = META_ENV.VITE_POSTHOG_KEY;
const POSTHOG_HOST = META_ENV.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
const IS_DEV = META_ENV.DEV;

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
      // No replayIntegration: even with replaysSessionSampleRate 0, the
      // on-error mode keeps an rrweb recorder buffering EVERY DOM mutation so
      // the last seconds exist when an error fires. This app mutates the DOM
      // continuously (heartbeats, streaming transcripts), and the recorder
      // showed up directly in keystroke CPU profiles. Error stacks + breadcrumbs
      // remain; only the video-replay-on-error goes.
      integrations: [
        Sentry.browserTracingIntegration(),
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
      // "history_change" also fires $pageview on SPA navigations (pushState/
      // popstate) — plain `true` only captures the initial load, which misses
      // nearly all movement in a single-page app.
      capture_pageview: "history_change",
      capture_pageleave: true,
      persistence: "localStorage",
      // Session recording is disabled everywhere, not just dev: rrweb
      // serializes every DOM mutation, and this UI mutates several times a
      // second at idle (liveness dots, streaming messages). The recorder was a
      // top self-time frame in keystroke CPU profiles — measurable typing lag
      // for every user, on all the time. Dead-click detection rides the same
      // per-interaction instrumentation. Product EVENTS (pageviews, captures,
      // autocapture clicks) all stay.
      disable_session_recording: true,
      capture_dead_clicks: false,
    });
    // Dev and prod share one PostHog project; the environment super property
    // is what keeps local-dev traffic filterable out of product metrics.
    posthog.register({ platform, environment: IS_DEV ? "development" : "production" });
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

// One report per distinct error per 30s, shared by every reporting path, so a
// tearing race that re-throws on every heartbeat doesn't stack toasts.
function claimErrorKey(key: string): boolean {
  if (_seenGlobalErrors.has(key)) return false;
  _seenGlobalErrors.add(key);
  setTimeout(() => _seenGlobalErrors.delete(key), 30_000);
  return true;
}

// A render that threw and that React then re-ran successfully. Nothing is
// visibly broken — React recovered — but a component did throw, so it is a real
// bug and stays reportable. Wired into createRoot in src/boot.tsx: React's own
// default rethrows its code-only wrapper at window.onerror, which is how this
// arrived as an unreadable "Uncaught: Minified React error #520" with the
// failure that actually happened stripped off.
export function reportRecoverableRenderError(
  error: unknown,
  info?: { componentStack?: string | null }
) {
  const key = errorSummary(error);
  if (isIgnoredError(key)) return;
  if (!claimErrorKey(key)) return;

  const componentStack = info?.componentStack ?? "";
  const trace = `${describeError(error)}\n\nComponent:${componentStack}`;
  console.error("[react:recoverable]", key, error, componentStack);
  captureError(rootError(error), {
    source: "react.onRecoverableError",
    // The wrapper's message names WHICH recovery React performed (concurrent
    // re-render vs hydration fallback) — context the cause alone doesn't carry.
    reactRecovery: errorChain(error)[0]?.message,
    componentStack,
  });
  showErrorToast(`Recovered render error: ${key}`, trace);
}

export function setupErrorToasts() {
  window.addEventListener("error", (e) => {
    const key = e.error ? errorSummary(e.error) : e.message;
    if (isIgnoredError(key)) {
      // Suppress the browser's default "Uncaught" console logging too.
      e.preventDefault();
      return;
    }
    if (!e.error) return;
    if (!claimErrorKey(key)) return;

    captureError(rootError(e.error), { source: "window.onerror" });
    showErrorToast(`Uncaught: ${key}`, describeError(e.error));
  });

  window.addEventListener("unhandledrejection", (e) => {
    const key = errorSummary(e.reason);
    if (isIgnoredError(key)) {
      e.preventDefault();
      return;
    }
    if (!claimErrorKey(key)) return;

    captureError(rootError(e.reason), { source: "unhandledrejection" });
    showErrorToast(`Unhandled rejection: ${key}`, describeError(e.reason));
  });
}

export { Sentry, posthog };
