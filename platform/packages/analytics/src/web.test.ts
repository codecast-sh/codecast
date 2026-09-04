import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// web.ts imports posthog-js and @sentry/react at module scope, so both are
// mocked before the module under test is loaded.
type Calls = Record<string, unknown[][]>;
const phCalls: Calls = {};
const sentryCalls: Calls = {};
// One log across both backends, so a test can assert the order calls landed in
// and not just that each one landed.
const order: string[] = [];
const record =
  (calls: Calls, name: string) =>
  (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    order.push(`${calls === phCalls ? "posthog" : "sentry"}.${name}`);
  };
const last = (calls: Calls, name: string) => (calls[name] ?? []).at(-1);
const count = (calls: Calls, name: string) => (calls[name] ?? []).length;

mock.module("posthog-js/dist/module.slim.js", () => ({
  default: {
    init: record(phCalls, "init"),
    register: record(phCalls, "register"),
    identify: record(phCalls, "identify"),
    reset: record(phCalls, "reset"),
    capture: record(phCalls, "capture"),
  },
}));
const analyticsExtensions = {
  autocapture: class Autocapture {},
  historyAutocapture: class HistoryAutocapture {},
};
mock.module("posthog-js/dist/extension-bundles.js", () => ({ AnalyticsExtensions: analyticsExtensions }));

mock.module("@sentry/react", () => ({
  init: record(sentryCalls, "init"),
  setUser: record(sentryCalls, "setUser"),
  captureException: record(sentryCalls, "captureException"),
}));

const web = await import("./web");
const { PRE_INIT_BUFFER_LIMIT } = await import("./index");

const base = {
  posthogKey: "phc_x",
  sentryDsn: "https://dsn@example.ingest.sentry.io/1",
  environment: "production" as const,
  platform: "web",
  appName: "codecast",
};

beforeEach(() => {
  web._resetForTests();
  for (const c of [phCalls, sentryCalls]) for (const k of Object.keys(c)) delete c[k];
  order.length = 0;
});

describe("initAnalytics (web)", () => {
  it("initializes PostHog with the donor options and registers super properties", () => {
    web.initAnalytics(base);
    const [key, options] = last(phCalls, "init") as [string, Record<string, unknown>];
    expect(key).toBe("phc_x");
    expect(options.api_host).toBe("https://us.i.posthog.com");
    expect(options.autocapture).toBe(true);
    expect(options.capture_pageview).toBe("history_change");
    expect(options.capture_pageleave).toBe(true);
    expect(options.persistence).toBe("localStorage");
    expect(options.__extensionClasses).toBe(analyticsExtensions);
    expect(options.disable_session_recording).toBe(true);
    expect(options.capture_dead_clicks).toBe(false);
    expect(last(phCalls, "register")).toEqual([
      { platform: "web", environment: "production", app: "codecast" },
    ]);
  });

  it("initializes Sentry error reporting in production", () => {
    web.initAnalytics(base);
    const [options] = last(sentryCalls, "init") as [Record<string, any>];
    expect(options.dsn).toBe(base.sentryDsn);
    expect(options.environment).toBe("production");
    expect(options.enabled).toBe(true);
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.integrations).toBeUndefined();
    expect(options.initialScope.tags).toEqual({ platform: "web", app: "codecast" });
  });

  it("disables Sentry in development", () => {
    web.initAnalytics({ ...base, environment: "development" });
    const [options] = last(sentryCalls, "init") as [Record<string, any>];
    expect(options.enabled).toBe(false);
    expect(options.tracesSampleRate).toBeUndefined();
  });

  it("initializes once; a second call is ignored", () => {
    web.initAnalytics(base);
    web.initAnalytics(base);
    expect(count(phCalls, "init")).toBe(1);
    expect(count(sentryCalls, "init")).toBe(1);
  });

  it("skips a backend whose key is absent", () => {
    web.initAnalytics({ environment: "production", platform: "web" });
    expect(count(phCalls, "init")).toBe(0);
    expect(count(sentryCalls, "init")).toBe(0);
    web.track("e");
    web.identifyUser("u1");
    web.captureError(new Error("x"));
    expect(count(phCalls, "capture")).toBe(0);
    expect(count(phCalls, "identify")).toBe(0);
    expect(count(sentryCalls, "captureException")).toBe(0);
  });
});

describe("identity and events (web)", () => {
  it("identifyUser reaches both backends with the app user id", () => {
    web.initAnalytics(base);
    web.identifyUser("users:abc123", { email: "a@b.c" });
    expect(last(sentryCalls, "setUser")).toEqual([{ id: "users:abc123", email: "a@b.c" }]);
    expect(last(phCalls, "identify")).toEqual(["users:abc123", { email: "a@b.c" }]);
  });

  it("resetUser clears both backends", () => {
    web.initAnalytics(base);
    web.resetUser();
    expect(last(sentryCalls, "setUser")).toEqual([null]);
    expect(count(phCalls, "reset")).toBe(1);
  });

  it("track forwards to posthog.capture", () => {
    web.initAnalytics(base);
    web.track("session_created", { kind: "fork" });
    expect(last(phCalls, "capture")).toEqual(["session_created", { kind: "fork" }]);
  });

  it("captureError forwards to Sentry with context as extra", () => {
    web.initAnalytics(base);
    const err = new Error("boom");
    web.captureError(err, { where: "test" });
    expect(last(sentryCalls, "captureException")).toEqual([err, { extra: { where: "test" } }]);
  });
});

// Boot defers initAnalytics to an idle callback while identify waits on a user
// query, so init usually wins the race. When it does not, the old code dropped
// the identify without a sound and the next crash reached Sentry with no user
// attached. These calls are held and replayed instead.
describe("calls made before init (web)", () => {
  it("replays a held identify into both backends once init runs", () => {
    web.identifyUser("users:abc123", { email: "a@b.c" });
    expect(count(sentryCalls, "setUser")).toBe(0);
    expect(count(phCalls, "identify")).toBe(0);

    web.initAnalytics(base);

    expect(last(sentryCalls, "setUser")).toEqual([{ id: "users:abc123", email: "a@b.c" }]);
    expect(last(phCalls, "identify")).toEqual(["users:abc123", { email: "a@b.c" }]);
  });

  it("replays held calls in the order they were made", () => {
    web.track("boot_started");
    web.identifyUser("users:abc123");
    web.track("workspace_opened", { id: "w1" });

    web.initAnalytics(base);

    expect(order.slice(order.indexOf("posthog.register") + 1)).toEqual([
      "posthog.capture",
      "sentry.setUser",
      "posthog.identify",
      "posthog.capture",
    ]);
    expect((phCalls.capture ?? []).map((args) => args[0])).toEqual([
      "boot_started",
      "workspace_opened",
    ]);
  });

  it("holds a reset in the same queue, so a sign out is not reordered behind the identify it cancels", () => {
    web.identifyUser("users:abc123");
    web.resetUser();

    web.initAnalytics(base);

    expect(last(sentryCalls, "setUser")).toEqual([null]);
    expect(count(phCalls, "reset")).toBe(1);
  });

  it("replays a held track after the super properties are registered", () => {
    // The held capture must carry platform, environment and app just like a
    // call made after boot, so replaying it before register would mislabel it.
    web.track("boot_started");
    web.initAnalytics(base);
    expect(order.indexOf("posthog.register")).toBeLessThan(order.indexOf("posthog.capture"));
  });

  it("passes calls made after init straight through, with nothing held", () => {
    web.initAnalytics(base);
    web.track("session_created", { kind: "fork" });
    web.identifyUser("users:abc123");
    expect(count(phCalls, "capture")).toBe(1);
    expect(count(phCalls, "identify")).toBe(1);

    // A second init is ignored, so it must not replay anything a second time.
    web.initAnalytics(base);
    expect(count(phCalls, "capture")).toBe(1);
    expect(count(phCalls, "identify")).toBe(1);
  });

  it("drops the oldest held call at the cap, and throws nothing", () => {
    const total = PRE_INIT_BUFFER_LIMIT + 10;
    for (let i = 0; i < total; i++) web.track(`e${i}`);
    web.identifyUser("users:latest");

    web.initAnalytics(base);

    // The identify is the newest call, so it is the one that must survive.
    expect(last(phCalls, "identify")).toEqual(["users:latest", undefined]);
    // One slot went to the identify, so the last cap-minus-one events remain.
    const events = (phCalls.capture ?? []).map((args) => args[0]);
    expect(events.length).toBe(PRE_INIT_BUFFER_LIMIT - 1);
    expect(events[0]).toBe(`e${total - (PRE_INIT_BUFFER_LIMIT - 1)}`);
    expect(events.at(-1)).toBe(`e${total - 1}`);
  });

  it("keeps replaying the rest when one held call throws", () => {
    // A backend refusing one held call must not break the boot that replays it,
    // nor swallow the calls queued behind it.
    const ph = web.posthog as unknown as Record<string, unknown>;
    const realIdentify = ph.identify;
    ph.identify = () => {
      throw new Error("posthog refused");
    };
    try {
      web.identifyUser("users:abc123");
      web.track("survives");
      expect(() => web.initAnalytics(base)).not.toThrow();
      expect(last(phCalls, "capture")).toEqual(["survives", undefined]);
    } finally {
      ph.identify = realIdentify;
    }
  });
});

describe("setupErrorToasts", () => {
  type Handler = (e: any) => void;
  let handlers: Record<string, Handler>;
  let toasts: Array<[string, string]>;

  const install = (ignoredErrorPatterns?: RegExp[]) => {
    handlers = {};
    toasts = [];
    (globalThis as any).window = {
      addEventListener: (type: string, fn: Handler) => {
        handlers[type] = fn;
      },
    };
    web.setupErrorToasts({ showErrorToast: (title, trace) => toasts.push([title, trace]), ignoredErrorPatterns });
  };

  beforeEach(() => {
    web.initAnalytics(base);
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("toasts and reports an uncaught error once", () => {
    install();
    const err = new Error("boom");
    const event = { error: err, message: "boom", preventDefault: record({}, "x") };
    handlers.error(event);
    handlers.error(event); // deduped for 30s
    expect(toasts.length).toBe(1);
    expect(toasts[0][0]).toBe("Uncaught: boom");
    expect(count(sentryCalls, "captureException")).toBe(1);
    expect(last(sentryCalls, "captureException")).toEqual([err, { extra: { source: "window.onerror" } }]);
  });

  it("toasts and reports an unhandled rejection, wrapping non-Error reasons", () => {
    install();
    handlers.unhandledrejection({ reason: "nope", preventDefault: () => {} });
    expect(toasts.length).toBe(1);
    expect(toasts[0][0]).toBe("Unhandled rejection: nope");
    expect(count(sentryCalls, "captureException")).toBe(1);
  });

  it("reads the failure through summarize, describe and toError", () => {
    // The shape React hands onRecoverableError, and the shape app code makes
    // with `new Error(msg, { cause })`: the wrapper says nothing, the cause is
    // the failure. An app that walks the chain gets the failure in the title,
    // in the trace and in the Sentry event.
    const cause = new TypeError("cannot read properties of undefined");
    const wrapper = new Error("Minified React error #520", { cause });
    handlers = {};
    toasts = [];
    (globalThis as any).window = { addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; } };
    const root = (e: unknown) => ((e as { cause?: unknown })?.cause as Error) ?? (e as Error);
    web.setupErrorToasts({
      showErrorToast: (title, trace) => toasts.push([title, trace]),
      summarize: (e) => root(e).message,
      describe: (e) => `${(e as Error).message}\ncaused by: ${root(e).message}`,
      toError: root,
    });

    handlers.error({ error: wrapper, message: "Minified React error #520", preventDefault: () => {} });
    expect(toasts[0][0]).toBe("Uncaught: cannot read properties of undefined");
    expect(toasts[0][1]).toContain("caused by: cannot read properties of undefined");
    expect(last(sentryCalls, "captureException")).toEqual([cause, { extra: { source: "window.onerror" } }]);
  });

  it("claimErrorKey shares one 30s window with the listeners", () => {
    // An app reporting from a path this module does not own (React's
    // onRecoverableError) claims the key first; the listener then declines the
    // same failure instead of toasting it a second time.
    install();
    expect(web.claimErrorKey("boom")).toBe(true);
    expect(web.claimErrorKey("boom")).toBe(false);
    handlers.error({ error: new Error("boom"), message: "boom", preventDefault: () => {} });
    expect(toasts.length).toBe(0);
    expect(count(sentryCalls, "captureException")).toBe(0);
  });

  it("ignored patterns suppress the toast, the report and the default logging", () => {
    install([/Could not find data for Group/]);
    let prevented = 0;
    handlers.error({
      error: new Error("Could not find data for Group with id 7"),
      message: "Could not find data for Group with id 7",
      preventDefault: () => prevented++,
    });
    handlers.unhandledrejection({
      reason: new Error("Could not find data for Group with id 9"),
      preventDefault: () => prevented++,
    });
    expect(prevented).toBe(2);
    expect(toasts.length).toBe(0);
    expect(count(sentryCalls, "captureException")).toBe(0);
  });
});
