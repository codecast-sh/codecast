// Speaker presentation shared by the call stage and the calls page: one
// stable accent per voice so a conversation reads the same everywhere.
import { markedName } from "@codecast/shared/contracts";
import { fmtDuration } from "../triggerCadence";

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

/** How long a call ran, in the same form the thread's passages use. */
export function fmtCallLength(startedAt: number, endedAt: number | null): string {
  return endedAt ? fmtDuration(Math.max(1000, endedAt - startedAt)) : "live";
}
