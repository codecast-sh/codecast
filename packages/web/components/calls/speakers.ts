// Speaker presentation shared by the call stage and the calls page: one
// stable accent per voice so a conversation reads the same everywhere.
import { callLength, isSpeakerKey, markedName, speakerColorIndex } from "@codecast/shared/contracts";

export const SPEAKER_COLORS = [
  "text-sol-cyan",
  "text-sol-green",
  "text-sol-yellow",
  "text-sol-violet",
  "text-sol-orange",
  "text-sol-magenta",
];

export function speakerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SPEAKER_COLORS[h % SPEAKER_COLORS.length];
}

/** A voice note's voice wears its cluster's color (spk:0 the first, as on
 *  the phone); any other speaker id keeps speakerColor. */
export function speakerAccent(key: string): string {
  return isSpeakerKey(key) ? SPEAKER_COLORS[speakerColorIndex(key, SPEAKER_COLORS.length)] : speakerColor(key);
}

export function firstName(name: string | undefined): string {
  const base = (name || "").split("@")[0];
  return base.split(/\s+/)[0] || "teammate";
}

/** A speaker's first name for a line of plain text, where no badge can
 *  follow: a guest keeps the mark the room put on their name
 *  (callSpeakerName) and an agent's face is marked by its identity
 *  (markedName), so "Ada (guest): words" never reads as a teammate. */
export function speakerShortName(name: string | undefined, identity?: string | null): string {
  return markedName(firstName(name), identity, name);
}

/** How long a call ran: the shared callLength, so the web and `cast calls`
 *  give a call one length. */
export { callLength as fmtCallLength };
