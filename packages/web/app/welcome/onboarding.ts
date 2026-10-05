// Which /welcome screen someone sees, as a pure rule so it is testable
// without a browser. Three screens: sign in, connect mail and calendar, and
// the first useful thing. The connect screen drops out where the deployment
// cannot connect mail, and for anyone already connected or who chose "Not now".

export type WelcomeStep = "signin" | "connect" | "start";

/** The URL's way of saying the person skipped connecting (`?step=start`), so
 *  a reload or the back button keeps them where they were. */
export const SKIP_PARAM = "step";
export const SKIP_VALUE = "start";

export interface WelcomeFacts {
  signedIn: boolean;
  /** whisk.connectAvailable; undefined while it loads. */
  connectAvailable: boolean | undefined;
  /** Whether the mail connection has answered (useLaneMail `known`). */
  connectionsKnown: boolean;
  connected: boolean;
  skipped: boolean;
}

/** The screen to show, or null while what decides it is still loading. */
export function welcomeStep(f: WelcomeFacts): WelcomeStep | null {
  if (!f.signedIn) return "signin";
  if (f.connectAvailable === false) return "start";
  // Start's first ask depends on what is connected, so even a skipped visit
  // waits for the connections (and grant) to answer before it paints.
  if (!f.connectionsKnown) return null;
  if (f.skipped) return "start";
  if (f.connectAvailable === undefined) return null;
  return f.connected ? "start" : "connect";
}

/** The steps the progress rail shows. */
export function welcomeTrail(connectAvailable: boolean | undefined): WelcomeStep[] {
  return connectAvailable === false ? ["signin", "start"] : ["signin", "connect", "start"];
}

/** Which way a move between screens goes, so the motion follows it. */
export function stepDirection(from: WelcomeStep, to: WelcomeStep): "forward" | "back" {
  const order: WelcomeStep[] = ["signin", "connect", "start"];
  return order.indexOf(to) >= order.indexOf(from) ? "forward" : "back";
}
