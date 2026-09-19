import { describe, expect, test } from "bun:test";
import { DORMANT_CLAIM_TTL_MS, OPEN_TASKS_FRESH_MS, placeProjectableRow, type ProjectableInboxRow } from "@codecast/shared/contracts";
import { openTasksRefreshDue, paneReconcileTarget, reconciledStatusWithTasks } from "./daemon.js";

const START = 1_800_000_000_000;
const task = { id: "bjmsej5ia", kind: "background" as const };
const dormant = (openTasksAt: number): ProjectableInboxRow => ({
  _id: "dormant-background-wait",
  updated_at: START,
  message_count: 275,
  agent_status: "dormant",
  thread_state_status: "dormant",
  is_idle: true,
  open_tasks: [task],
  open_tasks_at: openTasksAt,
});

describe("dormant background task refresh", () => {
  test("a verified background wait stays dormant beyond the two-hour claim expiry", () => {
    const row = dormant(START);
    const end = START + DORMANT_CLAIM_TTL_MS + OPEN_TASKS_FRESH_MS;
    let refreshes = 0;
    for (let now = START; now <= end; now += 90_000) {
      expect(paneReconcileTarget("idle", "dormant")).toBe("idle");
      expect(reconciledStatusWithTasks("dormant", "idle", true, "dormant")).toBeNull();
      if (openTasksRefreshDue("dormant", 1, row.open_tasks_at!, now)) {
        row.open_tasks_at = now;
        refreshes++;
      }
      expect(placeProjectableRow(row, false, now)).toEqual({ bucket: "dormant", work_state: "dormant" });
    }
    expect(refreshes).toBeGreaterThan(1);
    expect(placeProjectableRow(dormant(START), false, end).work_state).toBe("needs_input");
  });

  test("completed work and lost daemon reports still expire", () => {
    const now = START + DORMANT_CLAIM_TTL_MS;
    expect(openTasksRefreshDue("dormant", 0, START, now)).toBe(false);
    expect(placeProjectableRow({ ...dormant(now), open_tasks: [] }, false, now).work_state).toBe("needs_input");
    expect(placeProjectableRow(dormant(now - OPEN_TASKS_FRESH_MS), false, now).work_state).toBe("needs_input");
  });

  test("refreshes are throttled and do not publish active or completed verdicts", () => {
    for (const status of ["dormant", "waiting"] as const) {
      expect(openTasksRefreshDue(status, 1, START, START + 90_000)).toBe(false);
      expect(openTasksRefreshDue(status, 1, START, START + 4 * 60_000)).toBe(true);
      expect(openTasksRefreshDue(status, 1, undefined, START)).toBe(true);
    }
    for (const status of ["working", "thinking", "done", "idle", "permission_blocked"] as const) {
      expect(openTasksRefreshDue(status, 1, START, START + OPEN_TASKS_FRESH_MS)).toBe(false);
    }
  });

  test("fresh wait evidence cannot conceal a question, error, or wake", () => {
    const now = START + DORMANT_CLAIM_TTL_MS;
    for (const block of [{ awaiting_input: true }, { pending_api_error: true }, { agent_status: "permission_blocked" }, { thread_state_status: "blocked", agent_status: "idle" }]) {
      expect(placeProjectableRow({ ...dormant(now), ...block }, true, now).work_state).toBe("needs_input");
    }
    expect(paneReconcileTarget("busy", "dormant")).toBe("working");
    expect(reconciledStatusWithTasks("dormant", "active", true)).toBe("working");
  });
});
