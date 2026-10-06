// Which /welcome screen someone sees, as a pure rule so it is testable
// without a browser. The funnel is two steps, sign in and the first useful
// thing, so a newcomer sees the assistant answer before any outside consent
// screen. Connecting mail and calendar is a side screen: the person opens it
// from Start's "Connect it" (or comes back to it from Whisk), and only where
// the deployment has said connect works.

export type WelcomeStep = "signin" | "connect" | "start";

/** The URL's way of naming a screen (`?step=connect`), so a reload or the
 *  back button keeps the person where they were. `?step=start` is what
 *  older links and the skip button wrote; it lands on Start. */
export const STEP_PARAM = "step";
export const CONNECT_VALUE = "connect";

export interface WelcomeFacts {
  signedIn: boolean;
  /** whisk.connectAvailable; undefined while it loads or when it failed. */
  connectAvailable: boolean | undefined;
  /** Whether the mail connection has answered (useLaneMail `known`). */
  connectionsKnown: boolean;
  connected: boolean;
  /** The person asked for the connect screen (`?step=connect`). */
  connecting: boolean;
}

/** The screen to show, or null while what decides it is still loading. */
export function welcomeStep(f: WelcomeFacts): WelcomeStep | null {
  if (!f.signedIn) return "signin";
  // Start's asks depend on what is connected, so it waits for the
  // connection (and its grant) to answer before it paints.
  if (!f.connectionsKnown) return null;
  if (f.connecting && f.connectAvailable === true && !f.connected) return "connect";
  return "start";
}

/** The steps the progress rail names. Fixed, so the rail reads the same
 *  while the page loads. */
export const WELCOME_TRAIL: WelcomeStep[] = ["signin", "start"];

/** The rail position a screen stands at: the connect screen is part of
 *  starting, not a step of its own. */
export function trailStep(step: WelcomeStep): WelcomeStep {
  return step === "connect" ? "start" : step;
}

/** Which way a move between screens goes, so the motion follows it. */
export function stepDirection(from: WelcomeStep, to: WelcomeStep): "forward" | "back" {
  const order: WelcomeStep[] = ["signin", "start", "connect"];
  return order.indexOf(to) >= order.indexOf(from) ? "forward" : "back";
}
