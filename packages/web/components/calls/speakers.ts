// Speaker presentation shared by the call stage and the calls page: one
// stable accent per voice so a conversation reads the same everywhere.

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
  const total = Math.max(0, Math.floor(msFromStart / 1000));
  const s = String(total % 60).padStart(2, "0");
  if (total < 3600) return `${Math.floor(total / 60)}:${s}`;
  const m = String(Math.floor(total / 60) % 60).padStart(2, "0");
  return `${Math.floor(total / 3600)}:${m}:${s}`;
}
