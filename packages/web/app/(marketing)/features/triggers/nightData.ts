import { SOL } from "../../blog/blogChrome";

/**
 * One illustrative night of triggers, 18:00 to 09:00. Times are minutes from
 * midnight of the first day (so 02:00 the next morning is 26 * 60). Every
 * count the page prints about the night is derived from this list.
 */
export const NIGHT_START = 18 * 60;
export const NIGHT_END = 33 * 60;

export type Firing = {
  t: number;
  /** run: a session ran. skip: the precheck said no. park: hit a usage limit. attention: completed --needs-attention. */
  kind: "run" | "skip" | "park" | "attention";
  /** For a park: when the run resumed (the window reset plus a short grace). */
  until?: number;
  note: string;
  /** Shown in the morning log. Skips are summarized, not listed one by one. */
  log?: boolean;
};

export type Lane = {
  id: string;
  title: string;
  flags: string;
  where: "here" | "spawn";
  color: string;
  firings: Firing[];
};

const hours = (from: number, to: number, step = 1) => {
  const out: number[] = [];
  for (let h = from; h <= to; h += step) out.push(h * 60);
  return out;
};

export const LANES: Lane[] = [
  {
    id: "tr-41", title: "Check if CI is green on main", flags: "--in 30m", where: "here", color: SOL.blue,
    firings: [{ t: 18 * 60 + 40, kind: "run", note: "CI green on main. The answer lands in the thread that asked.", log: true }],
  },
  {
    id: "tr-43", title: "Review open PRs and summarize findings", flags: "--every 4h --spawn", where: "spawn", color: SOL.cyan,
    firings: hours(20, 32, 4).map((t, i) => ({
      t, kind: "run" as const,
      note: ["Reviewed 3 open PRs. Summary filed under the trigger.", "No new PRs. Clean run, nothing posted.", "No change since the last run.", "Two PRs went green overnight. Summary filed."][i],
      log: i === 0 || i === 3,
    })),
  },
  {
    id: "tr-44", title: "Rebuild the docs index if main moved", flags: "--every 1h --spawn --precheck '…'", where: "spawn", color: SOL.green,
    firings: hours(19, 32).map((t) => {
      const ran = t === 21 * 60 || t === 31 * 60;
      return ran
        ? { t, kind: "run" as const, note: "Precheck exited 0: main moved. Index rebuilt.", log: true }
        : { t, kind: "skip" as const, note: "Precheck exited 1. Skipped run recorded, no session spent.", log: t === 19 * 60 };
    }),
  },
  {
    id: "tr-45", title: "Respond to new PR review comments", flags: "--on pr_comment", where: "here", color: SOL.magenta,
    firings: [
      { t: 22 * 60 + 47, kind: "run", note: "A reviewer asked for a null check on #482. Fixed, pushed, replied.", log: true },
      { t: 23 * 60 + 12, kind: "run", note: "Follow-up question on the same thread. Answered.", log: false },
      { t: 30 * 60 + 58, kind: "run", note: "Early reviewer approved #482. Thread resolved.", log: true },
    ],
  },
  {
    id: "tr-46", title: "Audit dependencies for advisories", flags: "--every 1d --spawn --safe", where: "spawn", color: SOL.violet,
    firings: [{ t: 26 * 60, kind: "park", until: 27 * 60 + 14, note: "Hit a usage limit. Parked until the window reset, then resumed the same session. No advisories.", log: true }],
  },
  {
    id: "tr-47", title: "Investigate new production errors", flags: "--on error_new --source sentry --spawn", where: "spawn", color: SOL.red,
    firings: [{ t: 29 * 60 + 20, kind: "attention", note: "New TypeError in checkout, traced to last night's migration. Completed --needs-attention.", log: true }],
  },
];

export function clock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function pct(min: number): number {
  return ((min - NIGHT_START) / (NIGHT_END - NIGHT_START)) * 100;
}

const all = LANES.flatMap((l) => l.firings);
export const NIGHT_COUNTS = {
  firings: all.length,
  skipped: all.filter((f) => f.kind === "skip").length,
  sessions: all.filter((f) => f.kind !== "skip").length,
  parked: all.filter((f) => f.kind === "park").length,
  attention: all.filter((f) => f.kind === "attention").length,
};

export type LogLine = { t: number; id: string; color: string; kind: Firing["kind"]; text: string };

export const NIGHT_LOG: LogLine[] = LANES.flatMap((l) =>
  l.firings.flatMap((f) => {
    if (!f.log) return [];
    const lines: LogLine[] = [{ t: f.t, id: l.id, color: l.color, kind: f.kind, text: f.kind === "park" ? `Hit a usage limit and parked. Resumes ${clock(f.until!)}.` : f.note }];
    if (f.kind === "park") lines.push({ t: f.until!, id: l.id, color: l.color, kind: "run", text: "Resumed the same session. No advisories." });
    return lines;
  }),
).sort((a, b) => a.t - b.t);
