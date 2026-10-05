import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import {
  editStation, forkShippedLine, lineForkIndex, lineForkSlug, lineRunKind, resetAllStations, resetStation, rolesOnProject, stationDiffs, stationText,
} from "../lineStations";

const project = { _id: "k17abc", short_id: "pj-mfx3ab", title: "Codecast" };

describe("fork", () => {
  test("one stable, valid slug per project", () => {
    expect(lineForkSlug(project)).toBe("line-pj-mfx3ab");
    expect(lineForkSlug({ _id: "K17_Ab:c" })).toBe("line-k17-ab-c");
    expect(lineForkSlug({ _id: "x".repeat(90) }).length).toBeLessThanOrEqual(64);
  });

  test("a fork is the shipped graph under the project's slug, and differs nowhere", () => {
    const fork = forkShippedLine(SHIPPED_LINE, project);
    expect(fork.slug).toBe("line-pj-mfx3ab");
    expect(fork.name).toBe("Line for Codecast");
    expect(fork.source).toBe(SHIPPED_LINE.source);
    expect(fork.nodes.map((n) => n.id)).toEqual(SHIPPED_LINE.nodes.map((n) => n.id));
    expect(fork.edges).toEqual(SHIPPED_LINE.edges);
    expect(stationDiffs(fork.nodes, SHIPPED_LINE)).toEqual({});
    // A copy: editing the fork never touches the shipped snapshot.
    fork.nodes[0].label = "changed";
    expect(SHIPPED_LINE.nodes[0].label).not.toBe("changed");
  });
});

describe("diff and reset", () => {
  const fork = forkShippedLine(SHIPPED_LINE, project);

  test("an edited prompt, script or timeout marks its station and only it", () => {
    let nodes = editStation(fork.nodes, "ground", { prompt: "Ground it differently." });
    nodes = editStation(nodes, "red", { timeout: 60 });
    expect(stationDiffs(nodes, SHIPPED_LINE)).toEqual({ ground: ["prompt"], red: ["timeout"] });
    // Untouched stations keep their identity.
    expect(nodes.find((n) => n.id === "plan")).toBe(fork.nodes.find((n) => n.id === "plan"));
  });

  test("clearing a field removes it", () => {
    const nodes = editStation(fork.nodes, "prove", { timeout: null });
    expect("timeout" in nodes.find((n) => n.id === "prove")!).toBe(false);
    expect(stationDiffs(nodes, SHIPPED_LINE)).toEqual({ prove: ["timeout"] });
    const blank = editStation(fork.nodes, "ground", { prompt: "  " });
    expect(blank.find((n) => n.id === "ground")!.prompt).toBeUndefined();
  });

  test("reset puts one station back and leaves the others edited", () => {
    let nodes = editStation(fork.nodes, "ground", { prompt: "x", timeout: 10 });
    nodes = editStation(nodes, "verify", { script: "true" });
    nodes = resetStation(nodes, "ground", SHIPPED_LINE);
    expect(stationDiffs(nodes, SHIPPED_LINE)).toEqual({ verify: ["script"] });
  });

  test("reset all is the shipped graph again", () => {
    const all = resetAllStations(SHIPPED_LINE);
    expect(stationDiffs(all.nodes, SHIPPED_LINE)).toEqual({});
    expect(all.edges).toEqual(SHIPPED_LINE.edges);
  });

  test("a station the shipped line lacks differs in what it sets", () => {
    const nodes = [...fork.nodes, { id: "extra", label: "Extra", shape: "box", type: "agent", prompt: "p" }];
    expect(stationDiffs(nodes, SHIPPED_LINE)).toEqual({ extra: ["prompt"] });
  });
});

describe("what a station opens", () => {
  const byId = (id: string) => SHIPPED_LINE.nodes.find((n) => n.id === id)!;
  test("a prompt from its template file", () => {
    const t = stationText(byId("ground"), SHIPPED_LINE);
    expect(t.kind).toBe("prompt");
    expect(t.file).toBe("line/ground.md");
    expect(t.text.length).toBeGreaterThan(100);
  });
  test("a script, inline or from its file", () => {
    expect(stationText(byId("red"), SHIPPED_LINE)).toMatchObject({ kind: "script", file: "line/red.sh" });
    expect(stationText(byId("verify"), SHIPPED_LINE)).toMatchObject({ kind: "script" });
    expect(stationText(byId("verify"), SHIPPED_LINE).file).toBeUndefined();
  });
  test("start opens nothing", () => {
    expect(stationText(byId("start"), SHIPPED_LINE).kind).toBeNull();
  });
});

describe("roles on the project", () => {
  test("live roles whose area holds the project, with their line", () => {
    const roles = [
      { _id: "a", status: "active", scope: { project_ids: ["p1"] } },
      { _id: "b", status: "active", scope: { project_ids: ["p1", "p2"] }, line_workflow_slug: "line-pj-1" },
      { _id: "c", status: "retired", scope: { project_ids: ["p1"] } },
      { _id: "d", status: "active", scope: { project_ids: ["p2"] } },
    ];
    expect(rolesOnProject(roles, "p1").map((r) => [r.role._id, r.slug])).toEqual([["a", "line"], ["b", "line-pj-1"]]);
  });
});

describe("which line a run ran", () => {
  const other = { _id: "k2", short_id: "pj-b", title: "Mobile" };
  const forks = lineForkIndex([project, other]);
  test("a fork slug names its project; the shipped line by slug or by the builtin's name", () => {
    expect([...forks.keys()]).toEqual(["line-pj-mfx3ab", "line-pj-b"]);
    expect(lineRunKind({ workflow_slug: "line-pj-b", workflow_name: "Line for Mobile" }, forks)).toEqual({ kind: "customized", project: other });
    expect(lineRunKind({ workflow_slug: "line" }, forks)).toEqual({ kind: "shipped" });
    expect(lineRunKind({ workflow_name: "line" }, forks)).toEqual({ kind: "shipped" });
  });
  test("any other workflow is no line, even one whose slug starts with line-", () => {
    expect(lineRunKind({ workflow_slug: "line-up-the-ducks", workflow_name: "line" }, forks)).toBeNull();
    expect(lineRunKind({ workflow_slug: "feature", workflow_name: "feature" }, forks)).toBeNull();
    expect(lineRunKind({}, forks)).toBeNull();
  });
});
