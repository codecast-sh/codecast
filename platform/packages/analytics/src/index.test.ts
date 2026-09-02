import { describe, it, expect } from "bun:test";
import { AnalyticsConfigError, DEFAULT_POSTHOG_HOST, resolveConfig, superProperties } from "./index";

declare const Bun: { resolveSync: (specifier: string, from: string) => string };

const base = { environment: "production" as const, platform: "web" };

describe("resolveConfig", () => {
  it("fills the default host", () => {
    expect(resolveConfig(base).posthogHost).toBe(DEFAULT_POSTHOG_HOST);
  });
  it("keeps an explicit host and strips trailing slashes", () => {
    expect(resolveConfig({ ...base, posthogHost: "https://eu.i.posthog.com/" }).posthogHost).toBe(
      "https://eu.i.posthog.com",
    );
  });
  it("rejects a non-http host", () => {
    expect(() => resolveConfig({ ...base, posthogHost: "eu.i.posthog.com" })).toThrow(AnalyticsConfigError);
  });
  it("rejects a bad environment", () => {
    expect(() => resolveConfig({ ...base, environment: "staging" as any })).toThrow(AnalyticsConfigError);
    expect(() => resolveConfig({ ...base, environment: undefined as any })).toThrow(AnalyticsConfigError);
  });
  it("rejects a missing platform", () => {
    expect(() => resolveConfig({ environment: "production", platform: "" })).toThrow(AnalyticsConfigError);
    expect(() => resolveConfig({ environment: "production" } as any)).toThrow(AnalyticsConfigError);
  });
  it("rejects non-string keys", () => {
    expect(() => resolveConfig({ ...base, posthogKey: 5 as any })).toThrow(AnalyticsConfigError);
    expect(() => resolveConfig({ ...base, sentryDsn: {} as any })).toThrow(AnalyticsConfigError);
  });
  it("normalizes empty strings to undefined so falsy env vars disable a backend", () => {
    const r = resolveConfig({ ...base, posthogKey: "", sentryDsn: "" });
    expect(r.posthogKey).toBeUndefined();
    expect(r.sentryDsn).toBeUndefined();
  });
});

describe("superProperties", () => {
  it("platform and environment always; app only when named", () => {
    expect(superProperties(resolveConfig(base))).toEqual({ platform: "web", environment: "production" });
    expect(superProperties(resolveConfig({ ...base, appName: "codecast" }))).toEqual({
      platform: "web",
      environment: "production",
      app: "codecast",
    });
  });
});

describe("exports map", () => {
  it("every subpath resolves under bun", () => {
    const map: Record<string, string> = {
      "@platform/analytics": "src/index.ts",
      "@platform/analytics/web": "src/web.ts",
      "@platform/analytics/native": "src/native.ts",
      "@platform/analytics/server": "src/server.ts",
      "@platform/analytics/web-vitals": "src/webVitals.ts",
    };
    for (const [specifier, file] of Object.entries(map)) {
      // resolveSync resolves through package.json "exports" without executing
      // the module, so the browser entries stay unevaluated here.
      const dir = (import.meta as { dir?: string }).dir ?? new URL(".", import.meta.url).pathname;
      expect(Bun.resolveSync(specifier, dir).endsWith(file)).toBe(true);
    }
  });
});
