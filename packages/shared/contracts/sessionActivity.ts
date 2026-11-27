// What a Dormant row is really doing, for the inbox's Working / Shipping /
// Sleeping sections (plan pl-1138). Placement is untouched: the classifier
// still files these rows in its `dormant` bucket, and this splits that bucket
// for display only, with the words the row's under-line carries.
//
//   working   its own work runs while the agent itself is idle: background
//             subagents, child sessions, a workflow, eval draws, a long command
//   shipping  its change is between CI and live
//   sleeping  only a wait stands: on someone or something, a trigger, or
//             nothing visible at all (stalled)
//
// The person's own filing (a park, an active snooze) speaks first, as it does
// in the classifier. Past that, precedence is working > shipping > sleeping: a
// session whose own workers are producing reads Working even while its run
// waits. Pure and isomorphic: the
// web rail, the phone and the server's `cast sessions` all call it.
import { ACTIVE_AGENT_STATUSES } from "./agentStatus";
import { rowHeartbeatAliveAt, trustedStatusAt } from "./inboxProjection";
import type { WaitingOn } from "./waitingOn";
import { openTasksVouchForWaiting } from "./openTasks";
import {
  isArmedTrigger,
  runningWorkflowName,
  serverParkOf,
  sleepingWakeOf,
  type DormantTriggerRow,
  type DormantWake,
  type DormantWakeSession,
  type DormantWatch,
} from "./dormantWake";

export type WorkKind = "subagents" | "workers" | "workflow" | "evals" | "command";
export type WorkVerb = "reviewing" | "building" | "researching" | "measuring" | "testing";
/** The ship pipeline's five segments: Check, Review, Merge, Deploy, Live. */
export type ShipStage = "ci" | "review" | "merge" | "deploy" | "live";

/** Where the session's change is, as the caller resolves it (web: lib/ship/sessionShip; the server: the live change run). Only an in-flight change: a landed or stopped one is not shipping. */
export interface ShipInput {
  stage: ShipStage;
  failed?: boolean;
  /** The pull request, as "#263". */
  pr?: string | null;
  /** The deploy target, as "web". */
  target?: string | null;
  /** The step is held for a person: `you` (a gate the viewer answers, a deploy the viewer presses) asks for attention; `other` waits on someone else. */
  holder?: "you" | "other" | null;
  /** What the hold says ("Your call", "Waiting for green main"), in place of the stage's own words. */
  words?: string | null;
}

export interface SessionActivityRow extends DormantWakeSession {
  hibernated_at?: number | null;
  waiting_on?: WaitingOn | null;
  /** The pull request this session shepherds, folded onto the row by the server. */
  pr_status?: { repository?: string; number: number; state?: string } | null;
}

export interface SessionActivityInput<T extends DormantTriggerRow> {
  row: SessionActivityRow;
  /** The trigger rows into this session (web sessionTriggerRows); only armed ones count. */
  triggers: T[];
  /** Background shells and Monitors a surface watches live; they stand in for the row's shell open_tasks when given. */
  watches?: DormantWatch[];
  /** childrenRunningOf over the session's child rows. */
  childrenRunning?: number;
  /** What the running children are doing (their titles), for the workers' verb. */
  childWork?: string[];
  ship?: ShipInput | null;
  /** The run this session started (parked_wake_kind "run") or runs (workflow_run_id) is a flow that ships a change. */
  runShips?: boolean;
  /** The task a blocker or wait park waits on (its short id), when the caller knows it. */
  waitTask?: string | null;
  /** The name of the live run the session started that ships nothing (a build, an eval): "running build". */
  runName?: string | null;
  /** The session's own open pull request (its live change run's), when the caller knows it; else the row's pr_status while open. */
  ownPr?: PrRef | null;
  /** Whether the caller knows a pull request has merged or closed: a trigger on it is no longer shipping or a wait. */
  prEnded?: (pr: PrRef) => boolean;
  now: number;
}

export type WorkingActivity = { state: "working"; kind: WorkKind; verb: WorkVerb | null; count: number; words: string };
export type ShippingActivity = { state: "shipping"; stage: ShipStage; failed: boolean; words: string; holder?: "you" | "other"; pr?: string; target?: string };
export type SleepingActivity<T extends DormantTriggerRow = DormantTriggerRow> =
  /** `on` is null for a task blocker or wait whose task the caller could not name; `wake` then carries it. */
  | { state: "sleeping"; flavor: "waiting"; on: Omit<WaitingOn, "at"> | null; since: number | null; wake: Extract<DormantWake<T>, { kind: "blocker" | "wait" }> | null; hibernated: boolean }
  /** An armed trigger, or (`background`) a command that only waits out a clock. */
  | { state: "sleeping"; flavor: "scheduled"; wake: Extract<DormantWake<T>, { kind: "trigger" | "trigger_unloaded" | "background" }>; hibernated: boolean }
  /** Nothing visible will wake it; it returns to the person at `wake.back`. */
  | { state: "sleeping"; flavor: "stalled"; wake: Extract<DormantWake<T>, { kind: "claim" }>; hibernated: boolean }
  | { state: "sleeping"; flavor: "snoozed"; wake: Extract<DormantWake<T>, { kind: "snoozed" }>; hibernated: boolean }
  | { state: "sleeping"; flavor: "parked"; wake: Extract<DormantWake<T>, { kind: "parked" }>; hibernated: boolean }
  | { state: "sleeping"; flavor: "unconfirmed"; wake: Extract<DormantWake<T>, { kind: "unconfirmed" | "run_unreported" }>; hibernated: boolean };
export type SessionActivity<T extends DormantTriggerRow = DormantTriggerRow> = WorkingActivity | ShippingActivity | SleepingActivity<T>;

export type ChildRunningRow = {
  agent_status?: string | null;
  producing_until?: number | null;
  updated_at?: number;
  last_heartbeat?: number | null;
  open_tasks?: unknown[] | null;
  open_tasks_at?: number | null;
  inbox_killed_at?: number | null;
  inbox_dismissed_at?: number | null;
};

/**
 * How many of a session's child rows are running. Today it reads the facts the
 * child rows carry (an active agent_status, or producing ahead); ct-102250
 * (pl-1134) will write the authoritative running status on the child's own
 * row, and this is the one place that reads it then. A child counts only while
 * it is alive, as every other reader judges it: its heartbeat inside the
 * window and its status the trusted one (trustedStatusAt), never a closed row.
 */
export function childrenRunningOf(children: ReadonlyArray<ChildRunningRow>, now: number): number {
  return children.filter((c) => {
    if (c.inbox_killed_at || c.inbox_dismissed_at || !rowHeartbeatAliveAt(c, now)) return false;
    const status = trustedStatusAt({ ...c, updated_at: c.updated_at ?? 0 }, now);
    return (status != null && ACTIVE_AGENT_STATUSES.has(status)) || (c.producing_until != null && now < c.producing_until);
  }).length;
}

// ── Verbs ────────────────────────────────────────────────────────────────────

const VERB_RULES: Record<WorkVerb, RegExp> = {
  reviewing: /\b(review|verif|critic|audit)/i,
  building: /\b(implement|build|fix|wir(e|es|ed|ing)\b)/i,
  researching: /\b(research|explor|min(e|es|ing)\b|map(s|ping)?\b)/i,
  // Only words that name the evals harness: "Evaluate the options" and
  // "Sweep the repo" are ordinary work.
  measuring: /\.\/evals\b|\bevals?\b|\bxrun\b|(?<!\.)\bfreezes?\b|\breplay(s|ed|ing)?\b|(?<!\.)\bseal(s|ed|ing)?\b/i,
  testing: /\b(test|typecheck|tsc\b|ci\b|lint\b)|\bcast check\b/i,
};
// What a subagent or worker is asked to do reads by its task first; a command
// by what it runs first (`bun test evals/x.test.ts` is testing, not measuring).
const DESCRIPTION_ORDER: WorkVerb[] = ["reviewing", "building", "researching", "measuring", "testing"];
const COMMAND_ORDER: WorkVerb[] = ["testing", "measuring", "building", "reviewing", "researching"];

function verbOfText(text: string, order: WorkVerb[]): WorkVerb | null {
  return order.find((v) => VERB_RULES[v].test(text)) ?? null;
}

/** The verb most of the texts share; a tie goes to the one seen first. */
function verbOfAll(texts: string[], order: WorkVerb[]): WorkVerb | null {
  const counts = new Map<WorkVerb, number>();
  for (const t of texts) {
    const v = verbOfText(t, order);
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: WorkVerb | null = null;
  for (const [v, n] of counts) if (!best || n > counts.get(best)!) best = v;
  return best;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const textOf = (t: { description?: string; command?: string }) => `${t.description ?? ""} ${t.command ?? ""}`.trim();

// ── Shipping words ───────────────────────────────────────────────────────────

const STAGE_FAILED: Record<ShipStage, string> = {
  ci: "CI failed · fixing",
  review: "Changes requested · fixing",
  merge: "Merge failed · fixing",
  deploy: "Deploy failed · fixing",
  live: "Not live · fixing",
};

export function shipWords(ship: ShipInput): string {
  if (ship.failed) return STAGE_FAILED[ship.stage];
  switch (ship.stage) {
    case "ci": return ship.pr ? `CI running · ${ship.pr}` : "CI running";
    case "review": return "In review";
    case "merge": return "Merging";
    case "deploy": return ship.target ? `Deploying ${ship.target}` : "Deploying";
    case "live": return "Checking it's live";
  }
}

function shipping(ship: ShipInput): ShippingActivity {
  return {
    state: "shipping",
    stage: ship.stage,
    failed: !!ship.failed,
    words: ship.words || shipWords(ship),
    ...(ship.holder ? { holder: ship.holder } : {}),
    ...(ship.pr ? { pr: ship.pr } : {}),
    ...(ship.target ? { target: ship.target } : {}),
  };
}

// The commands a shell line runs, each as its words: split at every operator
// and substitution, with the words that only lead a command (an env
// assignment, `until`, `do`, `[`, `bash`…) taken off. A tool named as an
// argument (`cat deploy.sh`, `bun test deploy.sh.test.ts`) is never one.
const LEADERS = new Set(["until", "while", "do", "then", "else", "if", "!", "[", "[[", "time", "nohup", "exec", "command", "sudo", "bash", "sh", "zsh", "env"]);
function invocations(cmd: string): string[][] {
  return cmd.split(/&&|\|\||[;|\n`]|\$\(|\(/).map((seg) => {
    const words = seg.trim().split(/\s+/).map((w) => w.replace(/^["']+|["')]+$/g, "")).filter(Boolean);
    let i = 0;
    while (i < words.length && (LEADERS.has(words[i]) || /^\w+=/.test(words[i]))) i++;
    return words.slice(i);
  }).filter((w) => w.length > 0);
}

// The deploy target a deploy names: `cast deploy web`, `packages/convex/deploy.sh`,
// or a target flag (`deploy.sh --actor Jason --backend`: --actor takes a value,
// --backend names the component).
const DEPLOY_TARGET_FLAGS = new Set(["backend", "web", "cli", "mobile", "desktop", "convex", "electric", "intern", "aivery", "landing"]);
function deployScriptTarget(words: string[]): string | null {
  const dir = words[0].match(/(?:^|\/)packages\/([\w-]+)\/deploy\.sh$/)?.[1];
  if (dir) return dir;
  return words.slice(1).map((w) => w.match(/^--([\w-]+)$/)?.[1]).find((f) => !!f && DEPLOY_TARGET_FLAGS.has(f)) ?? null;
}

const SHIPPING_FLOWS = new Set(["change", "ship"]);

function shipOfInvocation(words: string[], cmd: string): ShipInput | null {
  const [a, b, c, d] = words;
  const has = (flag: RegExp) => words.some((w) => flag.test(w));
  if (a === "cast" && b === "flow" && c === "run") {
    return d && (SHIPPING_FLOWS.has(d) || d.endsWith(".cast")) && !has(/^--dry-run$/) ? { stage: "ci" } : null;
  }
  if (a === "cast" && b === "deploy") {
    if (has(/^(--help|-h)$/)) return null;
    return { stage: "deploy", target: words.slice(2).find((w) => !w.startsWith("-")) ?? null };
  }
  if (/(^|\/)(deploy|release)\.sh$/.test(a ?? "")) return { stage: "deploy", target: deployScriptTarget(words) };
  if ((a === "fly" && b === "deploy") || (a === "railway" && b === "up")) return { stage: "deploy" };
  if (a === "gh" && b === "workflow" && c === "run") return /deploy|release/i.test(d ?? "") ? { stage: "deploy" } : null;
  if (a === "gh" && b === "run" && (c === "watch" || (c === "view" && !has(/^--log/)))) {
    // Watching a deploy workflow's run is watching the deploy.
    return /--workflow[= ]\S*(deploy|release)|\bdeploy\.ya?ml\b/i.test(cmd) ? { stage: "deploy" } : { stage: "ci" };
  }
  if (a === "gh" && b === "pr" && c === "checks") return { stage: "ci", pr: prRef(d) };
  if (a === "gh" && b === "pr" && c === "merge") return { stage: "merge", pr: prRef(d) };
  return null;
}

const prRef = (word: string | undefined): string | null => {
  const n = word?.match(/^#?(\d+)$/)?.[1];
  return n ? `#${n}` : null;
};

/** A background command or Monitor that watches CI or a deploy, and the stage
 *  it watches. The command is read by what it invokes. Only a Monitor's
 *  description counts, since a Monitor says there what it watches; a shell's
 *  description is the Bash tool's ("Run deploy tests" is a test). */
export function shipStageOfCommand(t: { kind?: string; description?: string; command?: string }): ShipInput | null {
  const cmd = t.command ?? "";
  for (const words of invocations(cmd)) {
    const ship = shipOfInvocation(words, cmd);
    if (ship) return ship;
  }
  if (t.kind !== "monitor") return null;
  const desc = t.description ?? "";
  if (/\bdeploy(s|ing|ed)?\b/i.test(desc)) return { stage: "deploy" };
  if (/\bCI\b/.test(desc)) return { stage: "ci" };
  return null;
}

/** A command that only waits out a clock (`sleep 1800 && echo done`, an
 *  `until …; do sleep 5; done` poll of nothing the pipeline or evals run): a
 *  timed wake, not work. */
export function isTimedWait(t: { command?: string }): boolean {
  const cmd = t.command ?? "";
  return /(^|[\s;&|(])sleep\s+\d/.test(cmd) && !shipStageOfCommand({ command: cmd }) && verbOfText(cmd, COMMAND_ORDER) === null;
}

// The events that say a step of one change's pipeline happened. Failure-only
// events (pr_check_failed, deploy_failed) are a guard, not the wait.
const EVENT_STAGE: Record<string, ShipStage> = {
  pr_checks_green: "ci",
  pr_review_requested: "review",
  pr_review: "review",
  pr_approved: "review",
  pr_changes_requested: "review",
  pr_merged: "merge",
};
const STAGE_ORDER: ShipStage[] = ["ci", "review", "merge", "deploy", "live"];

/** A pull request as the facts name it: its number, and its repository when known. */
export type PrRef = { repository?: string | null; number: number };

const samePr = (a: PrRef, b: PrRef) =>
  a.number === b.number && (!a.repository || !b.repository || a.repository.toLowerCase() === b.repository.toLowerCase());

/** The session's own open pull request: the caller's (its live run's), else the one it shepherds while that is open. */
function ownPrOf<T extends DormantTriggerRow>(input: SessionActivityInput<T>): PrRef | null {
  if (input.ownPr) return input.ownPr;
  const s = input.row.pr_status;
  return s && s.state !== "merged" && s.state !== "closed" ? { repository: s.repository ?? null, number: s.number } : null;
}

/** A pull request that has merged or closed: as the caller knows it, or the session's own as its pr_status says. */
function prEnded<T extends DormantTriggerRow>(input: SessionActivityInput<T>, pr: PrRef): boolean {
  if (input.prEnded?.(pr)) return true;
  const s = input.row.pr_status;
  return !!s && (s.state === "merged" || s.state === "closed") && samePr(pr, { repository: s.repository ?? null, number: s.number });
}

/** The armed pull request event triggers into the session, each with the stage it waits on and its PR. */
function prTriggersOf(triggers: DormantTriggerRow[]): Array<{ stage: ShipStage; pr: PrRef }> {
  const out: Array<{ stage: ShipStage; pr: PrRef }> = [];
  for (const r of triggers) {
    const filter = r.task.event_filter;
    const stage = filter ? EVENT_STAGE[filter.event_type] : undefined;
    if (!stage || !filter?.pr_number || !isArmedTrigger(r)) continue;
    out.push({ stage, pr: { repository: filter.repository ?? null, number: filter.pr_number } });
  }
  return out;
}

/** The earliest ship stage an armed event trigger into the session waits on,
 *  only when it is about this session's own change: its own open pull request,
 *  not one the caller knows has merged or closed. A trigger on anyone else's
 *  PR is a wait on that PR (Sleeping), and one on an ended PR a plain
 *  scheduled wake. Trigger rows do not say whether an event trigger fires
 *  once, and the row's armed_trigger_kind is "standing" for every event
 *  trigger (convex dormancy.ts isStandingInjectTrigger), so a deploy or
 *  deploy_live trigger, which no filter narrows to one change, cannot be told
 *  from a monitor that verifies every deploy: it reads Sleeping (scheduled). */
function shipOfTriggers<T extends DormantTriggerRow>(input: SessionActivityInput<T>): ShipInput | null {
  const own = ownPrOf(input);
  if (!own || prEnded(input, own)) return null;
  let best: ShipInput | null = null;
  for (const { stage, pr } of prTriggersOf(input.triggers)) {
    if (!samePr(pr, own)) continue;
    if (!best || STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(best.stage)) best = { stage, pr: `#${pr.number}` };
  }
  return best;
}

/** An armed trigger on a pull request that is not this session's own and has not ended: what it waits on. */
function otherPrWaitOf<T extends DormantTriggerRow>(input: SessionActivityInput<T>): PrRef | null {
  const own = ownPrOf(input);
  return prTriggersOf(input.triggers).map((t) => t.pr).find((pr) => !(own && samePr(pr, own)) && !prEnded(input, pr)) ?? null;
}

// ── The split ────────────────────────────────────────────────────────────────

type OpenTask = NonNullable<SessionActivityRow["open_tasks"]>[number];

function workingOf<T extends DormantTriggerRow>(input: SessionActivityInput<T>, open: OpenTask[], commands: DormantWatch[], liveRun: boolean): WorkingActivity | null {
  const { row, now } = input;
  const work = (kind: WorkKind, verb: WorkVerb | null, count: number, words: string): WorkingActivity => ({ state: "working", kind, verb, count, words });

  const workflowName = (!input.runShips && runningWorkflowName(row)) || open.find((t) => t.kind === "workflow")?.description || (open.some((t) => t.kind === "workflow") ? "workflow run" : null);
  if (workflowName) return work("workflow", verbOfText(workflowName, DESCRIPTION_ORDER), 1, `workflow · ${workflowName}`);

  const children = input.childrenRunning ?? 0;
  if (children > 0) {
    const verb = verbOfAll(input.childWork ?? [], DESCRIPTION_ORDER);
    const workers = plural(children, "worker");
    return work("workers", verb, children, verb ? `${verb} · ${workers}` : workers);
  }

  const agents = open.filter((t) => t.kind === "agent").map(textOf);
  if (agents.length > 0) {
    const verbs = agents.map((a) => verbOfText(a, DESCRIPTION_ORDER));
    if (verbs.every((v) => v === "measuring")) return work("evals", "measuring", agents.length, `measuring · ${plural(agents.length, "eval draw")}`);
    const verb = verbOfAll(agents, DESCRIPTION_ORDER);
    const subagents = plural(agents.length, "subagent");
    return work("subagents", verb, agents.length, verb ? `${subagents} · ${verb}` : subagents);
  }
  if (row.producing_until != null && now < row.producing_until) return work("subagents", null, 0, "subagents working");

  const own = commands.filter((c) => !shipStageOfCommand(c) && !isTimedWait(c));
  if (own.length > 0) {
    const texts = own.map(textOf);
    const verbs = texts.map((t) => verbOfText(t, COMMAND_ORDER));
    if (verbs.every((v) => v === "measuring")) return work("evals", "measuring", own.length, `measuring · ${plural(own.length, "eval draw")}`);
    const verb = verbOfAll(texts, COMMAND_ORDER);
    // Never the raw command: a command line is data, not a label.
    const words = verb === "testing" ? "running tests"
      : verb ? verb
      : own.length > 1 ? `${own.length} background commands`
      : own[0].description?.trim() || "running a command";
    return work("command", verb, own.length, words);
  }

  if (liveRun && !input.runShips) return work("workflow", null, 1, input.runName ? `running ${input.runName}` : "running a flow");
  return null;
}

function shippingOf<T extends DormantTriggerRow>(input: SessionActivityInput<T>, commands: DormantWatch[], liveRun: boolean): ShippingActivity | null {
  if (input.ship) return shipping(input.ship);
  if (input.runShips && (liveRun || runningWorkflowName(input.row))) return shipping({ stage: "ci" });
  for (const c of commands) {
    const ship = shipStageOfCommand(c);
    if (ship) return shipping(ship);
  }
  const ship = shipOfTriggers(input);
  return ship ? shipping(ship) : null;
}

const hibernatedOf = (row: SessionActivityRow) => !!row.hibernated_at || row.agent_status === "hibernated";

/** The person's own filing: a park or an active snooze outranks every signal. */
function personFiledOf<T extends DormantTriggerRow>(row: SessionActivityRow, now: number): SleepingActivity<T> | null {
  const hibernated = hibernatedOf(row);
  if (row.user_rest === "dormant") return { state: "sleeping", flavor: "parked", wake: { kind: "parked" }, hibernated };
  if (row.inbox_snoozed_until && row.inbox_snoozed_until > now) return { state: "sleeping", flavor: "snoozed", wake: { kind: "snoozed", at: row.inbox_snoozed_until }, hibernated };
  return null;
}

function sleepingOf<T extends DormantTriggerRow>(input: SessionActivityInput<T>, commands: DormantWatch[]): SleepingActivity<T> {
  const { row, now } = input;
  const hibernated = hibernatedOf(row);
  if (row.waiting_on) {
    const { kind, ref, label, at } = row.waiting_on;
    return { state: "sleeping", flavor: "waiting", on: { kind, ref, ...(label ? { label } : {}) }, since: at ?? null, wake: null, hibernated };
  }
  // A trigger on someone else's open pull request: the session waits on that PR.
  const pr = otherPrWaitOf(input);
  if (pr) return { state: "sleeping", flavor: "waiting", on: { kind: "pr", ref: pr.repository ? `${pr.repository}#${pr.number}` : `#${pr.number}`, label: `#${pr.number}` }, since: null, wake: null, hibernated };
  const wake = sleepingWakeOf(row, input.triggers, now);
  switch (wake.kind) {
    case "trigger":
    case "trigger_unloaded":
      return { state: "sleeping", flavor: "scheduled", wake, hibernated };
    case "blocker":
    case "wait":
      return { state: "sleeping", flavor: "waiting", on: input.waitTask ? { kind: "task", ref: input.waitTask } : null, since: null, wake, hibernated };
    case "unconfirmed":
    case "run_unreported":
      return { state: "sleeping", flavor: "unconfirmed", wake, hibernated };
    case "claim": {
      // A command that waits out a clock is a timed wake the row can see.
      const waits = commands.filter(isTimedWait);
      if (waits.length > 0) return { state: "sleeping", flavor: "scheduled", wake: { kind: "background", count: waits.length, what: waits[0].description?.trim() || "a timed wait" }, hibernated };
      return { state: "sleeping", flavor: "stalled", wake, hibernated };
    }
    case "run":
      throw new Error("a live run reads working or shipping");
  }
}

/** Which section a dormant row draws in, and what its under-line says. */
export function sessionActivity<T extends DormantTriggerRow>(input: SessionActivityInput<T>): SessionActivity<T> {
  const { row, now } = input;
  const filed = personFiledOf<T>(row, now);
  if (filed) return filed;
  // The daemon's report of open background work counts only while it vouches
  // for it, the classifier's own rule: a report from a machine that stopped
  // heartbeating is leftovers, not work.
  const open = openTasksVouchForWaiting(row.open_tasks_at, row.open_tasks?.length ?? 0, rowHeartbeatAliveAt(row, now)) ? row.open_tasks ?? [] : [];
  const commands = input.watches?.length ? input.watches : open.filter((t) => t.kind !== "agent" && t.kind !== "workflow");
  const liveRun = serverParkOf(row, now)?.kind === "run";
  return workingOf(input, open, commands, liveRun) ?? shippingOf(input, commands, liveRun) ?? sleepingOf(input, commands);
}
