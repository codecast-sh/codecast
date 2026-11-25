import { describe, expect, test } from "bun:test";
import { DORMANT_CLAIM_TITLE, dormantWakeLabel, sessionTriggerRows } from "./dormantWake";
import type { TriggerRow } from "../triggerTasks";

const NOW = 1_800_000_000_000;
const task = (over: Record<string, unknown>) =>
  ({ _id: "t", title: "Nightly sweep", prompt: "", status: "scheduled", schedule_type: "recurring", run_count: 0, created_at: 0, ...over }) as TriggerRow["task"];

describe("dormantWakeLabel", () => {
  test("each wake kind reads as what it waits on and when", () => {
    expect(dormantWakeLabel({ kind: "background", count: 1, what: "Poll for native step-path docs" }, NOW))
      .toEqual({ what: "background task: Poll for native step-path docs", when: "when it finishes", warn: null });
    expect(dormantWakeLabel({ kind: "background", count: 3, what: "" }, NOW).what).toBe("3 background tasks");
    expect(dormantWakeLabel({ kind: "workflow", name: "audit" }, NOW)).toEqual({ what: "workflow: audit", when: "when it finishes", warn: null });
    expect(dormantWakeLabel({ kind: "workers" }, NOW)).toEqual({ what: "its subagents are still working", when: "when they finish", warn: null });
    expect(dormantWakeLabel({ kind: "trigger_unloaded" }, NOW)).toEqual({ what: "a trigger fires into it", when: "armed", warn: null });
    expect(dormantWakeLabel({ kind: "parked" }, NOW)).toEqual({ what: "parked by you", when: "on next activity", warn: null });
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
      .toEqual({ what: "nothing scheduled · reply from jx7", when: "yours in 30m", warn: DORMANT_CLAIM_TITLE });
    expect(dormantWakeLabel({ kind: "claim", what: null, back: NOW - 1 }, NOW))
      .toEqual({ what: "nothing scheduled", when: "yours now", warn: DORMANT_CLAIM_TITLE });
  });

  test("on a teammate's session the words name its owner, never the viewer", () => {
    expect(dormantWakeLabel({ kind: "claim", what: null, back: NOW + 30 * 60_000 }, NOW, "Ann"))
      .toEqual({ what: "nothing scheduled", when: "back to Ann in 30m", warn: "The agent named a wake nothing here can see. It returns to Ann if nothing happens." });
    expect(dormantWakeLabel({ kind: "claim", what: null, back: NOW - 1 }, NOW, "Ann").when).toBe("with Ann now");
    expect(dormantWakeLabel({ kind: "parked" }, NOW, "Ann").what).toBe("parked by Ann");
    expect(dormantWakeLabel({ kind: "run" }, NOW, "Ann").when).toBe("when it ends or asks Ann");
    const stale = dormantWakeLabel({ kind: "unconfirmed", wake: "wait", since: NOW - 3 * 86_400_000 }, NOW, "Ann");
    expect(stale.when).toBe("with Ann now");
    expect(stale.warn).toContain("it is Ann's to check");
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
