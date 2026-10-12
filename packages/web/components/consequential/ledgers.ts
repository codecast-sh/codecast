// The reviews of the app's other consequential switches, as data
// (ConsequentialSwitch SwitchLedger). Each is built from what its surface has
// on hand, so the numbers a person reads are the ones the switch runs under.
import type { SwitchLedger } from "./ConsequentialSwitch";
import { STOP, dayBudgetFigure, monthFigure, priceRow, type RunCost } from "./lineStartLedger";

const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A role's own switch (shared/contracts/roleAutonomy): it starts work and answers decisions in its area. */
export function roleAutonomyLedger(r: { name: string; handle: string; caps: { hands_per_day: number; wakes_per_day: number; tokens_per_day: number }; usedToday?: number | null; projects: string[]; merges: boolean; cost?: RunCost | null }): SwitchLedger {
  const area = r.projects.length === 0 ? "its area" : r.projects.length <= 2 ? r.projects.join(" and ") : `${r.projects.length} projects`;
  const n = r.caps.hands_per_day;
  return {
    name: "Start work and answer for you",
    subject: `${r.name} · @${r.handle}`,
    lead: { v: "It answers its sessions' questions for you", sub: `${r.merges ? "" : "It never merges or deploys. "}What it cannot settle still comes to you` },
    figures: [dayBudgetFigure(n, r.usedToday, `@${r.handle}`), monthFigure(r.cost, n)],
    rows: [
      { k: "Starts", v: `Paid sessions on work in ${area}, without asking. None at this press: from its next check on` },
      { k: "Can touch", v: "What its sessions' permissions allow on their machine: the repo, the shell, the tools set up there" },
      r.merges
        ? { k: "Merges", v: "Approved branches, on its own: its merge step is on (a separate switch)", tone: "warn" }
        : { k: "Merges", v: "Nothing: merging is a separate switch, and it is off", tone: "ok" },
      priceRow(r.cost),
    ],
    stop: STOP,
    confirm: "Turn on, let it decide",
  };
}

/** A line's merge step, turned back on under the limit it already has. */
export function mergeStepLedger(r: { name: string; limit: number | null; used: number }): SwitchLedger {
  return {
    name: "Merge step",
    subject: r.name,
    figures: r.limit === null ? [{ value: "No", label: "daily limit", tone: "warn" }] : [{ value: String(r.limit), label: "merges a day at most", tone: "warn" }, { value: String(r.used), label: "merged today" }],
    rows: [
      { k: "Merges", v: "Approved branches into the default branch", sub: "On its own, once their checks pass", tone: "warn" },
      { k: "Undo", v: "A merge is undone only by a revert" },
    ],
    yours: ["Approving each change", "The daily limit", "Revoking its merge authority"],
    stop: "Switch Merge step off: approved branches wait for a person to merge.",
    confirm: "Turn on merging",
  };
}

/** An issue source that starts a session whenever an outside issue takes its label or assignee. */
export function issueSpawnLedger(r: { provider: "GitHub" | "Linear"; source: string; label?: string; assignee?: string }): SwitchLedger {
  const on = [r.label && `label "${r.label}"`, r.assignee && `assignee ${r.assignee}`].filter(Boolean).join(" or ") || "the label or assignee set here";
  return {
    name: "Spawn on delegation",
    subject: r.source,
    figures: [{ value: "1", label: "paid session per matching issue", tone: "warn" }, { value: "No", label: "limit on how many", tone: "warn" }],
    rows: [
      { k: "Starts when", v: `An issue takes ${on}` },
      { k: "Who can", v: `Anyone who can label or assign on ${r.provider}`, sub: "They start sessions on your account", tone: "warn" },
    ],
    yours: ["The label and assignee", "Stopping any session"],
    stop: "Switch it off: issues stop starting sessions. Sessions already running continue.",
    confirm: "Turn on spawning",
  };
}

/** An issue source that creates an outside issue for every task born in its project. */
export function issuePushLedger(r: { provider: "GitHub" | "Linear"; source: string }): SwitchLedger {
  return {
    name: `Create issues on ${r.provider}`,
    subject: r.source,
    figures: [{ value: "1", label: `${r.provider} issue per new task`, tone: "warn" }],
    rows: [
      { k: "Sends", v: "The title and description of every new task here", tone: "warn" },
      { k: "Seen by", v: `Everyone with access to ${r.source} on ${r.provider}` },
      { k: "Undo", v: "Issues already created stay there", sub: "Close or delete them on the provider" },
    ],
    yours: ["Tasks in other projects stay here"],
    stop: "Switch it off: new tasks stay in codecast.",
    confirm: `Turn on, send new tasks to ${r.provider}`,
  };
}

/** A session's permission prompts, switched off for the rest of the session. */
export function allowAllLedger(r: { pending: number }): SwitchLedger {
  return {
    name: "Allow all",
    subject: "this session",
    figures: [{ value: String(r.pending), label: r.pending === 1 ? "call approved now" : "calls approved now", tone: "warn" }, { value: "0", label: "prompts after this", tone: "warn" }],
    rows: [
      { k: "Runs", v: "Every later tool call, without asking", tone: "warn" },
      { k: "Can touch", v: "Files, the shell and the network on its machine", tone: "warn" },
      { k: "Lasts", v: "Until this session ends or its mode changes" },
    ],
    yours: ["Other sessions still ask", "Stopping this one"],
    stop: "Set the permission mode back in the composer, or stop the session.",
    confirm: r.pending > 1 ? `Approve ${r.pending} and stop asking` : "Approve and stop asking",
  };
}

/** A member's team visibility raised to the whole conversation, for new sessions. */
export function shareInFullLedger(r: { team: string; others: number; sees: string }): SwitchLedger {
  return {
    name: "Share in full",
    subject: r.team,
    figures: [{ value: String(r.others), label: r.others === 1 ? "teammate reads them" : "teammates read them", tone: "warn" }, { value: "All", label: "new sessions shared with the team" }],
    rows: [
      { k: "They see", v: "The whole conversation: prompts, replies, tool output", sub: `Today they see only ${r.sees}`, tone: "warn" },
      { k: "Past", v: "Sessions before now stay as they are", tone: "ok" },
    ],
    yours: ["Each session's own share setting", "Projects not shared with the team"],
    stop: "Set the level back under Settings, Sync.",
    confirm: `Share new sessions with ${r.team}`,
  };
}
