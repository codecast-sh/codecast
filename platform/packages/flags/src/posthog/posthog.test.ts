import { describe, it, expect } from "bun:test";
import { splitFlagValue } from "./types";
import { fromPostHogJs } from "./posthogJs";
import { fromPostHogReactNative } from "./posthogReactNative";
import { parseFlagsResponse, createServerFlagsClient, flagsEndpoint, type FetchLike } from "./server";

describe("splitFlagValue", () => {
  it("boolean and variant", () => {
    expect(splitFlagValue(true)).toEqual({ enabled: true, variant: undefined });
    expect(splitFlagValue(false)).toEqual({ enabled: false, variant: undefined });
    expect(splitFlagValue(undefined)).toEqual({ enabled: false, variant: undefined });
    expect(splitFlagValue("control")).toEqual({ enabled: true, variant: "control" });
  });
});

describe("adapters", () => {
  it("posthog-js", async () => {
    let reloads = 0;
    const c = fromPostHogJs({
      getFeatureFlag: (k) => (k === "exp" ? "test" : k === "on" ? true : undefined),
      getFeatureFlagPayload: (k) => (k === "exp" ? { n: 1 } : undefined),
      reloadFeatureFlags: () => {
        reloads++;
        cb?.();
      },
      onFeatureFlags: (f) => {
        cb = f;
        return () => {};
      },
    });
    let cb: (() => void) | undefined;
    await c.reload();
    expect(reloads).toBe(1);
    expect(c.getFlag("exp")).toBe(true);
    expect(c.getVariant("exp")).toBe("test");
    expect(c.getPayload("exp")).toEqual({ n: 1 });
    expect(c.getFlag("on")).toBe(true);
    expect(c.getFlag("missing")).toBe(false);
  });
  it("posthog-react-native", async () => {
    let reloads = 0;
    const c = fromPostHogReactNative({
      getFeatureFlag: () => "b",
      getFeatureFlagPayload: () => 7,
      reloadFeatureFlagsAsync: async () => {
        reloads++;
      },
    });
    await c.reload();
    expect(reloads).toBe(1);
    expect(c.getVariant("x")).toBe("b");
    expect(c.getPayload("x")).toBe(7);
  });
});

describe("server evaluator", () => {
  it("endpoint strips trailing slash", () => {
    expect(flagsEndpoint("https://eu.i.posthog.com/")).toBe("https://eu.i.posthog.com/flags/?v=2");
  });
  it("parses v2 and legacy shapes", () => {
    expect(
      parseFlagsResponse({
        flags: {
          a: { enabled: true, variant: null, metadata: { payload: '{"x":1}' } },
          b: { enabled: true, variant: "test" },
          c: { enabled: false },
        },
      }),
    ).toEqual({ values: { a: true, b: "test", c: false }, payloads: { a: { x: 1 } } });
    expect(parseFlagsResponse({ featureFlags: { a: true, b: "v" }, featureFlagPayloads: { b: "[1]" } })).toEqual({
      values: { a: true, b: "v" },
      payloads: { b: [1] },
    });
    expect(parseFlagsResponse(null)).toEqual({ values: {}, payloads: {} });
  });
  it("posts the identity and reads the snapshot", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ flags: { f: { enabled: true, variant: "on" } } }) };
    };
    const c = createServerFlagsClient({ apiKey: "phc", host: "https://h", distinctId: "d1", groups: { team: "t" }, fetch });
    expect(c.getFlag("f")).toBe(false);
    await c.reload();
    expect(calls[0].url).toBe("https://h/flags/?v=2");
    expect(calls[0].body).toEqual({ api_key: "phc", distinct_id: "d1", groups: { team: "t" } });
    expect(c.getFlag("f")).toBe(true);
    expect(c.getVariant("f")).toBe("on");
    expect(c.snapshot().values).toEqual({ f: "on" });
  });
  it("throws on a failed response", async () => {
    const c = createServerFlagsClient({
      apiKey: "k", host: "https://h", distinctId: "d",
      fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    await expect(c.reload()).rejects.toThrow("PostHog flags request failed: 500");
  });
});
