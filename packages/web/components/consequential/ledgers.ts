// The reviews of the app's other consequential switches and acts, as data
// (ConsequentialSwitch SwitchLedger). Each is built from what its surface has
// on hand, and every row is a label and a value a glance takes in.
import type { SwitchLedger } from "./ConsequentialSwitch";
import { MERGES_NEVER, RUNNING_ROW, STOP, costFigure, dayCostFigure, listRow, dayLimitFigure, plural, priceRow, startingRow, usd, type RunCost } from "./lineStartLedger";

const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const areaOf = (projects: string[]) => (projects.length === 0 ? "No projects set" : projects.length <= 2 ? projects.join(", ") : `${projects.length} projects`);

/** A role's own switch (shared/contracts/roleAutonomy): it starts work and answers decisions in its area. */
export function roleAutonomyLedger(r: { name: string; handle: string; caps: { hands_per_day?: number | null; wakes_per_day?: number | null; tokens_per_day?: number | null }; usedToday?: number | null; projects: string[]; merges: boolean; cost?: RunCost | null }): SwitchLedger {
  // A role with no daily cap of its own has none: the review says so rather than show a default.
  const n = r.caps.hands_per_day ?? null;
  return {
    name: "Start work and decide",
    subject: `${r.name} · @${r.handle}`,
    hands: { its: ["Approach", "Next step", "What to start"], yours: ["Approving fixes", r.merges ? "Limits" : "Merge, deploy", "Switching it off"] },
    figures: [
      n != null ? dayLimitFigure(n) : { value: "∞", label: "a day, no limit", tone: "warn" },
      { value: String(r.usedToday ?? 0), label: "used today" },
      ...(n != null ? [dayCostFigure(r.cost, n)] : r.cost ? [costFigure(r.cost, 1, "a session")] : []),
    ],
    rows: [
      { k: "Area", v: areaOf(r.projects) },
      { k: "Runs on", v: "Its machine · repo, shell" },
      r.merges ? { k: "Merges", v: "On its own", tone: "warn" } : { k: "Merges", v: MERGES_NEVER, tone: "ok" },
      { k: "Tokens", v: r.caps.tokens_per_day != null ? `${compact(r.caps.tokens_per_day)} a day, max` : "No limit", ...(r.caps.tokens_per_day == null ? { tone: "warn" as const } : {}) },
      priceRow(r.cost),
      RUNNING_ROW,
    ],
    stop: STOP,
    confirm: "Let it decide",
  };
}

/** A line's merge step, turned back on under the limit it already has. */
export function mergeStepLedger(r: { name: string; limit: number | null; used: number }): SwitchLedger {
  return {
    name: "Merge step",
    subject: r.name,
    figures: r.limit === null ? [{ value: "∞", label: "merges a day", tone: "warn" }] : [{ value: String(r.limit), label: "merges a day, max", tone: "warn" }, { value: String(r.used), label: "today" }],
    rows: [
      { k: "Merges", v: "Approved branches", tone: "warn" },
      { k: "Into", v: "Default branch" },
      { k: "When", v: "Checks pass" },
      { k: "To undo", v: "Revert PR" },
    ],
    stop: "Switch off",
    confirm: "Turn on merging",
  };
}

/** An issue source that starts a session whenever an outside issue takes its label or assignee. */
export function issueSpawnLedger(r: { provider: "GitHub" | "Linear"; source: string; label?: string; assignee?: string }): SwitchLedger {
  return {
    name: "Spawn on delegation",
    subject: r.source,
    figures: [{ value: "1", label: "session per issue", tone: "warn" }, { value: "∞", label: "a day", tone: "warn" }],
    rows: [
      ...(r.label ? [{ k: "Label", v: r.label }] : []),
      ...(r.assignee ? [{ k: "Assignee", v: r.assignee }] : []),
      { k: "Who can", v: `Anyone on ${r.provider}`, tone: "warn" as const },
    ],
    stop: "Switch off",
    confirm: "Turn on spawning",
  };
}

/** An issue source that creates an outside issue for every task born in its project. */
export function issuePushLedger(r: { provider: "GitHub" | "Linear"; source: string }): SwitchLedger {
  return {
    name: `Create issues on ${r.provider}`,
    subject: r.source,
    figures: [{ value: "1", label: "issue per new task", tone: "warn" }],
    rows: [
      { k: "Sends", v: "Title · description", tone: "warn" },
      { k: "Seen by", v: `${r.source} on ${r.provider}` },
      { k: "To undo", v: `Close on ${r.provider}` },
    ],
    stop: "Switch off",
    confirm: `Send to ${r.provider}`,
  };
}

/** A session's permission prompts, switched off for the rest of the session. */
export function allowAllLedger(r: { pending: number }): SwitchLedger {
  return {
    name: "Allow all",
    subject: "This session",
    figures: [{ value: String(r.pending), label: "approved now", tone: "warn" }, { value: "0", label: "prompts after", tone: "warn" }],
    rows: [
      { k: "Asks first", v: "Never", tone: "warn" },
      { k: "Can touch", v: "Files · shell · network", tone: "warn" },
      { k: "Lasts", v: "Until the session ends" },
      { k: "Other sessions", v: "Still ask", tone: "ok" },
    ],
    stop: "Change mode in the composer",
    confirm: "Allow all",
    keep: "Not now",
  };
}

/** A member's team visibility raised to the whole conversation, for new sessions. */
export function shareInFullLedger(r: { team: string; others: number; sees: string }): SwitchLedger {
  return {
    name: "Share in full",
    subject: r.team,
    figures: [{ value: String(r.others), label: r.others === 1 ? "teammate reads" : "teammates read", tone: "warn" }],
    rows: [
      { k: "They see", v: "Whole transcripts", tone: "warn" },
      { k: "Today", v: r.sees },
      { k: "Applies to", v: "New sessions" },
      { k: "Past", v: "Unchanged", tone: "ok" },
    ],
    stop: "Settings › Sync",
    confirm: "Share in full",
    keep: "Not now",
  };
}

/** One problem's line started again from its first step. `goOn`: the run is a person's yes to a step that stopped
 *  with nowhere to go; a run cannot pick up where another stopped, so the review says the new one redoes the steps
 *  up to it before it reaches the next. */
export function startAgainLedger(r: { problem: string; project: string | null; branch?: boolean; cost?: RunCost | null; about?: string | null; goOn?: { step: string; next: string | null; proof?: string; warn?: string | null };
  /** What the last run's station said blocks it, in its words: the review leads with it, since a new run meets it again until it clears. */ hold?: string | null;
  /** A built fix sent back from review (lib/line/fixReview reviewMove): what sends it back, and that the builder reads it
   *  on the task. A new run redoes the steps before the build, then builds on the same branch. */
  sendBack?: { act: "sendback" | "rebuild"; why: string[] } | null;
  /** A step that rested its advice on one case while the problem holds more findings: the new run proves on all of them. */
  reprove?: { step: string; findings: number } | null }): SwitchLedger {
  const g = r.goOn;
  const back = r.sendBack ?? null;
  return {
    name: r.reprove ? `${r.reprove.step} again on all ${r.reprove.findings} findings (new run)` : back ? (back.act === "rebuild" ? "Rebuild on main (new run)" : "Send back to Implement (new run)") : g ? `Go on${g.next ? ` to ${g.next}` : ""} (new run)` : "Start a new run",
    subject: r.problem,
    shift: null,
    ...(r.hold ? { alert: "The last run stopped blocked" } : r.goOn?.warn ? { alert: "Its proof check will send it back" } : {}),
    figures: [
      { value: "1", label: "run starts now" },
      costFigure(r.cost, 1),
      ...(r.about ? [{ value: `~${r.about}`, label: "until it asks you" }] : []),
    ],
    rows: [
      // The block leads: a new run meets it again until it clears.
      ...(r.hold ? [{ k: "Blocked", v: r.hold, tone: "warn" as const }] : []),
      listRow(r.cost),
      ...(back ? back.why.map((w, i) => ({ k: i ? "And" : "Sends back", v: w, tone: "warn" as const })) : []),
      ...(r.project ? [{ k: "Project", v: r.project }] : []),
      r.branch ? { k: "From", v: "Its fix branch", tone: "ok" } : { k: "From", v: "main" },
      ...(g ? [{ k: "Redoes", v: `Every step through ${g.step}`, tone: "warn" as const }, ...(g.next ? [{ k: "Then", v: `${g.next}, when ${g.step} passes again` }] : [])] : []),
      ...(r.reprove ? [{ k: "Last time", v: `${r.reprove.step} read one case`, tone: "warn" as const }, { k: "Reads", v: `All ${r.reprove.findings} findings` }, { k: "Then", v: `You decide again after ${r.reprove.step}` }] : []),
      ...(back ? [{ k: "Redoes", v: "Every step through Prove", tone: "warn" as const }, { k: "Then", v: back.act === "rebuild" ? "Implement rebases its branch on main" : "Implement fixes its branch" }, { k: "The builder reads", v: "Why, on the problem" }] : []),
      // What the proof check holds the change to, and a warning when the last run left nothing it can check.
      ...(g?.proof ? [{ k: "Proof", v: g.proof }] : []),
      ...(g?.warn ? [{ k: "Last time", v: g.warn, tone: "warn" as const }] : []),
      { k: "Ends", v: "Your decision" },
      { k: "Merges", v: MERGES_NEVER, tone: "ok" },
    ],
    stop: "Stop from its page",
    confirm: "Start the run",
    keep: "Not now",
  };
}

/** A problem whose findings say nothing, kept as real anyway: the line takes it up, so a run starts now, after the
 *  problems queued ahead (`ahead`), or not at all while its line is off (`off`, the keep waits for the switch). */
export function keepRealLedger(r: { problem: string; project: string | null; empty: number; of: number; now: boolean; ahead: number | null; off: boolean; cost?: RunCost | null; about?: string | null }): SwitchLedger {
  const starts = r.off ? { value: "0", label: "start: its flow is off" } : r.now ? { value: "1", label: "run starts now" } : { value: "1", label: r.ahead ? `run, after ${r.ahead} queued` : "run, next in line" };
  return {
    name: "Keep it as a problem",
    subject: r.problem,
    shift: null,
    alert: r.empty >= r.of ? "No finding supports it" : undefined,
    figures: [
      starts,
      costFigure(r.cost, 1),
      ...(r.about ? [{ value: `~${r.about}`, label: "until it asks you" }] : []),
    ],
    rows: [
      listRow(r.cost),
      ...(r.project ? [{ k: "Project", v: r.project }] : []),
      { k: "Findings", v: `${r.empty} of ${r.of} empty`, tone: "warn" },
      { k: "From", v: "main" },
      { k: "Ends", v: "Your decision" },
      { k: "Merges", v: MERGES_NEVER, tone: "ok" },
    ],
    stop: r.off ? "Close it from its page" : "Stop from its page",
    confirm: r.off ? "Keep it" : "Keep it and start",
    keep: "Not now",
  };
}

/** Problems under one failure cause started again (line-journeys.md LJ6.7), at the line's own pace: `count` start now
 *  (the first in the heading's order, `first` by name), `rest` wait under the heading for a later press (nothing
 *  else starts a problem whose run ended), `slots` a press. `hold`: what the review leads with (the line is off, so only a press starts a run; no place is free). */
export function startTheseAgainLedger(r: { name?: string; cause: string; count: number; rest?: number; slots?: number | null; first?: string[]; projects: string[]; cost?: RunCost | null; about?: string | null; hold?: string | null }): SwitchLedger {
  const rest = r.rest ?? 0;
  return {
    name: r.name ?? (r.count + rest === 1 ? "Start it again" : "Start these again"),
    subject: r.cause,
    shift: null,
    ...(r.hold ? { alert: r.hold } : {}),
    figures: [
      { value: String(r.count), label: r.count === 1 ? "run starts now" : "runs start now", tone: r.count ? "warn" : undefined },
      ...(rest ? [{ value: String(rest), label: "wait here" }] : []),
      costFigure(r.cost, r.count, "these"),
      ...(r.about ? [{ value: `~${r.about}`, label: "each" }] : []),
    ],
    rows: [
      listRow(r.cost, r.count),
      { k: "Where", v: areaOf(r.projects) },
      // The ones that start, by the names the list gives them, in its order.
      ...startingRow(r.count, r.first ?? []),
      // Each has a run on record, so the line's own sweep passes it by, on or off: only another press starts the rest.
      ...(rest ? [{ k: "Then", v: `${rest} stay here until you press again` }] : []),
      { k: "Ends", v: "Your decision" },
      { k: "Merges", v: MERGES_NEVER, tone: "ok" },
    ],
    stop: "Stop from each run's page",
    confirm: r.count === 1 ? "Start the run" : `Start ${r.count} runs`,
    keep: "Not now",
    ...(r.count === 0 && r.hold ? { blocked: r.hold } : {}),
  };
}

/** A pull request merged into its base branch: one act, undone only by a revert. */
export function prMergeLedger(r: { title: string; number: number; base: string; head?: string; headSha?: string; method: string; deleteBranch: boolean; files?: number; additions?: number; deletions?: number; checks?: string; blockedBy?: string }): SwitchLedger {
  const alert = r.checks === "failure" ? "Checks failing" : r.blockedBy ? `GitHub: ${r.blockedBy}` : r.checks === "pending" ? "Checks still running" : undefined;
  return {
    name: `Merge #${r.number}`,
    subject: r.title,
    shift: ["Open", "Merged"],
    alert,
    figures: [
      ...(r.files != null ? [{ value: String(r.files), label: r.files === 1 ? "file" : "files" }] : []),
      ...(r.additions != null ? [{ value: `+${r.additions}`, label: `−${r.deletions ?? 0} lines` }] : []),
      { value: r.base, label: "lands on", tone: "warn" as const },
    ],
    rows: [
      { k: "Method", v: r.method },
      ...(r.checks === "success" ? [{ k: "Checks", v: "Passing", tone: "ok" as const }] : []),
      ...headRow(r.headSha),
      { k: "Branch", v: r.deleteBranch ? "Deleted after" : "Kept" },
      { k: "Then", v: `Deploys from ${r.base}` },
      { k: "To undo", v: "Revert PR" },
    ],
    confirm: alert ? "Merge anyway" : `Merge into ${r.base}`,
    keep: "Not now",
  };
}

/** The head the press is pinned to: GitHub refuses if the branch moves first. */
function headRow(sha?: string): { k: string; v: string }[] {
  return sha ? [{ k: "Head", v: `${sha.slice(0, 7)}, refused if it moves` }] : [];
}

/** GitHub merges the pull request on its own once required checks and reviews pass. */
export function prAutoMergeLedger(r: { title: string; number: number; base: string; headSha?: string; method: string; checks?: string }): SwitchLedger {
  return {
    name: `Auto-merge #${r.number}`,
    subject: r.title,
    shift: ["Manual", "Auto-merge"],
    figures: [{ value: r.base, label: "lands on", tone: "warn" }],
    rows: [
      { k: "Merges when", v: "Required checks and reviews pass" },
      { k: "Method", v: r.method },
      ...(r.checks ? [{ k: "Checks now", v: r.checks, tone: r.checks === "failure" ? ("warn" as const) : undefined }] : []),
      ...headRow(r.headSha),
    ],
    stop: "Turn it off",
    confirm: "Turn on auto-merge",
    keep: "Not now",
  };
}

/** The base branch merged into the pull request's branch, as a new commit on it. */
export function prUpdateBranchLedger(r: { title: string; number: number; base: string; head?: string; headSha?: string; behindBy?: number }): SwitchLedger {
  return {
    name: `Update #${r.number}`,
    subject: r.title,
    shift: null,
    figures: [
      ...(r.behindBy != null ? [{ value: String(r.behindBy), label: r.behindBy === 1 ? "commit behind" : "commits behind" }] : []),
      { value: r.head ?? "branch", label: "gets a merge commit", tone: "warn" as const },
    ],
    rows: [
      { k: "From", v: r.base },
      ...headRow(r.headSha),
      { k: "Then", v: "Checks run again" },
      { k: "Agents on it", v: "Must pull before pushing" },
    ],
    confirm: `Merge ${r.base} into it`,
    keep: "Not now",
  };
}

/** An agent's permission mode set to skip every prompt, for every session it starts from here. */
export function agentFullAccessLedger(r: { agent: string; label: string; from: string; sandbox: boolean }): SwitchLedger {
  return {
    name: `${r.agent}: ${r.label}`,
    subject: "New sessions",
    shift: [r.from, r.label],
    figures: [{ value: "0", label: "prompts", tone: "warn" }, { value: r.sandbox ? "Yes" : "No", label: "sandbox", tone: r.sandbox ? undefined : "warn" }],
    rows: [
      { k: "Asks first", v: "Never", tone: "warn" },
      { k: "Can touch", v: r.sandbox ? "Workspace" : "All files · network", tone: r.sandbox ? undefined : "warn" },
      { k: "Applies to", v: "New sessions, every machine" },
      { k: "Running", v: "Keep their mode", tone: "ok" },
    ],
    stop: `Pick ${r.from}`,
    confirm: `Use ${r.label}`,
    keep: `Keep ${r.from}`,
  };
}

/** Every off agent feature in a group, turned on at once on one machine. */
export function featuresAllLedger(r: { group: string; machine: string; names: string[] }): SwitchLedger {
  return {
    name: `${r.group} features`,
    subject: r.machine,
    figures: [{ value: String(r.names.length), label: "capabilities added", tone: "warn" }],
    rows: [
      { k: "Adds", v: plural(r.names.length, "feature"), list: r.names },
      { k: "Applies to", v: "New sessions here" },
    ],
    stop: "Each card's switch",
    confirm: `Turn on ${r.names.length}`,
  };
}

/** A paused routine set running: a recurring agent run on its schedule. */
export function routineActivateLedger(r: { title: string; every: string; applies: boolean; cost?: RunCost | null; nextAt?: number | null }): SwitchLedger {
  return {
    name: `Activate ${r.title}`,
    subject: `Every ${r.every}`,
    shift: ["Paused", "Running"],
    figures: [{ value: "1", label: `paid run every ${r.every}`, tone: "warn" }, costFigure(r.cost, 1, "a run")],
    rows: [
      listRow(r.cost),
      r.applies ? { k: "Acts", v: "Applies changes", tone: "warn" } : { k: "Acts", v: "Proposes only", tone: "ok" },
      { k: "First run", v: r.nextAt ? new Date(r.nextAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) : "Next slot" },
    ],
    stop: "Pause its trigger",
    confirm: "Activate",
    keep: "Keep paused",
  };
}

/** A money answer of a template hire raised after the hire (org-hire.md H3): the role may spend more once its machine has it. */
export function answerRaiseLedger(r: { label: string; from: number; to: number; role: string; machine?: string | null }): SwitchLedger {
  return {
    name: `Raise ${r.label}`,
    subject: r.role,
    shift: [usd(r.from), usd(r.to)],
    figures: [{ value: usd(r.to), label: r.label, tone: "warn" }, { value: `+${usd(r.to - r.from)}`, label: "more than now", tone: "warn" }],
    rows: [
      { k: "Spent by", v: r.role },
      { k: "Applies", v: r.machine ? `Next host step · ${r.machine}` : "Next host step" },
    ],
    stop: `Lower it here`,
    confirm: `Raise to ${usd(r.to)}`,
    keep: `Keep ${usd(r.from)}`,
  };
}

/** A selection of sessions ended, some of them mid-turn. */
export function killSessionsLedger(r: { total: number; working: string[] }): SwitchLedger {
  const w = r.working.length;
  return {
    name: `Kill ${r.total} sessions`,
    subject: `${w} working now`,
    shift: ["Running", "Ended"],
    figures: [{ value: String(w), label: "cut off mid-turn", tone: "warn" }, { value: String(r.total), label: "end" }],
    rows: [
      { k: "Working", v: plural(w, "session"), list: r.working.slice(0, 4).concat(w > 4 ? [`+${w - 4} more`] : []), tone: "warn" },
      { k: "Lost", v: "Unfinished turns", tone: "warn" },
      { k: "Triggers", v: "Canceled" },
      { k: "To undo", v: "Restore · turn lost" },
    ],
    confirm: `Kill ${r.total}`,
    keep: "Keep running",
  };
}

/** A session's change sent through a flow of the pool (docs/architecture/flows.md FL4): the session freezes its own
 *  edits, binds them to a task, and its machine runs each step; an agent step starts a session of its own, a check runs
 *  a command that only looks, an automatic step runs one that acts (a rebase, a ship), and a person's step is a
 *  question in their queue. */
export function flowRunLedger(r: { flow: string; session: string; stations: ReadonlyArray<{ label: string; kind: string }>; asks: ReadonlyArray<string>; ends: ReadonlyArray<string> }): SwitchLedger {
  const by = (kind: string) => r.stations.filter((s) => s.kind === kind).map((s) => s.label);
  const agents = by("agent");
  const checks = by("script");
  const auto = by("auto");
  return {
    name: `Run through ${r.flow}`,
    subject: r.session,
    shift: null,
    figures: [
      { value: String(r.stations.length), label: r.stations.length === 1 ? "step" : "steps" },
      { value: String(agents.length), label: agents.length === 1 ? "agent session starts" : "agent sessions start", ...(agents.length ? { tone: "warn" as const } : {}) },
      { value: String(r.asks.length), label: r.asks.length === 1 ? "question for you" : "questions for you" },
    ],
    rows: [
      { k: "Change", v: "This session's own edits" },
      ...(agents.length ? [{ k: "An agent", v: agents.join(", ") }] : []),
      ...(checks.length ? [{ k: "A check", v: checks.join(", ") }] : []),
      ...(auto.length ? [{ k: "Automatic", v: auto.join(", ") }] : []),
      ...r.asks.map((q) => ({ k: "You", v: q })),
      { k: "Can end", v: `${r.ends.length} ways`, list: [...r.ends] },
    ],
    stop: "Stop on its card",
    confirm: `Run through ${r.flow}`,
    keep: "Not now",
  };
}

/** Joining a team machine: a Linux user of your own on a box others share, which its admin can read. */
export function teamMachineJoinLedger(r: {
  machine: string; team: string; admin: string; linuxUser: string; members: number;
  load: { cpu_pct?: number; mem_free_gb: number; mem_total_gb: number; busy: boolean } | null;
  adminOnline: boolean;
}): SwitchLedger {
  return {
    name: "Join team machine",
    subject: `${r.machine} · ${r.team}`,
    shift: null,
    figures: [
      { value: String(r.members), label: r.members === 1 ? "member" : "members" },
      ...(r.load ? [
        ...(r.load.cpu_pct !== undefined ? [{ value: `${r.load.cpu_pct}%`, label: "CPU in use", ...(r.load.busy ? { tone: "warn" as const } : {}) }] : []),
        { value: `${Math.round(r.load.mem_free_gb)} GB`, label: `free of ${r.load.mem_total_gb}` },
      ] : []),
    ],
    rows: [
      { k: "Your user", v: r.linuxUser },
      { k: "Runs as", v: "You · your Claude account" },
      { k: "Root", v: `${r.admin} (admin)`, tone: "warn" },
      { k: "Installs", v: "Your bun, cast, agent CLIs" },
      { k: "Then", v: "Sign in to Claude" },
      ...(r.adminOnline ? [] : [{ k: "Starts", v: `When ${r.admin}'s machine is back`, tone: "warn" as const }]),
      { k: "To undo", v: "Leave · your files stay" },
    ],
    confirm: `Join as ${r.linuxUser}`,
    keep: "Cancel",
  };
}

/** Redrawing a role's icon (roleIcon.ts, roleIcons.generate): three drawings
 *  and a judge on Claude Opus, replacing the icon every viewer with characters
 *  off sees. A second round runs only when the judge rejects all three. */
export function redrawIconLedger(r: { title: string; handle: string; concept: string | null; hint: string | null }): SwitchLedger {
  return {
    name: r.concept ? "Redraw icon" : "Draw icon",
    subject: `${r.title} · @${r.handle}`,
    shift: null,
    figures: [{ value: "$0.20", label: "about, $0.40 at most" }, { value: "~30 s", label: "to draw" }],
    rows: [
      { k: "Draws", v: "3 options, Claude Opus picks one" },
      { k: "Replaces", v: r.concept ?? "The letter tile" },
      { k: "Hint", v: r.hint ?? "None" },
      { k: "Seen by", v: "Everyone with Characters off" },
      { k: "Undo", v: "Redraw again" },
    ],
    confirm: r.concept ? "Redraw" : "Draw",
    keep: "Cancel",
  };
}

/** Sharing one of your machine's skills, commands or subagents into the workspace kit. */
export function kitShareLedger(r: { name: string; kindLabel: string; kit: string; members: number; runs: "prose" | "code" | "unknown"; machine: string }): SwitchLedger {
  return {
    name: "Share",
    subject: `${r.kindLabel} · ${r.name}`,
    shift: null,
    figures: [
      { value: String(r.members), label: r.members === 1 ? "person can see it" : "people can see it" },
      r.runs === "code"
        ? { value: "Code", label: "runs on their machines", tone: "warn" as const }
        : r.runs === "prose"
          ? { value: "Text", label: "read by their agents" }
          : { value: "Scanned", label: "on upload; code asks each machine" },
    ],
    rows: [
      { k: "Into", v: r.kit },
      { k: "From", v: r.machine },
      { k: "Turned on", v: "By each person, or an admin for all" },
      { k: "Undo", v: "Remove it from the kit" },
    ],
    confirm: "Share",
    keep: "Cancel",
  };
}

/** An admin turning a kit item on for every member's machines. */
export function kitTeamLedger(r: { name: string; kit: string; members: number; runsCode: boolean }): SwitchLedger {
  return {
    name: "On for the team",
    subject: r.name,
    shift: ["Off", "Team"],
    figures: [
      { value: String(r.members), label: r.members === 1 ? "person's machines" : "people's machines" },
      { value: r.runsCode ? "Code" : "Text", label: r.runsCode ? "each machine asks first" : "installs on next sync", ...(r.runsCode ? { tone: "warn" as const } : {}) },
    ],
    rows: [
      { k: "Kit", v: r.kit },
      { k: "Members can", v: "Turn it off for themselves" },
    ],
    stop: "Switch back to Me or Off",
    confirm: "Turn on for everyone",
    keep: "Cancel",
  };
}

/** Taking an item out of the kit: it uninstalls from every machine that has it through the kit. */
export function kitRemoveLedger(r: { name: string; kit: string; members: number }): SwitchLedger {
  return {
    name: "Remove from kit",
    subject: r.name,
    shift: null,
    alert: "Uninstalls on every machine",
    figures: [{ value: String(r.members), label: r.members === 1 ? "person affected" : "people affected", tone: "warn" }],
    rows: [
      { k: "Kit", v: r.kit },
      { k: "Versions", v: "Kept; share again to restore" },
    ],
    confirm: "Remove",
    keep: "Cancel",
  };
}

/** Share out (decisions/DecisionAreas): who would get which open decisions, as convex decisionShareOut.preview reads it. */
export type ShareOutPreview = {
  moves: Array<{ decision_id: string; from: string | null; to: string; short_id?: string; question: string }>;
  to: Array<{ user_id: string; name: string; count: number }>;
  considered: number;
  unmatched: number;
};

/** Share out's review: how many move, to whom, and what stays. Pure, so it is tested without a browser. */
export function shareOutLedger(p: ShareOutPreview): SwitchLedger {
  const stays = p.considered - p.moves.length;
  return {
    name: "Share out",
    subject: `${p.considered} open decision${p.considered === 1 ? "" : "s"} with an area`,
    shift: null,
    figures: [
      { value: String(p.moves.length), label: "move", tone: p.moves.length ? "warn" : undefined },
      { value: String(p.to.length), label: p.to.length === 1 ? "person" : "people" },
      { value: String(stays), label: "stay" },
      { value: String(p.unmatched), label: "no one covers" },
    ],
    rows: [
      ...p.to.map((t) => ({ k: t.name, v: `${t.count}`, list: p.moves.filter((m) => m.to === t.user_id).map((m) => `${m.short_id ? `${m.short_id} ` : ""}${m.question}`) })),
      { k: "Each person", v: "Told once" },
      { k: "Kept as is", v: "Passed, escalated, asked by name, protected" },
    ],
    confirm: p.moves.length ? `Share out ${p.moves.length}` : "Share out",
    keep: "Cancel",
    ...(p.moves.length ? {} : { blocked: "Nothing to move" }),
  };
}
