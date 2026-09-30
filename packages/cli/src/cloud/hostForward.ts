/**
 * Reaching a cloud host daemon's loopback server from this laptop.
 *
 * The host daemon serves the terminal and the browser watch on its own
 * loopback, the same server this laptop's daemon runs. The web learns that
 * server's port and token through the daemon-command relay, but its probe of
 * 127.0.0.1 only ever reaches the machine the browser sits on, so a cloud
 * session's browser view and terminal had no way in. This module is the
 * missing hop: a loopback listener here whose every connection rides
 * `ssh -W` to the host's port, so the web talks to the host's server
 * unchanged (its token, its protocol) at a laptop port.
 *
 * Each connection is its own `ssh -W` channel on the ControlMaster `sshBase`
 * parks, so no handshake is paid per connection and nothing outlives its use:
 * the master persists 120s after the last channel, and the host's idle
 * watchdog then sees no inbound SSH and can put it to sleep. A listener with
 * no connection for FORWARD_IDLE_MS closes itself.
 */

import * as net from "node:net";
import { spawn } from "../proc.js";
import { hostForDevice, reachableRemoteHost, sshReachable, toRemoteHost } from "../browser/cloudHost.js";
import { sshBase, type RemoteHost } from "../remote/session-move.js";

export const FORWARD_IDLE_MS = 10 * 60_000;

export class HostForwardError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface Forward {
  server: net.Server;
  port: number;
  live: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const forwards = new Map<string, Promise<Forward>>();

/** The `ssh` argv that carries one connection to the host's loopback port. */
export function forwardSshArgs(host: RemoteHost, remotePort: number): string[] {
  return [...sshBase(host), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-W", `127.0.0.1:${remotePort}`, `${host.user}@${host.address}`];
}

/**
 * A laptop loopback port that reaches `remotePort` on the cloud host whose
 * codecast device is `deviceId`. Reuses a live listener for the same pair.
 * Never wakes a host: a sleeping one has no session to watch.
 */
export async function forwardToHost(
  deviceId: string,
  remotePort: number,
  deps: { resolve?: (deviceId: string) => Promise<RemoteHost | null> } = {},
): Promise<{ port: number }> {
  if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
    throw new HostForwardError(`not a daemon port: ${remotePort}`, 400);
  }
  const key = `${deviceId}:${remotePort}`;
  const existing = forwards.get(key);
  if (existing) {
    const f = await existing.catch(() => null);
    if (f?.server.listening) return { port: f.port };
    forwards.delete(key);
  }
  const resolve = deps.resolve ?? resolveHost;
  const pending = (async () => {
    const host = await resolve(deviceId);
    if (!host) throw new HostForwardError("that device is not a cloud host this laptop can reach", 404);
    return listen(key, host, remotePort);
  })();
  forwards.set(key, pending);
  try {
    return { port: (await pending).port };
  } catch (err) {
    forwards.delete(key);
    throw err;
  }
}

async function resolveHost(deviceId: string): Promise<RemoteHost | null> {
  const host = hostForDevice(deviceId);
  if (!host?.address) return null;
  return reachableRemoteHost(host, { toRemoteHost, sshReachable });
}

function listen(key: string, host: RemoteHost, remotePort: number): Promise<Forward> {
  return new Promise((resolve, reject) => {
    const f: Forward = { server: net.createServer(), port: 0, live: 0, idleTimer: null };
    const armIdle = () => {
      if (f.idleTimer) clearTimeout(f.idleTimer);
      f.idleTimer = setTimeout(() => { if (f.live === 0) close(); }, FORWARD_IDLE_MS);
      f.idleTimer.unref?.();
    };
    const close = () => {
      if (forwards.get(key)) forwards.delete(key);
      f.server.close();
    };
    f.server.on("connection", (sock) => {
      f.live++;
      if (f.idleTimer) { clearTimeout(f.idleTimer); f.idleTimer = null; }
      const child = spawn("ssh", forwardSshArgs(host, remotePort), { stdio: ["pipe", "pipe", "ignore"] });
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        f.live--;
        sock.destroy();
        try { child.kill("SIGTERM"); } catch { /* gone */ }
        if (f.live === 0) armIdle();
      };
      sock.pipe(child.stdin!);
      child.stdout!.pipe(sock);
      sock.on("error", end);
      sock.on("close", end);
      child.on("error", end);
      child.on("exit", end);
      child.stdin!.on("error", end);
    });
    f.server.once("error", reject);
    f.server.listen(0, "127.0.0.1", () => {
      f.port = (f.server.address() as net.AddressInfo).port;
      armIdle();
      resolve(f);
    });
    f.server.unref();
  });
}

/** Close every listener (daemon shutdown, tests). */
export async function closeHostForwards(): Promise<void> {
  const all = [...forwards.values()];
  forwards.clear();
  for (const p of all) {
    const f = await p.catch(() => null);
    if (f?.idleTimer) clearTimeout(f.idleTimer);
    f?.server.close();
  }
}
