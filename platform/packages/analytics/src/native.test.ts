import { describe, it, expect, beforeEach, mock } from "bun:test";

// native.ts lazily requires both native SDKs at module scope, so both are
// mocked before the module under test is loaded.
type Calls = Record<string, unknown[][]>;
const sentryCalls: Calls = {};
// One log across both backends, so a test can assert the order calls landed in
// and not just that each one landed.
const order: string[] = [];
const record =
  (calls: Calls, name: string) =>
  (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    order.push(`${calls === sentryCalls ? "sentry" : "posthog"}.${name}`);
  };
const last = (calls: Calls, name: string) => (calls[name] ?? []).at(-1);
const count = (calls: Calls, name: string) => (calls[name] ?? []).length;

class PostHogMock {
  static instances: PostHogMock[] = [];
  calls: Calls = {};
  constructor(
    public key: string,
    public options: Record<string, any>,
  ) {
    PostHogMock.instances.push(this);
  }
  register = record(this.calls, "register");
  identify = record(this.calls, "identify");
  reset = record(this.calls, "reset");
  capture = record(this.calls, "capture");
  screen = record(this.calls, "screen");
}

mock.module("@sentry/react-native", () => ({
  init: record(sentryCalls, "init"),
  setUser: record(sentryCalls, "setUser"),
  captureException: record(sentryCalls, "captureException"),
  wrap: (c: unknown) => ({ wrapped: c }),
}));

mock.module("posthog-react-native", () => ({ default: PostHogMock }));

const native = await import("./native");
const { PRE_INIT_BUFFER_LIMIT } = await import("./index");

const base = {
  posthogKey: "phc_x",
  sentryDsn: "https://dsn@example.ingest.sentry.io/1",
  environment: "production" as const,
  platform: "mobile",
  appName: "codecast",
};

beforeEach(() => {
  native._resetForTests();
  PostHogMock.instances.length = 0;
  for (const k of Object.keys(sentryCalls)) delete sentryCalls[k];
  order.length = 0;
});

const client = () => PostHogMock.instances.at(-1)!;

describe("initAnalytics (native)", () => {
  it("constructs PostHog with the donor options and registers super properties", () => {
    native.initAnalytics(base);
    const c = client();
    expect(c.key).toBe("phc_x");
    expect(c.options.host).toBe("https://us.i.posthog.com");
    expect(c.options.disabled).toBe(false);
    expect(c.options.captureAppLifecycleEvents).toBe(true);
    expect(c.options.enableSessionReplay).toBe(true);
    expect(c.options.sessionReplayConfig).toEqual({
      maskAllTextInputs: true,
      maskAllImages: false,
      captureLog: true,
      captureNetworkTelemetry: true,
    });
    expect(last(c.calls, "register")).toEqual([
      { platform: "mobile", environment: "production", app: "codecast" },
    ]);
  });

  it("disables PostHog capture in development", () => {
    native.initAnalytics({ ...base, environment: "development" });
    expect(client().options.disabled).toBe(true);
  });

  it("enableSessionReplay false passes through", () => {
    native.initAnalytics({ ...base, enableSessionReplay: false });
    expect(client().options.enableSessionReplay).toBe(false);
  });

  it("initializes Sentry enabled in production with the donor sample rate", () => {
    native.initAnalytics(base);
    const [options] = last(sentryCalls, "init") as [Record<string, any>];
    expect(options.dsn).toBe(base.sentryDsn);
    expect(options.enabled).toBe(true);
    expect(options.tracesSampleRate).toBe(0.2);
    expect(options.initialScope.tags).toEqual({ platform: "mobile", app: "codecast" });
  });
});

describe("identity and events (native)", () => {
  beforeEach(() => {
    native.initAnalytics(base);
  });

  it("identifyUser reaches both backends with the app user id", () => {
    native.identifyUser("users:abc123", { plan: "pro" });
    expect(last(sentryCalls, "setUser")).toEqual([{ id: "users:abc123", plan: "pro" }]);
    expect(last(client().calls, "identify")).toEqual(["users:abc123", { plan: "pro" }]);
  });

  it("resetUser clears both backends", () => {
    native.resetUser();
    expect(last(sentryCalls, "setUser")).toEqual([null]);
    expect(count(client().calls, "reset")).toBe(1);
  });

  it("track and trackScreen forward to the client", () => {
    native.track("session_opened", { from: "inbox" });
    native.trackScreen("/settings", { tab: "team" });
    expect(last(client().calls, "capture")).toEqual(["session_opened", { from: "inbox" }]);
    expect(last(client().calls, "screen")).toEqual(["/settings", { tab: "team" }]);
  });

  it("captureError forwards to Sentry with context as extra", () => {
    const err = new Error("boom");
    native.captureError(err, { where: "test" });
    expect(last(sentryCalls, "captureException")).toEqual([err, { extra: { where: "test" } }]);
  });

  it("wrapRoot wraps through Sentry.wrap", () => {
    const Root = { name: "Root" };
    expect(native.wrapRoot(Root)).toEqual({ wrapped: Root } as any);
  });
});

// The same gap the web entry had, and worse here: the header tells apps to call
// initAnalytics after first mount, so an app that identifies from a stored
// session routinely gets there first. Held and replayed rather than dropped.
describe("calls made before init (native)", () => {
  it("replays a held identify into both backends once init runs", () => {
    native.identifyUser("users:abc123", { plan: "pro" });
    expect(count(sentryCalls, "setUser")).toBe(0);
    expect(PostHogMock.instances.length).toBe(0);

    native.initAnalytics(base);

    expect(last(sentryCalls, "setUser")).toEqual([{ id: "users:abc123", plan: "pro" }]);
    expect(last(client().calls, "identify")).toEqual(["users:abc123", { plan: "pro" }]);
  });

  it("replays held calls in the order they were made", () => {
    native.track("boot_started");
    native.identifyUser("users:abc123");
    native.trackScreen("/inbox");

    native.initAnalytics(base);

    expect(order.slice(order.indexOf("posthog.register") + 1)).toEqual([
      "posthog.capture",
      "sentry.setUser",
      "posthog.identify",
      "posthog.screen",
    ]);
  });

  it("holds a reset in the same queue, so a sign out is not reordered behind the identify it cancels", () => {
    native.identifyUser("users:abc123");
    native.resetUser();

    native.initAnalytics(base);

    expect(last(sentryCalls, "setUser")).toEqual([null]);
    expect(count(client().calls, "reset")).toBe(1);
  });

  it("passes calls made after init straight through, with nothing held", () => {
    native.initAnalytics(base);
    native.track("session_opened", { from: "inbox" });
    expect(count(client().calls, "capture")).toBe(1);
  });

  it("drops the oldest held call at the cap, and throws nothing", () => {
    const total = PRE_INIT_BUFFER_LIMIT + 10;
    for (let i = 0; i < total; i++) native.track(`e${i}`);
    native.identifyUser("users:latest");

    native.initAnalytics(base);

    // The identify is the newest call, so it is the one that must survive.
    expect(last(client().calls, "identify")).toEqual(["users:latest", undefined]);
    // One slot went to the identify, so the last cap-minus-one events remain.
    const events = (client().calls.capture ?? []).map((args) => args[0]);
    expect(events.length).toBe(PRE_INIT_BUFFER_LIMIT - 1);
    expect(events[0]).toBe(`e${total - (PRE_INIT_BUFFER_LIMIT - 1)}`);
    expect(events.at(-1)).toBe(`e${total - 1}`);
  });
});
