import { describe, expect, test } from "bun:test";
import { internalHostRefusal, tokenHttp } from "./tokenHttp";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("internalHostRefusal", () => {
  test("loopback, private, link-local, CGNAT, unique-local and codecast's own hosts are refused; public hosts pass", () => {
    for (const url of [
      "https://localhost/x",
      "https://api.localhost",
      "https://127.0.0.1",
      "https://0.0.0.0",
      "https://10.1.2.3",
      "https://172.16.0.1",
      "https://192.168.0.10",
      "https://169.254.169.254/latest/meta-data",
      "https://100.100.1.1",
      "https://[::1]",
      "https://[fc00::1]",
      "https://[fe80::1]",
      "https://[::ffff:10.0.0.1]",
      "https://2130706433",
      "https://convex.codecast.sh",
      "https://metadata.google.internal",
    ]) {
      expect(internalHostRefusal(url)).not.toBeNull();
    }
    for (const url of ["https://sentry.io", "https://us.posthog.com", "https://8.8.8.8", "https://[2606:4700::1111]", "https://api.example.com/v1"]) {
      expect(internalHostRefusal(url)).toBeNull();
    }
  });
});

describe("tokenHttp", () => {
  test("sends the bearer token with redirects refused, and reads the answer and its link header", async () => {
    let seen: RequestInit | undefined;
    const res = await tokenHttp(async (_u, init) => ((seen = init), json(200, { a: 1 }, { link: "<x>; rel=next" })), { url: "https://api.example.com/x", token: "tok", vendor: "Acme" });
    expect(res).toMatchObject({ ok: true, status: 200, text: '{"a":1}', link: "<x>; rel=next" });
    expect(seen?.redirect).toBe("manual");
    expect((seen?.headers as any).Authorization).toBe("Bearer tok");
  });

  test("an internal host is refused before any call", async () => {
    let called = false;
    const res = await tokenHttp(async () => ((called = true), json(200, {})), { url: "https://10.0.0.1/x", token: "tok", vendor: "Acme" });
    expect(res).toMatchObject({ ok: false, status: 0, failure: "refused_host" });
    expect(called).toBe(false);
  });

  test("a redirect is refused with its body cancelled and its target never echoed", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const res = await tokenHttp(async () => new Response(body, { status: 302, headers: { location: "https://elsewhere.example/" } }), { url: "https://api.example.com/x", token: "SECRET", vendor: "Acme" });
    expect(res).toMatchObject({ ok: false, status: 302, failure: "redirect" });
    expect(cancelled).toBe(true);
    expect(res.error).not.toContain("elsewhere");
    expect(res.error).not.toContain("SECRET");
  });

  test("every read is capped, with a default when the caller names none", async () => {
    const over = await tokenHttp(async () => new Response("x".repeat(2000)), { url: "https://api.example.com/x", token: "t", vendor: "Acme", maxBytes: 1000 });
    expect(over).toMatchObject({ ok: false, failure: "over" });
    const huge = await tokenHttp(async () => new Response("", { headers: { "content-length": String(50 * 1024 * 1024) } }), { url: "https://api.example.com/x", token: "t", vendor: "Acme" });
    expect(huge).toMatchObject({ ok: false, failure: "over" });
  });

  test("a non-2xx answer keeps its text for the vendor's wording; a network error and a timeout name themselves without the token", async () => {
    const bad = await tokenHttp(async () => json(400, { detail: "nope" }), { url: "https://api.example.com/x", token: "t", vendor: "Acme" });
    expect(bad).toMatchObject({ ok: false, status: 400, text: '{"detail":"nope"}', error: "Acme answered 400" });
    expect(bad.failure).toBeUndefined();
    const down = await tokenHttp(async () => {
      throw new Error("ECONNREFUSED");
    }, { url: "https://api.example.com/x", token: "SECRET", vendor: "Acme" });
    expect(down).toMatchObject({ ok: false, status: 0, failure: "unreachable" });
    expect(down.error).toContain("Could not reach Acme at https://api.example.com");
    const slow = await tokenHttp(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }, { url: "https://api.example.com/x", token: "SECRET", vendor: "Acme", timeoutMs: 5000 });
    expect(slow).toMatchObject({ failure: "timeout", error: "Acme gave no answer in 5s" });
  });
});
