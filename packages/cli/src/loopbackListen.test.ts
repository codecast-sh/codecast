// listenOnSavedPort against real sockets and a real config dir. The daemon is
// never booted here: the point is that a bare http.Server takes the saved port,
// answers immediately, and survives a squatter on that port.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { hookPortFile, identityFile, listenOnSavedPort, loadOrCreateIdentity, readIdentity } from "./loopbackIdentity.js";

const closers: Array<() => Promise<void>> = [];
const dirs: string[] = [];

function tmpConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-listen-"));
  dirs.push(dir);
  return dir;
}

function healthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return server;
}

async function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, body: await res.text() };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("listenOnSavedPort", () => {
  test("a fresh dir listens, records the port, and answers within 200ms", async () => {
    const dir = tmpConfigDir();
    const lines: string[] = [];
    const identity = loadOrCreateIdentity(dir);
    const port = await listenOnSavedPort(healthServer(), { configDir: dir, identity, log: (m) => lines.push(m) });

    const started = Date.now();
    const res = await get(port, "/health");
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(200);

    expect(fs.readFileSync(hookPortFile(dir), "utf-8")).toBe(String(port));
    const saved = readIdentity(dir)!;
    expect(saved.port).toBe(port);
    expect(saved.token).toBe(identity.token);
    expect(saved.pid).toBe(process.pid);
    // The bench parses this line to measure boot blackout. Byte identical.
    expect(lines).toContain(`Hook server listening on 127.0.0.1:${port}`);
    const LISTEN_RE = /^Hook server listening on 127\.0\.0\.1:(\d+)$/;
    expect(lines.some((l) => LISTEN_RE.test(l))).toBe(true);
  });

  test("a second daemon from the same config dir binds the same port", async () => {
    const dir = tmpConfigDir();
    const first = healthServer();
    const firstPort = await listenOnSavedPort(first, { configDir: dir, identity: loadOrCreateIdentity(dir), log: () => {} });
    await new Promise<void>((r) => first.close(() => r()));

    const secondPort = await listenOnSavedPort(healthServer(), {
      configDir: dir,
      identity: loadOrCreateIdentity(dir),
      log: () => {},
    });
    expect(secondPort).toBe(firstPort);
  });

  test("a squatter on the saved port forces a fallback, and the new port is recorded", async () => {
    const dir = tmpConfigDir();
    const first = healthServer();
    const takenPort = await listenOnSavedPort(first, { configDir: dir, identity: loadOrCreateIdentity(dir), log: () => {} });

    await new Promise<void>((r) => first.close(() => r()));
    // An unrelated process now owns that port: the daemon must not fail to
    // listen, it must ask the OS for another one and write that down.
    const squatter = net.createServer();
    closers.push(() => new Promise<void>((r) => squatter.close(() => r())));
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(takenPort, "127.0.0.1", () => resolve());
    });

    const identity = loadOrCreateIdentity(dir);
    expect(identity.port).toBe(takenPort);
    const lines: string[] = [];
    const port = await listenOnSavedPort(healthServer(), { configDir: dir, identity, log: (m) => lines.push(m) });

    expect(port).not.toBe(takenPort);
    expect((await get(port, "/health")).status).toBe(200);
    expect(fs.readFileSync(hookPortFile(dir), "utf-8")).toBe(String(port));
    const saved = readIdentity(dir)!;
    expect(saved.port).toBe(port);
    expect(saved.token).toBe(identity.token);
    // The fallback detail rides its own line so the listen line stays parseable.
    expect(lines).toContain(`Hook server port ${takenPort} is taken, asking the OS for another`);
    expect(lines).toContain(`Hook server listening on 127.0.0.1:${port}`);
  }, 15_000);

  test("the identity file the listen writes is still 0600", async () => {
    const dir = tmpConfigDir();
    await listenOnSavedPort(healthServer(), { configDir: dir, identity: loadOrCreateIdentity(dir), log: () => {} });
    expect((fs.statSync(identityFile(dir)).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(hookPortFile(dir)).mode & 0o777).toString(8)).toBe("600");
  });
});
