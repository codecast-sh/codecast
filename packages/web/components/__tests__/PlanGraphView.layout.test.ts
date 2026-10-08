import { expect, test } from "bun:test";
import type { TaskWait } from "@codecast/shared/tasks";
import { EDGE_IN_Y, planGraphLayout, WAIT_IN_Y } from "../PlanGraphView";

const task = (n: number, extra: Record<string, unknown> = {}) => ({ _id: `id${n}`, short_id: `ct-${n}`, title: `Task ${n}`, status: "open", ...extra });
const wait = (id: string, state: TaskWait["state"]): TaskWait =>
  ({ id, kind: "decision", decision: "sd-4", state, created_at: 0 }) as TaskWait;

test("columns follow the dependency order, older _id refs included", () => {
  const { positions, edges } = planGraphLayout([
    task(3, { blocked_by: ["ct-2"] }),
    task(2, { blocked_by: ["id1"] }),
    task(1),
  ]);
  const x = (s: string) => positions.get(s)!.x;
  expect(x("ct-1")).toBeLessThan(x("ct-2"));
  expect(x("ct-2")).toBeLessThan(x("ct-3"));
  expect(edges).toEqual([{ from: "ct-2", to: "ct-3" }, { from: "ct-1", to: "ct-2" }]);
});

test("a task's waits stack in a lane to its left, from its mid-line down, below where task edges enter", () => {
  const { positions, waitNodes } = planGraphLayout([task(1, { waits: [wait("w1", "waiting"), wait("w2", "met")] })]);
  const p = positions.get("ct-1")!;
  expect(waitNodes.map((n) => [n.key, n.task, n.wait.state])).toEqual([["ct-1:w1", "ct-1", "waiting"], ["ct-1:w2", "ct-1", "met"]]);
  for (const n of waitNodes) {
    expect(n.x).toBeLessThan(p.x);
    expect(n.y).toBeGreaterThan(p.y + EDGE_IN_Y);
  }
  expect(waitNodes[0].y).toBe(p.y + 22);
  expect(WAIT_IN_Y).toBeGreaterThan(EDGE_IN_Y);
});

test("a column without waits gains no lane", () => {
  const plain = planGraphLayout([task(1)]);
  const waited = planGraphLayout([task(1, { waits: [wait("w1", "failed")] })]);
  expect(waited.positions.get("ct-1")!.x).toBeGreaterThan(plain.positions.get("ct-1")!.x);
  expect(waited.width).toBeGreaterThan(plain.width);
});

test("tasks on a cycle still get a place", () => {
  const { positions } = planGraphLayout([task(1, { blocked_by: ["ct-2"] }), task(2, { blocked_by: ["ct-1"] }), task(3)]);
  expect([...positions.keys()].sort()).toEqual(["ct-1", "ct-2", "ct-3"]);
  expect(positions.get("ct-1")!.x).toBeGreaterThan(positions.get("ct-3")!.x);
});
