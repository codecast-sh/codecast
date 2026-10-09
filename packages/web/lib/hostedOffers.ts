// What a hosted reply offers under it, read from its words: the mail and
// calendar connection when it says to connect (or that mail is coming), and
// the same errand as a routine after a first finished answer that repeats.
// Pure, so the web's chips (conversation/HostedNotice) and the phone's
// session screen read one rule.
import { replyAsksPerson } from "@codecast/shared/contracts/assistant";

/** Whether a reply offers to connect mail and calendar (the tool set's note
 *  asks the assistant to, when they are not connected). */
export function offersMailConnect(text: string | null | undefined): boolean {
  const t = text ?? "";
  // Where connecting is closed the assistant says mail is coming through
  // Whisk instead; the chip then offers Whisk on its own (UseWhiskNow).
  return /\b(?:re)?connect\b[^.?!\n]{0,40}\b(?:mail|email|calendar)\b/i.test(t) || /\b(?:mail|email|calendar)\b[^.?!\n]{0,40}\bcoming soon\b/i.test(t);
}

export type RoutineOffer = { label: string; ask: string };

/** Errands that are worth repeating, each with the cadence its offer names.
 *  An errand that matches none (a note, a trip, a comparison, a draft) is
 *  done once, and offering it weekly would read as a misunderstanding. */
const REPEATABLE: readonly { shape: RegExp; when: string }[] = [
  { shape: /\b(news|headlines|weather|forecast|digest|briefing|summar(?:y|ise|ize))\b/i, when: "every morning" },
  // The week's planning itself, not a list that happens to be inside an
  // errand ("a short checklist for the night before" is part of one trip).
  { shape: /\b(plan (?:my|the) week|weekly review|review my (?:to-?dos?|list)|what'?s (?:still )?open)\b/i, when: "every Monday" },
  { shape: /\b(prices?|deals?|sales?|check (?:on|for|if|whether)|keep an eye|track|status of)\b/i, when: "every week" },
];

/** An errand tied to one date or one event happens once, whatever words it
 *  shares with a repeating one. */
const ONE_OFF = /\b(trip|vacation|holiday|party|wedding|birthday|event|move|moving|tomorrow|tonight|this (?:weekend|week|month)|next (?:week|month|weekend)|(?:in|on|for) (?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))\b/i;

/** The follow-up a first finished answer offers, or null: the same errand as
 *  a routine, worded with the cadence the errand suggests ("Do this every
 *  morning?"). Offered only after the conversation's first answer, finished,
 *  not asking the person anything in its last paragraph, for an errand that
 *  repeats and was not already about a schedule. */
export function routineOffer(reply: string | null | undefined, asked: string | undefined, personTurns: number, working: boolean): RoutineOffer | null {
  const text = reply?.trim() ?? "";
  if (working || personTurns !== 1 || !text || replyAsksPerson(text)) return null;
  const errand = asked ?? "";
  if (/\b(every|each|daily|weekly|weekday|routine|remind)\b/i.test(errand) || ONE_OFF.test(errand)) return null;
  const match = REPEATABLE.find((r) => r.shape.test(errand));
  return match ? { label: `Do this ${match.when}?`, ask: `Do this for me ${match.when}.` } : null;
}
