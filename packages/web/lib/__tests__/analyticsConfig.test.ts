import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// lib/analytics.ts is now codecast's configuration of @platform/analytics/web:
// the wiring moved to the package, the Vite env values and the "codecast" app
// name stayed here. This locks that mapping, and the error reading the package
// takes from us — the toast, the dedupe key and the Sentry event all name the
// failure in `cause`, not the wrapper it was thrown inside of.
//
// Under bun, import.meta.env IS process.env, so the module under test reads
// what is set here as long as it is set before the import below.
process.env.VITE_POSTHOG_KEY = "phc_test_key";
process.env.VITE_POSTHOG_HOST = "https://ph.test";
process.env.VITE_SENTRY_DSN = "https://dsn@sentry.test/1";
delete process.env.DEV;

type Calls = Record<string, unknown[][]>;
const phCalls: Calls = {};
const sentryCalls: Calls = {};
const record =
  (calls: Calls, name: string) =>
  (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
const last = (calls: Calls, name: string) => (calls[name] ?? []).at(-1);
const count = (calls: Calls, name: string) => (calls[name] ?? []).length;

mock.module("posthog-js", () => ({
  default: {
    init: record(phCalls, "init"),
    register: record(phCalls, "register"),
    identify: record(phCalls, "identify"),
    reset: record(phCalls, "reset"),
    capture: record(phCalls, "capture"),
  },
}));
mock.module("@sentry/react", () => ({
  init: record(sentryCalls, "init"),
  setUser: record(sentryCalls, "setUser"),
  captureException: record(sentryCalls, "captureException"),
  browserTracingIntegration: () => ({ name: "BrowserTracing" }),
}));

const toasts: Array<[string, string]> = [];
mock.module("../errorToast", () => ({
  showErrorToast: (title: string, trace: string) => toasts.push([title, trace]),
}));

const analytics = await import("../analytics");

describe("codecast's analytics configuration reaches the package", () => {
  test("loads the SDKs on init and passes the app configuration", async () => {
    expect(count(phCalls, "init")).toBe(0);
    expect(count(sentryCalls, "init")).toBe(0);
    await analytics.initAnalytics();

    const [key, options] = last(phCalls, "init") as [string, Record<string, unknown>];
    expect(key).toBe("phc_test_key");
    expect(options.api_host).toBe("https://ph.test");
    // Behavior the package owns, asserted here because codecast depends on it:
    // no session recording, no dead clicks, pageviews on SPA navigations.
    expect(options.disable_session_recording).toBe(true);
    expect(options.capture_dead_clicks).toBe(false);
    expect(options.capture_pageview).toBe("history_change");

    // Dev and prod share one PostHog project, so every event carries the
    // environment; "app" keeps codecast filterable from other platform apps.
    expect(last(phCalls, "register")).toEqual([
      { platform: "web", environment: "production", app: "codecast" },
    ]);

    const [sentryOptions] = last(sentryCalls, "init") as [Record<string, any>];
    expect(sentryOptions.dsn).toBe("https://dsn@sentry.test/1");
    expect(sentryOptions.environment).toBe("production");
    expect(sentryOptions.enabled).toBe(true);
    expect(sentryOptions.initialScope.tags).toEqual({ platform: "web", app: "codecast" });
  });

  test("identify uses the id the caller passes — the Convex users._id", async () => {
    await analytics.initAnalytics();
    analytics.identifyUser("users:abc123", { email: "a@b.c" });
    expect(last(phCalls, "identify")).toEqual(["users:abc123", { email: "a@b.c" }]);
    expect(last(sentryCalls, "setUser")).toEqual([{ id: "users:abc123", email: "a@b.c" }]);
  });
});

describe("error toasts read the cause chain", () => {
  let handlers: Record<string, (e: any) => void>;

  beforeEach(async () => {
    await analytics.initAnalytics();
    handlers = {};
    toasts.length = 0;
    for (const k of Object.keys(sentryCalls)) delete sentryCalls[k];
    (globalThis as any).window = {
      addEventListener: (type: string, fn: (e: any) => void) => {
        handlers[type] = fn;
      },
    };
    analytics.setupErrorToasts();
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  test("an uncaught wrapper is reported by the failure it hides", () => {
    const cause = new TypeError("cannot read properties of undefined (reading 'title')");
    const wrapper = new Error("Minified React error #520", { cause });
    handlers.error({ error: wrapper, message: wrapper.message, preventDefault: () => {} });

    expect(toasts.length).toBe(1);
    expect(toasts[0][0]).toBe(`Uncaught: ${cause.message}`);
    expect(toasts[0][1]).toContain("caused by: ");
    expect(last(sentryCalls, "captureException")).toEqual([
      cause,
      { extra: { source: "window.onerror" } },
    ]);
  });

  test("known-benign third party errors are neither toasted nor reported", () => {
    let prevented = 0;
    handlers.error({
      error: new Error("Could not find data for Group with id 7"),
      message: "Could not find data for Group with id 7",
      preventDefault: () => prevented++,
    });
    handlers.unhandledrejection({
      reason: new Error("Dispatch binding changed while work was in flight"),
      preventDefault: () => prevented++,
    });
    expect(prevented).toBe(2);
    expect(toasts.length).toBe(0);
    expect(count(sentryCalls, "captureException")).toBe(0);
  });

  test("one report per failure per 30s across both reporting paths", () => {
    // React's recovered-render path and the window listener share the package's
    // dedupe, so a failure arriving on both toasts once.
    const cause = new RangeError("out of range");
    analytics.reportRecoverableRenderError(new Error("Minified React error #418", { cause }), {
      componentStack: "\n at Flaky",
    });
    expect(toasts.length).toBe(1);
    expect(toasts[0][0]).toBe(`Recovered render error: ${cause.message}`);

    handlers.error({ error: cause, message: cause.message, preventDefault: () => {} });
    expect(toasts.length).toBe(1);
  });
});
