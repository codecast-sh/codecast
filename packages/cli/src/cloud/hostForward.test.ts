/**
 * The laptop's forward into a cloud host's loopback server: bytes cross both
 * ways, a second ask reuses the listener, a quiet listener closes itself, and
 * a device that is not a host is refused. The dialer stands in for `ssh -W`
 * with a local pipe to an echo server, which is the same stdio contract.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { closeHostForwards, forwardSshArgs, forwardToHost, HostForwardError } from "./hostForward.js";

const HOST = { address: "203.0.113.7", user: "ubuntu", keyPath: "/k.pem", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };

// `ssh -W` hands one TCP connection to stdio; this does the same to a local port.
const PIPE = `const s=require("net").connect(+process.argv[1],"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("close",()=>process.exit(0));`;
const dialLocal = (_h: unknown, port: number): [string, string[]] => [process.execPath, ["-e", PIPE, String(port)]];

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.pipe(s));
    srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
}

function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(text));
    s.once("data", (d) => { resolve(d.toString()); s.destroy(); });
    s.once("error", reject);
  });
}

const answered = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});

afterEach(closeHostForwards);

describe("forwardToHost", () => {
  test("carries a connection both ways and reuses the listener", async () => {
    const echo = await echoServer();
    try {
      const deps = { resolve: async () => HOST, dial: dialLocal };
      const f = await forwardToHost("dev-a", echo.port, deps);
      expect(await roundTrip(f.port, "hello host")).toBe("hello host");
      expect((await forwardToHost("dev-a", echo.port, deps)).port).toBe(f.port);
    } finally {
      echo.close();
    }
  });

  test("a listener nobody uses closes itself", async () => {
    const echo = await echoServer();
    try {
      const f = await forwardToHost("dev-b", echo.port, { resolve: async () => HOST, dial: dialLocal, idleMs: 150 });
      expect(await roundTrip(f.port, "x")).toBe("x");
      await new Promise((r) => setTimeout(r, 500));
      expect(await answered(f.port)).toBe(false);
    } finally {
      echo.close();
    }
  });

  test("refuses a device that is not a host, and a port that is not a daemon's", async () => {
    const notAHost = forwardToHost("dev-c", 40000, { resolve: async () => null });
    await expect(notAHost).rejects.toBeInstanceOf(HostForwardError);
    await expect(notAHost).rejects.toMatchObject({ status: 404 });
    await expect(forwardToHost("dev-c", 22, { resolve: async () => HOST })).rejects.toMatchObject({ status: 400 });
  });

  test("rides the parked ControlMaster, never prompts, and targets the host's loopback", () => {
    const args = forwardSshArgs(HOST, 34427);
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(-3)).toEqual(["-W", "127.0.0.1:34427", "ubuntu@203.0.113.7"]);
  });
});
