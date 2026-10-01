// Speaker presentation shared by the call stage and the calls page: one
// stable accent per voice so a conversation reads the same everywhere.
import { formatCallTime } from "@codecast/shared/entities";
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

/**
 * A duration on a transcript's own clock: how far into the call this is, or
 * how long a recording has been running.
 *
 * Rolls into hours past sixty minutes. Without that, an afternoon-long
 * recording read "93:07", which is a number nobody converts in their head —
 * and a meeting recorder is exactly the surface that runs that long.
 */
export function fmtClock(msFromStart: number): string {
  // The same clock a moment reference is written in (`cl-42@12:34`), so the
  // time beside a line is the time an agent quotes to point at its frame.
  return formatCallTime(msFromStart);
}

/** How long a call ran, in the same form the thread's passages use. */
export function fmtCallLength(startedAt: number, endedAt: number | null): string {
  return endedAt ? fmtDuration(Math.max(1000, endedAt - startedAt)) : "live";
}
