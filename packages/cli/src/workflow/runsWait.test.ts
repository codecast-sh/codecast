import { describe, expect, test } from "bun:test";
import { runWaitVerdict } from "./runsWait";

// Agents looped `cast workflow runs --task ct-N` with sleeps (85 iterations in
// one session) to see a run move.
describe("runWaitVerdict", () => {
  const at = (status: string, node?: string) => ({ status, current_node_id: node });
  test("with no target, any move ends the wait", () => {
    expect(runWaitVerdict(at("running", "plan"), at("running", "plan"), true)).toEqual({ done: false, met: false });
    expect(runWaitVerdict(at("running", "plan"), at("running", "verify"), true)).toEqual({ done: true, met: true });
    expect(runWaitVerdict(at("running", "plan"), at("paused", "plan"), true)).toEqual({ done: true, met: true });
    expect(runWaitVerdict(at("failed", "plan"), at("failed", "plan"), true)).toEqual({ done: true, met: true });
  });
  test("a status target waits for it, and a run finishing otherwise ends unmet", () => {
    expect(runWaitVerdict(at("running"), at("running"), "completed")).toEqual({ done: false, met: false });
    expect(runWaitVerdict(at("running"), at("completed"), "completed")).toEqual({ done: true, met: true });
    expect(runWaitVerdict(at("running"), at("failed"), "completed")).toEqual({ done: true, met: false });
    expect(runWaitVerdict(at("running"), at("pending"), "pending")).toEqual({ done: true, met: true });
  });
  test("a station target waits for the run to stand there", () => {
    expect(runWaitVerdict(at("running", "plan"), at("running", "verify"), "verify")).toEqual({ done: true, met: true });
    expect(runWaitVerdict(at("running", "plan"), { status: "running", current_node_id: "n3", current_node_label: "review" }, "review")).toEqual({ done: true, met: true });
    expect(runWaitVerdict(at("running", "plan"), at("failed", "plan"), "verify")).toEqual({ done: true, met: false });
  });
});
