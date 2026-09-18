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

/**
 * Errors Sentry must never open an issue for, because no engineer can act on
 * one. Each entry is a browser or deploy condition, not a defect in app code,
 * and each is matched narrowly by the words that identify that condition — the
 * list never drops a whole error class (every TypeError) or a whole origin.
 *
 * Sentry reads this as `ignoreErrors`, which matches an event's message and its
 * exception `Type: value`, so the filter applies to every capture path: the
 * window "error" and "unhandledrejection" listeners, a React error boundary
 * calling captureError, and a direct captureError from app code.
 */
export const UNACTIONABLE_ERROR_PATTERNS: RegExp[] = [
  // A tab holding a stale index.html after a deploy asks for a chunk hash the
  // CDN no longer has, and Vite's preload helper throws. Nothing is broken in
  // the build being served; the tab is simply behind it. The app recovers by
  // reloading itself onto the current build, so the report has no reader.
  /Unable to preload CSS for/,
  // The END USER's disk is full, so the browser cannot open IndexedDB at all.
  // Every app that stores anything locally hits this on a full disk; no code
  // change makes room on their drive.
  /Encountered full disk/,
  // An IndexedDB transaction still in flight while the page (and with it the
  // connection) closes — a navigation or an unload during a write. The work is
  // abandoned by design at that point, and the next load reopens the database.
  /Connection is closing/,
];

/**
 * React DOM crashes that a page translator causes, and that ONLY a translator
 * causes. Google Translate and its peers wrap text nodes in `<font>` elements,
 * which moves React's own children into a parent React never rendered. React
 * then inserts a sibling next to a node that is no longer where its fiber says
 * it is, and the DOM call throws.
 *
 * These two messages are deliberately NOT in the ignoreErrors list above. The
 * same message from an UNTRANSLATED page is a real reconciler bug — our own
 * imperative DOM write, a portal container pulled out from under a commit —
 * and we want that reported. So the drop is conditional on the page actually
 * being translated at the moment the error fires, which `isPageTranslated`
 * reads from the live DOM.
 */
const TRANSLATED_DOM_ERROR_PATTERNS = [
  "Failed to execute 'insertBefore' on 'Node'",
  "Failed to execute 'removeChild' on 'Node'",
];

/** Whether a page translator has rewritten this document right now. */
export function isPageTranslated(): boolean {
  try {
    if (typeof document === "undefined") return false;
    // Google Translate stamps the class on <html> while a translation is live.
    const cls = document.documentElement?.classList;
    if (cls?.contains("translated-ltr") || cls?.contains("translated-rtl")) return true;
    // Microsoft Translator leaves no root marker, only its own font wrappers.
    return !!document.querySelector("font[_msttexthash]");
  } catch {
    // A beforeSend that throws loses the event entirely, so any failure here
    // means "not translated" and the report goes through.
    return false;
  }
}

/**
 * The beforeSend rule, split out so it is testable without a Sentry client.
 * Returns true when the event is translator damage and must not be reported.
 */
export function isTranslatedDomError(message: string, translated = isPageTranslated()): boolean {
  if (!message) return false;
  if (!TRANSLATED_DOM_ERROR_PATTERNS.some((p) => message.includes(p))) return false;
  return translated;
}

/** Every message Sentry carries for one event: the top message and each exception value. */
function eventMessages(event: {
  message?: string;
  exception?: { values?: Array<{ value?: string; type?: string }> };
}): string[] {
  const out: string[] = [];
  if (event.message) out.push(event.message);
  for (const v of event.exception?.values ?? []) {
    if (v?.value) out.push(v.value);
    if (v?.type && v?.value) out.push(`${v.type}: ${v.value}`);
  }
  return out;
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
      // Without this every captured error becomes an issue, including the
      // environment conditions above that nobody can fix. An app adds its own
      // known-benign messages through config.extraIgnoreErrors.
      ignoreErrors: [...UNACTIONABLE_ERROR_PATTERNS, ...(config.extraIgnoreErrors ?? [])],
      // Conditional drops, which ignoreErrors cannot express: it matches on the
      // message alone, and these depend on the state of the page.
      beforeSend: (event) => {
        try {
          const translated = isPageTranslated();
          if (eventMessages(event).some((m) => isTranslatedDomError(m, translated))) return null;
        } catch {
          // Never lose an event to a bug in the filter.
        }
        return event;
      },
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
