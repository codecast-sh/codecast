// Who said each line of a voice note, for the components that draw a line
// or a speaker (docs/architecture/speaker-attribution.md). The call page
// provides it (SpeakerAttribution) only for a recording whose lines carry
// voice keys; everywhere else it is null and the transcript draws as before.
// Plain .ts: component modules export only components.
import { createContext, useContext } from "react";
import type { ResolvedSpeaker, SpeakerRoster, WireCallSpeaker } from "@codecast/shared/contracts";

/** What the picker was opened for: a whole voice, or one line of it. */
export type SpeakerPickTarget = { kind: "speaker"; key: string } | { kind: "line"; seq: number; key: string };

export type SpeakerAttributionValue = {
  transcriptId: string;
  speakers: WireCallSpeaker[] | undefined;
  roster: SpeakerRoster;
  resolve: (segment: { speaker_id: string; speaker_name: string }) => ResolvedSpeaker;
  pick: (target: SpeakerPickTarget, anchor: Element) => void;
  /** The voice whose chip is under the pointer: its lines light, the rest step back. */
  setHoverKey: (key: string | null) => void;
};

/** A speaker or voice write's server leg. The store painted it already and
 *  owns the rest: a parked dispatch waits in the outbox, and a refusal puts
 *  the server's value back and says why in its own toast. The caller only
 *  keeps the rejection from surfacing again as an unhandled one. */
export function settleSpeakerWrite(write: Promise<unknown>): void {
  write.catch(() => {});
}

export const SpeakerAttributionContext = createContext<SpeakerAttributionValue | null>(null);

export function useSpeakerAttribution(): SpeakerAttributionValue | null {
  return useContext(SpeakerAttributionContext);
}
