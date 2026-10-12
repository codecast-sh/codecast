// What turning a project's line on starts, as the review's data (ConsequentialSwitch
// SwitchLedger): read from the same admission every line surface reads. Its own
// file with no component in it, so the numbers are tested without a browser.
import type { LineAdmission } from "../../lib/lineFlow";
import { startsAtOnce, type NotReady } from "../line/map/LineStartSwitch";
import type { SwitchLedger } from "./ConsequentialSwitch";

/** What a run costs, from runs whose card recorded a price: this project's own, else every line's in the workspace. */
export type RunCost = { avgUsd: number; runs: number; scope: "project" | "workspace" };

const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type LineStartFacts = {
  project: string;
  admission: LineAdmission;
  /** The role's own switch is off, and turning the line on turns that on too (useLineAdmission lineSwitchFields). */
  roleOwnSwitchOff?: boolean;
  /** Every problem waiting on this line, and how many of them are ready to start (lineFlow waitingReadiness). */
  waiting?: number | null;
  ready?: number | null;
  notReady?: NotReady;
  cost?: RunCost | null;
};

/** The review of a line's start switch, as data. */
export function lineStartLedger({ project, admission: a, roleOwnSwitchOff = false, waiting = null, ready = null, notReady = [], cost = null }: LineStartFacts): SwitchLedger {
  const who = a.role ? `@${a.role.handle}` : "The lead";
  const queued = ready ?? a.queued ?? null;
  const now = startsAtOnce({ ...a, queued });
  const all = waiting ?? queued;
  const held = notReady.reduce((n, r) => n + r.count, 0) || (waiting != null && queued != null && waiting > queued ? waiting - queued : 0);
  const perDay = a.handsCap;

  // Every waiting problem starts at the press: one tile says both, not the same number twice.
  const allNow = now != null && now > 0 && now === all;
  const dayUsd = cost && perDay != null ? cost.avgUsd * perDay : null;
  const figures: SwitchLedger["figures"] = [
    allNow
      ? { value: String(now), label: now === 1 ? "problem waiting, starts now" : "problems waiting, all start now", tone: "warn" }
      : { value: now == null ? `≤${a.slots}` : String(now), label: now === 1 ? "session starts now" : "sessions start now", tone: now === 0 ? undefined : "warn" },
    ...(!allNow && all != null ? [{ value: String(all), label: all === 1 ? "problem waiting" : "problems waiting" }] : []),
    { value: String(a.slots), label: "running at once, at most" },
    ...(perDay != null ? [{ value: String(perDay), label: "new sessions a day, at most" }] : []),
    ...(dayUsd != null ? [{ value: `~${usd(dayUsd)}`, label: "a day at most, estimated", tone: "warn" as const }] : []),
  ];

  const rows: SwitchLedger["rows"] = [];
  rows.push({ k: "Each one", v: `A paid agent session writes a fix in ${project}'s repo`, sub: "It runs until its fix waits for your decision" });
  if (cost) {
    const from = cost.scope === "project" ? `${plural(cost.runs, "priced run")} here` : `${plural(cost.runs, "priced run")} across your lines; none priced here yet`;
    rows.push({ k: "Cost", v: `About ${usd(cost.avgUsd)} a run${now ? `, about ${usd(cost.avgUsd * now)} for the ${now} starting now` : ""}`, sub: `Mean of ${from}. Billed to your agent accounts` });
  } else {
    rows.push({ k: "Cost", v: "Not priced yet: no run here has recorded a cost", sub: `Billed to your agent accounts${perDay != null ? `, at most ${plural(perDay, "session")} a day` : ""}`, tone: "warn" });
  }
  const rest = queued != null && now != null ? queued - now : 0;
  const counted = now && perDay != null ? `The ${now} now count toward today's ${perDay}` : undefined;
  if (rest > 0 && perDay) rows.push({ k: "Pace", v: `All ${queued} ready in about ${plural(1 + Math.ceil(rest / perDay), "day")}`, sub: [counted, held ? `${held} more wait on you or another run first` : null].filter(Boolean).join(". ") || undefined });
  else if (held || counted) rows.push({ k: "Pace", v: held ? `${held} wait on you or another run first` : counted!, sub: held ? counted : "New problems start as they arrive, inside the same limits" });
  rows.push({ k: "Ships", v: "Nothing without you", sub: "No merge and no deploy until you approve that fix", tone: "ok" });
  if (roleOwnSwitchOff) rows.push({ k: "Also on", v: `${who} starts other work in ${project} on its own`, sub: "And answers its sessions' questions there without asking you", tone: "warn" });
  if (a.role?.paused) rows.push({ k: "Lead", v: `${who} is paused`, sub: "Nothing starts until it resumes", tone: "warn" });

  return {
    name: "Auto-start",
    subject: project,
    figures,
    rows,
    yours: ["Approve, revise or drop every fix", "Merge and ship", "Both limits: at once and a day"],
    stop: "Switch Auto-start off: nothing new starts. Running sessions finish and wait for you, or stop any one from its page.",
    confirm: now ? `Turn on, start ${now} now` : "Turn on",
  };
}
