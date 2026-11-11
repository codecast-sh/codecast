import { describe, expect, test } from "bun:test";
import { applyOp, coalesceOps, diffStates, foldOps, invertOps, opsProblem, type ArtifactOp, type ElementState } from "./core";
import { askAgentBrief } from "./ask";

const fold = (ops: ArtifactOp[], start?: Map<string, ElementState>) => foldOps(new Map(start ?? []), ops);

// A tiny model of the server: one ordered log, every client applies it in that order.
function serverOrder(batches: ArtifactOp[][]): Map<string, ElementState> {
  const state = new Map<string, ElementState>();
  for (const b of batches) for (const op of b) {
    const prev = state.get(op.k);
    if ("set" in op && (!prev || prev.deleted)) continue;
    state.set(op.k, applyOp(prev, op));
  }
  return state;
}

describe("ops", () => {
  test("put, set, del", () => {
    const s = fold([
      { k: "a", put: { kind: "sticky", x: 1, text: "hi" } },
      { k: "a", set: { x: 5, color: "red" } },
      { k: "a", set: { text: null } },
    ]);
    expect(s.get("a")).toEqual({ kind: "sticky", fields: { x: 5, color: "red" } });
    expect(fold([{ k: "a", put: { kind: "sticky" } }, { k: "a", del: true }]).get("a")?.deleted).toBe(true);
  });

  test("a set on a missing element does nothing", () => {
    expect(applyOp(undefined, { k: "x", set: { a: 1 } }).deleted).toBe(true);
  });

  test("validation refuses reserved fields, bad keys, missing kinds", () => {
    expect(opsProblem([{ k: "a", set: { rev: 3 } }])).toContain("reserved");
    expect(opsProblem([{ k: "a b", del: true }])).toContain("bad element key");
    expect(opsProblem([{ k: "a", put: {} as any }])).toContain("kind");
    expect(opsProblem([{ k: "c:Sheet1!B2", put: { kind: "cell", input: "=A1" } }])).toBeNull();
  });

  test("coalesce folds a drag into one op with the same effect", () => {
    const drag: ArtifactOp[] = [{ k: "a", put: { kind: "sticky", x: 0, y: 0 } }];
    for (let i = 1; i <= 60; i++) drag.push({ k: "a", set: { x: i, y: i * 2 } });
    drag.push({ k: "b", set: { text: "t" } }, { k: "b", set: { color: "red" } });
    const merged = coalesceOps(drag);
    expect(merged).toHaveLength(2);
    expect(fold(merged)).toEqual(fold(drag));
  });

  test("coalesce keeps a delete and a re-create", () => {
    const ops: ArtifactOp[] = [{ k: "a", set: { x: 1 } }, { k: "a", del: true }, { k: "a", put: { kind: "sticky", x: 9 } }, { k: "a", set: { y: 2 } }];
    const base = new Map<string, ElementState>([["a", { kind: "sticky", fields: { x: 0 } }]]);
    expect(fold(coalesceOps(ops), base)).toEqual(fold(ops, base));
  });

  test("invert undoes sets, puts and deletes", () => {
    const base = new Map<string, ElementState>([
      ["a", { kind: "sticky", fields: { x: 0, text: "keep" } }],
      ["b", { kind: "sticky", fields: { x: 1 } }],
    ]);
    const ops: ArtifactOp[] = [{ k: "a", set: { x: 10, color: "red" } }, { k: "b", del: true }, { k: "c", put: { kind: "sticky", x: 3 } }];
    const after = fold(ops, base);
    const undone = fold(invertOps((k) => base.get(k), ops), after);
    for (const [k, s] of base) expect(undone.get(k)).toEqual(s);
    expect(undone.get("c")?.deleted).toBe(true);
  });

  test("diff turns one state into another", () => {
    const from = new Map<string, ElementState>([["a", { kind: "k", fields: { x: 1 } }], ["b", { kind: "k", fields: {} }]]);
    const to = new Map<string, ElementState>([["a", { kind: "k", fields: { x: 2 } }], ["c", { kind: "k", fields: { y: 1 } }]]);
    const out = fold(diffStates(from, to), from);
    expect(out.get("a")).toEqual(to.get("a")!);
    expect(out.get("c")).toEqual(to.get("c")!);
    expect(out.get("b")?.deleted).toBe(true);
  });
});

describe("convergence", () => {
  // Two writers edit the same elements concurrently. Whatever order the
  // server takes their batches in, every client that applies the server's
  // order lands on the same state, and field-level last-writer-wins keeps
  // both writers' edits to different fields.
  test("concurrent field edits merge; same-field edits take the later write", () => {
    const base: ArtifactOp[] = [{ k: "a", put: { kind: "sticky", x: 0, y: 0, text: "" } }];
    const person: ArtifactOp[] = [{ k: "a", set: { x: 100, y: 50 } }];
    const agent: ArtifactOp[] = [{ k: "a", set: { text: "Lock pricing", x: 7 } }, { k: "b", put: { kind: "sticky", x: 300 } }];
    const one = serverOrder([base, person, agent]);
    const two = serverOrder([base, agent, person]);
    expect(one.get("a")!.fields).toEqual({ x: 7, y: 50, text: "Lock pricing" });
    expect(two.get("a")!.fields).toEqual({ x: 100, y: 50, text: "Lock pricing" });
    // Replaying the same order on two clients is deterministic.
    expect(serverOrder([base, person, agent])).toEqual(one);
  });

  test("random interleavings: all clients agree with the server log", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 50; round++) {
      const log: ArtifactOp[][] = [];
      for (let i = 0; i < 40; i++) {
        const k = `el_${Math.floor(rnd() * 5)}`;
        const r = rnd();
        log.push([r < 0.2 ? { k, put: { kind: "sticky", x: Math.floor(rnd() * 100) } } : r < 0.3 ? { k, del: true } : { k, set: { x: Math.floor(rnd() * 100), t: rnd() < 0.5 ? null : "s" } }]);
      }
      // A client that coalesces its own runs before sending still lands on the same state.
      const coalesced = log.map((b) => coalesceOps(b));
      expect(serverOrder(coalesced)).toEqual(serverOrder(log));
    }
  });
});

test("ask brief carries the request, the artifact and the CLI", () => {
  const brief = askAgentBrief({
    prompt: "Draft a forecast",
    doc: { _id: "k17abcdefghijklmnopqrstuv", title: "Pre-orders", doc_type: "sheet" },
    url: "https://codecast.sh/docs/k17abcdefghijklmnopqrstuv",
    selected: [{ key: "c:Sheet1!B2", kind: "cell", rev: 1, input: "21000" }],
    draft: true,
  });
  expect(brief).toStartWith("Draft a forecast");
  expect(brief).toContain("cast sheet read k17abcdefghijklmnopqrstuv");
  expect(brief).toContain("--draft");
  expect(brief).toContain("c:Sheet1!B2 cell");
  expect(brief).toContain("https://codecast.sh/docs/k17abcdefghijklmnopqrstuv");
});
