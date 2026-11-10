import { expect, test } from "bun:test";
import { assertGlance } from "../../consequential/__tests__/glance";
import { newTriggerLedger, triggerArmLedger, triggerRunNowLedger, workflowAgentSteps, workflowRunLedger, workflowSteps } from "../startLedgers";

const cost = { billedUsd: 0.4, listUsd: 1.2, runs: 6, scope: "workspace" as const };
const trigger = { title: "Check CI on main", cadence: "every 2h", schedule: "recurring", intervalMs: 2 * 3600_000, agent: "claude", project: "codecast", applies: false };

test("every start review fits a glance", () => {
  for (const l of [
    triggerRunNowLedger(trigger, cost),
    triggerRunNowLedger({ ...trigger, hosted: true }, null),
    triggerArmLedger(trigger, "Paused", null, cost),
    triggerArmLedger({ ...trigger, schedule: "event", intervalMs: null }, "Finished", Date.now() + 60_000, null),
    newTriggerLedger({ ...trigger, firstAt: Date.now() + 1800_000, now: false }, cost),
    newTriggerLedger({ ...trigger, schedule: "once", intervalMs: null, firstAt: null, now: true }, null),
    workflowRunLedger({ name: "Fix", subject: "pl-12", agentSteps: 3, steps: 5, project: "codecast" }, cost),
    workflowRunLedger({ name: "Fix", agentSteps: null, steps: null }, null),
  ]) assertGlance(l);
});

test("a start names what it spends and how to stop it", () => {
  const run = triggerRunNowLedger({ ...trigger, applies: true }, cost);
  expect(run.confirm).toBe("Run now");
  expect(run.stop).toBeTruthy();
  expect(run.rows.find((r) => r.k === "Acts")?.tone).toBe("warn");
  const arm = triggerArmLedger(trigger, "Paused", null, cost);
  expect(arm.shift).toEqual(["Paused", "Armed"]);
  expect(arm.figures[0].label).toBe("paid run every 2h");
});

test("workflow steps count agent and prompt nodes as sessions", () => {
  const nodes = [{ type: "start" }, { type: "agent" }, { type: "prompt" }, { type: "command" }, { type: "human" }, { type: "exit" }];
  expect(workflowAgentSteps(nodes)).toBe(2);
  expect(workflowSteps(nodes)).toBe(4);
  expect(workflowAgentSteps(undefined)).toBeNull();
  expect(workflowRunLedger({ name: "Fix", agentSteps: 2, steps: 4 }, cost).figures[1]).toEqual({ value: "2", label: "agent sessions start", tone: "warn" });
});
