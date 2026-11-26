// A gate a flow edit renamed is found again on the graph as it is now.
import { expect, test } from "bun:test";
import { renamedGate } from "./reask";
import { parseWorkflowSource } from "./parser";
import { resolveWorkflowSource } from "./templates";

const graphOf = (ids: Array<[string, string]>) => ({ nodes: new Map(ids.map(([id, type]) => [id, { id, type }])), edges: [] }) as any;

test("the change flow's decision is a segment station named after the node that holds it", () => {
  const src = resolveWorkflowSource("change")!;
  const graph = parseWorkflowSource(src.source, src.dir);
  expect(graph.nodes.get("decide__decide")?.type).toBe("human");
  // Union renamed that node to `card`: a run waiting at card__decide finds decide__decide.
  expect(renamedGate(graph, "card__decide", new Set(["card__decide"]))).toEqual({ gate: "decide__decide", candidates: ["decide__decide"] });
});

test("only a person's gate with the same last part matches", () => {
  const graph = graphOf([["card__decide", "human"], ["card__brief", "agent"], ["review__decide", "agent"]]);
  expect(renamedGate(graph, "decide__decide", new Set(["decide__decide"])).gate).toBe("card__decide");
});

test("a gate the run already had beside the old one is another gate, not the old one renamed", () => {
  const graph = graphOf([["ship_decide__decide", "human"]]);
  // review_decide was deleted; ship_decide__decide stood beside it when the run started.
  expect(renamedGate(graph, "review_decide__decide", new Set(["review_decide__decide", "ship_decide__decide"]))).toEqual({ candidates: [] });
  // Renamed: the run never had card__decide.
  expect(renamedGate(graphOf([["card__decide", "human"]]), "decide__decide", new Set(["decide__decide"])).gate).toBe("card__decide");
});

test("no match or several is no answer", () => {
  expect(renamedGate(graphOf([["approve", "human"]]), "decide__decide", new Set())).toEqual({ candidates: [] });
  const two = renamedGate(graphOf([["a__decide", "human"], ["b__decide", "human"]]), "decide__decide", new Set());
  expect(two.gate).toBeUndefined();
  expect(two.candidates).toEqual(["a__decide", "b__decide"]);
});
