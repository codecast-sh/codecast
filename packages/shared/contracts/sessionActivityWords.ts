// A session's under-line as plain words, for a surface that draws text only
// (`cast sessions`): what sessionActivity says the row is doing. Working and
// Shipping carry their own words; a Sleeping row's are said here from what
// wakes it. The web and the phone draw the same facts as pills and bars.
//
// Imported by path (@codecast/shared/contracts/sessionActivityWords), never
// through the contracts barrel.
import type { DormantTriggerRow } from "./dormantWake";
import type { SessionActivity } from "./sessionActivity";

/** A span in the fewest characters, never rounded up past a unit: "45s", "90m", "3h", "2d". */
export function shortSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The wait's target as a person reads it: "@ashot", "jx7c6zk", "ct-12 landing", "#42". */
function waitTarget(on: { kind: string; ref: string; label?: string }): string {
  if (on.kind === "session") return on.label ?? on.ref.slice(0, 7);
  if (on.kind === "task") return `${on.ref} landing`;
  if (on.kind === "pr") return on.ref.replace(/^[^#]*(?=#)/, "");
  return on.ref;
}

export function sessionActivityWords<T extends DormantTriggerRow>(a: SessionActivity<T>, now: number): string {
  if (a.state !== "sleeping") return a.words;
  switch (a.flavor) {
    case "waiting":
      return a.on ? `waiting on ${waitTarget(a.on)}` : a.wake?.kind === "blocker" ? "waiting on a blocker landing" : "waiting on a task";
    case "scheduled": {
      const w = a.wake;
      if (w.kind === "background") return `timed wait · ${w.what}`;
      if (w.kind === "trigger_unloaded") return "a trigger is armed";
      const task = w.row.task;
      const more = w.others > 0 ? ` · +${w.others} more` : "";
      if (task.status === "running") return `trigger running${more}`;
      if (task.run_at != null) return `wakes in ${shortSpan(task.run_at - now)}${more}`;
      return `wakes on ${task.event_filter?.event_type ?? "an event"}${more}`;
    }
    case "stalled": {
      const left = a.wake.back - now;
      return left > 0 ? `nothing scheduled · back to you in ${shortSpan(left)}` : "nothing scheduled · back to you now";
    }
    case "snoozed":
      return `snoozed · back in ${shortSpan(a.wake.at - now)}`;
    case "parked":
      return "parked by you";
    case "unconfirmed":
      return a.wake.kind === "run_unreported"
        ? "its run's machine is not reporting"
        : `no word on its ${a.wake.wake} for ${shortSpan(now - a.wake.since)}`;
  }
}
