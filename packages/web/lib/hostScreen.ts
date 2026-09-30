// The cloud host's whole screen, in a pane beside the agent's tab.
//
// The tab stream shows one page. Anything outside it (a second window, a
// file picker, a Chrome dialog, an extension popup) is only on the host's
// display. The pane (components/browser/backends/ScreenBackend.tsx) reaches
// it through this machine's daemon and draws it with noVNC's client.

import { openBrowserPane } from "./stage";

/** A machine whose screen the host serves: a remote Linux box (a provisioned cloud host) you can reach. */
export function hasHostScreen(machine: { is_remote?: boolean; platform?: string; is_mine?: boolean; via_bot?: boolean } | null | undefined): boolean {
  return !!machine?.is_remote && machine.platform === "linux" && !!machine.is_mine && !machine.via_bot;
}

/** Open the host's screen beside this pane; the pane says itself when it cannot reach it. */
export function openHostScreen(deviceId: string): void {
  openBrowserPane({ kind: "screen", deviceId });
}
