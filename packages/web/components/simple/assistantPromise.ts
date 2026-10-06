// What the hosted assistant promises someone new, worded once for every way
// in: the marketing home page, signup and /welcome's sign in. Mail and
// calendar are promised only where this deployment can connect them through
// Whisk (whisk.connectAvailable); elsewhere the words say what works today.
// Light on purpose: the public pages import it, so it reaches neither the
// store nor the lane's model.
import { api } from "@codecast/convex/convex/_generated/api";
import { useState } from "react";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { askFirstFor } from "./askFirst";

export type ConnectAvailability = {
  /** The deployment's answer; undefined until it has given one. */
  available: boolean | undefined;
  /** No answer within the deadline (still asking in the background): a
   *  screen stops waiting and offers nothing that needs a yes. */
  failed: boolean;
};

/** How long a gate question may go unanswered before a screen stops waiting
 *  for it. */
export const GATE_DEADLINE_MS = 4000;
/** Pauses between asking again after no answer: a busy deployment answers late
 *  rather than never, and the screen follows when it does. */
const GATE_RETRY_MS = [4000, 8000, 16000];

/** A yes or no question to the deployment that keeps asking. `answer` is only
 *  ever what the deployment said: a dropped subscription or a failure is no
 *  answer yet, never a no. `late` turns true once the deadline passes without
 *  one, so a screen can stop waiting while the question is asked again. */
function useGate(query: typeof api.whisk.connectAvailable | typeof api.assistant.incidents.thinkingAvailable): {
  answer: boolean | undefined;
  late: boolean;
} {
  const res = useQueryNoThrow(query, {}, { breakAfterMs: GATE_DEADLINE_MS });
  const [tries, setTries] = useState(0);
  const { error, retry } = res;
  useWatchEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => {
      setTries((n) => n + 1);
      retry();
    }, GATE_RETRY_MS[Math.min(tries, GATE_RETRY_MS.length - 1)]);
    return () => clearTimeout(timer);
  }, [error, retry, tries]);
  const answer = error ? undefined : res.data;
  return { answer, late: answer === undefined && (!!error || tries > 0) };
}

export function useConnectAvailable(): ConnectAvailability {
  const { answer, late } = useGate(api.whisk.connectAvailable);
  return { available: answer, failed: late };
}

/** Whether the assistant can think right now (assistant/incidents.ts
 *  thinkingAvailable): false only when the deployment says no, undefined
 *  until it answers. Asks show on anything but a no, since the send path turns
 *  a real outage into its own notice; a slow answer never reads as an outage. */
export function useThinkingAvailable(): boolean | undefined {
  return useGate(api.assistant.incidents.thinkingAvailable).answer;
}

/** Said while no provider can serve a turn. Nothing queues meanwhile, so it
 *  promises no answer later; the server probes the provider and this clears
 *  by itself once it serves again (assistant/incidents.ts probe). */
export const THINKING_DOWN = "I'm having trouble thinking right now. Try again in a few minutes.";

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
  trip: "Plan a relaxed weekend away for two, with a rough budget",
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
    : `I draft notes, compare options, keep your lists and run routines. ${askFirstFor(null)}`;
}

/** Said on the first ask where mail cannot be connected yet, so the gap reads as planned. */
export const MAIL_COMING = "Mail and calendar are coming soon.";
