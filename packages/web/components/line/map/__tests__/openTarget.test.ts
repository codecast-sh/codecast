// Where the map opens (line-map.md LX2): a card for the viewer, then the worst trouble, then the busiest node.
import { describe, expect, test } from "bun:test";
import type { MapNode } from "../../../../lib/line/lineMap";
import { openTarget } from "../LineMapView";
import { groupingWords } from "../../../../lib/line/lineSources";
import { MORE_SOURCES, foldSources } from "../LineMap";
import { groundWords } from "../../trace/TraceStory";

const node = (id: string, kind: MapNode["kind"], now: number, marks: MapNode["marks"] = []) => ({ id, kind, now: Array.from({ length: now }, () => ({})), marks }) as unknown as MapNode;

describe("openTarget", () => {
  const nodes = [node("causes", "causes", 47), node("prove", "station", 1, [{ level: "warn", words: "2 of 7 failed" }]), node("verify", "station", 0, [{ level: "fail", words: "3 of 4 failed" }]), node("decide", "decide", 0)];
  test("a card waiting on you wins", () => expect(openTarget(nodes, 1)).toBe("decide"));
  test("then trouble that holds work now, over a failure mark on an empty node", () => expect(openTarget(nodes, 0)).toBe("prove"));
  test("a warned queue of 80 outranks a failure on a node with nothing here", () => {
    expect(openTarget([node("causes", "causes", 80, [{ level: "warn", words: "Piling up" }]), node("implement", "station", 0, [{ level: "fail", words: "2 of 2 failed" }])], 0)).toBe("causes");
  });
  test("with no trouble holding work, the worst mark anywhere, a failure over a warning", () => {
    expect(openTarget([node("prove", "station", 0, [{ level: "warn", words: "2 of 7 failed" }]), node("verify", "station", 0, [{ level: "fail", words: "3 of 4 failed" }]), node("causes", "causes", 3)], 0)).toBe("verify");
  });
  test("then the busiest", () => expect(openTarget([node("causes", "causes", 47), node("implement", "station", 2)], 0)).toBe("causes"));
  test("nothing anywhere opens nowhere", () => expect(openTarget([node("causes", "causes", 0)], 0)).toBeNull());
});

describe("groupingWords", () => {
  test("a key pattern reads in plain words", () => expect(groupingWords("union:<key>")).toBe("counts reports with the same Union key as one cause"));
  test("anything else reads as its pattern", () => expect(groupingWords("sentry-issue")).toBe("counts reports with the same sentry-issue as one cause"));
});

describe("foldSources (LX2)", () => {
  const src = (id: string, through: number, marks: MapNode["marks"] = []) => ({ id, kind: "source", label: id, phase: "sense", col: 0, main: false, now: [], through, passed: [], marks, medianMs: null, failed: 0, source: id }) as unknown as MapNode;
  const map = (n: number, extra: MapNode[] = []) => {
    const sources = [...Array.from({ length: n }, (_, i) => src(`source:s${i}`, 10 - i)), ...extra];
    const signals = { ...src("signals", 0), id: "signals", kind: "signals" } as MapNode;
    return { nodes: [...sources, signals], edges: sources.map((s) => ({ id: `${s.id}->signals`, from: s.id, to: "signals", kind: "flow" as const, count: s.through, items: [] })), window: { from: 0, to: 1, label: "7d" } };
  };
  test("two sources draw as they are", () => expect(foldSources(map(2)).nodes.length).toBe(3));
  test("past that, every source folds into one stacked chip with their count and edges, in the first one's place", () => {
    const m = foldSources(map(6));
    expect(m.nodes.map((n) => n.id)).toEqual([MORE_SOURCES, "signals"]);
    expect(m.nodes.find((n) => n.id === MORE_SOURCES)).toMatchObject({ label: "6 sources", through: 10 + 9 + 8 + 7 + 6 + 5 });
    expect(m.edges.find((e) => e.from === MORE_SOURCES)).toMatchObject({ to: "signals", count: 45 });
  });
  test("a source in trouble or pinned (open, traced) is never folded", () => {
    const m = foldSources(map(7, [src("source:quiet", 0, [{ level: "warn", words: "silent 3d" }])]), new Set(["source:s6"]));
    const ids = m.nodes.map((n) => n.id);
    expect(ids).toContain("source:quiet");
    expect(ids).toContain("source:s6");
  });
});

describe("groundWords (LX4)", () => {
  test("titled with the goal and the fix, the rest of the note as body", () => {
    expect(groundWords({ status: "done", detail: "Serves Matching Engine & Funnel. Intro prompt hides who offers what; fix is a two-line prompt rewrite, already proven red-to-green" }))
      .toEqual({ title: "Serves Matching Engine & Funnel; fix is a two-line prompt rewrite", detail: "Intro prompt hides who offers what; already proven red-to-green" });
  });
  test("a goal alone is the title", () => expect(groundWords({ status: "done", detail: "Serves in-3" })).toEqual({ title: "Serves in-3", detail: "" }));
  test("not grounded yet says so", () => expect(groundWords({ status: "waiting", detail: "Waiting to be admitted" }).title).toBe("Not grounded yet"));
});
