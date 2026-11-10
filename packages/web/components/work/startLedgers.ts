// The reviews for starting agent work from the work-object pages: running a
// trigger now, arming one (new, resumed or reactivated), and starting a
// workflow run. Each start is a paid agent run, so the press goes through the
// shared confirm flow (components/consequential) with one of these ledgers.
// Plain data, built from what the page already holds.
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";
import { costFigure, listRow, type RunCost } from "../consequential/lineStartLedger";
import { fmtClock, fmtDuration } from "../triggerCadence";

type TriggerFacts = {
  title: string;
  /** The cadence in words (describeTaskCadence). */
  cadence: string;
  schedule: "once" | "recurring" | "event" | string | undefined;
  intervalMs?: number | null;
  agent?: string | null;
  project?: string | null;
  applies: boolean;
  /** Its home is the hosted assistant: no agent or project of its own. */
  hosted?: boolean;
};

const actsRow = (applies: boolean): SwitchLedger["rows"][number] =>
  applies ? { k: "Acts", v: "Applies changes", tone: "warn" } : { k: "Acts", v: "Reports only", tone: "ok" };

function whoRows(t: TriggerFacts): SwitchLedger["rows"] {
  if (t.hosted) return [{ k: "Agent", v: "Assistant" }];
  return [
    { k: "Agent", v: t.agent || "claude" },
    { k: "Project", v: t.project || "None set" },
  ];
}

/** How often an armed trigger spends a run, as the review's lead figure. */
function cadenceFigure(t: TriggerFacts): SwitchLedger["figures"][number] {
  if (t.schedule === "recurring" && t.intervalMs) return { value: "1", label: `paid run every ${fmtDuration(t.intervalMs)}`, tone: "warn" };
  if (t.schedule === "event") return { value: "1", label: "paid run per event", tone: "warn" };
  return { value: "1", label: "paid run", tone: "warn" };
}

/** Run a trigger once, now, outside its cadence. */
export function triggerRunNowLedger(t: TriggerFacts, cost: RunCost | null): SwitchLedger {
  return {
    name: "Run now",
    subject: t.title,
    shift: null,
    figures: [{ value: "1", label: "agent run starts", tone: "warn" }, costFigure(cost, 1, "a run")],
    rows: [...whoRows(t), actsRow(t.applies), { k: "Cadence", v: "Unchanged" }, listRow(cost)],
    stop: "Stop its session",
    confirm: "Run now",
    keep: "Not now",
  };
}

/** Arm a paused or finished trigger again: it fires on its cadence from now on. */
export function triggerArmLedger(t: TriggerFacts, from: "Paused" | "Finished", nextAt: number | null, cost: RunCost | null): SwitchLedger {
  const verb = from === "Paused" ? "Resume" : "Reactivate";
  return {
    name: verb,
    subject: t.title,
    shift: [from, "Armed"],
    figures: [cadenceFigure(t), costFigure(cost, 1, "a run")],
    rows: [
      { k: "Fires", v: t.cadence },
      ...(nextAt ? [{ k: "Next run", v: fmtClock(nextAt) }] : []),
      ...whoRows(t),
      actsRow(t.applies),
      listRow(cost),
    ],
    stop: "Pause",
    confirm: verb,
    keep: from === "Paused" ? "Keep paused" : "Not now",
  };
}

/** A new trigger set from the form: when it first runs and how often after. */
export function newTriggerLedger(t: TriggerFacts & { firstAt: number | null; now: boolean }, cost: RunCost | null): SwitchLedger {
  return {
    name: "Set trigger",
    subject: t.title,
    shift: null,
    figures: [t.now ? { value: "1", label: "agent run starts", tone: "warn" } : cadenceFigure(t), costFigure(cost, 1, "a run")],
    rows: [
      { k: "Fires", v: t.now ? "Within a minute" : t.cadence },
      ...(t.firstAt && !t.now ? [{ k: "First run", v: fmtClock(t.firstAt) }] : []),
      ...whoRows(t),
      actsRow(t.applies),
      listRow(cost),
    ],
    stop: "Pause or cancel it",
    confirm: "Set trigger",
    keep: "Not now",
  };
}

/** The agent steps of a workflow (agent and prompt nodes): each starts an agent session when it runs. */
export function workflowAgentSteps(nodes: ReadonlyArray<{ type: string }> | null | undefined): number | null {
  return nodes ? nodes.filter((n) => n.type === "agent" || n.type === "prompt").length : null;
}

/** The steps a run walks, the start and exit markers left out. */
export function workflowSteps(nodes: ReadonlyArray<{ type: string }> | null | undefined): number | null {
  return nodes ? nodes.filter((n) => n.type !== "start" && n.type !== "exit").length : null;
}

/** Start one run of a workflow: each agent step starts a session of its own. */
export function workflowRunLedger(w: { name: string; subject?: string | null; agentSteps: number | null; steps: number | null; project?: string | null }, cost: RunCost | null): SwitchLedger {
  const agents = w.agentSteps;
  return {
    name: `Run ${w.name}`,
    subject: w.subject || w.name,
    shift: null,
    figures: [
      ...(w.steps != null ? [{ value: String(w.steps), label: w.steps === 1 ? "step" : "steps" }] : []),
      agents != null
        ? { value: String(agents), label: agents === 1 ? "agent session starts" : "agent sessions start", ...(agents ? { tone: "warn" as const } : {}) }
        : { value: "?", label: "agent sessions", tone: "warn" as const },
      costFigure(cost, agents ?? 1, agents === 1 || agents == null ? "a session" : `${agents} sessions`),
    ],
    rows: [
      ...(w.project !== undefined ? [{ k: "Project", v: w.project || "None set" }] : []),
      listRow(cost, agents ?? 1),
    ],
    stop: "Cancel the run",
    confirm: "Run",
    keep: "Not now",
  };
}
