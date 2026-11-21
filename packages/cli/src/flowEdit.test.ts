// `cast flow edit` (pipeline.md PL5): each typed edit writes the one line that says it, over the shipped change.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyFlowEdit, planFlowEdit, type FlowEditRequest } from "./flowEdit.js";
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
    expect(plan.edit).toEqual({ flow: "change", file: ".codecast/flows/change.cast", graph_hash: graphHash(parseWorkflowFile(path.join(root, ".codecast/flows/change.cast"))), base: "change", changes: [{ op: "add", station: "lint", label: "Lint", after: "check", by: "command" }] });
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
    expect(flowFile(root)).toContain(`review [guide="@change/review.md"]`);
    expect(fs.readFileSync(path.join(root, ".codecast/flows/change/review.md"), "utf8")).toBe("Also check X.\n");
    expect(parseWorkflowFile(path.join(root, ".codecast/flows/change.cast")).nodes.get("review__review")!.prompt).toEndWith("\n\nAlso check X.");
    const undo = edit(root, { op: "undo", station: "review" });
    expect(undo.words).toEqual(["Review: back to the base"]);
    expect(flowFile(root)).not.toContain("review [");
    expect(fs.existsSync(path.join(root, ".codecast/flows/change/review.md"))).toBe(false);
  });

  test("skip and when read as what they do; skipping a station the project added takes it out", () => {
    const root = repo();
    edit(root, { op: "guide", station: "decide", text: "Ask about X." });
    expect(edit(root, { op: "skip", station: "decide" }).words).toEqual(["Decide skipped"]);
    expect(flowFile(root)).toContain(`decide [skip=true]`);
    expect(flowFile(root)).not.toContain("guide=");
    edit(root, { op: "add", station: "e2e", after: "check", run: "bun e2e", label: "E2E" });
    expect(edit(root, { op: "when", station: "e2e", paths: "landing/**, backend/src/routes/**" }).words).toEqual(["E2E runs when landing/**, backend/src/routes/**"]);
    expect(flowFile(root)).toContain(`when="landing/**, backend/src/routes/**"`);
    expect(edit(root, { op: "when", station: "e2e", paths: "always" }).words).toEqual(["E2E always runs"]);
    expect(flowFile(root)).not.toContain("when=");
    expect(edit(root, { op: "skip", station: "e2e" }).words).toEqual(["E2E: back to the base"]);
    expect(flowFile(root)).not.toContain("e2e");
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
});
