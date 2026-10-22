// A Claude Code workflow becomes a flow (docs/architecture/flows.md FL5): traced with recording
// stand-ins, shaped into a graph, written as a draft only its session is offered.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { importWorkflowScript, shapeTrace, traceWorkflowScript } from "./flowImport";
import { poolFlows } from "./flowPool";
import { parseWorkflowFile, validateWorkflow } from "./parser";

const SCRIPT = `export const meta = { name: 'ship-widget', description: 'Build the widget, then polish', phases: [{ title: 'Build' }, { title: 'Polish' }] }
const CTX = \`${"## Context\\n" + "Shared context line.\\n".repeat(30)}\`
const JOBS = [{ key: 'api', job: 'the api' }, { key: 'ui', job: 'the ui' }]
phase('Build')
const built = await parallel(JOBS.map((j) => () => agent(\`\${CTX}\\nBuild \${j.job}\`, { label: \`build:\${j.key}\`, phase: 'Build' })))
const rounds = []
for (let r = 1; r <= 3; r++) {
  const [crit, rev] = await parallel([
    () => agent(\`\${CTX}\\nCritique\`, { label: \`critique:r\${r}\`, phase: 'Polish', schema: { type: 'object', properties: { issues: { type: 'array' } } } }),
    () => agent(\`\${CTX}\\nReview\`, { label: \`review:r\${r}\`, phase: 'Polish', schema: { type: 'object', properties: { blocking: { type: 'array' } } } }),
  ])
  rounds.push({ crit, rev })
  if (!rev.blocking.length) break
}
return { built, rounds }`;

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-import-")));
  execFileSync("git", ["init", "-q", root]);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("tracing a workflow script", () => {
  test("records each agent call with its phase, and which ran side by side", async () => {
    const t = await traceWorkflowScript(SCRIPT);
    expect(t.stopped).toBeNull();
    expect(t.meta.name).toBe("ship-widget");
    expect(t.calls.map((c) => c.label)).toEqual(["build:api", "build:ui", "critique:r1", "review:r1"]);
    expect(t.calls[0].group).toBe(t.calls[1].group);
    expect(t.calls[2].group).toBe(t.calls[3].group);
    expect(t.calls[0].group).not.toBe(t.calls[2].group);
  });

  test("a script that reads absent args stops with why, and the calls before it stand", async () => {
    const t = await traceWorkflowScript("const a = await agent('one', { label: 'one' }); const x = args.items.map((i) => i); await agent('two')");
    expect(t.calls.map((c) => c.label)).toEqual(["one"]);
    expect(t.stopped).toMatch(/stopped in the sandbox/);
  });

  test("shapes fan-outs as steps and numbered rounds as a loop", async () => {
    const shaped = shapeTrace(await traceWorkflowScript(SCRIPT));
    expect(shaped.steps.map((s) => s.stations)).toEqual([["build_api", "build_ui"], ["critique", "review"]]);
    expect(shaped.loops).toEqual([{ from: 1, to: 1, rounds: 3 }]);
  });
});

describe("importing it", () => {
  test("writes a valid draft of the importing session, its shared opening factored out", async () => {
    const out = await importWorkflowScript(SCRIPT, { kind: "segment", cwd: root, session: "jx7abcd" });
    const graph = parseWorkflowFile(out.file);
    expect(validateWorkflow(graph)).toEqual([]);
    expect(graph.draft).toBe("jx7abcd");
    expect(graph.nodes.get("critique")!.max_visits).toBe(3);
    expect(graph.edges).toContainEqual({ from: "join_2", to: "fan_2", condition: "review.json.again = true", label: "another round" });
    expect(fs.readFileSync(path.join(root, ".codecast/flows/ship-widget/_shared.md"), "utf-8")).toContain("Shared context line.");
    expect(graph.nodes.get("build_api")!.prompt).toContain("Build the api");
  });

  test("a draft is offered only to the session that owns it", async () => {
    await importWorkflowScript(SCRIPT, { kind: "segment", cwd: root, session: "jx7abcd" });
    expect(poolFlows(root, "jx7abcd").some((f) => f.slug === "ship-widget")).toBe(true);
    expect(poolFlows(root, "jx7zzzz").some((f) => f.slug === "ship-widget")).toBe(false);
    expect(poolFlows(root, null).some((f) => f.slug === "ship-widget")).toBe(false);
  });

  test("refuses to write over a flow of the same name", async () => {
    await importWorkflowScript(SCRIPT, { kind: "segment", cwd: root, session: "jx7abcd" });
    await expect(importWorkflowScript(SCRIPT, { kind: "segment", cwd: root, session: "jx7abcd" })).rejects.toThrow(/exists/);
  });
});
