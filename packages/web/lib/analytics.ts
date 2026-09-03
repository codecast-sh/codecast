// Codecast's analytics surface. The PostHog and Sentry wiring itself was
// extracted into @platform/analytics/web, so what lives here is codecast's own
// configuration (its Vite env values, its platform label) plus the error
// reporting layered on top of it: cause chain reading (./errorCause) and the
// one error toast (./errorToast). Every consumer keeps importing from here.
import { describeError, errorChain, errorSummary, rootError } from "./errorCause";
import { showErrorToast } from "./errorToast";

type AnalyticsRuntime = typeof import("@platform/analytics/web");

let runtime: AnalyticsRuntime | undefined;
let initPromise: Promise<void> | undefined;
const queuedCalls: Array<(analytics: AnalyticsRuntime) => void> = [];
const seenGlobalErrors = new Set<string>();

function withAnalytics(call: (analytics: AnalyticsRuntime) => void) {
  if (runtime) call(runtime);
  else queuedCalls.push(call);
}

function claimErrorKey(key: string): boolean {
  if (seenGlobalErrors.has(key)) return false;
  seenGlobalErrors.add(key);
  setTimeout(() => seenGlobalErrors.delete(key), 30_000);
  return true;
}

// Indirect access so this file also TYPECHECKS inside the mobile program (its
// tsconfig has no vite/client ImportMeta.env). The cast erases at compile time,
// leaving a bare `import.meta.env` access, which Vite replaces with its env
// object in builds (destructuring/indirect access is supported since Vite 5);
// mobile never RUNS this file (analytics.native.ts is the Metro-resolved twin —
// Hermes cannot even parse `import.meta`).
const META_ENV = (import.meta as any).env ?? {};

export type AnalyticsPlatform = "desktop" | "web" | "mobile";

// The platform every event is stamped with. Exported so other telemetry
// (the inbox digest compare) stamps the same value; the native twin answers
// "mobile".
export function getPlatform(): AnalyticsPlatform {
  return typeof window !== "undefined" && !!(window as any).__CODECAST_ELECTRON__
    ? "desktop"
    : "web";
}

// Codecast's configuration. The package holds the behavior these values drive:
// Sentry off in development, traces at 1.0 there and 0.2 in production, no
// session recording or dead click capture (they cost typing latency), SPA
// pageviews on history changes, and platform/environment/app on every event as
// super properties. Dev and prod share one PostHog project, so the environment
// property is what keeps local traffic out of product metrics.
export function initAnalytics(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = import("@platform/analytics/web").then((analytics) => {
    analytics.initAnalytics({
      posthogKey: META_ENV.VITE_POSTHOG_KEY,
      posthogHost: META_ENV.VITE_POSTHOG_HOST,
      sentryDsn: META_ENV.VITE_SENTRY_DSN,
      environment: META_ENV.DEV ? "development" : "production",
      platform: getPlatform(),
      appName: "codecast",
    });
    runtime = analytics;
    for (const call of queuedCalls.splice(0)) call(analytics);
  });
  return initPromise;
}

export function identifyUser(userId: string, traits?: Record<string, unknown>) {
  withAnalytics((analytics) => analytics.identifyUser(userId, traits));
}

export function resetUser() {
  withAnalytics((analytics) => analytics.resetUser());
}

export function track(event: string, properties?: Record<string, unknown>) {
  withAnalytics((analytics) => analytics.track(event, properties));
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  withAnalytics((analytics) => analytics.captureError(error, context));
}

// Known-benign errors thrown from third-party internals that don't affect the
// app — surfacing them as "Uncaught" toasts (and Sentry events) is pure noise.
//
//  • react-resizable-panels throws "Could not find data for Group with id …"
//    from its document-level pointerup/pointermove listeners when a divider
//    drag's module-global state outlives the PanelGroup that owns it (the group
//    unmounts/remounts while a sibling group keeps the shared, ref-counted
//    listeners alive — the shell's sidebar/rail Groups and the diff layouts
//    all live in the persistent tab shell). The throw aborts only that one
//    listener call; the divider and panels keep working. The lookup uses
//    throwOnMissing=true internally, so we can't fix it short of forking the
//    library (4.11.2 still has it) — we just decline to report it.
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

// A render that threw and that React then re-ran successfully. Nothing is
// visibly broken — React recovered — but a component did throw, so it is a real
// bug and stays reportable. Wired into createRoot in src/boot.tsx: React's own
// default rethrows its code-only wrapper at window.onerror, which is how this
// arrived as an unreadable "Uncaught: Minified React error #520" with the
// failure that actually happened stripped off.
//
// claimErrorKey is the package's dedupe, shared with the window listeners
// below, so one failure arriving on both paths still reports once per 30s.
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

// The window "error" and "unhandledrejection" listeners are the package's; the
// three readers below are what make them name the real failure instead of the
// wrapper React or app code threw it inside of.
export function setupErrorToasts() {
  window.addEventListener("error", (event) => {
    const key = event.error ? errorSummary(event.error) : event.message;
    if (isIgnoredError(key)) {
      event.preventDefault();
      return;
    }
    if (!event.error || !claimErrorKey(key)) return;
    captureError(rootError(event.error), { source: "window.onerror" });
    showErrorToast(`Uncaught: ${key}`, describeError(event.error));
  });

  window.addEventListener("unhandledrejection", (event) => {
    const key = errorSummary(event.reason);
    if (isIgnoredError(key)) {
      event.preventDefault();
      return;
    }
    if (!claimErrorKey(key)) return;
    captureError(rootError(event.reason), { source: "unhandledrejection" });
    showErrorToast(`Unhandled rejection: ${key}`, describeError(event.reason));
  });
}
