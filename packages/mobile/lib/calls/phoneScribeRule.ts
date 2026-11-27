// When the phone scribes a huddle. The phone hears only its own microphone,
// so it is the scribe only while nobody else who could be is in the room: on a
// walk, alone in a session's room or a room of one. Everything else is web's
// rule (decideAutoScribe), so the opt-out, adoption and "who holds the run"
// answers never differ between the two clients; the server (transcripts.start)
// still arbitrates every start.
//
// When another person sits down, a phone holding the run gives the seat back
// ("release": transcripts.releaseScribe marks it open), so a web or desktop
// seat, which transcribes every track, takes the run over on its next look.
import { isAgentFaceIdentity, isGuestIdentity } from "@codecast/shared/contracts";
import { decideAutoScribe, type AutoScribeInput, type AutoScribeVerdict } from "@codecast/web/lib/calls/autoScribe";

export type PhoneScribeVerdict = AutoScribeVerdict | "release";

/** Another person seated who could scribe: not me, not an agent's face, not a guest. */
export function othersSeated(rosterIds: readonly string[], meId: string | null): boolean {
  return rosterIds.some((id) => id !== meId && !isAgentFaceIdentity(id) && !isGuestIdentity(id));
}

export function decidePhoneScribe(i: AutoScribeInput): PhoneScribeVerdict {
  const verdict = decideAutoScribe(i);
  const others = othersSeated(i.rosterIds, i.meId);
  if (i.scribeActive) return verdict === "hold" && others ? "release" : verdict;
  return others ? "hold" : verdict;
}
