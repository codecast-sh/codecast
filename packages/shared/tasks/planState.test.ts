import { describe, expect, test } from "bun:test";
import { derivePlanState, PLAN_MOVING_MS, type PlanMember } from "./planState";

const NOW = 10 * 24 * 3600_000;
const H = 3600_000;
const m = (id: string, work_state: PlanMember["work_state"], hoursAgo: number): PlanMember => ({ id, work_state, at: NOW - hoursAgo * H });

describe("derivePlanState", () => {
  test("a waiting member puts the plan on the person, whatever its status says", () => {
    // pl-1007: marked done, two sessions waiting.
    const s = derivePlanState({ status: "done" }, [m("a", "needs_input", 1), m("b", "needs_input", 3), m("c", "working", 0)], NOW);
    expect(s.state).toBe("needs_you");
    expect(s.asks).toEqual(["b", "a"]);
    expect(s.askedAt).toBe(NOW - 3 * H);
  });

  test("a draft with a working member is moving", () => {
    expect(derivePlanState({ status: "draft" }, [m("a", "working", 0)], NOW).state).toBe("moving");
  });

  test("a recent turn counts as moving; an old one does not", () => {
    expect(derivePlanState({ status: "draft" }, [m("a", "done", 2)], NOW).state).toBe("moving");
    expect(derivePlanState({ status: "draft" }, [m("a", "done", PLAN_MOVING_MS / H + 1)], NOW).state).toBe("stalled");
  });

  test("dormant members park the plan", () => {
    expect(derivePlanState({ status: "active" }, [m("a", "dormant", 48)], NOW).state).toBe("parked");
    // A parked lead beside a worker that delivered an hour ago: the wake owns the next move.
    expect(derivePlanState({ status: "draft" }, [m("lead", "dormant", 1), m("w", "done", 1)], NOW).state).toBe("parked");
  });

  test("status closes a plan only when nothing on it is live", () => {
    expect(derivePlanState({ status: "done" }, [m("a", "done", 2)], NOW).state).toBe("closed");
    expect(derivePlanState({ status: "abandoned" }, [], NOW).state).toBe("closed");
  });

  test("every task done and nothing live is finished, not closed", () => {
    expect(derivePlanState({ status: "draft", progress: { done: 4, total: 4 } }, [], NOW).state).toBe("finished");
  });

  test("open work with nobody on it is stalled, active or not", () => {
    // pl-306: marked active, no session in 53 days.
    expect(derivePlanState({ status: "active", progress: { done: 10, total: 25 } }, [], NOW).state).toBe("stalled");
  });
});
