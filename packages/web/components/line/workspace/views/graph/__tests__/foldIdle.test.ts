import { describe, expect, test } from "bun:test";
import { foldIdle } from "../foldIdle";

// A straight line a → b → c → d → e → f, f the end.
const node = (id: string, kind = "agent", col = 0) => ({ id, label: id.toUpperCase(), fileLabel: null, kind, stage: "build", half: "fix", col, end: null }) as any;
const edge = (from: string, to: string, kind = "flow") => ({ id: `${from}->${to}`, from, to, words: null, does: null, condition: null, kind }) as any;
const graph = (nodes: any[], edges: any[]) => ({ nodes, edges, stages: [{ key: "build", label: "Build", half: "fix", nodes: nodes.map((n) => n.id) }], halves: [] }) as any;

describe("folding the idle stretches of a live graph", () => {
  const line = graph(["a", "b", "c", "d", "e", "f"].map((id, i) => node(id, i === 5 ? "end" : "agent", i)), [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("e", "f")]);

  test("a straight idle stretch folds into one step that counts it; busy steps and ends stay", () => {
    const g = foldIdle(line, (id) => id === "d");
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "fold:b", "d", "e", "f"]);
    expect(g.nodes.find((n) => n.id === "fold:b")).toMatchObject({ label: "2 steps", kind: "script" });
    expect(g.edges.map((e) => e.id)).toEqual(["a->fold:b", "fold:b->d", "d->e", "e->f"]);
  });

  test("one idle step alone is not folded, and an opened fold stays open", () => {
    expect(foldIdle(line, (id) => id === "c" || id === "e").nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(foldIdle(line, (id) => id === "d", new Set(["fold:b"])).nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("a step another path reaches (a branch or a loop into it) breaks the stretch", () => {
    // The loop e → c gives c two ways in, which leaves b and d alone on either side of it: nothing folds.
    const looped = graph(line.nodes, [...line.edges, edge("e", "c", "loop")]);
    expect(foldIdle(looped, (id) => id === "e").nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("nothing to fold gives the same graph back", () => {
    expect(foldIdle(line, () => true)).toBe(line);
  });
});
