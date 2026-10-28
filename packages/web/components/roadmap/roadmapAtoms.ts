// What the roadmap's chart and sheet share: a row's colour, the words and
// colours for where it stands against its target, and how a day reads.
import { formatTargetDay } from "@codecast/shared/time";
import { HEALTH_COLOR, INITIATIVE_ACCENT } from "../../lib/initiativeColors";
import { projectDotClass } from "../../lib/projectColors";
import type { RoadRow, Standing } from "./roadmapModel";

export const STANDING_WORD: Record<Standing, string> = {
  late: "past deadline",
  behind: "behind pace",
  on_pace: "on pace",
  no_pace: "no pace yet",
  no_date: "no deadline",
  done: "done",
};

export const PACE_COLOR: Record<Standing, string> = {
  late: "var(--sol-red)",
  behind: "var(--sol-yellow)",
  on_pace: "var(--sol-green)",
  no_pace: "var(--sol-text-dim)",
  no_date: "var(--sol-text-dim)",
  done: "var(--sol-text-muted)",
};

/** A goal wears its health, a project its own colour, a role violet. */
export function rowAccent(r: Pick<RoadRow, "kind" | "health" | "color" | "title">): string {
  if (r.kind === "goal") return r.health && r.health !== "none" ? HEALTH_COLOR[r.health] : INITIATIVE_ACCENT;
  if (r.kind === "role") return "var(--sol-violet)";
  const cls = projectDotClass({ color: r.color, title: r.title });
  const m = /bg-(?:sol-)?([a-z]+)/.exec(cls);
  return `var(--sol-${(m && PALETTE_TO_SOL[m[1]]) ?? "cyan"})`;
}

/** A hashed label colour (Tailwind's palette) as the sol accent nearest it. */
const PALETTE_TO_SOL: Record<string, string> = {
  red: "red", rose: "red", orange: "orange", amber: "yellow", yellow: "yellow", lime: "green", green: "green", emerald: "green",
  teal: "cyan", cyan: "cyan", sky: "blue", blue: "blue", indigo: "violet", violet: "violet", purple: "violet",
  fuchsia: "magenta", pink: "magenta", magenta: "magenta", slate: "text-muted", gray: "text-muted", zinc: "text-muted", stone: "text-muted", neutral: "text-muted",
};

const sameYear = (t: number) => new Date(t).getFullYear() === new Date().getFullYear();

/** "Oct 30", with the year when it is not this one. */
export function dayLabel(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear(t) ? {} : { year: "numeric" }) });
}

/** A target: a goal's is a stored UTC day, a project's the end of a local day. */
export function fmtDay(t: number, local: boolean): string {
  return local ? dayLabel(t) : formatTargetDay(t, Date.now());
}
