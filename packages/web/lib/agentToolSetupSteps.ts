/**
 * The steps `cast browser` and `cast computer` need on a machine, read off the
 * machine's setup status (contracts/agentToolSetup.ts). The setup card under a
 * blocked command, the Agent features page and the /setup pages all draw these
 * same steps; each surface only decides how they look.
 */

import { BROWSER_EXTENSION_STORE_URL, type AgentSetupTool, type AgentToolSetupStatus } from "@codecast/shared/contracts";

export interface AgentSetupStep {
  label: string;
  /** The step as the next thing to do, for the one-line version. */
  next: string;
  hint?: string;
  done: boolean;
  /** A link the person follows, or a start the machine runs (`useAgentToolSetup().start`). */
  action?: { label: string; href: string } | { label: string; start: true };
}

type BrowserStatus = AgentToolSetupStatus & { tool: "browser" };
type ComputerStatus = AgentToolSetupStatus & { tool: "computer" };

function browserSteps(s: BrowserStatus | undefined): AgentSetupStep[] {
  // Daemons before the `installed` field only know whether it ever paired.
  const installed = s?.installed ?? !!s?.paired;
  return [
    {
      label: "Add Codecast to Chrome",
      next: "install the Chrome extension",
      hint: "Use the Chrome profile you want agents to work in.",
      done: installed || !!s?.connected,
      action: { label: "Add to Chrome", href: BROWSER_EXTENSION_STORE_URL },
    },
    {
      label: "Pair it with this machine",
      next: "pair it",
      hint: s?.paired && !s.connected
        ? s.chrome_running
          ? "Paired before but not answering: pair again, or reload it at chrome://extensions."
          : "Chrome is not running. Pairing starts it."
        : "Opens the extension in Chrome; click Pair there.",
      done: !!s?.connected,
      // Pairing an extension that is not there only opens an error page.
      action: s?.installed === false ? undefined : { label: s?.paired ? "Pair again" : "Pair", start: true },
    },
  ];
}

function computerSteps(s: ComputerStatus | undefined): AgentSetupStep[] {
  const open = { label: "Open System Settings", start: true as const };
  return [
    {
      label: "Accessibility",
      next: "turn on Accessibility",
      hint: "Lets the agent read a window and click, type and scroll in it.",
      done: !!s?.accessibility,
      action: open,
    },
    {
      label: "Screen Recording",
      next: "turn on Screen Recording",
      hint: "Lets it see a picture of the window it reads.",
      done: !!s?.screen_recording,
      action: s?.accessibility ? open : undefined,
    },
  ];
}

export function agentSetupSteps(tool: AgentSetupTool, status: AgentToolSetupStatus | undefined): AgentSetupStep[] {
  return tool === "browser"
    ? browserSteps(status as BrowserStatus | undefined)
    : computerSteps(status as ComputerStatus | undefined);
}

/** What the Codecast extension in the viewing Chrome profile wrote onto the setup page (background.js tellSetupPage). */
export interface ThisProfileExtension {
  state: string;
  connected: boolean;
  version?: string;
}

/**
 * The machine answers for every Chrome profile at once: "connected" means
 * some profile is. A setup page open in a profile whose own extension is not
 * connected must not say Ready, so that profile's word wins when it spoke.
 */
export function withThisProfile(status: AgentToolSetupStatus | undefined, ext: ThisProfileExtension | null): AgentToolSetupStatus | undefined {
  if (!ext || status?.tool !== "browser") return status;
  return { ...status, installed: true, connected: ext.connected, ready: ext.connected, paired: ext.connected || (status.paired && ext.state !== "no-config") };
}

/** Reads the extension's note off the page, or null when this profile's extension wrote none (not installed, or a build before 0.1.8). */
export function readThisProfileExtension(raw: string | undefined): ThisProfileExtension | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ThisProfileExtension>;
    return typeof v.state === "string" ? { state: v.state, connected: !!v.connected, version: v.version } : null;
  } catch {
    return null;
  }
}
