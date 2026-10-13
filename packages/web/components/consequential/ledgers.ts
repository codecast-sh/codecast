// The reviews of the app's other consequential switches, as data
// (ConsequentialSwitch SwitchLedger). Each is built from what its surface has
// on hand, so the numbers a person reads are the ones the switch runs under.
import type { SwitchLedger } from "./ConsequentialSwitch";
import { STOP, dayCostFigure, dayLimitFigure, priceRow, usd, type RunCost } from "./lineStartLedger";

const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A role's own switch (shared/contracts/roleAutonomy): it starts work and answers decisions in its area. */
export function roleAutonomyLedger(r: { name: string; handle: string; caps: { hands_per_day?: number | null }; usedToday?: number | null; projects: string[]; merges: boolean; cost?: RunCost | null }): SwitchLedger {
  const area = r.projects.length === 0 ? "its area" : r.projects.length <= 2 ? r.projects.join(" and ") : `${r.projects.length} projects`;
  const n = r.caps.hands_per_day ?? null;
  return {
    name: "Start work and answer for you",
    subject: `${r.name} · @${r.handle}`,
    hands: {
      its: ["Which approach a session takes", "What a session does next", `What work to start in ${area}`],
      yours: [r.merges ? "Approving each fix" : "Approving, merging and deploying a fix", "What it cannot settle", "Its limits, and this switch"],
    },
    figures: [...(n != null ? [dayLimitFigure(n, r.usedToday, "none start at this press")] : []), dayCostFigure(r.cost, n)],
    rows: [
      { k: "Does", v: `Starts paid agent sessions on work in ${area}, from its next check on` },
      { k: "Can touch", v: "The repo and shell on its machine, the same as a session you start" },
      ...(r.merges ? [{ k: "Merges", v: "On its own: its line merges approved branches (the merge step is on)", tone: "warn" as const }] : []),
      priceRow(r.cost),
    ],
    stop: STOP,
    confirm: "Turn on, start and answer",
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

/** One problem's line run started again so its fix is asked again (line-journeys.md LJ6.7): what starts, what it
 *  costs, how long it takes when that is known, and that the fix already built is picked up from its branch. */
export function startAgainLedger(r: { problem: string; project: string | null; branch?: boolean; cost?: RunCost | null; about?: string | null }): SwitchLedger {
  return {
    name: "Start a new run",
    subject: r.problem,
    figures: [
      { value: "1", label: "run starts now" },
      r.cost ? { value: `~${usd(r.cost.avgUsd)}`, label: "for the run, an estimate", tone: "warn" } : { value: "$?", label: "no run priced yet", tone: "warn" },
      ...(r.about ? [{ value: `~${r.about}`, label: "until it asks you" }] : []),
    ],
    rows: [
      { k: "Starts", v: `The line${r.project ? ` in ${r.project}` : ""} on this problem, from its first step` },
      r.branch ? { k: "Branch", v: "The fix already built is saved on its branch: the new run picks it up", tone: "ok" } : { k: "Branch", v: "Nothing was built yet: the run starts from main" },
      priceRow(r.cost),
      { k: "Ends", v: "With a decision for you to answer. Nothing merges before that" },
    ],
    stop: "Stop the run from its page at any time; what it built stays on its branch.",
    confirm: "Start the run",
  };
}

/** Every problem under one failure cause started again (line-journeys.md LJ6.7): how many runs start, what they
 *  cost together, and how long one takes when that is known. Each is a full run of its own. */
export function startTheseAgainLedger(r: { cause: string; count: number; projects: string[]; cost?: RunCost | null; about?: string | null }): SwitchLedger {
  const where = r.projects.length === 0 ? "" : r.projects.length <= 2 ? ` in ${r.projects.join(" and ")}` : ` across ${r.projects.length} projects`;
  return {
    name: r.count === 1 ? "Start it again" : "Start these again",
    subject: r.cause,
    figures: [
      { value: String(r.count), label: r.count === 1 ? "run starts now" : "runs start now" },
      r.cost ? { value: `~${usd(r.cost.avgUsd * r.count)}`, label: r.count === 1 ? "for the run, an estimate" : `in all: ${r.count} × ~${usd(r.cost.avgUsd)}`, tone: "warn" } : { value: "$?", label: "no run priced yet", tone: "warn" },
      ...(r.about ? [{ value: `~${r.about}`, label: r.count === 1 ? "until it is done" : "each, side by side" }] : []),
    ],
    rows: [
      { k: "Starts", v: `The line${where} on ${plural(r.count, "problem")}, each from its first step` },
      { k: "Failed on", v: `${r.cause}. A new run meets the same step: start again once its cause is gone`, tone: "warn" },
      priceRow(r.cost),
      { k: "Ends", v: "Each with a decision for you to answer, or at the step that fails again. Nothing merges before you answer" },
    ],
    stop: "Stop any run from its page; what it built stays on its branch.",
    confirm: r.count === 1 ? "Start the run" : `Start ${r.count} runs`,
  };
}

/** A pull request merged into its base branch: one act, undone only by a revert. */
export function prMergeLedger(r: { title: string; number: number; base: string; head?: string; method: string; deleteBranch: boolean; files?: number; additions?: number; deletions?: number; checks?: string; blockedBy?: string }): SwitchLedger {
  const checks = r.checks === "success" ? { v: "Passing", tone: "ok" as const } : r.checks === "pending" ? { v: "Still running", tone: "warn" as const } : r.checks === "failure" ? { v: "Failing", tone: "warn" as const } : null;
  return {
    name: `Merge #${r.number}`,
    subject: r.title,
    shift: ["Open", "Merged"],
    figures: [
      ...(r.files != null ? [{ value: String(r.files), label: r.files === 1 ? "file changes" : "files change" }] : []),
      ...(r.additions != null ? [{ value: `+${r.additions}`, label: `−${r.deletions ?? 0} lines` }] : []),
      { value: r.base, label: "is where it lands", tone: "warn" as const },
    ],
    rows: [
      { k: "Method", v: r.method },
      ...(checks ? [{ k: "Checks", v: checks.v, tone: checks.tone }] : []),
      ...(r.blockedBy ? [{ k: "GitHub says", v: r.blockedBy, sub: "GitHub may refuse; this tries anyway", tone: "warn" as const }] : []),
      { k: "Branch", v: r.deleteBranch ? `${r.head ?? "The branch"} is deleted after` : `${r.head ?? "The branch"} stays` },
      { k: "Then", v: `Whatever deploys from ${r.base} picks it up` },
    ],
    stop: "A merge is undone only by a revert: a new pull request that takes it back out.",
    confirm: `Merge into ${r.base}`,
  };
}

/** An agent's permission mode set to skip every prompt, for every session it starts from here. */
export function agentFullAccessLedger(r: { agent: string; label: string; from: string; sandbox: boolean; flag: string }): SwitchLedger {
  return {
    name: `${r.agent}: ${r.label}`,
    subject: "Every new session of this agent",
    shift: [r.from, r.label],
    figures: [
      { value: "0", label: "permission prompts", tone: "warn" },
      { value: r.sandbox ? "Yes" : "No", label: "sandbox", tone: r.sandbox ? undefined : "warn" },
    ],
    rows: [
      { k: "Runs", v: "Every tool call without asking: edits, shell commands, installs", tone: "warn" },
      { k: "Can touch", v: r.sandbox ? "Its workspace; the network as the sandbox allows" : "Every file and the network on its machine", tone: r.sandbox ? undefined : "warn" },
      { k: "Applies to", v: "Sessions started after this, on every machine", sub: "Running sessions keep their mode" },
      { k: "Flag", v: r.flag },
    ],
    stop: `Pick ${r.from} again: new sessions ask before acting.`,
    confirm: `Switch to ${r.label}`,
  };
}

/** Every off agent feature in a group, turned on at once on one machine. */
export function featuresAllLedger(r: { group: string; machine: string; names: string[] }): SwitchLedger {
  return {
    name: `Turn on ${r.names.length} ${r.group} features`,
    subject: r.machine,
    figures: [{ value: String(r.names.length), label: "agent capabilities added", tone: "warn" }],
    rows: [
      { k: "Adds", v: "What every agent session on this machine may then do", list: r.names },
      { k: "Applies to", v: "New sessions on this machine", sub: "Each feature has its own switch below" },
    ],
    stop: "Switch any feature off on its own card.",
    confirm: `Turn on all ${r.names.length}`,
  };
}

/** A paused routine set running: a recurring agent run on its schedule. */
export function routineActivateLedger(r: { title: string; every: string; applies: boolean; cost?: RunCost | null }): SwitchLedger {
  return {
    name: `Activate ${r.title}`,
    subject: `Every ${r.every}`,
    shift: ["Paused", "Running"],
    figures: [
      { value: "1", label: `paid agent run every ${r.every}`, tone: "warn" },
      ...(r.cost ? [{ value: `~${usd(r.cost.avgUsd)}`, label: "a run, an estimate", tone: "warn" as const }] : []),
    ],
    rows: [
      r.applies
        ? { k: "Acts", v: "It applies what it finds, without asking", tone: "warn" }
        : { k: "Acts", v: "It proposes; you approve each change", tone: "ok" },
      { k: "First run", v: "At its next scheduled time" },
      priceRow(r.cost),
    ],
    stop: "Pause it on its trigger: no more runs. A run in progress finishes.",
    confirm: `Activate, every ${r.every}`,
  };
}

/** A selection of sessions ended, some of them mid-turn. */
export function killSessionsLedger(r: { total: number; working: string[] }): SwitchLedger {
  const w = r.working.length;
  return {
    name: `Kill ${r.total} sessions`,
    subject: `${w} of them working right now`,
    shift: ["Running", "Ended"],
    figures: [
      { value: String(w), label: w === 1 ? "turn cut off mid-work" : "turns cut off mid-work", tone: "warn" },
      { value: String(r.total), label: "sessions end" },
    ],
    rows: [
      { k: "Working", v: "These stop where they are; their unfinished turn is lost", list: r.working.slice(0, 4).concat(w > 4 ? [`and ${w - 4} more`] : []), tone: "warn" },
      { k: "Triggers", v: "Triggers bound to them are canceled with them" },
      { k: "Undo", v: "Restore brings a session and its triggers back, not the cut-off turn" },
    ],
    stop: "Keep them running, or kill only the idle ones by leaving the working ones out of the selection.",
    confirm: `Kill ${r.total}`,
  };
}
