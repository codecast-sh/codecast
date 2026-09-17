/**
 * The CDP port forward's argv. Shared by the remote browser launch (a
 * long-lived, detached tunnel) and the cookie carry into a cloud host's
 * Chrome (a short-lived one), so its shape is pinned once here.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { cdpTunnelArgs, withCdpTunnel } from "./remote.js";

const host = { address: "1.2.3.4", user: "ubuntu", keyPath: "/k/id", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };

describe("cdpTunnelArgs", () => {
  test("binds 127.0.0.1 on both ends, runs no command, fails on a taken port, and never rides the shared master", () => {
    const args = cdpTunnelArgs(host, 45678, 37121);
    expect(args).toEqual([
      "-i", "/k/id",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=20",
      "-o", "BatchMode=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-N",
      "-L", "127.0.0.1:45678:127.0.0.1:37121",
      "-o", "ExitOnForwardFailure=yes",
      "ubuntu@1.2.3.4",
    ]);
    expect(args.join(" ")).not.toMatch(/ControlMaster|ControlPath|ControlPersist/);
  });

});

/** The tunnel spawns after `freePort()` resolves; wait for the child to exist. */
const spawned = () => new Promise<void>((r) => setTimeout(r, 20));

/** A fake ssh child: records argv, exposes kill, and lets a test end it. */
function fakeSsh() {
  const spawned: { cmd: string; args: string[]; opts: any }[] = [];
  const children: (EventEmitter & { kill: (sig?: string) => boolean; killed: string[]; stderr: EventEmitter })[] = [];
  const spawn = ((cmd: string, args: string[], opts: any) => {
    spawned.push({ cmd, args, opts });
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      killed: [] as string[],
      kill(sig = "SIGTERM") { child.killed.push(sig); setTimeout(() => child.emit("exit", null), 0); return true; },
    });
    children.push(child);
    return child;
  }) as any;
  return { spawn, spawned, children };
}

describe("withCdpTunnel", () => {
  test("opens the forward with the pinned argv, an attached child and stderr captured; closes it when fn is done", async () => {
    const ssh = fakeSsh();
    const r = await withCdpTunnel(host, 37121, async (port) => `cdp on ${port}`, { spawn: ssh.spawn, isCdpAlive: async () => true });
    expect(r).toMatch(/^cdp on \d+$/);
    expect(ssh.spawned).toHaveLength(1);
    expect(ssh.spawned[0].cmd).toBe("ssh");
    const forward = ssh.spawned[0].args.indexOf("-L") + 1;
    expect(ssh.spawned[0].args[forward]).toMatch(/^127\.0\.0\.1:\d+:127\.0\.0\.1:37121$/);
    expect(ssh.spawned[0].args.filter((_, i) => i !== forward)).toEqual(cdpTunnelArgs(host, 1, 37121).filter((a) => !a.startsWith("127.0.0.1:")));
    expect(ssh.spawned[0].opts).toEqual({ stdio: ["ignore", "ignore", "pipe"] });
    expect(ssh.children[0].killed).toEqual(["SIGTERM"]);
  });

  test("names ssh, not the host's Chrome, when ssh cannot start or exits before the forward is up", async () => {
    const cannotStart = fakeSsh();
    const p1 = withCdpTunnel(host, 37121, async () => "never", { spawn: cannotStart.spawn, isCdpAlive: async () => false });
    await spawned();
    cannotStart.children[0].emit("error", new Error("spawn ssh ENOENT"));
    await expect(p1).rejects.toThrow("ssh could not start: spawn ssh ENOENT");

    const refused = fakeSsh();
    const p2 = withCdpTunnel(host, 37121, async () => "never", { spawn: refused.spawn, isCdpAlive: async () => false });
    await spawned();
    refused.children[0].stderr.emit("data", "Warning: Permanently added\nssh: connect to host 1.2.3.4 port 22: Connection refused\n");
    refused.children[0].emit("exit", 255);
    await expect(p2).rejects.toThrow("ssh exited with code 255 before the forward came up: Warning: Permanently added");
  });

  test("a silent Chrome is reported as the host's Chrome after connectMs", async () => {
    const ssh = fakeSsh();
    await expect(withCdpTunnel(host, 37121, async () => "never", { spawn: ssh.spawn, isCdpAlive: async () => false, connectMs: 1 }))
      .rejects.toThrow("the host's Chrome on port 37121 never answered through the tunnel");
    expect(ssh.children[0].killed).toEqual(["SIGTERM"]);
  });

  test("deadlineMs bounds the whole run, fn included, and closes the tunnel", async () => {
    const ssh = fakeSsh();
    let fnDone = false;
    const p = withCdpTunnel(host, 37121, () => new Promise<string>((r) => setTimeout(() => { fnDone = true; r("late"); }, 200)), {
      spawn: ssh.spawn, isCdpAlive: async () => true, deadlineMs: 20,
    });
    await expect(p).rejects.toThrow("the login carry did not finish within 0s; the tunnel was closed");
    expect(fnDone).toBe(false);
    expect(ssh.children[0].killed).toEqual(["SIGTERM"]);
  });
});
