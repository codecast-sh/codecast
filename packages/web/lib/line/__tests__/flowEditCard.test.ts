// The edit card's model over what the real CLI printed (lib/renderGalleryPipeline.generated.ts, from
// scripts/gen-gallery-pipeline.ts): `cast flow edit` and `cast flow pipeline` in a scratch repo (origin
// example-org/example-app): add lint after check when landing/**, guide review, skip decide, in that order, so the
// later fences carry the earlier edits in their graph.
import { describe, expect, test } from "bun:test";
import { asGitDiff, editDrawing, editLines, editRun, liveDeploy } from "../flowEditCard";
import { editFromOutput, readEdit } from "../flowEditFence";
import { parseCastDiff } from "../../castDiff";
import { readFlowFence } from "../flowFence";
import { pipelineCommandRepo } from "../flowCommandOutput";
import { EDIT_ADD, EDIT_GUIDE, EDIT_SKIP, PIPELINE_TEXT } from "../../renderGalleryPipeline.generated";
import type { DiagramStep } from "../flowDiagram";

const allSteps = (steps: DiagramStep[]): DiagramStep[] => steps.flatMap((s) => [s, ...allSteps(s.inner)]);
const OUT = { add: EDIT_ADD, guide: EDIT_GUIDE, skip: EDIT_SKIP, pipeline: PIPELINE_TEXT } as const;
const out = (name: keyof typeof OUT) => OUT[name].output;
const made = (name: keyof typeof OUT) => editFromOutput(out(name))!;
const pathOf = (name: keyof typeof OUT) => editDrawing(made(name).edit)!.diagram.steps.map((s) => s.label);

describe("the edit a `cast flow edit` printed", () => {
  test("reads the fence and the diff printed above it", () => {
    const { edit, diff } = made("add");
    expect(edit.flow).toBe("change");
    expect(edit.repository).toBe("example-org/example-app");
    expect(diff).toContain("+++ b/.codecast/flows/change.cast");
    expect(diff).toContain(`lint [after="check"`);
    expect(diff).not.toContain("```");
  });

  test("its diff opens as the transcript's diff card, one card per file", () => {
    const files = parseCastDiff(asGitDiff(made("guide").diff!));
    expect(files.map((f) => f.path)).toEqual([".codecast/flows/change/review.guide.md", ".codecast/flows/change.cast"]);
    expect(files.map((f) => f.status)).toEqual(["added", "modified"]);
    expect(files[1].additions).toBe(1);
    expect(parseCastDiff(asGitDiff(made("add").diff!))[0].status).toBe("added");
  });

  test("the same body is a ```flow fence's edit", () => {
    const body = out("skip").match(/```flow\n(.*)\n```/)![1];
    const read = readFlowFence(body);
    expect(read.ok && read.spec.edit?.changes[0].op).toBe("skip");
    expect(readEdit(body)?.graph_hash).toBe(made("skip").edit.graph_hash);
  });

  test("a pipeline fence names its repository, lowercased; anything else is not one", () => {
    const read = readFlowFence('{"pipeline":"Example-Org/example-app"}');
    expect(read.ok && read.spec.pipeline).toBe("example-org/example-app");
    expect(readFlowFence('{"pipeline":"not a repo"}').ok).toBe(false);
    expect(pipelineCommandRepo(out("pipeline"), false)).toBe("example-org/example-app");
    expect(pipelineCommandRepo(out("pipeline"), true)).toBeNull();
  });
});

describe("the edit in words", () => {
  test("a station added with a when reads as one line", () => {
    expect(editLines(made("add").edit)).toEqual(["+ Lint after Check · runs when landing/**"]);
  });
  test("guidance and a skip read by the station's name", () => {
    expect(editLines(made("guide").edit)).toEqual(["~ Review: guidance added"]);
    expect(editLines(made("skip").edit)).toEqual(["Decide skipped"]);
  });
});

describe("the flow the edit builds", () => {
  test("draws the graph as it validated, the new station marked added with its paths", () => {
    const d = editDrawing(made("add").edit)!;
    expect(d.diagram.steps.map((s) => s.label)).toEqual(["Check", "Lint", "Review", "Decide", "Land", "Deploy"]);
    expect(d.marks.lint).toMatchObject({ own: "added", when: "landing/**" });
    expect(Object.keys(d.marks)).toEqual(["lint"]);
  });

  test("a later edit's drawing keeps the earlier ones, and marks only its own", () => {
    const d = editDrawing(made("guide").edit)!;
    expect(d.diagram.steps.map((s) => s.label)).toContain("Lint");
    expect(Object.keys(d.marks)).toEqual(["review"]);
    expect(d.marks.review).toMatchObject({ own: "changed", changed: ["guidance"] });
  });

  test("a skipped station comes back as a ghost where it stood, the person's step it was", () => {
    const d = editDrawing(made("skip").edit)!;
    expect(d.diagram.steps.map((s) => s.label)).toEqual(["Check", "Lint", "Review", "Decide", "Land", "Deploy"]);
    expect(d.diagram.steps.find((s) => s.id === "decide")?.kind).toBe("person");
    expect(d.marks.decide).toEqual({ own: null, skipped: true, proposed: "proposed" });
    // Once live, it is no longer a proposal.
    expect(editDrawing(made("skip").edit, { live: true })!.marks.decide).toEqual({ own: null, skipped: true });
  });

  test("an older fence with no graph draws over the backbone with the file's edits laid on", () => {
    const { graph: _g, ...old } = made("skip").edit;
    const base = editDrawing(made("add").edit)!; // any graph will do as a backbone; take the one before Lint
    const backbone = { nodes: base.flow.nodes.filter((n) => n.id !== "lint"), edges: base.flow.edges.filter((e) => e.from !== "lint" && e.to !== "lint") };
    expect(editDrawing(old)).toBeNull();
    const d = editDrawing(old, { base: backbone })!;
    const labels = d.diagram.steps.map((s) => s.label);
    expect(labels.indexOf("Lint")).toBe(labels.indexOf("Check") + 1);
    expect(d.marks.decide?.skipped).toBe(true);
    expect(allSteps(d.diagram.steps).filter((s) => s.id === "decide")).toHaveLength(1);
  });

  test("the path the CLI printed is the path drawn, less the ghost", () => {
    const printed = out("skip").match(/· (Check → .*)$/m)![1].split(" → ");
    expect(pathOf("skip").filter((l) => l !== "Decide")).toEqual(printed);
  });
});

describe("which run carries the edit", () => {
  const edit = made("skip").edit;
  const run = (id: string, created_at: number, graph_hash?: string) => ({ _id: id, created_at, graph_hash });
  test("none before the session runs its change", () => {
    expect(editRun(edit, [run("old", 100)], 500)).toBeNull();
  });
  test("a run of the graph it built, or one started after it, the newest", () => {
    expect(editRun(edit, [run("old", 100), run("same", 200, edit.graph_hash)], 500)?._id).toBe("same");
    expect(editRun(edit, [run("a", 600), run("b", 900)], 500)?._id).toBe("b");
    expect(editRun(edit, [run("a", 600)], null)).toBeNull();
  });
  test("its deploy is named once it is live", () => {
    expect(liveDeploy("live on web dp-12, waiting for cli")).toBe("dp-12");
    expect(liveDeploy(null)).toBeNull();
  });
});

describe("the fence readers stay leaves", () => {
  // flowFence (every markdown surface) and the `cast flow` tool card load these on the transcript's path. Reaching the
  // drawing's model pulled in lineModel's graph, whose import cycle left bun's module load unresolved and hung two
  // web test files until their timeout (main CI, 8010fe3f9).
  test("flowFence and flowEditFence import neither the edit card's model nor the line model", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const file of ["../flowFence.ts", "../flowEditFence.ts"]) {
      const src = fs.readFileSync(path.join(import.meta.dir, file), "utf8");
      const imports = [...src.matchAll(/^import[^;]*from "([^"]+)"/gm)].map((m) => m[1]);
      expect(imports.filter((i) => /flowEditCard|flowDiagram|pipelineModel|lineModel/.test(i))).toEqual([]);
    }
  });
});
