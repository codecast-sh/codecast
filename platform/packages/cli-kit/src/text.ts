import * as fs from "fs";

// Plumbing every terminal client shares: column layout that ignores colour
// codes, JSON for machines, a body read from an argument, a file or stdin,
// and the "3d" style cutoff a --since flag takes.

export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function pad(text: string, width: number): string {
  const visible = visibleLength(text);
  return visible >= width ? text : text + " ".repeat(width - visible);
}

export function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : flat.slice(0, Math.max(0, width - 1)) + "…";
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The body from the positional argument, --body-file, or stdin.
 *  A lone "-" (or nothing, when stdin is not a terminal) reads stdin.
 *  Stdin is read straight off fd 0: under Bun, iterating `process.stdin`
 *  yields nothing when stdin is a file (a heredoc or `< file`) and any module
 *  touched the stream earlier, which every prompt library does at import. */
export async function readBody(positional: string | undefined, opts: { bodyFile?: string }): Promise<string> {
  if (opts.bodyFile) return fs.readFileSync(opts.bodyFile, "utf8");
  if (positional !== undefined && positional !== "-") return positional;
  if (process.stdin.isTTY && positional !== "-") return "";
  return fs.readFileSync(0, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
}

/** "3d" style durations for --since filters, or a date: epoch millis of the cutoff. */
export function parseSince(text: string, now: number = Date.now()): number | null {
  const m = text.trim().match(/^(\d+)\s*(h|d|w|m)$/);
  if (m) {
    const ms = { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 30 * 86_400_000 }[m[2] as "h" | "d" | "w" | "m"];
    return now - Number(m[1]) * ms;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/** "2h", "3d", "just now": how long ago, in the shortest words. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d`;
  const w = Math.round(d / 7);
  if (w < 9) return `${w}w`;
  const date = new Date(ts);
  return date.getFullYear() === new Date(now).getFullYear()
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleDateString(undefined, { year: "2-digit", month: "short" });
}
