import { expect, test } from "bun:test";
import { Hono } from "hono";
import { responsePolicy } from "./responsePolicy";

test("HTML responses report CSP violations without changing embedding or script behavior", async () => {
  const app = new Hono().use("*", responsePolicy).get("/", c => c.html('<script>fixture()</script>'));
  const response = await app.request("/");
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
