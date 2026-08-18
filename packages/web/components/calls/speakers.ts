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

export function fmtClock(msFromStart: number): string {
  const m = Math.floor(msFromStart / 60000);
  const s = String(Math.floor((msFromStart % 60000) / 1000)).padStart(2, "0");
  return `${m}:${s}`;
}
