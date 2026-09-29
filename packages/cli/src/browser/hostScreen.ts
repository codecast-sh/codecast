/**
 * The cloud host's shared screen: one Xvfb display that the host's Chrome
 * paints into and that the live view (RTSP/HLS) and machine VNC capture.
 * A leaf module, so the launch path can read it without the provisioning
 * graph (provisionLinux.ts installs the services that serve these).
 */

import * as fs from "node:fs";

/** The Xvfb display everything on the box shares. */
export const SCREEN_DISPLAY = ":99";
export const SCREEN_SIZE = { width: 1440, height: 900 };
/** Loopback ports on the box; reached from here through an SSH tunnel. */
export const RTSP_PORT = 8554;
export const HLS_PORT = 8888;
/** Machine-level VNC (x11vnc) and its browser client (noVNC via websockify). */
export const VNC_PORT = 5900;
export const NOVNC_PORT = 6080;

/** The X server's unix socket for a display: its existence means the server is up. */
export function xSocketPath(display: string): string {
  return `/tmp/.X11-unix/X${display.replace(/^:/, "").split(".")[0]}`;
}

/**
 * Where a headed Chrome paints on Linux. Agents on a cloud host inherit the
 * daemon's environment, which has no DISPLAY, and a headed Chrome with no
 * display exits before CDP comes up. The box's own Xvfb is the screen the
 * live view and VNC show, so a launch without DISPLAY lands there; with no X
 * server at all the launch goes headless rather than dying.
 */
export function linuxDisplayPlan(
  env: NodeJS.ProcessEnv,
  headless: boolean,
  hasSocket: (path: string) => boolean = fs.existsSync,
): { display: string | null; headless: boolean } {
  if (headless) return { display: null, headless: true };
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return { display: null, headless: false };
  if (hasSocket(xSocketPath(SCREEN_DISPLAY))) return { display: SCREEN_DISPLAY, headless: false };
  return { display: null, headless: true };
}
