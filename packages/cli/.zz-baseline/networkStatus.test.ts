import { describe, expect, test } from "bun:test";
import { lookup } from "node:dns/promises";
import { collectNetworkStatus, daemonConnectionStatus, networkStatusRows, STATUS_STATE_STALE_MS } from "./networkStatus.js";
import { cliFetch } from "./cliHttp.js";

const config = { convex_url: "https://example.convex.cloud", auth_token: "test-secret" };
const settings = { sync_mode: "all", sync_projects: [] };
const deps = {
  lookup: (async () => [{ address: "192.0.2.1", family: 4 }]) as unknown as typeof lookup,
  networkInterfaces: () => ({}),
  fetch: (async () => Response.json(settings)) as typeof cliFetch,
  timeoutMs: 500,
};

describe("status network diagnostics", () => {
  test("probes the configured HTTP endpoint without redirects or retries", async () => {
    const calls: unknown[] = [];
    const report = await collectNetworkStatus(config, true, { ...deps, fetch: async (...args) => {
      calls.push(args);
      return Response.json(settings);
    } });
    expect(report.endpoint).toBe("https://example.convex.site");
    expect(report.auth).toBe("verified");
    expect(report.api.status).toBe("ok");
    expect(report.api.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.dns.detail).toBe("192.0.2.1");
    expect(calls).toEqual([["https://example.convex.site/cli/sync-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: "test-secret" }), redirect: "error",
    }, { timeoutMs: 500, retries: 0 }]]);
    expect(JSON.stringify(report)).not.toContain("test-secret");
  });

  test.each([401, 403, 429, 500, 503])("HTTP %d is a responding server, not an offline network", async (status) => {
    const report = await collectNetworkStatus(config, true, { ...deps, fetch: async () => new Response("failed", { status }) });
    expect(report.api).toMatchObject({ status: "error", httpStatus: status });
    expect(report.api.detail).toContain("reachable;");
    expect(report.auth).toBe(status === 401 || status === 403 ? "rejected" : "unverified");
    expect(networkStatusRows(report).find(row => row[0] === "Latency")?.[1]).toContain("until failure");
  });

  test.each(["<html>sign in</html>", JSON.stringify({ error: "Unauthorized" }), "null", "{}"])("does not trust an unexpected HTTP 200 body: %s", async (body) => {
    const report = await collectNetworkStatus(config, true, { ...deps, fetch: async () => new Response(body) });
    expect(report.api.status).toBe("error");
    expect(report.auth).toBe("unverified");
    expect(report.api.detail).toBe("unexpected response from backend");
  });

  test("a timeout includes stalled response bodies and DNS without serial waits", async () => {
    const start = performance.now();
    const report = await collectNetworkStatus(config, true, {
      ...deps, timeoutMs: 60,
      lookup: (() => new Promise(() => {})) as unknown as typeof lookup,
      fetch: async () => new Response(new ReadableStream()),
    });
    expect(performance.now() - start).toBeLessThan(300);
    expect(report.api).toMatchObject({ status: "error", detail: "timed out" });
    expect(report.dns).toMatchObject({ status: "error", detail: "timed out" });
    expect(report.auth).toBe("unverified");
  });

  test.each([
    ["ENOTFOUND", "DNS lookup failed (ENOTFOUND)"],
    ["ECONNREFUSED", "connection refused"],
    ["ConnectionRefused", "connection refused"],
    ["ConnectionClosed", "connection reset"],
    ["ENETUNREACH", "network unreachable"],
    ["CERT_HAS_EXPIRED", "TLS certificate or handshake failed"],
  ])("classifies %s without leaking request secrets", async (code, detail) => {
    const report = await collectNetworkStatus(config, true, { ...deps, fetch: async () => {
      throw Object.assign(new Error("test-secret"), { cause: { code } });
    } });
    expect(report.api.detail).toBe(detail);
    expect(JSON.stringify(report)).not.toContain("test-secret");
  });

  test("an independent DNS failure does not override a successful API request", async () => {
    const report = await collectNetworkStatus(config, true, { ...deps,
      lookup: (async () => { throw Object.assign(new Error(), { code: "EAI_AGAIN" }); }) as unknown as typeof lookup,
    });
    expect(report.dns.status).toBe("error");
    expect(report.api.status).toBe("ok");
    expect(report.auth).toBe("verified");
  });

  test("no-network and missing configuration never call the network", async () => {
    let calls = 0;
    const never = async () => { calls++; throw new Error("must not run"); };
    for (const [cfg, enabled] of [[config, false], [null, true]] as const) {
      const report = await collectNetworkStatus(cfg, enabled, { ...deps, fetch: never, lookup: never });
      expect(report.api.status).toBe("skipped");
      expect(report.dns.status).toBe("skipped");
    }
    expect(calls).toBe(0);
  });

  test("without a token, checks reachability without claiming authentication", async () => {
    const report = await collectNetworkStatus({ convex_url: config.convex_url }, true, { ...deps, fetch: async (_, init) => {
      expect(init.method).toBe("OPTIONS");
      expect(init.body).toBeUndefined();
      return new Response(null, { status: 204 });
    } });
    expect(report.api.status).toBe("ok");
    expect(report.auth).toBe("missing");
  });

  test.each(["garbage", "file:///tmp/config", "https://user:test-secret@example.com"])("rejects invalid or credential-bearing endpoints: %s", async (convex_url) => {
    const report = await collectNetworkStatus({ ...config, convex_url }, true, deps);
    expect(report.endpoint).toBeNull();
    expect(report.api.status).toBe("error");
    expect(JSON.stringify(report)).not.toContain("test-secret");
  });

  test("keeps self-hosted endpoints and removes URL query credentials", async () => {
    const report = await collectNetworkStatus({ ...config, convex_url: "https://backend.example/api?token=test-secret#test-secret" }, false, deps);
    expect(report.endpoint).toBe("https://backend.example/api");
    expect(JSON.stringify(report)).not.toContain("test-secret");
  });

  test("shows interface addresses without loopback and link-local tunnel noise", async () => {
    const entry = { address: "10.0.0.2", family: "IPv4" as const, internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "10.0.0.2/24" };
    const report = await collectNetworkStatus(config, false, { ...deps, networkInterfaces: () => ({
      en0: [entry, entry], lo0: [{ ...entry, internal: true }],
      utun0: [{ ...entry, family: "IPv6", address: "fe80::1", scopeid: 1 }],
    }) });
    expect(report.interfaces).toEqual([{ name: "en0", addresses: ["10.0.0.2"] }]);
  });

  test("marks a successful slow response and labels it as round-trip time", async () => {
    const report = await collectNetworkStatus(config, true, { ...deps, timeoutMs: 2000, fetch: async () => {
      await Bun.sleep(1050);
      return Response.json(settings);
    } });
    expect(report.api.status).toBe("slow");
    expect(networkStatusRows(report).find(row => row[0] === "Latency")?.[1]).toContain("round-trip (slow)");
  });
});

describe("saved daemon WebSocket state", () => {
  const now = 1_000_000;
  const fresh = { connected: true, timestamp: now - 1000, lastHeartbeatTick: now - 30_000 };
  test("requires a running daemon and fresh state before showing connected", () => {
    expect(daemonConnectionStatus(true, fresh, now).status).toBe("connected");
    expect(daemonConnectionStatus(false, fresh, now).status).toBe("stopped");
    expect(daemonConnectionStatus(true, { ...fresh, connected: false }, now).status).toBe("disconnected");
    expect(daemonConnectionStatus(true, { timestamp: now }, now).status).toBe("unknown");
  });
  test("stale state or a frozen event loop cannot look connected", () => {
    expect(daemonConnectionStatus(true, null, now).status).toBe("unknown");
    expect(daemonConnectionStatus(true, { connected: true }, now).status).toBe("unknown");
    for (const field of ["timestamp", "lastHeartbeatTick"]) {
      expect(daemonConnectionStatus(true, { ...fresh, [field]: now - STATUS_STATE_STALE_MS - 1 }, now).status).toBe("unknown");
    }
  });
});

describe("real HTTP diagnostics", () => {
  test("reads settings over a real socket, follows no redirects, and bounds a stalled response", async () => {
    let mode = "ok";
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/cli/sync-settings");
      expect(await request.json()).toEqual({ api_token: "test-secret" });
      if (mode === "redirect") return Response.redirect("https://example.com");
      if (mode === "stall") return new Response(new ReadableStream());
      return Response.json(settings);
    } });
    const local = { ...config, convex_url: `http://127.0.0.1:${server.port}` };
    try {
      const liveDeps = { ...deps, lookup, fetch: cliFetch, timeoutMs: 150 };
      const healthy = await collectNetworkStatus(local, true, liveDeps);
      expect(healthy.api.status).toBe("ok");
      expect(healthy.auth).toBe("verified");
      mode = "redirect";
      expect((await collectNetworkStatus(local, true, liveDeps)).api.status).toBe("error");
      mode = "stall";
      const start = performance.now();
      expect((await collectNetworkStatus(local, true, liveDeps)).api.status).toBe("error");
      expect(performance.now() - start).toBeLessThan(600);
    } finally {
      await server.stop(true);
    }
    const refused = await collectNetworkStatus(local, true, { ...deps, lookup, fetch: cliFetch });
    expect(refused.api.status).toBe("error");
    expect(refused.api.detail).toBe("connection refused");
    expect(refused.auth).toBe("unverified");
  });
});
