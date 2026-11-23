import { describe, expect, test } from "bun:test";
import { dormantWakeLabel, sessionTriggerRows } from "./dormantWake";
import type { TriggerRow } from "../triggerTasks";

const NOW = 1_800_000_000_000;
const task = (over: Record<string, unknown>) =>
  ({ _id: "t", title: "Nightly sweep", prompt: "", status: "scheduled", schedule_type: "recurring", run_count: 0, created_at: 0, ...over }) as TriggerRow["task"];

describe("dormantWakeLabel", () => {
  test("each wake kind reads as what it waits on and when", () => {
    expect(dormantWakeLabel({ kind: "background", count: 1, what: "Poll for native step-path docs" }, NOW))
      .toEqual({ what: "background task: Poll for native step-path docs", when: "when it finishes", warn: false });
    expect(dormantWakeLabel({ kind: "background", count: 3, what: "" }, NOW).what).toBe("3 background tasks");
    expect(dormantWakeLabel({ kind: "workflow", name: "audit" }, NOW)).toEqual({ what: "workflow: audit", when: "when it finishes", warn: false });
    expect(dormantWakeLabel({ kind: "workers" }, NOW)).toEqual({ what: "its subagents are still working", when: "when they finish", warn: false });
    expect(dormantWakeLabel({ kind: "trigger_unloaded" }, NOW)).toEqual({ what: "a trigger fires into it", when: "armed", warn: false });
    expect(dormantWakeLabel({ kind: "parked" }, NOW)).toEqual({ what: "parked by you", when: "on next activity", warn: false });
    expect(dormantWakeLabel({ kind: "snoozed", at: NOW + 3_600_000 }, NOW).what).toBe("snoozed");
  });

  test("a trigger carries its task for the live countdown badge", () => {
    const t = task({});
    const l = dormantWakeLabel({ kind: "trigger", row: { task: t, unread: false }, others: 2 }, NOW);
    expect(l.what).toBe("Nightly sweep +2");
    expect(l.when).toEqual({ task: t });
  });

  test("an unverified claim warns and says when it comes back", () => {
    expect(dormantWakeLabel({ kind: "claim", what: "reply from jx7", back: NOW + 30 * 60_000 }, NOW))
      .toEqual({ what: "nothing scheduled · reply from jx7", when: "yours in 30m", warn: true });
    expect(dormantWakeLabel({ kind: "claim", what: null, back: NOW - 1 }, NOW))
      .toEqual({ what: "nothing scheduled", when: "yours now", warn: true });
  });
});

describe("sessionTriggerRows", () => {
  test("keeps the rows the session originates, created, or was spawned by", () => {
    const rows = [
      { task: task({ _id: "a", originating_conversation_id: "s1" }), unread: false },
      { task: task({ _id: "b", created_by_conversation_id: "s1" }), unread: false },
      { task: task({ _id: "c" }), unread: false },
      { task: task({ _id: "d", originating_conversation_id: "s2" }), unread: false },
    ] as TriggerRow[];
    expect(sessionTriggerRows(rows, { _id: "s1", agent_task_id: "c" } as never).map((r) => r.task._id)).toEqual(["a", "b", "c"]);
    expect(sessionTriggerRows(rows, { _id: "s1" } as never).map((r) => r.task._id)).toEqual(["a", "b"]);
  });
});
