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
// Precedence is working > shipping > sleeping: a session whose own workers are
// producing reads Working even while its run waits. Pure and isomorphic: the
// web rail, the phone and the server's `cast sessions` all call it.
import { ACTIVE_AGENT_STATUSES } from "./agentStatus";
import type { WaitingOn } from "./inboxProjection";
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
}

export interface SessionActivityRow extends DormantWakeSession {
  hibernated_at?: number | null;
  waiting_on?: WaitingOn | null;
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
  now: number;
}

export type WorkingActivity = { state: "working"; kind: WorkKind; verb: WorkVerb | null; count: number; words: string };
export type ShippingActivity = { state: "shipping"; stage: ShipStage; failed: boolean; words: string; pr?: string; target?: string };
export type SleepingActivity<T extends DormantTriggerRow = DormantTriggerRow> =
  /** `on` is null for a task blocker or wait whose task the caller could not name; `wake` then carries it. */
  | { state: "sleeping"; flavor: "waiting"; on: Omit<WaitingOn, "at"> | null; since: number | null; wake: Extract<DormantWake<T>, { kind: "blocker" | "wait" }> | null; hibernated: boolean }
  | { state: "sleeping"; flavor: "scheduled"; wake: Extract<DormantWake<T>, { kind: "trigger" | "trigger_unloaded" }>; hibernated: boolean }
  /** Nothing visible will wake it; it returns to the person at `wake.back`. */
  | { state: "sleeping"; flavor: "stalled"; wake: Extract<DormantWake<T>, { kind: "claim" }>; hibernated: boolean }
  | { state: "sleeping"; flavor: "snoozed"; wake: Extract<DormantWake<T>, { kind: "snoozed" }>; hibernated: boolean }
  | { state: "sleeping"; flavor: "parked"; wake: Extract<DormantWake<T>, { kind: "parked" }>; hibernated: boolean }
  | { state: "sleeping"; flavor: "unconfirmed"; wake: Extract<DormantWake<T>, { kind: "unconfirmed" | "run_unreported" }>; hibernated: boolean };
export type SessionActivity<T extends DormantTriggerRow = DormantTriggerRow> = WorkingActivity | ShippingActivity | SleepingActivity<T>;

/**
 * How many of a session's child rows are running. Today it reads the facts the
 * child rows carry (an active agent_status, or producing ahead); ct-102250
 * (pl-1134) will write the authoritative running status on the child's own
 * row, and this is the one place that reads it then.
 */
export function childrenRunningOf(children: ReadonlyArray<{ agent_status?: string | null; producing_until?: number | null }>, now: number): number {
  return children.filter((c) => (c.agent_status != null && ACTIVE_AGENT_STATUSES.has(c.agent_status)) || (c.producing_until != null && now < c.producing_until)).length;
}

// ── Verbs ────────────────────────────────────────────────────────────────────

const VERB_RULES: Record<WorkVerb, RegExp> = {
  reviewing: /\b(review|verif|critic|audit)/i,
  building: /\b(implement|build|fix|wir(e|es|ed|ing)\b)/i,
  researching: /\b(research|explor|min(e|es|ing)\b|map(s|ping)?\b)/i,
  measuring: /\b(eval|draws?\b|replay|seal|sweep)/i,
  testing: /\b(test|typecheck|tsc\b)|\bcast check\b/i,
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
    words: shipWords(ship),
    ...(ship.pr ? { pr: ship.pr } : {}),
    ...(ship.target ? { target: ship.target } : {}),
  };
}

/** A background command (or Monitor) that watches CI or a deploy, and the stage it watches. */
// The command is read by what it runs; a description (a Monitor's) by its
// words, since only there does "deploy" or "CI" name what it watches
// (`bun test deploy.test.ts` and `CI=1 bun test` are tests).
export function shipStageOfCommand(t: { description?: string; command?: string }): ShipInput | null {
  const cmd = t.command ?? "";
  const desc = t.description ?? "";
  if (/\bcast\s+deploy\b|deploy\.sh\b|\bfly\s+deploy\b|\brailway\s+up\b|\bdeploy\.ya?ml\b|--workflow[= ]\S*(deploy|release)|\bgh\s+workflow\s+run\b.*\b(deploy|release)|cut-cli-release/i.test(cmd) || /\bdeploy(s|ing|ed)?\b/i.test(desc)) {
    const target = cmd.match(/\bcast\s+deploy\s+([a-z][\w-]*)/i)?.[1] ?? cmd.match(/packages\/([\w-]+)\/deploy\.sh\b/)?.[1] ?? cmd.match(/deploy\.sh\s+--([a-z][\w-]*)/)?.[1] ?? null;
    return { stage: "deploy", target };
  }
  if (/\bcast\s+flow\s+run\b/.test(cmd)) return { stage: "ci" };
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) return { stage: "merge", pr: prOf(cmd) };
  if (/\bgh\s+run\s+(watch|view)\b|\bgh\s+pr\s+checks\b/.test(cmd) || /\bCI\b/.test(desc)) return { stage: "ci", pr: prOf(cmd) };
  return null;
}

const prOf = (text: string): string | null => {
  const n = text.match(/\bgh\s+pr\s+(?:checks|merge|view)\s+#?(\d+)/)?.[1];
  return n ? `#${n}` : null;
};

const EVENT_STAGE: Record<string, ShipStage> = {
  pr_checks_green: "ci",
  pr_check_failed: "ci",
  pr_review_requested: "review",
  pr_review: "review",
  pr_approved: "review",
  pr_changes_requested: "review",
  pr_merged: "merge",
  deploy: "deploy",
  deploy_failed: "deploy",
  deploy_live: "live",
};
const STAGE_ORDER: ShipStage[] = ["ci", "review", "merge", "deploy", "live"];

/** The earliest ship stage an armed event trigger into the session waits on. */
function shipOfTriggers(triggers: DormantTriggerRow[]): ShipInput | null {
  let best: ShipInput | null = null;
  for (const r of triggers) {
    const filter = r.task.event_filter;
    const stage = filter ? EVENT_STAGE[filter.event_type] : undefined;
    if (!stage || !isArmedTrigger(r)) continue;
    if (!best || STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(best.stage)) best = { stage, pr: filter?.pr_number ? `#${filter.pr_number}` : null };
  }
  return best;
}

// ── The split ────────────────────────────────────────────────────────────────

function workingOf<T extends DormantTriggerRow>(input: SessionActivityInput<T>, commands: DormantWatch[], liveRun: boolean): WorkingActivity | null {
  const { row, now } = input;
  const open = row.open_tasks ?? [];
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

  const own = commands.filter((c) => !shipStageOfCommand(c));
  if (own.length > 0) {
    const texts = own.map(textOf);
    const verbs = texts.map((t) => verbOfText(t, COMMAND_ORDER));
    if (verbs.every((v) => v === "measuring")) return work("evals", "measuring", own.length, `measuring · ${plural(own.length, "eval draw")}`);
    const verb = verbOfAll(texts, COMMAND_ORDER);
    const words = verb === "testing" ? "running tests"
      : verb ? verb
      : own.length > 1 ? `${own.length} background commands`
      : (own[0].description || own[0].command?.split("\n").find((l) => l.trim()) || "background command").trim();
    return work("command", verb, own.length, words);
  }

  if (liveRun && !input.runShips) return work("workflow", null, 1, "workflow · a run it started");
  return null;
}

function shippingOf<T extends DormantTriggerRow>(input: SessionActivityInput<T>, commands: DormantWatch[], liveRun: boolean): ShippingActivity | null {
  if (input.ship) return shipping(input.ship);
  if (input.runShips && (liveRun || runningWorkflowName(input.row))) return shipping({ stage: "ci" });
  for (const c of commands) {
    const ship = shipStageOfCommand(c);
    if (ship) return shipping(ship);
  }
  const ship = shipOfTriggers(input.triggers);
  return ship ? shipping(ship) : null;
}

function sleepingOf<T extends DormantTriggerRow>(input: SessionActivityInput<T>): SleepingActivity<T> {
  const { row, now } = input;
  const hibernated = !!row.hibernated_at || row.agent_status === "hibernated";
  if (row.user_rest === "dormant") return { state: "sleeping", flavor: "parked", wake: { kind: "parked" }, hibernated };
  if (row.inbox_snoozed_until && row.inbox_snoozed_until > now) return { state: "sleeping", flavor: "snoozed", wake: { kind: "snoozed", at: row.inbox_snoozed_until }, hibernated };
  if (row.waiting_on) {
    const { kind, ref, at } = row.waiting_on;
    return { state: "sleeping", flavor: "waiting", on: { kind, ref }, since: at ?? null, wake: null, hibernated };
  }
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
    case "claim":
      return { state: "sleeping", flavor: "stalled", wake, hibernated };
    case "run":
      throw new Error("a live run reads working or shipping");
  }
}

/** Which section a dormant row draws in, and what its under-line says. */
export function sessionActivity<T extends DormantTriggerRow>(input: SessionActivityInput<T>): SessionActivity<T> {
  const { row, now } = input;
  const commands = input.watches?.length ? input.watches : (row.open_tasks ?? []).filter((t) => t.kind !== "agent" && t.kind !== "workflow");
  const liveRun = serverParkOf(row, now)?.kind === "run";
  return workingOf(input, commands, liveRun) ?? shippingOf(input, commands, liveRun) ?? sleepingOf(input);
}
