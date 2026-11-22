// `cast flow edit` (pipeline.md PL5): each typed edit writes the one line that says it, over the shipped change.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyFlowEdit, planFlowEdit, type FlowEditRequest } from "./flowEdit.js";
import { isolateCodecastDirEachTest } from "./test-helpers/codecastDir.js";
isolateCodecastDirEachTest("cast-flow-edit-");
import { graphHash, parseWorkflowFile } from "./workflow/parser.js";

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const repo = (files: Record<string, string> = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowedit-"));
  tmp.push(root);
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); }
  return root;
};
const edit = (root: string, req: FlowEditRequest, flow = "change") => { const plan = planFlowEdit(root, flow, req); applyFlowEdit(plan); return plan; };
const flowFile = (root: string) => fs.readFileSync(path.join(root, ".codecast/flows/change.cast"), "utf8");

describe("cast flow edit change", () => {
  test("add creates the project's flow over the library's, one line, and prints the edit object", () => {
    const root = repo();
    const plan = edit(root, { op: "add", station: "lint", after: "check", run: "bun run lint" });
    expect(plan.created).toBe(true);
    expect(flowFile(root)).toContain(`graph [extends="change"]\n  lint [after="check", label="Lint", shape=parallelogram, script="bun run lint"]\n}`);
    expect(plan.words).toEqual(["+ Lint after Check"]);
    expect(plan.path).toBe("Check → Lint → Review → Decide → Land → Deploy");
    const { graph, variant, ...rest } = plan.edit;
    expect(rest).toEqual({ flow: "change", file: ".codecast/flows/change.cast", graph_hash: graphHash(parseWorkflowFile(path.join(root, ".codecast/flows/change.cast"))), base: "change", changes: [{ op: "add", station: "lint", label: "Lint", after: "check", who: "command", by: "command" }] });
    // The card draws the flow as it validated: the new station is in it, and no command's text is.
    expect(graph!.nodes.find((n) => n.id === "lint")).toMatchObject({ label: "Lint", type: "command" });
    expect(graph!.edges.some((e) => e.from === "lint")).toBe(true);
    expect(JSON.stringify(graph)).not.toContain("bun run lint");
    expect(variant).toEqual([{ op: "add", station: "lint", label: "Lint", after: "check" }]);
    expect(plan.diff).toContain("+++ b/.codecast/flows/change.cast");
  });

  test("the same edit twice writes nothing; a changed one rewrites its line", () => {
    const root = repo();
    edit(root, { op: "add", station: "lint", after: "check", run: "bun run lint" });
    expect(planFlowEdit(root, "change", { op: "add", station: "lint", after: "check", run: "bun run lint" }).changed).toBe(false);
    edit(root, { op: "run", station: "lint", cmd: "bun run lint --changed" });
    expect(flowFile(root)).toContain(`script="bun run lint --changed"`);
    expect(flowFile(root).match(/lint \[/g)?.length).toBe(1);
  });

  test("guide writes the text beside the flow and names it; undo takes the line and the file away", () => {
    const root = repo();
    const plan = edit(root, { op: "guide", station: "Review", text: "Also check X." });
    expect(plan.words).toEqual(["~ Review: guidance added"]);
    expect(flowFile(root)).toContain(`review [guide="@change/review.guide.md"]`);
    expect(fs.readFileSync(path.join(root, ".codecast/flows/change/review.guide.md"), "utf8")).toBe("Also check X.\n");
    expect(parseWorkflowFile(path.join(root, ".codecast/flows/change.cast")).nodes.get("review__review")!.prompt).toEndWith("\n\nAlso check X.");
    const undo = edit(root, { op: "undo", station: "review" });
    expect(undo.words).toEqual(["Review: back to the base"]);
    // Back to saying nothing, the file this tool made goes with its directory, so the library's flow runs again.
    expect(undo.removed).toBe(true);
    expect(fs.existsSync(path.join(root, ".codecast"))).toBe(false);
    expect(planFlowEdit(root, "change", { op: "undo", station: "review" }).changed).toBe(false);
  });

  test("skip and when read as what they do; skipping a station the project added takes it out", () => {
    const root = repo();
    edit(root, { op: "prompt", station: "decide", text: "Ask about X." });
    expect(edit(root, { op: "skip", station: "decide" }).words).toEqual(["Decide skipped"]);
    expect(flowFile(root)).toContain(`decide [skip=true]`);
    expect(flowFile(root)).not.toContain("prompt=");
    edit(root, { op: "add", station: "e2e", after: "check", run: "bun e2e", label: "E2E" });
    expect(edit(root, { op: "when", station: "e2e", paths: "landing/**, backend/src/routes/**" }).words).toEqual(["E2E runs when landing/**, backend/src/routes/**"]);
    expect(flowFile(root)).toContain(`when="landing/**, backend/src/routes/**"`);
    expect(edit(root, { op: "when", station: "e2e", paths: "always" }).words).toEqual(["E2E always runs"]);
    expect(flowFile(root)).not.toContain("when=");
    expect(edit(root, { op: "skip", station: "e2e" }).words).toEqual(["- E2E"]);
    expect(flowFile(root)).not.toContain("e2e");
  });

  test("a prompt and guidance on one station live in separate files, so neither overwrites the other", () => {
    const root = repo();
    edit(root, { op: "prompt", station: "review", text: "Review it fully." });
    edit(root, { op: "guide", station: "review", text: "Also check migrations." });
    expect(flowFile(root)).toContain(`review [prompt="@change/review.md", guide="@change/review.guide.md"]`);
    expect(parseWorkflowFile(path.join(root, ".codecast/flows/change.cast")).nodes.get("review__review")!.prompt).toBe("Review it fully.\n\nAlso check migrations.");
  });

  test("words: a skipped station undone reads by its name, a replaced command says what it replaced", () => {
    const root = repo();
    edit(root, { op: "skip", station: "decide" });
    expect(edit(root, { op: "undo", station: "decide" }).words).toEqual(["Decide: back to the base"]);
    expect(edit(root, { op: "run", station: "deploy", cmd: "echo deployed" }).words).toEqual(["~ Deploy: runs a new command, replacing cast flow await-deploy"]);
    expect(() => planFlowEdit(root, "change", { op: "guide", station: "decide", text: "x" })).toThrow('Decide is a person\'s question, not an agent\'s prompt: change the question with cast flow edit change prompt decide "<text>"');
    const ends = repo({
      "line/flow.cast": `digraph flow {\n  graph [kind="line", takes="task,branch"]\n  start [shape=Mdiamond]\n  pr [shape=parallelogram, script="true"]\n  exit [shape=Msquare]\n  nopr [shape=Msquare, stop="no pr"]\n  start -> pr\n  pr -> exit [condition="outcome = success"]\n  pr -> nopr\n}\n`,
      ".codecast/flows/flow.cast": `digraph flow { graph [extends="../../line/flow.cast"] }\n`,
    });
    expect(edit(ends, { op: "add", station: "lint", after: "pr", run: "true" }, "flow").words).toEqual(["+ Lint after pr; a failure ends the run"]);
  });

  test("comments and the rest of a hand-written file stay; a repo flow that extends a file gets the line", () => {
    const root = repo({
      "line/change.cast": `digraph change {\n  graph [kind="line"]\n  start [shape=Mdiamond]\n  check [shape=parallelogram, script="true"]\n  exit [shape=Msquare]\n  fix [prompt="Fix it."]\n  start -> check -> exit\n  check -> fix [condition="outcome = failure"]\n  fix -> check\n}\n`,
      ".codecast/flows/change.cast": `// Union's flow\ndigraph change { graph [extends="../../line/change.cast"] }\n`,
    });
    const plan = edit(root, { op: "add", station: "lint", after: "check", run: "bun lint" });
    expect(flowFile(root)).toBe(`// Union's flow\ndigraph change { graph [extends="../../line/change.cast"]\n  lint [after="check", label="Lint", shape=parallelogram, script="bun lint"]\n}\n`);
    expect(plan.edit.base).toBe("../../line/change.cast");
    const g = parseWorkflowFile(path.join(root, ".codecast/flows/change.cast"));
    expect(g.edges.filter((e) => e.from === "lint")).toEqual([
      { from: "lint", to: "exit", condition: "outcome = success" },
      { from: "lint", to: "fix", condition: "outcome = failure", label: "lint failed" },
    ]);
  });

  test("a wrong edit is refused with what to write instead, and nothing is written", () => {
    const root = repo();
    const bad = (req: FlowEditRequest) => () => planFlowEdit(root, "change", req);
    expect(bad({ op: "add", station: "lint", after: "chek", run: "x" })).toThrow('change has no station "chek"; its stations: check, review, decide, ship, deploy, fix_check, fix_review, revise, fix_conflict');
    expect(bad({ op: "add", station: "lint", after: "check" })).toThrow('say what lint does with one of --run "<command>", --agent "<prompt|@file>" or --person "<question>"');
    expect(bad({ op: "add", station: "review", after: "check", run: "x" })).toThrow("change already has a station review");
    expect(bad({ op: "run", station: "review", cmd: "x" })).toThrow('Review is an agent, not a command: change what it reads with cast flow edit change prompt review "<text>"');
    expect(bad({ op: "guide", station: "check", text: "x" })).toThrow("no station of check reads a prompt");
    expect(bad({ op: "skip", station: "review" })).toThrow('answerer="review__review"');
    expect(() => planFlowEdit(root, "nope", { op: "skip", station: "x" })).toThrow("there is no flow nope to extend");
    expect(fs.existsSync(path.join(root, ".codecast"))).toBe(false);
    const whole = repo({ ".codecast/flows/change.cast": `digraph change { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }` });
    expect(() => planFlowEdit(whole, "change", { op: "skip", station: "x" })).toThrow("is a whole flow, not a variant of one");
  });

  test("the edit object draws without the graph's text: a skipped station says where it stood and who did it", () => {
    const root = repo();
    edit(root, { op: "guide", station: "review", text: "Also check the migrations" });
    const plan = edit(root, { op: "skip", station: "decide" });
    expect(plan.edit.changes).toEqual([{ op: "skip", station: "decide", after: "review", who: "person", label: "Decide", by: "command" }]);
    // The fence's graph is what drawing reads: no prompt, script or shape travels in the transcript.
    const nodes = plan.edit.graph!.nodes;
    expect(nodes.some((n) => n.id === "decide")).toBe(false);
    expect(nodes.every((n) => !("prompt" in n) && !("script" in n) && !("shape" in n) && !("segment_label" in n))).toBe(true);
    // The file's other edits ride along, without their text.
    expect(plan.edit.variant).toContainEqual({ op: "guide", station: "review" });
  });
});
