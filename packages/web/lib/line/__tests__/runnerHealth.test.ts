// Start these again on runs a machine stalled names those machines and holds the start while none of them works
// (runnerHealth; "Its session never started at Prove": 15 runs on 2 machines).
import { describe, expect, test } from "bun:test";
import { runnerHold, runnerMachines, withRunners, type RunnerRun } from "../runnerHealth";

const T = new Date(2026, 9, 13, 8).getTime();
const H = 3600_000;
const run = (id: string, device: string, at: number, done?: number): RunnerRun => ({ _id: id, runner_device: device, updated_at: at, node_statuses: done ? [{ status: "completed", session_id: "s", completed_at: done }] : [] });

describe("runnerHealth", () => {
  const failed = [run("a", "76e7d3", T - 2 * H), run("b", "76e7d3", T - H), run("c", "28d80e", T)];
  const devices = new Map([["76e7d3", { name: "MacBook-Pro-182", online: true }], ["28d80e", { name: "mini", online: false }]]);
  test("each machine the failed runs ran on, most runs first, with whether a session finished a step there since", () => {
    const m = runnerMachines(failed, [...failed, run("d", "76e7d3", T + H, T + H), run("e", "28d80e", T - 3 * H, T - 3 * H)], devices);
    expect(m).toEqual([
      { device: "76e7d3", name: "MacBook-Pro-182", online: true, runs: 2, workedAt: T + H },
      { device: "28d80e", name: "mini", online: false, runs: 1, workedAt: null },
    ]);
    expect(runnerHold("nosession:prove", m)).toBeNull();
  });
  test("held while none of them works again; never for a cause that is the problem's own", () => {
    const m = runnerMachines(failed, failed, devices);
    expect(runnerHold("nosession:prove", m)).toBe("No session has finished a step on MacBook-Pro-182 and mini since these stalled");
    expect(runnerHold("check:typecheck", m)).toBeNull();
    const ledger = withRunners({ rows: [{ k: "Where", v: "Union" }, { k: "Ends", v: "Your decision" }] }, "nosession:prove", m);
    expect(ledger.rows.map((r) => r.k)).toEqual(["Where", "MacBook-Pro-182", "mini", "Ends"]);
    expect(ledger.blocked).toBe(ledger.alert);
    expect(ledger.rows[2]).toMatchObject({ v: "Offline · no step finished since these stalled", tone: "warn" });
    expect(runnerHold("nosession:prove", runnerMachines(failed.slice(2), failed, devices))).toBe("mini is offline");
  });
});
