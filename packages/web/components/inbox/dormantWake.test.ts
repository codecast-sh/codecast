import { describe, expect, test } from "bun:test";
import { DORMANT_CLAIM_TTL_MS } from "@codecast/shared/contracts";
import { dormantWakeOf } from "./dormantWake";
import type { TriggerRow } from "../triggerTasks";

const NOW = 1_800_000_000_000;
const row = (id: string, status: string, run_at?: number): TriggerRow =>
  ({ task: { _id: id, title: id, prompt: "", status, schedule_type: "recurring", run_at, run_count: 0, created_at: 0 }, unread: false }) as TriggerRow;

describe("dormantWakeOf", () => {
  test("names the soonest armed trigger and ignores paused ones", () => {
    const w = dormantWakeOf({}, [row("late", "scheduled", NOW + 9e6), row("paused", "paused", NOW + 1), row("soon", "scheduled", NOW + 6e4)], [], NOW);
    expect(w.kind).toBe("trigger");
    if (w.kind === "trigger") {
      expect(w.row.task._id).toBe("soon");
      expect(w.others).toBe(1);
    }
  });

  test("a running trigger beats any countdown", () => {
    const w = dormantWakeOf({}, [row("soon", "scheduled", NOW + 1), row("now", "running", NOW + 9e9)], [], NOW);
    expect(w.kind === "trigger" && w.row.task._id).toBe("now");
  });

  test("live work outranks a timed wake", () => {
    expect(dormantWakeOf({ workflow_run_id: "r", workflow_run_status: "running", workflow_run_name: "audit" }, [row("t", "scheduled", NOW + 1)], [], NOW)).toEqual({ kind: "workflow", name: "audit" });
    expect(dormantWakeOf({}, [], [{ description: "tests" }, { command: "x" }], NOW)).toEqual({ kind: "background", count: 2, what: "tests" });
    expect(dormantWakeOf({ producing_until: NOW + 1 }, [], [], NOW).kind).toBe("workers");
    // A workflow or background Agent reaches the row only through the daemon's report.
    expect(dormantWakeOf({ open_tasks: [{ kind: "workflow" }] }, [], [], NOW)).toEqual({ kind: "workflow", name: "workflow run" });
    expect(dormantWakeOf({ open_tasks: [{ kind: "agent" }] }, [], [], NOW).kind).toBe("workers");
    expect(dormantWakeOf({ open_tasks: [{ kind: "background", command: "bun test" }] }, [], [], NOW)).toEqual({ kind: "background", count: 1, what: "bun test" });
  });

  test("a stamped trigger the roster has not loaded still counts as a wake", () => {
    expect(dormantWakeOf({ armed_trigger_kind: "standing" }, [], [], NOW).kind).toBe("trigger_unloaded");
  });

  test("the person's own park and snooze speak first", () => {
    expect(dormantWakeOf({ user_rest: "dormant" }, [row("t", "scheduled", NOW + 1)], [], NOW).kind).toBe("parked");
    expect(dormantWakeOf({ inbox_snoozed_until: NOW + 5 }, [], [], NOW)).toEqual({ kind: "snoozed", at: NOW + 5 });
  });

  test("nothing verifiable: a claim, with the Next line and when it returns", () => {
    const w = dormantWakeOf({ updated_at: NOW - 1000, thread_state: "Waiting on review\nStatus: half done\nNext: jx7abc reports back" }, [], [], NOW);
    expect(w).toEqual({ kind: "claim", what: "jx7abc reports back", back: NOW - 1000 + DORMANT_CLAIM_TTL_MS });
    const bare = dormantWakeOf({ updated_at: NOW, thread_state: "Waiting on `deploy`" }, [], [], NOW);
    expect(bare.kind === "claim" && bare.what).toBe("Waiting on deploy");
  });
});
