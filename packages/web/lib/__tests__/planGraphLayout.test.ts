import { expect, test } from "bun:test";
import type { TaskWait } from "@codecast/shared/tasks";
import { edgeDraw, NODE_W, nodeStyle, planGraphKey, planGraphLayout, waitNodeLabel, wrapTitle } from "../planGraphLayout";

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
  expect(edges.map(({ from, to }) => ({ from, to }))).toEqual([{ from: "ct-2", to: "ct-3" }, { from: "ct-1", to: "ct-2" }]);
});

test("a task's waits stack in a lane to its left, from its mid-line down, below where task edges enter", () => {
  const { positions, waitNodes, edges } = planGraphLayout([task(1, { waits: [wait("w1", "waiting"), wait("w2", "met")], blocked_by: ["ct-2"] }), task(2)]);
  const p = positions.get("ct-1")!;
  expect(waitNodes.map((n) => [n.key, n.task, n.wait.state])).toEqual([["ct-1:w1", "ct-1", "waiting"], ["ct-1:w2", "ct-1", "met"]]);
  const edgeIn = edges[0].points.at(-1)!.y - p.y;
  for (const n of waitNodes) {
    expect(n.x).toBeLessThan(p.x);
    expect(n.y).toBeGreaterThan(p.y + edgeIn);
    expect(n.inY).toBeGreaterThan(edgeIn);
  }
  expect(waitNodes[0].y).toBe(p.y + 22);
  // Each connector enters the lower half at its own point.
  const ins = waitNodes.map((n) => n.inY);
  expect(new Set(ins).size).toBe(2);
  for (const y of ins) expect(y).toBeGreaterThan(22);
});

test("a column without waits gains no lane", () => {
  const plain = planGraphLayout([task(1)]);
  const waited = planGraphLayout([task(1, { waits: [wait("w1", "failed")] })]);
  expect(waited.positions.get("ct-1")!.x).toBeGreaterThan(plain.positions.get("ct-1")!.x);
  expect(waited.width).toBeGreaterThan(plain.width);
  // A closed task's waits are history: no lane, no pills.
  const closed = planGraphLayout([task(1, { status: "done", waits: [wait("w1", "met")] })]);
  expect(closed.waitNodes).toEqual([]);
  expect(closed.width).toBe(plain.width);
});

test("tasks on a cycle still get a place", () => {
  const { positions } = planGraphLayout([task(1, { blocked_by: ["ct-2"] }), task(2, { blocked_by: ["ct-1"] }), task(3)]);
  expect([...positions.keys()].sort()).toEqual(["ct-1", "ct-2", "ct-3"]);
  expect(positions.get("ct-1")!.x).toBeGreaterThan(positions.get("ct-3")!.x);
});

test("edges into one task enter at their own ports, ordered by where they come from", () => {
  const { positions, edges } = planGraphLayout([task(4, { blocked_by: ["ct-1", "ct-2", "ct-3"] }), task(1), task(2), task(3)]);
  const into = edges.filter((e) => e.to === "ct-4");
  const fromY = into.map((e) => positions.get(e.from)!.y);
  const inY = into.map((e) => e.points.at(-1)!.y);
  expect(fromY).toEqual([...fromY].sort((a, b) => a - b));
  expect(inY).toEqual([...inY].sort((a, b) => a - b));
  expect(new Set(inY).size).toBe(3);
});

test("an edge from a closed blocker is settled; an open one is not", () => {
  const { edges } = planGraphLayout([task(3, { blocked_by: ["ct-1", "ct-2"] }), task(1, { status: "done" }), task(2)]);
  expect(Object.fromEntries(edges.map((e) => [e.from, e.settled]))).toEqual({ "ct-1": true, "ct-2": false });
});

test("an open blocker holds only while the blocked task still waits for pickup", () => {
  const holding = (status: string) =>
    planGraphLayout([task(3, { status, blocked_by: ["ct-1", "ct-2"] }), task(1, { status: "done" }), task(2)]).edges.map((e) => [e.from, e.holding]);
  expect(holding("open")).toEqual([["ct-1", false], ["ct-2", true]]);
  expect(holding("in_progress")).toEqual([["ct-1", false], ["ct-2", false]]);
});

test("an edge that skips a column crosses it between rows, never behind a box", () => {
  // ct-1 -> ct-2 -> ct-3 puts ct-2 in the middle column; ct-1 -> ct-3 skips it.
  const { positions, edges } = planGraphLayout([task(3, { blocked_by: ["ct-1", "ct-2"] }), task(2, { blocked_by: ["ct-1"] }), task(1)]);
  const skip = edges.find((e) => e.from === "ct-1" && e.to === "ct-3")!;
  const mid = positions.get("ct-2")!;
  const via = skip.points.slice(1, -1);
  expect(via.length).toBe(2);
  for (const pt of via) expect(pt.y < mid.y || pt.y > mid.y + 44).toBe(true);
  expect(via[0].x).toBeLessThanOrEqual(mid.x);
  expect(via[1].x).toBeGreaterThanOrEqual(mid.x + NODE_W);
});

/** Pairs of edges between the same two adjacent columns that cross. */
function crossings(tasks: ReturnType<typeof task>[]) {
  const { positions, edges } = planGraphLayout(tasks);
  const pos = (s: string) => positions.get(s)!;
  const adjacent = edges.filter((e) => e.points.length === 2);
  let n = 0;
  for (const [i, a] of adjacent.entries())
    for (const b of adjacent.slice(i + 1))
      if (pos(a.from).x === pos(b.from).x && pos(a.to).x === pos(b.to).x && (pos(a.from).y - pos(b.from).y) * (pos(a.to).y - pos(b.to).y) < 0) n++;
  return n;
}

test("each column is ordered by its neighbours, so edges cross only where the graph makes them", () => {
  // Listed in an order that crosses every edge: 1 feeds 6, 2 feeds 5, 3 feeds 4, and 6 -> 7, 4 -> 8.
  const tasks = [
    task(1), task(2), task(3),
    task(4, { blocked_by: ["ct-3"] }), task(5, { blocked_by: ["ct-2"] }), task(6, { blocked_by: ["ct-1"] }),
    task(8, { blocked_by: ["ct-4"] }), task(7, { blocked_by: ["ct-6"] }),
  ];
  expect(crossings(tasks)).toBe(0);
  // A task with no neighbour on one side keeps its place rather than jumping to the top.
  const { positions } = planGraphLayout([task(1), task(2), task(3, { blocked_by: ["ct-2"] })]);
  expect(positions.get("ct-1")!.y).toBeLessThan(positions.get("ct-2")!.y);
});

test("a title breaks at a word onto a second line, clipped there", () => {
  expect(wrapTitle("Short", 10, 20)).toEqual(["Short", ""]);
  expect(wrapTitle("Shared graph core: readiness and waits", 20, 30)).toEqual(["Shared graph core:", "readiness and waits"]);
  expect(wrapTitle("Waits backend: create, settle, notify and wake the owner", 15, 20)).toEqual(["Waits backend:", "create, settle, not…"]);
  // A first word longer than the id's line breaks inside it, so that line is not left empty.
  expect(wrapTitle("Supercalifragilistic", 8, 30)).toEqual(["Supercal", "ifragilistic"]);
  expect(wrapTitle("packages/web/components/PlanGraphView.tsx wrap", 10, 20)).toEqual(["packages/w", "eb/components/PlanG…"]);
});

const NOW = Date.UTC(2026, 9, 9, 9, 0);
const UTC = { now: NOW, timeZone: "UTC" };
const timeWait = (at: number, state: TaskWait["state"]): TaskWait => ({ id: "w", kind: "time", at, state, created_at: 0 }) as TaskWait;
const prWait = (kind: string, state: TaskWait["state"]): TaskWait =>
  ({ id: "w", kind, repository: "codecast-sh/codecast", pr_number: 4213, state, created_at: 0 }) as TaskWait;

test("every wait label fits its node whole: the PR number and a settled wait's verb survive", () => {
  const labels = [
    prWait("pr_merged", "waiting"), prWait("pr_merged", "met"),
    prWait("pr_checks_green", "waiting"), prWait("pr_checks_green", "met"),
    { id: "w", kind: "decision", decision: "sd-412", state: "waiting", created_at: 0 } as TaskWait,
    timeWait(Date.UTC(2026, 9, 11, 9, 0), "waiting"),
    timeWait(Date.UTC(2027, 9, 14, 9, 0), "waiting"),
    timeWait(Date.UTC(2026, 9, 9, 1, 23), "met"),
    timeWait(Date.UTC(2026, 8, 14, 9, 0), "met"),
    // The widest label a node can carry: a date in another year, with a verb.
    timeWait(Date.UTC(2027, 9, 14, 9, 0), "met"),
  ].map((w) => waitNodeLabel(w, UTC));
  for (const label of labels) expect(label).not.toContain("…");
  // A holding wait is worded as what it waits FOR: `waitLabel`'s present
  // tense is byte-identical to `waitMetLabel` for checks and for a decision,
  // and a node carries no state word to tell the two apart.
  expect(labels).toEqual([
    "PR #4213 to merge", "PR #4213 merged",
    "PR #4213 checks to go green", "checks green on #4213",
    "sd-412 to be answered",
    "until Sun 09:00", "until Oct 14, 2027 09:00",
    "Fri 01:23 passed", "Sep 14 09:00 passed", "Oct 14, 2027 09:00 passed",
  ]);
});

test("a failed wait's node names its cause, not the thing it was waiting for", () => {
  // A failed wait keeps blocking (TG2), so the node that most needs attention
  // cannot be the one that says least: it carries `waitFailedCause`, the same
  // words the task page, the row mark and the CLI show — never the present
  // tense of what it wanted, which reads as if it had happened.
  expect([
    prWait("pr_merged", "failed"),
    prWait("pr_checks_green", "failed"),
    { id: "w", kind: "decision", decision: "sd-412", state: "failed", created_at: 0 } as TaskWait,
    // A settle's own note takes the place of the generic word.
    { ...prWait("pr_merged", "failed"), note: "closed unmerged" } as TaskWait,
  ].map((w) => waitNodeLabel(w, UTC))).toEqual([
    "PR #4213 closed without merging",
    "PR #4213 can no longer go green",
    "sd-412 will not be answered",
    "PR #4213 closed unmerged",
  ]);
  // A cause is prose and cannot be bounded, so the longest clips; the node's
  // title (`waitLine`) carries the whole line either way.
  const long = waitNodeLabel(timeWait(Date.UTC(2027, 9, 14, 9, 0), "failed"), UTC);
  expect(long.startsWith("Oct 14, 2027 09:00 ")).toBe(true);
  expect(long.endsWith("…")).toBe(true);
});

test("the key names only the marks the graph makes, each drawn as the mark itself", () => {
  const { edges, waitNodes } = planGraphLayout([
    task(1, { status: "done" }),
    task(2, { waits: [wait("w1", "waiting"), wait("w2", "met"), wait("w3", "failed")] }),
    // ct-1 is cleared, ct-2 still blocks.
    task(3, { blocked_by: ["ct-1", "ct-2"] }),
    // Being worked already, so its open blocker holds nothing back.
    task(4, { status: "in_progress", blocked_by: ["ct-2"] }),
  ]);
  const key = planGraphKey({ edges, waitNodes, blocked: true });
  // The three edge words sit on one axis and are worded in parallel.
  expect(key.encodings.map((k) => k.word)).toEqual([
    "still blocking", "still open, not blocking", "cleared", "still waiting", "wait met", "wait failed", "the agent is blocked",
  ]);
  expect(key.statuses).toEqual([]);
  // Each line swatch is drawn exactly as some edge in the graph.
  for (const item of key.encodings) {
    if (item.mark !== "line") continue;
    expect(edges.map(edgeDraw)).toContainEqual(item.draw);
  }
  // Nothing is said about a mark the graph does not make.
  expect(planGraphKey({ edges: [], waitNodes: [], blocked: false })).toEqual({ statuses: [], encodings: [] });
  expect(planGraphKey({ edges: [], waitNodes, blocked: false }).encodings.map((k) => k.word)).toEqual(["still waiting", "wait met", "wait failed"]);
  // A wait on a task already being worked draws dim: it holds nothing, so the
  // key says nothing about it.
  const worked = planGraphLayout([task(5, { status: "in_progress", waits: [wait("w1", "waiting")] })]);
  expect(planGraphKey({ edges: [], waitNodes: worked.waitNodes, blocked: false })).toEqual({ statuses: [], encodings: [] });
});

test("a node draws and is named by the status itself, a team's own included", () => {
  expect(nodeStyle({ id: "open", name: "Open", category: "open" })).toEqual({ tone: "--sol-blue", label: "Open", dim: false });
  // A team's own status keeps its name and its colour, so the graph never
  // calls a "Today" task Open or draws it Open-blue.
  expect(nodeStyle({ id: "s1", name: "Today", category: "open", color: "cyan" })).toEqual({ tone: "--sol-cyan", label: "Today", dim: false });
  // No colour of its own: the category's, and dropped greys its title.
  expect(nodeStyle({ id: "s2", name: "Shipped", category: "done" })).toEqual({ tone: "--sol-green", label: "Shipped", dim: false });
  expect(nodeStyle({ id: "dropped", name: "Dropped", category: "dropped" }).dim).toBe(true);
});

test("the key names each status drawn once, apart from the marks it carries in colour alone", () => {
  const { edges, waitNodes } = planGraphLayout([task(1, { status: "done" }), task(2, { blocked_by: ["ct-1"] })]);
  const nodes = [
    nodeStyle({ id: "s1", name: "Today", category: "open", color: "cyan" }),
    nodeStyle({ id: "done", name: "Done", category: "done" }),
    nodeStyle({ id: "s1", name: "Today", category: "open", color: "cyan" }),
  ];
  const key = planGraphKey({ edges, waitNodes, blocked: false, nodes });
  expect(key.statuses.map((k) => [k.mark, k.word])).toEqual([["status", "Today"], ["status", "Done"]]);
  expect(key.encodings.map((k) => [k.mark, k.word])).toEqual([["line", "cleared"]]);
  expect(key.statuses[0]).toEqual({ word: "Today", mark: "status", tone: "--sol-cyan" });
  // Nothing is said about a status no node draws.
  expect(planGraphKey({ edges: [], waitNodes: [], blocked: false, nodes: [] })).toEqual({ statuses: [], encodings: [] });
});

test("the key's statuses read in the team's order, whatever order the layout drew them in", () => {
  const { edges, waitNodes } = planGraphLayout([task(1, { status: "done" }), task(2, { blocked_by: ["ct-1"] })]);
  // Drawn finished-work-first, as a plan whose first column is done would be.
  const nodes = [
    nodeStyle({ id: "done", name: "Done", category: "done" }),
    nodeStyle({ id: "s1", name: "Today", category: "open", color: "cyan" }),
    nodeStyle({ id: "wip", name: "Working on", category: "in_progress" }),
  ];
  const order = ["Backlog", "Today", "Working on", "In Review", "Done", "Dropped"];
  expect(planGraphKey({ edges, waitNodes, blocked: false, nodes, statusOrder: order }).statuses.map((k) => k.word))
    .toEqual(["Today", "Working on", "Done"]);
  // A name the team's list does not hold keeps its place after the ones it does.
  const withStray = [...nodes, nodeStyle({ id: "x", name: "Parked", category: "open" })];
  expect(planGraphKey({ edges, waitNodes, blocked: false, nodes: withStray, statusOrder: order }).statuses.map((k) => k.word))
    .toEqual(["Today", "Working on", "Done", "Parked"]);
  // Without the order, the draw order stands.
  expect(planGraphKey({ edges, waitNodes, blocked: false, nodes }).statuses.map((k) => k.word))
    .toEqual(["Done", "Today", "Working on"]);
});
