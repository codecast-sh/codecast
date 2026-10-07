// Codecast's analytics surface. The PostHog and Sentry wiring itself was
// extracted into @platform/analytics/web, so what lives here is codecast's own
// configuration (its Vite env values, its platform label) plus the error
// reporting layered on top of it: cause chain reading (./errorCause) and the
// one error toast (./errorToast). Every consumer keeps importing from here.
import { describeError, errorChain, errorSummary, rootError } from "./errorCause";
import { showErrorToast } from "./errorToast";
import {
  claimErrorKey,
  setupErrorToasts as setupPlatformErrorToasts,
} from "@platform/analytics/errors";
import { CODECAST_EVENTS, type CodecastEventName, type CodecastEventProps } from "@codecast/shared/analytics";
import { CHUNK_LOAD_ERROR_PATTERNS } from "./chunkReloadGuard";
import { DOC_REWRITTEN_ERROR } from "@codecast/shared/docs";
import codecastJson from "../codecast.json";
import { parseCodecastConfig } from "@codecast/shared/contracts/codecastConfig";

type AnalyticsRuntime = typeof import("@platform/analytics/web-runtime");

let runtime: AnalyticsRuntime | undefined;
let initPromise: Promise<void> | undefined;
const queuedCalls: Array<(analytics: AnalyticsRuntime) => void> = [];

function withAnalytics(call: (analytics: AnalyticsRuntime) => void) {
  if (runtime) call(runtime);
  else queuedCalls.push(call);
}

// Indirect access so this file also TYPECHECKS inside the mobile program (its
// tsconfig has no vite/client ImportMeta.env). The cast erases at compile time,
// leaving a bare `import.meta.env` access, which Vite replaces with its env
// object in builds (destructuring/indirect access is supported since Vite 5);
// mobile never RUNS this file (analytics.native.ts is the Metro-resolved twin —
// Hermes cannot even parse `import.meta`).
const META_ENV = (import.meta as any).env ?? {};

export type AnalyticsPlatform = "desktop" | "web" | "mobile";

// Codecast's addresses that ARE credentials: a share link (/share/<token> and
// /share/<kind>/<token>), a guest's meeting link (/meet/<token>), a team
// invite (/join/<code>) and an unlisted published page (/a/<slug>). Whoever
// holds one can open the shared call, knock on the meeting or join the team,
// so none may reach PostHog, Sentry or the error sink as written. A full load
// of a share or guest page boots standalone with no analytics at all
// (src/shareBoot.tsx); these arrive from inside the app: a member following
// their own link, the referrer of the page after it, a navigation crumb.
//
// Matched only as the first segment of a path (after the host, at the start,
// or after a quote in an autocaptured element chain), so a repository file
// under a folder named "a" keeps its name. `share/[a-z]+` before bare `share`
// is the same shape isStandaloneSharePath reads, so a kind added later is
// covered without a list to keep in step; a conversation token that starts
// with letters backtracks to the bare form.
const SECRET_PATH = /(^|[\s"'=(]|\/\/[^/\s"'?#]+)\/(share\/[a-z]+|share|meet|join|a)\/[^/?#\s"']+/g;

/** Rewrite every secret path in a string to its shape: "/meet/k3y" to "/meet/:token". */
export function scrubSecretPaths(text: string): string {
  return text.replace(SECRET_PATH, "$1/$2/:token");
}

// The platform every event is stamped with. Exported so other telemetry
// (the inbox digest compare) stamps the same value; the native twin answers
// "mobile".
export function getPlatform(): AnalyticsPlatform {
  return typeof window !== "undefined" && !!(window as any).__CODECAST_ELECTRON__
    ? "desktop"
    : "web";
}

// Codecast's configuration. The package holds the behavior these values drive:
// Sentry error reporting off in development, no browser tracing, session
// recording or dead click capture, SPA pageviews on history changes, and
// platform/environment/app on every event as super properties. Dev and prod
// share one PostHog project, so the environment property keeps local traffic
// out of product metrics.
export function initAnalytics(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = import("@platform/analytics/web-runtime").then((analytics) => {
    analytics.initAnalytics({
      posthogKey: META_ENV.VITE_POSTHOG_KEY,
      posthogHost: META_ENV.VITE_POSTHOG_HOST,
      sentryDsn: META_ENV.VITE_SENTRY_DSN,
      environment: META_ENV.DEV ? "development" : "production",
      platform: getPlatform(),
      appName: "codecast",
      // The catalog is enforced at the track boundary inside the package: an
      // event it does not describe is dropped, and a session stops sending
      // after 1000 events. A browser that sets Do Not Track loads no PostHog
      // at all. See packages/shared/analytics/events.ts (ct-49565).
      catalog: CODECAST_EVENTS,
      // The same known-benign list the window listeners below use, applied at
      // the Sentry boundary so it also covers an ErrorBoundary's captureError.
      // The package contributes the environment-level noise (stale-deploy
      // chunk preloads, a full user disk, an IndexedDB connection closing
      // mid-transaction) on top of these.
      extraIgnoreErrors: IGNORED_ERROR_PATTERNS,
      // Codecast reports its own errors to codecast (docs/architecture/
      // external-data.md X2), alongside Sentry, through the same listeners and
      // dedupe. The key is the committed packages/web/codecast.json's (which
      // `cast sources add` writes; it is write-only, so safe in the bundle),
      // and VITE_CODECAST_INGEST_KEY overrides it. Off with neither, and in
      // development like Sentry. The release is the build sha boot.tsx
      // publishes on window, so an error group knows which deploy it came from.
      codecastIngestKey: META_ENV.VITE_CODECAST_INGEST_KEY || undefined,
      codecastConfig: codecastJson,
      release: (globalThis as { __CODECAST_BUILD?: { sha?: string } }).__CODECAST_BUILD?.sha,
      // Codecast's links that are keys, named by their shape wherever a URL
      // leaves the page (pageviews, referrers, error reports, replays).
      scrubUrl: scrubSecretPaths,
    });
    runtime = analytics;
    startReplayOnError(analytics);
    for (const call of queuedCalls.splice(0)) call(analytics);
  });
  return initPromise;
}

// The replay recorder rides the codecast sink: with no sink (no key, or
// development) it never loads. Its own chunk, loaded after init, so the boot
// path pays nothing for it. codecast.json's `replay` block sets it: by
// default sample 0 (a recording uploads only when an error is reported,
// carrying the minute before it) and DOM capture off. The DOM capture (rrweb,
// its own chunk again) costs main-thread time on every DOM change, about
// 2.5 ms per burst of churn and a ~55 ms snapshot every 30 s on the inbox
// (docs/architecture/external-data.md X5), which is why it stays off here
// unless the file turns it on.
function startReplayOnError(analytics: AnalyticsRuntime) {
  const sink = analytics.getCodecastSink();
  if (!sink || typeof window === "undefined") return;
  const parsed = parseCodecastConfig(codecastJson);
  const replay = parsed.ok ? parsed.config.replay : undefined;
  void import("@platform/analytics/replay")
    .then(({ startReplay }) => startReplay({ sink, sampleRate: replay?.sampleRate ?? 0, replayDom: replay?.dom ?? "off" }))
    .catch(() => {});
}

export function identifyUser(userId: string, traits?: Record<string, unknown>) {
  withAnalytics((analytics) => analytics.identifyUser(userId, traits));
}

export function resetUser() {
  withAnalytics((analytics) => analytics.resetUser());
}

// Only an event the catalog names, with the properties it declares. The runtime
// check inside the package is the backstop; this signature is what stops a typo
// or a renamed property from reaching a build at all.
export function track<N extends CodecastEventName>(event: N, properties: CodecastEventProps<N>) {
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
/** The regex that matches one string as written, for a list that mixes both. */
const literalPattern = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

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
  // A stale tab after a deploy, in every wording the browsers use (the list
  // the reload guard reloads on). The tab reloads itself onto the current
  // build, so the report has no reader; the platform list carries only the
  // CSS wording, and Safari's "Importing a module script failed" kept opening
  // issues for the same condition.
  ...CHUNK_LOAD_ERROR_PATTERNS.map(literalPattern),
  // A doc editor behind a CLI rewrite: the server refuses its steps and the
  // editor's gap detector remounts it from the new snapshot (docSync.stepsAfter).
  literalPattern(DOC_REWRITTEN_ERROR),
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
  setupPlatformErrorToasts({
    showErrorToast,
    captureError,
    ignoredErrorPatterns: IGNORED_ERROR_PATTERNS,
    summarize: errorSummary,
    describe: describeError,
    toError: rootError,
  });
}
