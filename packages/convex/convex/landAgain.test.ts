import { expect, test } from "bun:test";
import { landAgainRefusal } from "./workflow_runs";

const behind = { node_id: "ship", status: "failed", result_preview: "line: codecast/line-ct-58259 is behind origin/main; rebase it first, so the squash carries only this change\nthe ship command exited 1" };

test("Rebase and land starts only on an ended run answered Ship whose landing step refused it for being behind (ct-58259)", () => {
  expect(landAgainRefusal({ status: "completed", gate_response: "S", node_statuses: [{ node_id: "decide", status: "completed" }, behind] })).toBeNull();
  expect(landAgainRefusal({ status: "running", gate_response: "S", node_statuses: [behind] })).toMatch(/has not ended/);
  expect(landAgainRefusal({ status: "completed", gate_response: null, node_statuses: [behind] })).toMatch(/Nobody answered Ship/);
  expect(landAgainRefusal({ status: "completed", gate_response: "D", node_statuses: [behind] })).toMatch(/Nobody answered Ship/);
  expect(landAgainRefusal({ status: "failed", gate_response: "Ship", node_statuses: [{ ...behind, result_preview: "merge conflict in a.ts" }] })).toMatch(/did not refuse/);
});
