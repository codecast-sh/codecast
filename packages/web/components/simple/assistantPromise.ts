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

/** How long a gate question may go unanswered before it counts as "no": a
 *  deployment without the function, or one too busy to answer, never offers
 *  what it cannot vouch for. */
const GATE_DEADLINE_MS = 4000;

export function useConnectAvailable(): ConnectAvailability {
  const res = useQueryNoThrow(api.whisk.connectAvailable, {}, { breakAfterMs: GATE_DEADLINE_MS });
  return { available: res.error ? undefined : res.data, failed: !!res.error };
}

/** Whether the assistant can think right now (assistant/incidents.ts
 *  thinkingAvailable): true only once the deployment says so, false when it
 *  says no or cannot answer within the deadline, undefined for the moment
 *  before that. Asks are offered only on true, so a newcomer's first tap
 *  never lands on a turn that cannot run. */
export function useThinkingAvailable(): boolean | undefined {
  const res = useQueryNoThrow(api.assistant.incidents.thinkingAvailable, {}, { breakAfterMs: GATE_DEADLINE_MS });
  if (res.error) return false;
  return res.data;
}

/** Said before the person types while no provider can serve a turn. */
export const THINKING_DOWN = "I'm having trouble thinking right now. Anything you ask waits here, and I'll answer as soon as I'm back.";

/** The asks the lane suggests, worded once for home and /welcome. */
export const ASKS = {
  week: "Look through my email and calendar and tell me what needs me this week",
  replies: "What needs a reply from me this week?",
  overnight: "Every weekday at 8, tell me what came in overnight that matters",
  calendarWeek: "What's on my calendar this week, and when am I free?",
  focus: "Find a free hour for me to focus this week",
  morning: "Every weekday at 8, tell me what's on today",
  planWeek: "Help me plan my week. Ask me what's on my plate first.",
  sayNo: "Help me write a kind note saying no to an invitation",
  compare: "Compare the three best rated robot vacuums for a small apartment",
  mondays: "Every Monday at 9, remind me to plan the week",
} as const;

/** The assistant's one line of promise as a headline: /welcome's sign in and
 *  the marketing page's section for people who do not write code. */
export const ASSISTANT_HEADLINE = "An assistant for the busywork.";

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
