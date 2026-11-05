import { describe, expect, test } from "bun:test";
import { foldIdle } from "../foldIdle";

// A straight line a → b → c → d → e → f, f the end.
const node = (id: string, kind = "agent", col = 0) => ({ id, label: id.toUpperCase(), fileLabel: null, kind, stage: "build", half: "fix", col, end: null }) as any;
const edge = (from: string, to: string, kind = "flow") => ({ id: `${from}->${to}`, from, to, words: null, does: null, condition: null, kind }) as any;
const graph = (nodes: any[], edges: any[]) => ({ nodes, edges, stages: [{ key: "build", label: "Build", half: "fix", nodes: nodes.map((n) => n.id) }], halves: [] }) as any;

describe("folding the idle stretches of a live graph", () => {
  const line = graph(["a", "b", "c", "d", "e", "f"].map((id, i) => node(id, i === 5 ? "end" : "agent", i)), [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("e", "f")]);

  test("a straight idle stretch folds into one step that counts it; busy steps and ends stay", () => {
    const g = foldIdle(line, (id) => id === "a" || id === "d");
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "fold:b", "d", "e", "f"]);
    expect(g.nodes.find((n) => n.id === "fold:b")).toMatchObject({ label: "2 steps", kind: "script" });
    expect(g.edges.map((e) => e.id)).toEqual(["a->fold:b", "fold:b->d", "d->e", "e->f"]);
  });

  test("one idle step alone is not folded, and an opened fold stays open", () => {
    expect(foldIdle(line, (id) => id === "a" || id === "c" || id === "e").nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(foldIdle(line, (id) => id === "a" || id === "d", new Set(["fold:b"])).nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("a way back into a quiet stretch (a loop) does not keep it open; the fold takes the loop", () => {
    const looped = graph(line.nodes, [...line.edges, edge("e", "c", "loop")]);
    const g = foldIdle(looped, (id) => id === "a" || id === "e");
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "fold:b", "e", "f"]);
    expect(g.edges.map((e) => e.id)).toContain("e->fold:b");
  });

  test("a quiet entry folds with what follows it", () => {
    expect(foldIdle(line, (id) => id === "d").nodes.map((n) => n.id)).toEqual(["fold:a", "d", "e", "f"]);
  });

  test("nothing to fold gives the same graph back", () => {
    expect(foldIdle(line, () => true)).toBe(line);
  });
});

describe("folding a quiet branch", () => {
  // a → b, b fans out to c1 and c2, both join at d → e (busy) → f (the end).
  const g = graph(
    ["a", "b", "c1", "c2", "d", "e", "f"].map((id, i) => node(id, id === "f" ? "end" : "agent", i)),
    [edge("a", "b"), edge("b", "c1", "branch"), edge("b", "c2", "branch"), edge("c1", "d"), edge("c2", "d"), edge("d", "e"), edge("e", "f")],
  );

  test("a quiet region with one way in and one way out folds whole, however it branches inside", () => {
    const out = foldIdle(g, (id) => id === "a" || id === "e");
    expect(out.nodes.map((n) => n.id)).toEqual(["a", "fold:b", "e", "f"]);
    expect(out.nodes.find((n) => n.id === "fold:b")!.label).toBe("4 steps");
    expect(out.edges.map((e) => e.id)).toEqual(["a->fold:b", "fold:b->e", "e->f"]);
  });

  test("a region that work leaves two ways stays open", () => {
    const two = graph(g.nodes, [...g.edges, edge("c1", "f", "branch")]);
    expect(foldIdle(two, (id) => id === "a" || id === "e").nodes.some((n) => n.id === "fold:b")).toBe(false);
  });
});
