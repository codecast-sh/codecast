// Undo policy for triggers. Pause and resume go back through the opposite
// verb (see triggerInverse). Run now, reactivate and cancel are not recorded.
// The verbs run without their drafts: the overlay puts the status back, and
// run_at is the server's to recompute.
import type { UndoCtx } from "@platform/engine";
import type { UndoPolicy } from "../policy";
import { quoted } from "../labels";
import { call, cellsOf, rowIds } from "./work";

type TriggerVerb = "pause" | "resume" | "runNow" | "cancel" | "reactivate";
const TRIGGER_STORES = ["agentTasks", "foreignTriggers"] as const;
const triggerRow = (state: any, id: string) => state?.agentTasks?.[id] ?? state?.foreignTriggers?.[id];
const triggerTitle = (state: any, id: string) => {
  const t = triggerRow(state, id);
  return quoted(t?.display_title || t?.title || t?.prompt, "trigger");
};

/**
 * The verbs that take a trigger verb back, given the status before it.
 * Pause works on a scheduled trigger and resume returns it to scheduled.
 * Nothing else is taken back: run now has run, reactivate has re-armed, and
 * cancel ends the trigger (reactivating re-arms a recurring one an interval
 * from now, not at its slot).
 */
function triggerInverse(verb: TriggerVerb, prior: unknown): string[] | null {
  if (verb === "pause") return prior === "scheduled" ? ["resume"] : null;
  if (verb === "resume") return prior === "paused" ? ["pause"] : null;
  return null;
}

const priorStatus = (ctx: UndoCtx, id: string) =>
  ctx.changes.find((c) => c.id === id && c.field === "status" && (TRIGGER_STORES as readonly string[]).includes(c.store))?.before;

const TRIGGER_TEXT_FIELDS = ["prompt", "title", "mode", "agent_type"] as const;

/** A trigger's prior values for the fields an edit named (TriggerEdit). */
function priorTriggerFields(prior: any, edited: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TRIGGER_TEXT_FIELDS) if (k in edited && prior[k] != null) out[k] = prior[k];
  if ("project_path" in edited) out.project_path = prior.project_path ?? "";
  if ("schedule_type" in edited || "interval_ms" in edited || "run_at" in edited) {
    out.schedule_type = prior.schedule_type;
    if (prior.schedule_type === "recurring") out.interval_ms = prior.interval_ms;
    if (prior.schedule_type === "event") out.event_filter = prior.event_filter;
    if (prior.schedule_type !== "event" && typeof prior.run_at === "number" && prior.run_at > Date.now()) out.run_at = prior.run_at;
  }
  return out;
}

function formatInterval(ms: number): string {
  const units: Array<[number, string]> = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"]];
  for (const [size, unit] of units) if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.round(ms / 60_000)}m`;
}

export const TRIGGER_UNDO_POLICY: UndoPolicy = {
  triggerAction: {
    spec: {
      label: (ctx) => {
        const [id, verb] = ctx.args as [string, TriggerVerb];
        if (!triggerInverse(verb, priorStatus(ctx, id))) return null;
        const done = { pause: "Paused", resume: "Resumed" }[verb as "pause" | "resume"];
        return `${done} ${triggerTitle(ctx.before, id)}`;
      },
      inverse: (ctx) => {
        const verb = ctx.args[1] as TriggerVerb;
        return rowIds(cellsOf(ctx, TRIGGER_STORES, "status")).flatMap((id) =>
          (triggerInverse(verb, priorStatus(ctx, id)) ?? []).map((v) => call("triggerAction", id, v)),
        );
      },
      toast: true,
    },
  },
  // The draft runs so run_at lands where the server's applyTaskUpdate puts it
  // for the prior interval; the captured run_at is left out for that reason.
  setTriggerInterval: {
    spec: {
      label: (ctx) => `Set ${triggerTitle(ctx.before, ctx.args[0] as string)} to every ${formatInterval(ctx.args[1] as number)}`,
      inverse: (ctx) =>
        cellsOf(ctx, TRIGGER_STORES, "interval_ms").map((c) => ({ action: "setTriggerInterval", args: [c.id, c.before] })),
      ignoreFields: ["run_at"],
    },
  },
  // The inverse sends the prior value of every field the edit named. A
  // schedule goes back whole: its type with the cadence or event it ran on.
  // A past run_at is left to the server (an interval from now), like the
  // interval verb above.
  editTrigger: {
    spec: {
      label: (ctx) => `Edited ${triggerTitle(ctx.before, ctx.args[0] as string)}`,
      inverse: (ctx) => {
        const [id, fields] = ctx.args as [string, Record<string, unknown>];
        if (!ctx.changes.some((c) => c.id === id && (TRIGGER_STORES as readonly string[]).includes(c.store))) return [];
        const prior = triggerRow(ctx.before, id);
        if (!prior) return [];
        return [{ action: "editTrigger", args: [id, priorTriggerFields(prior, fields)] }];
      },
      ignoreFields: ["run_at"],
    },
  },
};
