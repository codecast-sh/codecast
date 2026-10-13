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
      { device: "76e7d3", name: "MacBook-Pro-182", online: true, owner: null, runs: 2, workedAt: T + H },
      { device: "28d80e", name: "mini", online: false, owner: null, runs: 1, workedAt: null },
    ]);
    expect(runnerHold("nosession:prove", m)).toBeNull();
  });
  test("held while none of them works again; never for a cause that is the problem's own", () => {
    const m = runnerMachines(failed, failed, devices);
    expect(runnerHold("nosession:prove", m)).toBe("No session has finished a step on MacBook-Pro-182 since these stalled");
    expect(runnerHold("check:typecheck", m)).toBeNull();
    const ledger = withRunners({ rows: [{ k: "Where", v: "Union" }, { k: "Ends", v: "Your decision" }] }, "nosession:prove", m);
    expect(ledger.rows.map((r) => r.k)).toEqual(["Where", "MacBook-Pro-182", "mini", "Ends"]);
    expect(ledger.blocked).toBe(ledger.alert);
    expect(ledger.rows[2]).toMatchObject({ v: "Offline · no step finished since these stalled", tone: "warn" });
    // A working machine of the viewer's own offers nothing to do; one that is not working offers Machines.
    const acts = withRunners({ rows: [] as Array<{ k: string; v: string; act?: { label: string; press: () => void } }> }, "nosession:prove", runnerMachines(failed, [...failed, run("d", "76e7d3", T + H, T + H)], devices), () => {});
    expect(acts.rows.map((r) => `${r.k}:${r.act?.label ?? "-"}`)).toEqual(["MacBook-Pro-182:-", "mini:Machines…"]);
    expect(runnerHold("nosession:prove", runnerMachines(failed.slice(2), failed, devices))).toBe("mini is offline");
  });
  test("one machine still up and stalled holds the start, however well another works: the runner's queue may hand it the new runs", () => {
    // The live case: the review said "MacBook-Pro… Online · no step finished since these stalled" and still offered "Start 5 runs".
    const both = new Map([["76e7d3", { name: "MacBook-Pro-182", online: true }], ["28d80e", { name: "mini", online: true }]]);
    const m = runnerMachines(failed, [...failed, run("e", "28d80e", T + H, T + H)], both);
    expect(runnerHold("nosession:prove", m)).toBe("No session has finished a step on MacBook-Pro-182 since these stalled");
  });
  test("a machine not the viewer's says whose it is, and every machine row opens Machines (6ebf36, the team's agent box)", () => {
    const box = { ...run("f", "6ebf36", T - H, undefined), user_id: "kd7e0g" };
    const later = { ...run("g", "6ebf36", T, T + H), user_id: "kd7e0g" };
    const teamBox = new Map([["6ebf36", { name: "cloud-linux", online: true, owner: "Aivery's agent box" }]]);
    expect(runnerMachines([box], [box, later], teamBox)[0]).toMatchObject({ name: "cloud-linux", owner: "Aivery's agent box", online: true });
    // Opened to nobody here: still named by the account its runner signed in as.
    const unknown = runnerMachines([box], [box, later], new Map(), (u) => (u === "kd7e0g" ? "Aivery's agent box" : null));
    expect(unknown[0]).toMatchObject({ name: null, owner: "Aivery's agent box", online: null });
    let opened = 0;
    const ledger = withRunners({ rows: [] as Array<{ k: string; v: string; act?: { label: string; press: () => void } }> }, "nosession:prove", unknown, () => opened++);
    expect(ledger.rows[0]).toMatchObject({ k: "Machine 6ebf36", v: expect.stringMatching(/^Aivery's agent box · not shared with you · finished a step /) });
    expect(ledger.rows[0].act?.label).toBe("Machines…");
    ledger.rows[0].act!.press();
    expect(opened).toBe(1);
  });
});
