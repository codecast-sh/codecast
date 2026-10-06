// What the hosted assistant promises someone new, worded once for every way
// in: the marketing home page, signup and /welcome's sign in. Mail and
// calendar are promised only where this deployment can connect them through
// Whisk (whisk.connectAvailable); elsewhere the words say what works today.
// Light on purpose: the public pages import it, so it reaches neither the
// store nor the lane's model.
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { askFirstFor } from "./askFirst";

export type ConnectAvailability = {
  /** True or false once the deployment has answered; undefined while it loads or after it failed. */
  available: boolean | undefined;
  /** The question could not be answered. */
  failed: boolean;
};

export function useConnectAvailable(): ConnectAvailability {
  const res = useQueryNoThrow(api.whisk.connectAvailable, {});
  return { available: res.error ? undefined : res.data, failed: !!res.error };
}

/** Whether the assistant can think right now (assistant/incidents.ts
 *  thinkingAvailable). True until the deployment says otherwise, and when
 *  the question fails: a worry is said only when it is known. */
export function useThinkingAvailable(): boolean {
  return useQueryNoThrow(api.assistant.incidents.thinkingAvailable, {}).data !== false;
}

/** Said before the person types while no provider can serve a turn. */
export const THINKING_DOWN = "I'm having trouble thinking right now. Anything you ask waits here, and I'll answer as soon as I'm back.";

/** The link that invites a visitor who does not write code. */
export function assistantInvite(mail: boolean): string {
  return mail
    ? "Get an assistant for your errands, notes and routines, mail included"
    : "Get an assistant for your errands, notes and routines";
}

/** The one line under the sign in heading, in the assistant's own voice and
 *  ending on the same promise the lane makes. */
export function assistantPromise(mail: boolean): string {
  return mail
    ? `I read your mail, find time on your calendar and handle the follow-ups. ${askFirstFor({ send_mail: true, calendar: true })}`
    : `Ask me for help with plans, notes and decisions. ${askFirstFor(null)}`;
}

/** Said on the first ask where mail cannot be connected yet, so the gap reads as planned. */
export const MAIL_COMING = "Email and calendar are on their way. Until then, ask me anything else.";
