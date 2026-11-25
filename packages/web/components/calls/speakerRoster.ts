// Who a voice note's speakers are, by name, for every web surface that prints
// a line: the transcript, the passage previews, the excerpt sent to an agent
// and the picker. Names come from callSpeakerRoster (the server's
// speaker_names for the recording's own team win over the local roster); the
// picker's teammates are the store's roster only when it is the recording's
// team, so a recording in another team never offers this team's people.
// Plain .ts: component modules export only components.
import { useMemo } from "react";
import { callSpeakerRoster, resolveLineSpeaker, type SpeakerRoster, type WireCallSpeaker } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";

export type PickerPerson = { _id: string; name?: string; image?: string };

type CallNames = { team_id?: unknown; speaker_names?: Readonly<Record<string, string>> | null; speakers?: WireCallSpeaker[] } | null | undefined;

export function useSpeakerPeople(call: CallNames): { people: PickerPerson[]; roster: SpeakerRoster } {
  const identities = useTeamRosterIdentity();
  const activeTeam = useInboxStore((s) => activeTeamIdOf(s));
  const sameTeam = !call?.team_id || String(call.team_id) === activeTeam;
  const names = call?.speaker_names;
  return useMemo(() => {
    const members = sameTeam ? identities : [];
    const people = members
      .filter((m) => !m.is_bot && !m.role)
      .map((m) => ({ _id: m._id, name: m.name ?? m.email, image: m.image ?? m.github_avatar_url }));
    return { people, roster: callSpeakerRoster({ speaker_names: names }, members) };
  }, [identities, sameTeam, names]);
}

/** The call's lines with each voice note line's speaker_name resolved, so
 *  anything built from them (turns, previews, aria labels, an excerpt) names
 *  who said it. Lines that are not diarized, or need no change, keep their
 *  object, and with `enabled` off the array comes back as is. */
export function useNamedSegments<T extends { speaker_id: string; speaker_name: string }>(
  call: CallNames,
  segments: T[] | undefined,
  enabled: boolean,
): T[] | undefined {
  const { roster } = useSpeakerPeople(call);
  const speakers = call?.speakers;
  return useMemo(() => {
    if (!enabled || !segments) return segments;
    return segments.map((s) => {
      const name = resolveLineSpeaker(s, speakers, roster).name;
      return name === s.speaker_name ? s : { ...s, speaker_name: name };
    });
  }, [enabled, segments, speakers, roster]);
}
