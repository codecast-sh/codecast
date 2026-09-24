import { expect, test } from "bun:test";
import { Hono } from "hono";
import { DOCUMENT_POLICY, createResponsePolicy, cspReportEndpoint, responsePolicy } from "./responsePolicy";

const DSN = "https://publickey@o123.ingest.us.sentry.io/456";

function htmlApp(policy = responsePolicy) {
  return new Hono().use("*", policy).get("/", c => c.html('<script>fixture()</script>'));
}

test("HTML responses report CSP violations without changing embedding or script behavior", async () => {
  const response = await htmlApp().request("/");
  expect(response.headers.get("Content-Security-Policy")).toBeNull();
  expect(response.headers.get("Content-Security-Policy-Report-Only")).toContain("frame-ancestors 'self'");
  expect(response.headers.get("Content-Security-Policy-Report-Only")).toContain("script-src 'self'");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Permissions-Policy")).toContain("microphone=(self)");
  expect(await response.text()).toContain("fixture()");
});

test("non-HTML responses get response hardening without an irrelevant document CSP", async () => {
  const app = new Hono().use("*", responsePolicy).get("/api", c => c.json({ ok: true }));
  const response = await app.request("/api");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
});

test("every response carries HSTS with a max-age only", async () => {
  const app = new Hono().use("*", responsePolicy).get("/api", c => c.json({ ok: true }));
  const hsts = (await app.request("/api")).headers.get("Strict-Transport-Security");
  expect(hsts).toMatch(/^max-age=\d+$/);
});

test("a Sentry DSN becomes its CSP security endpoint; a malformed one yields nothing", () => {
  expect(cspReportEndpoint(DSN, { environment: "production", release: "1.2.3" })).toBe(
    "https://o123.ingest.us.sentry.io/api/456/security/?sentry_key=publickey&sentry_environment=production&sentry_release=1.2.3",
  );
  expect(cspReportEndpoint(undefined, {})).toBeNull();
  expect(cspReportEndpoint("not a url", {})).toBeNull();
  expect(cspReportEndpoint("https://o1.ingest.sentry.io/", {})).toBeNull();
});

test("a sampled HTML response names the report sink in both reporting forms", async () => {
  const policy = createResponsePolicy({ sentryDsn: DSN, environment: "production", sampleRate: 1, random: () => 0 });
  const response = await htmlApp(policy).request("/");
  const csp = response.headers.get("Content-Security-Policy-Report-Only")!;
  expect(csp).toContain("report-uri https://o123.ingest.us.sentry.io/api/456/security/?sentry_key=publickey");
  expect(csp).toContain("report-to csp");
  expect(response.headers.get("Reporting-Endpoints")).toBe(
    'csp="https://o123.ingest.us.sentry.io/api/456/security/?sentry_key=publickey&sentry_environment=production"',
  );
  expect(response.headers.get("Content-Security-Policy")).toBeNull();
});

test("unsampled responses and servers without a DSN send no reports", async () => {
  const unsampled = createResponsePolicy({ sentryDsn: DSN, sampleRate: 0.1, random: () => 0.5 });
  const noDsn = createResponsePolicy({ sentryDsn: undefined, sampleRate: 1, random: () => 0 });
  for (const policy of [unsampled, noDsn]) {
    const response = await htmlApp(policy).request("/");
    expect(response.headers.get("Content-Security-Policy-Report-Only")).not.toContain("report-uri");
    expect(response.headers.get("Reporting-Endpoints")).toBeNull();
  }
});

test("reporting documents are capped per hour, then resume in the next hour", async () => {
  let now = 0;
  const policy = createResponsePolicy({ sentryDsn: DSN, sampleRate: 1, maxReportingPerHour: 2, random: () => 0, now: () => now });
  const app = htmlApp(policy);
  const reporting = async () => (await app.request("/")).headers.get("Reporting-Endpoints") !== null;
  expect([await reporting(), await reporting(), await reporting()]).toEqual([true, true, false]);
  now = 60 * 60 * 1000;
  expect(await reporting()).toBe(true);
});

test("the draft policy names every source the app loads from", () => {
  const directive = (name: string) => DOCUMENT_POLICY.split("; ").find(d => d.startsWith(`${name} `)) ?? "";
  expect(directive("connect-src")).toContain("wss://convex.codecast.sh");
  expect(directive("connect-src")).toContain("https://us.i.posthog.com");
  expect(directive("connect-src")).toContain("ws://127.0.0.1:*");
  expect(directive("script-src")).toContain("https://us-assets.i.posthog.com");
  expect(directive("font-src")).toContain("https://fonts.gstatic.com");
  expect(directive("frame-src")).toContain("https:");
  expect(directive("frame-ancestors")).toBe("frame-ancestors 'self' https://local.codecast.sh");
  expect(DOCUMENT_POLICY).not.toContain("'unsafe-eval'");
});
