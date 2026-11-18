// climb.cast (flows.md FL10) ships inside the binary and resolves by name.
// These tests parse it, check its stations, edges and gate, and run its
// station scripts against a fake cast. The climb's rules themselves run in
// climb/climb.dryrun.test.ts.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { conditionError, evalCondition, extractJsonOutput } from "./condition";
import { parseWorkflowFile, parseWorkflowSource, validateWorkflow } from "./parser";
import { expandScriptVars, gatePayload, parseGateEdgeLabel } from "./runner";
import { lineCommandEnv, lineProfileVars, parseLineProfileText, resolveLineProfile } from "../lineProfile";
import { BUILTIN_WORKFLOW_TEMPLATES, LINE_TEMPLATE_FILES, resolveWorkflowSource } from "./templates";
import { describeFlow } from "./flowPool";

const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.climb);
const AGENTS = ["frame", "propose", "review", "promote"];
const SCRIPTS = ["gauge", "admit", "screen", "confirm", "guard", "evidence", "approve", "drop", "record"];
const fired = (id: string, context: Record<string, string>) => graph.edges.filter((e) => e.from === id && (!e.condition || evalCondition(e.condition, context))).map((e) => e.to);

describe("climb.cast", () => {
  test("resolves by name, joins the pool as a whole flow that takes a task, and validates", () => {
    expect(resolveWorkflowSource("climb")?.label).toBe("builtin:climb");
    expect(validateWorkflow(graph)).toEqual([]);
    const flow = describeFlow("climb", BUILTIN_WORKFLOW_TEMPLATES.climb, "shipped", null);
    expect([flow.kind, flow.takes]).toEqual(["line", ["task"]]);
    // The file run from disk reads the same as the builtin.
    const disk = parseWorkflowFile(path.join(import.meta.dir, "templates", "climb.cast"));
    expect([...disk.nodes.keys()]).toEqual([...graph.nodes.keys()]);
    expect(disk.nodes.get("frame")!.prompt).toBe(graph.nodes.get("frame")!.prompt);
  });

  test("agents write only the card and the candidates; every number comes from cast climb", () => {
    for (const id of AGENTS) {
      const n = graph.nodes.get(id)!;
      expect([n.backend, n.agent]).toEqual(["session", "claude"]);
      expect(n.prompt).toBe(LINE_TEMPLATE_FILES[`climb/${id}.md`]);
    }
    expect(graph.nodes.get("propose")!.isolated).toBe(true);
    expect(graph.nodes.get("review")!.reviewer).toBe(true);
    for (const id of ["gauge", "admit", "screen", "confirm", "guard"]) expect(graph.nodes.get(id)!.script).toMatch(new RegExp(`cast climb ${id} --dir "\\$(d|run_dir/climb)"`));
    for (const id of SCRIPTS) expect(graph.nodes.get(id)!.type).toBe("command");
  });

  test("station prompts state intent first, keep facts in a block, name others' text as data, and end with a pinned report", () => {
    for (const id of AGENTS) {
      const p = graph.nodes.get(id)!.prompt!;
      expect(p.indexOf("`")).toBeGreaterThan(p.indexOf(". "));
      expect(p).toContain("\nFacts\n");
      expect(p).toMatch(/data[^.]{0,20} not instructions/);
      expect(p).toContain("cast state --status done");
      expect(p).not.toContain("—");
      expect(p).not.toMatch(/no longer|used to|previously/i);
    }
  });

  test("every $var a station names is one the run provides", () => {
    const known = new Set(["task_id", "task_title", "task_description", "goal_ref", "run_dir", "worktree", "human_message", ...Object.keys(lineProfileVars(resolveLineProfile(parseLineProfileText("").values).profile))]);
    const nodeVar = /^(\w+)\.(output|outcome|exit_code|json(\.\w+)*)$/;
    const texts = [...graph.nodes.values()].flatMap((n) => [n.prompt, n.script, n.doc]).filter(Boolean) as string[];
    const unknown = new Set<string>();
    for (const t of texts) for (const [, name] of t.matchAll(/\$(\w+(?:\.\w+)*)/g)) {
      const m = name.match(nodeVar);
      if (known.has(name) || (m && graph.nodes.has(m[1]))) continue;
      if (/^[a-z]+$/.test(name) && texts.some((x) => x.includes(`${name}=`))) continue;
      unknown.add(name);
    }
    expect([...unknown]).toEqual([]);
  });

  test("every condition parses; every node is reachable and reaches exit; every end passes through record", () => {
    for (const e of graph.edges) if (e.condition) expect(conditionError(e.condition)).toBeNull();
    const next = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => e.to);
    const reach = (seed: string, step: (id: string) => string[]) => { const seen = new Set([seed]); const q = [seed]; while (q.length) for (const n of step(q.shift()!)) if (!seen.has(n)) { seen.add(n); q.push(n); } return seen; };
    expect([...graph.nodes.keys()].filter((id) => !reach("start", next).has(id))).toEqual([]);
    expect([...graph.nodes.keys()].filter((id) => !reach("exit", (id) => graph.edges.filter((e) => e.to === id).map((e) => e.from)).has(id))).toEqual([]);
    expect(graph.edges.filter((e) => e.to === "exit").map((e) => e.from)).toEqual(["record"]);
    expect(graph.edges.filter((e) => e.from === "promote").map((e) => e.to)).toEqual(["evidence"]);
  });

  test("routing: a refused card goes back to Frame; nothing to promote and a spent budget go to Record", () => {
    expect(fired("gauge", { outcome: "success", "gauge.exit_code": "0" })).toEqual(["propose"]);
    expect(fired("gauge", { outcome: "failure", "gauge.exit_code": "5" })).toEqual(["frame"]);
    expect(fired("gauge", { outcome: "failure", "gauge.exit_code": "3" })).toEqual(["record"]);
    for (const id of ["screen", "confirm"]) for (const code of ["3", "4"]) expect(fired(id, { outcome: "failure", [`${id}.exit_code`]: code })).toEqual(["record"]);
    expect(fired("screen", { outcome: "success" })).toEqual(["confirm"]);
    expect(fired("confirm", { outcome: "success" })).toEqual(["guard"]);
    expect(fired("guard", { outcome: "success" })).toEqual(["promote"]);
    expect(fired("guard", { outcome: "failure" })).toEqual(["record"]);
    expect(fired("admit", { outcome: "failure" })).toEqual(["record"]);
    expect(graph.nodes.get("frame")!.max_visits).toBe(2);
  });

  test("one gate, asked by the run with the computed record: Start, Drop, or a note back to Promote", () => {
    const gates = [...graph.nodes.values()].filter((n) => n.type === "human");
    // The run asks itself, with the computed record as the document: the person answers from the filed runs, not Promote's words alone.
    expect(gates.map((g) => [g.id, g.asker])).toEqual([["decide", undefined]]);
    expect(graph.nodes.get("decide")!.doc).toBe("$evidence.output");
    const opts = graph.edges.filter((e) => e.from === "decide").map((e) => ({ ...parseGateEdgeLabel(e.label ?? ""), to: e.to, condition: e.condition }));
    expect(opts.map((o) => `${o.key ?? ""}:${o.to}`)).toEqual(["S:approve", "D:drop", ":promote"]);
    const payload = gatePayload(graph.nodes.get("decide")!, graph, { "promote.json": JSON.stringify({ question: "Run a 6-week holdout on lead-with-need?", task: "ct-9", why: "Held +0.06." }), "evidence.output": "Climb on in-9: cand-1 promoted.", run_dir: "/nonexistent" });
    expect([payload.prompt, payload.doc_md]).toEqual(["Run a 6-week holdout on lead-with-need?", "Climb on in-9: cand-1 promoted."]);
  });
});

describe("climb.cast station scripts", () => {
  setDefaultTimeout(60_000);
  let tmp: string, log: string, env: NodeJS.ProcessEnv;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "climb-scripts-"));
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    log = path.join(tmp, "cast.log");
    // The fake cast logs each call; `climb status` answers from FAKE_* and `climb guard|screen` exit FAKE_EXIT.
    fs.writeFileSync(path.join(bin, "cast"), `#!/bin/bash
for a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"; echo --- >> "${log}"
if [ "$1 $2" = "climb status" ]; then case "$*" in *"--field task"*) echo "$FAKE_TASK" ;; *--field*) echo "$FAKE_GOAL" ;; *--summary*) printf '%s' "$FAKE_SUMMARY" ;; esac; fi
if [ "$1" = "climb" ] && [ -n "$FAKE_EXIT" ]; then exit "$FAKE_EXIT"; fi
exit 0
`, { mode: 0o755 });
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").split("---\n").filter(Boolean).map((c) => c.trimEnd().split("\n")) : []);
  const run = (id: string, ctx: Record<string, string>, extra: NodeJS.ProcessEnv = {}) => {
    const c = { task_id: "ct-1", run_dir: path.join(tmp, "run"), goal_ref: "in-9:yes_rate", human_message: "", ...lineProfileVars(resolveLineProfile(parseLineProfileText("").values).profile), ...ctx };
    const r = spawnSync("bash", ["-c", expandScriptVars(graph.nodes.get(id)!.script!, c)], { cwd: tmp, env: { ...env, ...extra, ...lineCommandEnv(c) }, encoding: "utf-8" });
    return { code: r.status, out: r.stdout, json: extractJsonOutput(r.stdout) as any };
  };
  const d = () => path.join(tmp, "run", "climb");

  test("gauge reads Frame's card from the climb directory and keeps cast climb's exit", () => {
    expect(run("gauge", {}, { FAKE_EXIT: "5" }).code).toBe(5);
    expect(calls()[0]).toEqual(["climb", "gauge", "--dir", d(), "--card", `${d()}/card.json`, "--task", "ct-1", "--goal", "in-9:yes_rate"]);
    expect(fs.existsSync(d())).toBe(true);
  });

  test("guard names no command: the gate is the line profile's eval command as committed at the base", () => {
    run("guard", { "line.commands.eval": "bun run evals --gate" });
    expect(calls()).toEqual([["climb", "guard", "--dir", d()]]);
  });

  test("record leaves the summary on the goal and the task, and never fails the run", () => {
    const out = run("record", {}, { FAKE_GOAL: "in-9", FAKE_SUMMARY: "Climb on in-9: cand-1 promoted.\nCost: $3.00 of $25.00" });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.out.trim().split("\n").pop()!).why).toBe("Climb on in-9: cand-1 promoted.");
    const cs = calls();
    expect(cs).toContainEqual(["goal", "update", "in-9", "Climb on in-9: cand-1 promoted.", "Cost: $3.00 of $25.00"]);
    expect(cs).toContainEqual(["task", "comment", "ct-1", "Climb on in-9: cand-1 promoted.", "Cost: $3.00 of $25.00", "-t", "progress"]);
  });

  test("record before any card falls back to the task's goal and says nothing was tried", () => {
    const out = run("record", {}, { FAKE_GOAL: "", FAKE_SUMMARY: "" });
    expect(out.code).toBe(0);
    expect(calls().find((c) => c[0] === "goal")).toEqual(["goal", "update", "in-9", "The climb ended before Frame wrote a card it could run, so nothing was tried."]);
  });

  test("approve and drop act only on the task cast climb promote recorded, never on Promote's words", () => {
    run("approve", { "promote.json.task": "ct-999", "human.message": "go" }, { FAKE_TASK: "ct-77" });
    expect(calls().slice(1)).toEqual([
      ["climb", "outcome", "--dir", d(), "Production experiment approved: ct-77. go"],
      ["task", "update", "ct-77", "-s", "open"],
      ["task", "comment", "ct-77", "Approved for a production experiment at the climb's decision. go", "-t", "progress"],
    ]);
    fs.rmSync(log);
    run("drop", { "promote.json.task": "ct-999" }, { FAKE_TASK: "ct-77" });
    expect(calls().slice(1)).toEqual([["climb", "outcome", "--dir", d(), "Dropped at the decision."], ["task", "drop", "ct-77", "-m", "Dropped at the climb's decision."]]);
    fs.rmSync(log);
    run("drop", {}, { FAKE_TASK: "" });
    expect(calls().some((c) => c[0] === "task")).toBe(false);
  });

  test("evidence prints the computed summary for the gate's document, then Promote's case, and posts the summary on the climb's task", () => {
    const out = run("evidence", { "promote.json.why": "Held +0.06 on 30 sealed cases." }, { FAKE_SUMMARY: "Climb on in-9: cand-1 promoted." });
    expect(out.out).toBe("Climb on in-9: cand-1 promoted.\n\nPromote recommends: Held +0.06 on 30 sealed cases.\n");
    expect(calls().at(-1)).toEqual(["task", "comment", "ct-1", "What the climb measured (computed from its filed runs):", "Climb on in-9: cand-1 promoted.", "-t", "progress"]);
  });
});
