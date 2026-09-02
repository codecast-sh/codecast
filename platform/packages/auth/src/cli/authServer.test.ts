import { describe, test, expect, afterEach } from "bun:test";
import * as http from "http";
import { AuthServer } from "./authServer.js";

// Grab a port the OS just confirmed is free, then hand it back. Good enough for
// a single-process test; the tiny TOCTOU window doesn't matter here.
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("AuthServer", () => {
  let servers: AuthServer[] = [];
  let occupiers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) s.stop();
    servers = [];
    await Promise.all(
      occupiers.map((o) => new Promise<void>((res) => o.close(() => res())))
    );
    occupiers = [];
  });

  // The regression: runAuth used to read the requested port (42424) into the
  // browser URL before binding, so an EADDRINUSE bump left the browser POSTing
  // to a port nothing was listening on. listen() must report where it really
  // bound, and that port must be live.
  test("listen() returns the actual bound port when the preferred one is taken", async () => {
    const base = await getFreePort();

    const occupier = http.createServer();
    await new Promise<void>((res) => occupier.listen(base, "127.0.0.1", () => res()));
    occupiers.push(occupier);

    const server = new AuthServer({ port: base, timeout: 1000 });
    servers.push(server);

    const port = await server.listen();
    expect(port).toBe(base + 1);

    // The browser, told `port`, must reach a live listener there.
    const result = server.waitForCallback();
    const res = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1", apiToken: "t1", nonce: server.getNonce() }),
    });
    expect(res.status).toBe(200);
    expect(await result).toEqual({ userId: "u1", apiToken: "t1", nonce: server.getNonce() });
  });

  // Chrome's Private Network Access blocks a fetch from an https page to
  // http://127.0.0.1 unless the preflight opts in. Missing this header is the
  // prime suspect for the reporter's "Failed to fetch (127.0.0.1:42424)".
  test("OPTIONS preflight opts in to Private Network Access", async () => {
    const base = await getFreePort();
    const server = new AuthServer({ port: base, timeout: 1000 });
    servers.push(server);
    const port = await server.listen();

    const res = await fetch(`http://127.0.0.1:${port}/callback`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("a callback with the wrong nonce is rejected and does not complete auth", async () => {
    const base = await getFreePort();
    const server = new AuthServer({ port: base, timeout: 250 });
    servers.push(server);
    const port = await server.listen();

    const result = server.waitForCallback();
    const res = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1", apiToken: "t1", nonce: "wrong" }),
    });
    expect(res.status).toBe(400);
    // A bad nonce must never resolve credentials; the short timeout yields null.
    expect(await result).toBeNull();
  });
});
