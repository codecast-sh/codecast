import { describe, expect, test } from "bun:test";
import { decisionWaitLabel, gateRunLabel, runHref } from "../decisionLinks";

// The run chip on a gate decision (the-line.md L4, L10).
describe("gateRunLabel", () => {
  test("no run row yet: a plain fallback that still names the gate node", () => {
    expect(gateRunLabel(undefined, "review")).toEqual({ workflow: "a workflow run", node: "review", known: false });
  });
  test("listRuns's join names the current node", () => {
    const run = { workflow_name: "line", current_node_id: "review", current_node_label: "Review" };
    expect(gateRunLabel(run, "review")).toEqual({ workflow: "line", node: "Review", known: true });
  });
  test("the get channel's row labels the node from node_statuses, else the id", () => {
    const run = { workflow_name: "feature", current_node_id: "gate1", node_statuses: [{ node_id: "gate1", label: "Ship it?" }] };
    expect(gateRunLabel(run, "gate1").node).toBe("Ship it?");
    expect(gateRunLabel({ workflow_name: "feature", current_node_id: "gate2" }, "gate2").node).toBe("gate2");
  });
  test("a gate on a node the run has moved past does not borrow the current node's label", () => {
    const run = { workflow_name: "line", current_node_id: "implement", current_node_label: "Implement", node_statuses: [{ node_id: "review", label: "Review" }] };
    expect(gateRunLabel(run, "review").node).toBe("Review");
  });
  test("runHref", () => {
    expect(runHref("r1")).toBe("/workflows/runs/r1");
  });
});

// The decision page's header: whose wait it is, read off the viewer's queue.
describe("decisionWaitLabel", () => {
  test("a blocking ask in the viewer's queue waits on them", () => {
    expect(decisionWaitLabel({ status: "pending", blocking: true, in_queue: true })).toBe("Waiting on you");
  });
  test("one passed, escalated or shared out to someone else waits on them, not the viewer", () => {
    expect(decisionWaitLabel({ status: "pending", blocking: true, in_queue: false })).toBe("Waiting on a teammate");
  });
  test("a silent card was asked by codecast, so no agent went ahead", () => {
    expect(decisionWaitLabel({ status: "pending", blocking: false, silent: true })).toBe("Asked of you");
    expect(decisionWaitLabel({ status: "pending", blocking: false })).toBe("The agent went ahead; you can change course");
  });
  test("opened straight from its document (no queue stamp), the people it asks decide whose wait it is", () => {
    expect(decisionWaitLabel({ status: "pending", blocking: true, asked_user_ids: ["tess"] }, "ashot")).toBe("Waiting on a teammate");
    expect(decisionWaitLabel({ status: "pending", blocking: true, asked_user_ids: ["ashot"] }, "ashot")).toBe("Waiting on you");
  });
  test("a settled one says its status", () => {
    expect(decisionWaitLabel({ status: "answered", blocking: true, in_queue: false })).toBe("answered");
  });
});
