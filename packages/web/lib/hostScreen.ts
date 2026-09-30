// The cloud host's whole screen, in a pane beside the agent's tab.
//
// The tab stream shows one page. Anything outside it (a second window, a
// file picker, a Chrome dialog, an extension popup) is only on the host's
// display, which the host serves as noVNC on its own loopback. This machine's
// daemon forwards that port (packages/cli/src/cloud/hostForward.ts), so the
// screen opens at a local URL with mouse and keyboard.

import type { ConvexReactClient } from "convex/react";
import { HOST_NOVNC_PORT, hostScreenUrl } from "@codecast/shared/contracts";
import { forwardHostPort } from "./terminal/endpoint";
import { openBrowserPane } from "./stage";

/** A machine whose screen the host serves: a remote Linux box (a provisioned cloud host). */
export function hasHostScreen(machine: { is_remote?: boolean; platform?: string; is_mine?: boolean; via_bot?: boolean } | null | undefined): boolean {
  return !!machine?.is_remote && machine.platform === "linux" && !!machine.is_mine && !machine.via_bot;
}

/** Open the host's screen beside this pane. Returns why it could not, or null. */
export async function openHostScreen(convex: ConvexReactClient, deviceId: string): Promise<string | null> {
  const port = await forwardHostPort(convex, deviceId, HOST_NOVNC_PORT);
  if (port === null) return "The screen opens through the laptop that manages this host; open it from there";
  openBrowserPane({ kind: "url", url: hostScreenUrl(port) });
  return null;
}
