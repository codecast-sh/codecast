import { describe, expect, test } from "bun:test";
import { closeFactsFrom, closeTooltip, type GatheredCloseFacts } from "./closeKind";

const NOW = 1_800_000_000_000;
const quiet: GatheredCloseFacts = { inFlight: null, armedTriggers: 0, lastHeartbeat: NOW - 1000, runLive: false, inProcessRun: false, takesDown: 0 };

// The rules both sides share: the web over the rows it holds (lib/sessionClose),
// the server over its database (convex closeAdvice closeFactsOnServer).
describe("closeFactsFrom", () => {
  test("a role's own session or a standing anchor is a role", () => {
    expect(closeFactsFrom({ persistent: true }, quiet, NOW).role).toBe(true);
    expect(closeFactsFrom({ standing_role_id: "or-1" }, quiet, NOW).role).toBe(true);
    expect(closeFactsFrom({}, quiet, NOW).role).toBe(false);
  });

  test("the row's armed kind counts a trigger the gathered count has not seen yet", () => {
    expect(closeFactsFrom({ armed_trigger_kind: "once" }, quiet, NOW).triggers).toBe(1);
    expect(closeFactsFrom({ armed_trigger_kind: "none" }, { ...quiet, armedTriggers: 2 }, NOW).triggers).toBe(2);
  });

  test("a park counts only while the server still stands behind it", () => {
    expect(closeFactsFrom({ parked_wake_kind: "blocker", updated_at: NOW - 1000 }, quiet, NOW).parkedWake).toBe("blocker");
    expect(closeFactsFrom({ parked_wake_kind: "wait", updated_at: NOW - 30 * 24 * 3_600_000 }, quiet, NOW).parkedWake).toBeNull();
    expect(closeFactsFrom({ parked_wake_kind: "run", updated_at: NOW - 1000 }, { ...quiet, lastHeartbeat: null }, NOW).parkedWake).toBeNull();
  });

  test("a live flow run it started waits it, unless the run runs inside its own process", () => {
    const f = closeFactsFrom({}, { ...quiet, runLive: true }, NOW);
    expect(f.waitingOnRun).toBe(true);
    expect(closeTooltip(f)).toBe("Close: stops it, its run goes on, back when it's done or needs you");
    expect(closeFactsFrom({}, { ...quiet, runLive: true, inProcessRun: true }, NOW).waitingOnRun).toBe(false);
  });

  test("in flight is passed through as gathered", () => {
    expect(closeFactsFrom({}, { ...quiet, inFlight: "nested_awaiting" }, NOW).inFlight).toBe("nested_awaiting");
  });
});
