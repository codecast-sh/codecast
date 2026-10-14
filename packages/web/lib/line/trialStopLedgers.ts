// The reviews of the two acts on a trial run that stopped at a failure step
// (/trial Stopped, line-journeys.md LJ8.7): ask for a new approach when the
// station that gave up says its approach did not work, or close the problem.
// Both are consequential (a run costs money; a close retires the findings), so
// each goes through the shared confirm flow (ConsequentialSwitch SwitchReview).
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";
import { MERGES_NEVER, costFigure, listRow, usd, type RunCost } from "../../components/consequential/lineStartLedger";

/** A trial station's node id as its name ("build" -> "Build"); no node is its start. */
export const trialStationName = (id: string | null) => (id ? id.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase()) : "Start");

/** The trial limit that refuses any new run now (lineTrial rerunRefusal: its runs used, its billed-money cap, its
 *  accounts' quota), in words ("115 of 115 runs used"), read off its dispatcher's last hold; null when a run would start. */
export function trialRunLimit(held: string | null | undefined): string | null {
  return held && /^(\d+ of \d+ runs used|billed \$|quota \d+%)/.test(held) ? held.split(/:\s/)[0] : null;
}

/** A new run from main asked for a different approach: the station's report rides on the problem and in the run's history.
 *  `rerun`: the station gave up without saying the approach failed, so the run investigates again from main.
 *  `blocked`: the trial's limit that refuses any new run now (its runs used, its spend cap). */
export function newApproachLedger(r: { problem: string; station: string; cost?: RunCost | null; blocked?: string | null; rerun?: boolean }): SwitchLedger {
  return {
    ...(r.blocked ? { alert: `Trial starts no new run: ${r.blocked}`, blocked: r.blocked } : {}),
    name: r.rerun ? "Rerun from main" : "New approach",
    subject: r.problem,
    shift: null,
    figures: [
      r.blocked ? { value: "0", label: "runs start now", tone: "warn" } : { value: "1", label: "run starts now" },
      costFigure(r.cost, 1),
    ],
    rows: [
      listRow(r.cost),
      { k: "From", v: "main" },
      ...(r.rerun ? [{ k: "Investigates", v: "Again, from the findings" }] : [
        { k: "Carries", v: `${r.station}'s report: why it did not work` },
        { k: "Asks for", v: "A different approach" },
      ]),
      { k: "Ends", v: "Your decision" },
      { k: "Merges", v: MERGES_NEVER, tone: "ok" },
    ],
    stop: "Stop from its page",
    confirm: "Start the run",
    keep: "Not now",
  };
}

/** The problem closes as dropped; its findings retire with it, so judging the same thing again files nothing new on it. */
export function closeStoppedLedger(r: { problem: string; findings: number; week: number | null }): SwitchLedger {
  return {
    name: "Close the problem",
    subject: r.problem,
    shift: ["Open", "Dropped"],
    figures: [
      { value: String(r.findings), label: r.findings === 1 ? "finding closes with it" : "findings close with it", ...(r.findings ? { tone: "warn" as const } : {}) },
      ...(r.week != null ? [{ value: String(r.week), label: "in 7d" }] : []),
    ],
    rows: [
      { k: "Runs", v: "None start" },
      { k: "Found again", v: "Stays with this closed problem" },
    ],
    confirm: "Close it",
    keep: "Not now",
  };
}

/** The trial's two raisable limits as its dispatcher reads them (lineTrial trialRoom): runs started against `max_runs`,
 *  and billed money (model calls, hand entries, run sessions on API keys) against `cap_usd`. `perRun` is a line run's
 *  average billed money: nothing while its sessions run on subscription accounts, which quota limits instead. */
export type TrialLimits = { runs: number; maxRuns: number | null; spent: number; cap: number; perRun: number };

/** How many more runs a raise allows, the picks the review offers. */
export const RAISE_PICKS = ["10", "25", "50"] as const;

/** Which limit holds the trial now: both can, and a raise of one alone starts nothing. */
export function limitsHit(l: TrialLimits): { runs: boolean; spend: boolean } {
  return { runs: l.maxRuns != null && l.runs >= l.maxRuns, spend: l.spent + l.perRun > l.cap };
}

/** The limits a raise of `more` runs sets: the run limit that many past what has run, and a spend cap with room for them
 *  (rounded up to $50), never below the caps it had. */
export function raisedLimits(l: TrialLimits, more: number): { maxRuns: number; cap: number } {
  const maxRuns = Math.max(l.maxRuns ?? 0, l.runs) + more;
  const cap = Math.max(l.cap, Math.ceil((l.spent + more * l.perRun) / 50) * 50);
  return { maxRuns, cap };
}

/** Raising a held trial's limits: its dispatcher starts runs again, at a cost per run, until the new limits hold it. */
export function raiseLimitsLedger(r: { project: string; limits: TrialLimits; pick: string }): SwitchLedger {
  const l = r.limits;
  const more = Number(r.pick);
  const next = raisedLimits(l, more);
  return {
    name: "Raise the trial's limits",
    subject: r.project,
    shift: null,
    figures: [
      { value: String(more), label: "more runs it may start" },
      { value: `~${usd(more * l.perRun)}`, label: "billed, est.", tone: "warn" },
    ],
    rows: [
      { k: "Run limit", v: `${l.maxRuns ?? "none"} → ${next.maxRuns}` },
      { k: "Billed cap", v: `${usd(l.cap)} → ${usd(next.cap)}` },
      { k: "A run bills", v: `~${usd(l.perRun)}` },
      { k: "Runs spend", v: "Subscription quota" },
      { k: "Starts", v: "On its next pass, within 10 min" },
      { k: "Merges", v: MERGES_NEVER, tone: "ok" },
    ],
    pick: { k: "More runs", options: RAISE_PICKS, value: r.pick },
    confirm: "Raise the limits",
    keep: "Not now",
  };
}
