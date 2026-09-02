import { describe, it, expect } from "bun:test";
import { AnalyticsConfigError, DEFAULT_POSTHOG_HOST } from "./index";
import { createServerAnalytics } from "./server";

interface Sent {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function mockFetch() {
  const calls: Sent[] = [];
  const fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const body = (c: Sent) => JSON.parse(c.init.body);

describe("createServerAnalytics", () => {
  it("requires a key and a source", () => {
    expect(() => createServerAnalytics({ posthogKey: "", source: "convex" })).toThrow(AnalyticsConfigError);
    expect(() => createServerAnalytics({ posthogKey: "phc_x", source: "" })).toThrow(AnalyticsConfigError);
    expect(() => createServerAnalytics({ posthogKey: "phc_x", posthogHost: "not-a-url", source: "convex" })).toThrow(
      AnalyticsConfigError,
    );
  });

  it("defaults to the US cloud capture endpoint", () => {
    const a = createServerAnalytics({ posthogKey: "phc_x", source: "convex", fetch: mockFetch().fetch });
    expect(a.endpoint).toBe(`${DEFAULT_POSTHOG_HOST}/i/v0/e/`);
  });

  it("honors a host override and strips trailing slashes", () => {
    const a = createServerAnalytics({
      posthogKey: "phc_x",
      posthogHost: "https://eu.i.posthog.com/",
      source: "convex",
      fetch: mockFetch().fetch,
    });
    expect(a.endpoint).toBe("https://eu.i.posthog.com/i/v0/e/");
  });

  it("capture posts the donor payload shape: api_key in the body, source first", async () => {
    const { calls, fetch } = mockFetch();
    const a = createServerAnalytics({ posthogKey: "phc_x", source: "convex", fetch });
    await a.capture("cli_auth_completed", "users:abc123", { method: "device_code" });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(a.endpoint);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(body(calls[0])).toEqual({
      api_key: "phc_x",
      event: "cli_auth_completed",
      distinct_id: "users:abc123",
      properties: { source: "convex", method: "device_code" },
    });
  });

  it("caller properties can override source", async () => {
    const { calls, fetch } = mockFetch();
    const a = createServerAnalytics({ posthogKey: "phc_x", source: "convex", fetch });
    await a.capture("e", "u1", { source: "daemon" });
    expect(body(calls[0]).properties.source).toBe("daemon");
  });

  it("capturePersonless uses a random distinct_id and no person profile", async () => {
    const { calls, fetch } = mockFetch();
    const a = createServerAnalytics({
      posthogKey: "phc_x",
      source: "web_server",
      fetch,
      randomUUID: () => "uuid-1",
    });
    await a.capturePersonless("install_script_downloaded", { script: "sh" });
    expect(body(calls[0])).toEqual({
      api_key: "phc_x",
      event: "install_script_downloaded",
      distinct_id: "uuid-1",
      properties: { source: "web_server", $process_person_profile: false, script: "sh" },
    });
  });

  it("buildPayload builds without sending", () => {
    const { calls, fetch } = mockFetch();
    const a = createServerAnalytics({ posthogKey: "phc_x", source: "convex", fetch });
    const p = a.buildPayload("e", "u1", { n: 1 });
    expect(p).toEqual({ api_key: "phc_x", event: "e", distinct_id: "u1", properties: { source: "convex", n: 1 } });
    expect(calls.length).toBe(0);
  });

  it("a failing fetch never rejects the caller", async () => {
    const a = createServerAnalytics({
      posthogKey: "phc_x",
      source: "convex",
      fetch: (async () => {
        throw new Error("posthog is down");
      }) as unknown as typeof globalThis.fetch,
    });
    await a.capture("e", "u1");
    await a.capturePersonless("e");
  });
});
