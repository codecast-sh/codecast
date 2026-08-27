/**
 * Watching the remote machine's screen from here.
 *
 * The box streams its display as RTSP (VLC) and HLS (any browser), but both
 * listeners bind to the box's loopback — the screen shows logged-in pages, so
 * the only way in is the same SSH key that controls the machine. This module
 * owns that last hop: a background SSH tunnel from local loopback to the
 * box's, plus a one-frame screenshot for when a still is enough.
 *
 * The tunnel is idempotent: if the local port already answers, whatever holds
 * it is presumed to be a live tunnel and reused. That makes `hosts view` safe
 * to run repeatedly — it converges on "the URLs work" rather than stacking
 * ssh processes.
 */

import { execFileSync } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "../proc.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { RemoteHost } from "../remote/session-move.js";
import { HLS_PORT, NOVNC_PORT, RTSP_PORT, VNC_PORT } from "./provisionLinux.js";

/**
 * Bring the machine-level VNC to local loopback and return the noVNC URL.
 *
 * This is the fallback below the in-app browser control: it shows the whole
 * X display, so anything outside the agent's tab — a popup window, a Chrome
 * dialog, a second window — is reachable. Same shape as the view tunnel:
 * idempotent, reuses a tunnel that already answers.
 */
export async function ensureVncTunnel(host: RemoteHost): Promise<{ url: string; tunnelPid?: number }> {
  const url = `http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=scale&path=`;
  if (await portAnswers(NOVNC_PORT)) return { url };
  const tunnel = spawn(
    "ssh",
    ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "ConnectTimeout=20", "-o", "BatchMode=yes",
     "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
     "-o", "ExitOnForwardFailure=yes",
     "-N",
     // Only noVNC crosses the tunnel: websockify on the box proxies to the
     // VNC port there. Forwarding 5900 too collided with macOS Screen
     // Sharing, which owns that port locally, and ExitOnForwardFailure then
     // took the whole tunnel down with it.
     "-L", `127.0.0.1:${NOVNC_PORT}:127.0.0.1:${NOVNC_PORT}`,
     `${host.user}@${host.address}`],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  tunnel.unref();
  if (!tunnel.pid) throw new Error("could not start the VNC tunnel");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await portAnswers(NOVNC_PORT)) return { url, tunnelPid: tunnel.pid };
    await sleep(400);
  }
  try { process.kill(tunnel.pid, "SIGTERM"); } catch { /* gone */ }
  throw new Error("the VNC tunnel never came up — re-run `cast browser hosts provision` to install it");
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

/** Bring both view ports to local loopback; reuse an existing tunnel if one answers. */
export async function ensureViewTunnel(host: RemoteHost): Promise<ViewUrls> {
  const urls = {
    rtsp: `rtsp://127.0.0.1:${RTSP_PORT}/screen`,
    hls: `http://127.0.0.1:${HLS_PORT}/screen`,
  };
  if (await portAnswers(RTSP_PORT)) return urls;

  const tunnel = spawn(
    "ssh",
    ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "ConnectTimeout=20", "-o", "BatchMode=yes",
     "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
     "-o", "ExitOnForwardFailure=yes",
     "-N",
     "-L", `127.0.0.1:${RTSP_PORT}:127.0.0.1:${RTSP_PORT}`,
     "-L", `127.0.0.1:${HLS_PORT}:127.0.0.1:${HLS_PORT}`,
     `${host.user}@${host.address}`],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  tunnel.unref();
  if (!tunnel.pid) throw new Error("could not start the view tunnel");

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await portAnswers(RTSP_PORT)) return { ...urls, tunnelPid: tunnel.pid };
    await sleep(400);
  }
  try { process.kill(tunnel.pid, "SIGTERM"); } catch { /* gone */ }
  throw new Error("the view tunnel never came up — is the host provisioned? (`cast browser hosts provision`)");
}

/**
 * One frame of the machine's display, saved locally. Captured on the box with
 * ffmpeg (already there from provisioning) and copied back — no stream, no
 * tunnel, just a still of whatever the screen shows right now.
 */
export function machineShot(host: RemoteHost, display = ":99"): string {
  execFileSync(
    "ssh",
    ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "BatchMode=yes", `${host.user}@${host.address}`,
     `ffmpeg -y -loglevel error -f x11grab -i ${display} -frames:v 1 /tmp/cast-machine-shot.png`],
    { timeout: 30_000, stdio: ["ignore", "ignore", "pipe"] },
  );
  const local = path.join(os.tmpdir(), `cast-machine-${Date.now()}.png`);
  execFileSync(
    "scp",
    ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
     "-o", "BatchMode=yes", `${host.user}@${host.address}:/tmp/cast-machine-shot.png`, local],
    { timeout: 30_000, stdio: ["ignore", "ignore", "pipe"] },
  );
  return local;
}
