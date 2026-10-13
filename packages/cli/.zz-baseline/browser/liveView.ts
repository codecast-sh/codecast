/**
 * Watching the remote machine's screen from here.
 *
 * The box streams its display as RTSP (VLC) and HLS (any browser), but both
 * listeners bind to the box's loopback — the screen shows logged-in pages, so
 * the only way in is the same SSH key that controls the machine. This module
 * owns that last hop: a background SSH tunnel from local loopback to the
 * box's, plus a one-frame screenshot for when a still is enough.
 *
 * Each tunnel is idempotent per host (ensureHostTunnel): running `hosts vnc`
 * or `hosts view` again converges on "the URLs work" rather than stacking ssh
 * processes, and a tunnel nobody uses exits by itself.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RemoteHost } from "../remote/session-move.js";
import { HLS_PORT, NOVNC_PORT, RTSP_PORT, SCREEN_DISPLAY } from "./hostScreen.js";
import { SHOT_TEMP_KIND } from "./shotFile.js";
import { freePort } from "./instance.js";
import { agentTempPath } from "../tempFiles.js";
import { hostScreenUrl } from "@codecast/shared/contracts";

/**
 * How long a VNC or view tunnel outlives its last viewer. The tunnel is an
 * SSH master of its own, and ControlPersist counts open forwarded
 * connections: a live noVNC socket or player keeps it up, and this long after
 * the last one closes it exits, so a forgotten viewer never keeps the host
 * awake (the idle watchdog counts inbound SSH as use).
 */
export const TUNNEL_IDLE_SECONDS = 600;

/** The control socket for one kind of tunnel to one host, and the file naming its local ports. */
export function tunnelSocket(host: RemoteHost, kind: string): string {
  return path.join(os.tmpdir(), `cast-${kind}-${host.user}-${host.address.replace(/[^\w.]/g, "_")}`);
}

/**
 * Local loopback ports that reach `remotePorts` on this host, through a
 * detached SSH master that ends itself when idle. Reused only when it is this
 * host's own tunnel and its ports answer: a fixed port reused on sight could
 * show a different host, or whatever else holds it. A local port keeps the
 * remote number when that is free, so the URLs stay familiar.
 */
export async function ensureHostTunnel(
  host: RemoteHost,
  kind: string,
  remotePorts: number[],
): Promise<{ localPorts: number[]; tunnelPid?: number }> {
  const socket = tunnelSocket(host, kind);
  const record = `${socket}.json`;
  const target = `${host.user}@${host.address}`;
  const alive = spawnSync("ssh", ["-S", socket, "-O", "check", target], { stdio: "ignore", timeout: 5_000 }).status === 0;
  if (alive) {
    try {
      const ports = JSON.parse(fs.readFileSync(record, "utf-8")).localPorts as number[];
      if (ports.length === remotePorts.length && (await Promise.all(ports.map((p) => portAnswers(p)))).every(Boolean)) {
        return { localPorts: ports };
      }
    } catch { /* no record: replace the tunnel */ }
    spawnSync("ssh", ["-S", socket, "-O", "exit", target], { stdio: "ignore", timeout: 5_000 });
  }
  const localPorts: number[] = [];
  for (const p of remotePorts) localPorts.push((await portAnswers(p)) ? await freePort() : p);
  const r = spawnSync(
    "ssh",
    ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "ConnectTimeout=20", "-o", "BatchMode=yes",
     "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
     "-o", "ExitOnForwardFailure=yes",
     "-o", "ControlMaster=yes", "-o", `ControlPath=${socket}`, "-o", `ControlPersist=${TUNNEL_IDLE_SECONDS}`,
     "-f", "-N",
     ...remotePorts.flatMap((p, i) => ["-L", `127.0.0.1:${localPorts[i]}:127.0.0.1:${p}`]),
     target],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf-8", timeout: 45_000 },
  );
  if (r.status !== 0) throw new Error(`could not open the ${kind} tunnel: ${(r.stderr || "ssh failed").trim().split("\n").pop()}`);
  fs.writeFileSync(record, JSON.stringify({ localPorts }));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await Promise.all(localPorts.map((p) => portAnswers(p)))).every(Boolean)) {
      const pid = Number(spawnSync("ssh", ["-S", socket, "-O", "check", target], { encoding: "utf-8", timeout: 5_000 }).stderr?.match(/pid=(\d+)/)?.[1]);
      return { localPorts, tunnelPid: pid || undefined };
    }
    await sleep(400);
  }
  spawnSync("ssh", ["-S", socket, "-O", "exit", target], { stdio: "ignore", timeout: 5_000 });
  throw new Error(`the ${kind} tunnel opened but nothing answered — re-run \`cast hosts provision\` to install the ${kind} service`);
}

/** Close this host's tunnel of that kind now, rather than at its idle timeout. */
export function closeHostTunnel(host: RemoteHost, kind: string): boolean {
  return spawnSync("ssh", ["-S", tunnelSocket(host, kind), "-O", "exit", `${host.user}@${host.address}`], { stdio: "ignore", timeout: 5_000 }).status === 0;
}

/**
 * Bring the machine-level VNC to local loopback and return the noVNC URL.
 *
 * This is the fallback below the in-app browser control: it shows the whole
 * X display, so anything outside the agent's tab (a popup window, a Chrome
 * dialog, a second window) is reachable. Only noVNC crosses the tunnel:
 * websockify on the box proxies to the VNC port there, and forwarding 5900
 * too collided with macOS Screen Sharing, which owns that port locally.
 */
export async function ensureVncTunnel(host: RemoteHost): Promise<{ url: string; tunnelPid?: number }> {
  const t = await ensureHostTunnel(host, "vnc", [NOVNC_PORT]);
  return { url: hostScreenUrl(t.localPorts[0]), tunnelPid: t.tunnelPid };
}

export interface ViewUrls {
  rtsp: string;
  hls: string;
  /** Set when this call created the tunnel (vs reusing one). */
  tunnelPid?: number;
}

function portAnswers(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (up: boolean) => { sock.destroy(); resolve(up); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/** Bring both view ports to local loopback; reuse this host's tunnel if it answers. */
export async function ensureViewTunnel(host: RemoteHost): Promise<ViewUrls> {
  const t = await ensureHostTunnel(host, "view", [RTSP_PORT, HLS_PORT]);
  return {
    rtsp: `rtsp://127.0.0.1:${t.localPorts[0]}/screen`,
    hls: `http://127.0.0.1:${t.localPorts[1]}/screen`,
    tunnelPid: t.tunnelPid,
  };
}

/**
 * One frame of the machine's display, saved locally. Captured on the box with
 * ffmpeg (already there from provisioning) and copied back — no stream, no
 * tunnel, just a still of whatever the screen shows right now.
 */
export function machineShot(host: RemoteHost, display = SCREEN_DISPLAY): string {
  execFileSync(
    "ssh",
    ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "BatchMode=yes", `${host.user}@${host.address}`,
     `ffmpeg -y -loglevel error -f x11grab -i ${display} -frames:v 1 /tmp/cast-machine-shot.png`],
    { timeout: 30_000, stdio: ["ignore", "ignore", "pipe"] },
  );
  const local = agentTempPath(SHOT_TEMP_KIND, `cast-machine-${Date.now()}.png`);
  execFileSync(
    "scp",
    ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "BatchMode=yes", `${host.user}@${host.address}:/tmp/cast-machine-shot.png`, local],
    { timeout: 30_000, stdio: ["ignore", "ignore", "pipe"] },
  );
  return local;
}
