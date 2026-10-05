// What the hosted assistant promises someone new, worded once for every way
// in: the marketing home page, signup and /welcome's sign in. Mail and
// calendar are promised only where this deployment can connect Google
// (googleOAuth.connectAvailable); elsewhere the words say what works today.
// Light on purpose: the public pages import it, so it reaches neither the
// store nor the lane's model.
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { ASK_FIRST, askFirst } from "./askFirst";

export type ConnectAvailability = {
  /** True or false once the deployment has answered; undefined while it loads or after it failed. */
  available: boolean | undefined;
  /** The question could not be answered. */
  failed: boolean;
};

export function useConnectAvailable(): ConnectAvailability {
  const res = useQueryNoThrow(api.googleOAuth.connectAvailable, {});
  return { available: res.error ? undefined : res.data, failed: !!res.error };
}

/** The link that invites a visitor who does not write code. */
export function assistantInvite(mail: boolean): string {
  return mail ? "Get an assistant for your email and calendar" : "Get a personal assistant";
}

/** The one line under the sign in heading, in the assistant's own voice and
 *  ending on the same promise the lane makes. */
export function assistantPromise(mail: boolean): string {
  return mail
    ? `I read your mail, find time on your calendar and handle the follow-ups. ${ASK_FIRST}`
    : `Ask me for help with plans, notes and decisions. ${askFirst("act for you")}`;
}

/** Said on the first ask where Google cannot be connected yet, so the gap reads as planned. */
export const MAIL_COMING = "Email and calendar are on their way. Until then, ask me anything else.";
