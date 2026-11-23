import { describe, expect, test } from "bun:test";
import { DORMANT_CLAIM_TTL_MS } from "@codecast/shared/contracts";
import { PARKED_WAKE_TTL_MS } from "@codecast/shared/contracts/inboxPlacement";
import { DORMANT_RUN_UNREPORTED_TITLE, DORMANT_UNCONFIRMED_TITLE, dormantWakeLabel, dormantWakeOf } from "./dormantWake";
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

  // jx7cn1s: parked on a blocker, which the classifier counts as a wake. The
  // card says so instead of warning the row is the person's.
  test("a server-seen park names the wake by the classifier's rule, and why when it drops it", () => {
    const quiet = (quietFor: number, extra: Record<string, any>) => ({ updated_at: NOW - quietFor, thread_state: "Waiting on the PR", ...extra });
    // jx7cn1s: a task on its blocked_by. Exact, so no lifetime: still named after 4 days.
    const blocker = dormantWakeOf(quiet(96 * 3_600_000, { parked_wake_kind: "blocker" }), [], [], NOW);
    expect(blocker).toEqual({ kind: "blocker" });
    expect(dormantWakeLabel(blocker, NOW)).toEqual({ what: "a task it waits on", when: "when it closes", warn: null });
    const wait = dormantWakeOf(quiet(3 * 3_600_000, { parked_wake_kind: "wait" }), [], [], NOW);
    expect(dormantWakeLabel(wait, NOW)).toEqual({ what: "a pending wait", when: "when it clears", warn: null });
    // A run counts while its machine's daemon reports.
    const run = dormantWakeOf(quiet(3 * 3_600_000, { parked_wake_kind: "run", last_heartbeat: NOW - 5_000 }), [], [], NOW);
    expect(dormantWakeLabel(run, NOW)).toEqual({ what: "a run it started", when: "when it ends or asks you", warn: null });
    // The row's own running workflow already says what it waits on.
    expect(dormantWakeOf(quiet(0, { parked_wake_kind: "run", workflow_run_id: "r", workflow_run_status: "running", workflow_run_name: "audit" }), [], [], NOW)).toEqual({ kind: "workflow", name: "audit" });
    // A run whose machine stopped reporting: named, with why, never hidden.
    const unreported = dormantWakeOf(quiet(3 * 3_600_000, { parked_wake_kind: "run", last_heartbeat: NOW - 3 * 3_600_000 }), [], [], NOW);
    expect(unreported).toEqual({ kind: "run_unreported" });
    expect(dormantWakeLabel(unreported, NOW)).toEqual({ what: "a run it started · its session's daemon is not reporting", when: "yours now", warn: DORMANT_RUN_UNREPORTED_TITLE });
    // A wait past its lifetime is unconfirmed for its age, never "nothing scheduled".
    const stale = dormantWakeOf(quiet(PARKED_WAKE_TTL_MS + 3_600_000, { parked_wake_kind: "wait" }), [], [], NOW);
    expect(stale).toEqual({ kind: "unconfirmed", wake: "wait", since: NOW - PARKED_WAKE_TTL_MS - 3_600_000 });
    expect(dormantWakeLabel(stale, NOW)).toEqual({ what: "a pending wait · unconfirmed 3d 1h", when: "yours now", warn: DORMANT_UNCONFIRMED_TITLE });
    // A run stuck past the same lifetime, its daemon still beating, is unconfirmed too.
    const stuck = dormantWakeOf(quiet(PARKED_WAKE_TTL_MS, { parked_wake_kind: "run", last_heartbeat: NOW - 5_000 }), [], [], NOW);
    expect(dormantWakeLabel(stuck, NOW)).toEqual({ what: "a run it started · unconfirmed 3d", when: "yours now", warn: DORMANT_UNCONFIRMED_TITLE });
    // Its tooltip is its own: the claim's two sentences are false for a wake the server saw.
    expect(DORMANT_UNCONFIRMED_TITLE).toBe("The server saw this wake, but nothing has happened for 3 days; it is yours to check.");
    expect(dormantWakeOf(quiet(0, { parked_wake_kind: "none" }), [], [], NOW).kind).toBe("claim");
  });
});
