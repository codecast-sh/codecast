// When the phone scribes a huddle. The phone hears only its own microphone,
// so it scribes only while no seat that can hear every track (web or
// desktop) is in the room: on a walk, alone in a session's room or a room of
// one, or with other phones. Everything else is web's rule (decideAutoScribe),
// so the opt-out, adoption and "who holds the run" answers never differ
// between the clients; the server (transcripts.start) arbitrates every start.
//
// When a web or desktop seat sits down, a phone holding the run gives the seat
// back ("release": scribeSeat.releaseScribe marks it open), and that seat's
// own decideAutoScribe takes it on its next look (an open seat reads as
// startedBy null, which is "start"). The phone never asks again while such a
// seat is there, so the run cannot bounce back. Two phones never release to
// each other: whichever asked first keeps it.
import { isAgentFaceIdentity, isGuestIdentity } from "@codecast/shared/contracts";
import { decideAutoScribe, type AutoScribeInput, type AutoScribeVerdict } from "@codecast/web/lib/calls/autoScribe";

export type PhoneScribeVerdict = AutoScribeVerdict | "release";

export type PhoneScribeInput = AutoScribeInput & {
  /** Seats that are phones (token metadata `client: "phone"`). */
  phoneIds: readonly string[];
};

/** A seat other than mine that transcribes every track: a person's, not an
 *  agent's face or a guest's, and not a phone's. */
export function fullScribeSeated(i: PhoneScribeInput): boolean {
  return i.rosterIds.some(
    (id) => id !== i.meId && !isAgentFaceIdentity(id) && !isGuestIdentity(id) && !i.phoneIds.includes(id),
  );
}

export function decidePhoneScribe(i: PhoneScribeInput): PhoneScribeVerdict {
  const verdict = decideAutoScribe(i);
  const yieldTo = fullScribeSeated(i);
  if (i.scribeActive) return verdict === "hold" && yieldTo ? "release" : verdict;
  return yieldTo ? "hold" : verdict;
}
