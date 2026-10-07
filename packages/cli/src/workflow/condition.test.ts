import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { evalCondition, conditionError, extractJsonOutput, lookupContextVar } from "./condition.js";
import { parseWorkflowFile } from "./parser.js";
import { recordNodeOutput, expandScriptVars, expandPromptVars } from "./runner.js";

describe("evalCondition: every condition the shipped workflows use", () => {
  // Each row: a condition string found in templates/, packages/cli/workflows
  // or the repo's workflows/, a context, and what the old evaluator returned.
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ["outcome = success", { outcome: "success" }, true],
    ["outcome = success", { outcome: "failure" }, false],
    ["outcome = failure", { outcome: "failure" }, true],
    ["outcome = failure", { outcome: "success" }, false],
    ["outcome=success", { outcome: "success" }, true],
    ["outcome=success", { outcome: "failure" }, false],
    ["outcome=failure", { outcome: "failure" }, true],
    ["outcome=failure", {}, false],
    ["handoff = done", { handoff: "done" }, true],
    ["handoff = done", { handoff: "none" }, false],
    ["review_verdict = approve", { review_verdict: "approve" }, true],
    ["review_verdict = approve", { review_verdict: "none" }, false],
    ["review_verdict = changes", { review_verdict: "changes" }, true],
    ["review_verdict = changes", { review_verdict: "approve" }, false],
    ["review_verdict = reject", { review_verdict: "reject" }, true],
    ["review_verdict = reject", {}, false],
    // plan-autopilot: never evaluable before (no `context.ready_tasks` key)
    ["context.ready_tasks > 0", { ready_tasks: "3" }, true],
    ["context.ready_tasks > 0", { ready_tasks: "0" }, false],
    ["context.ready_tasks = 0", { ready_tasks: "0" }, true],
    ["context.ready_tasks = 0", { ready_tasks: "2" }, false],
    ["context.ready_tasks > 0", {}, false],
    ["context.ready_tasks = 0", {}, false],
    // line.cast (the-line-end-to-end.md LE5 to LE11): routing on the ground
    // fields and node JSON; templates.test.ts walks each station's table.
    ["readiness != ready or goal_ref = none or not goal_ref", { readiness: "ready", goal_ref: "" }, true],
    ["readiness != ready or goal_ref = none or not goal_ref", { readiness: "ready", goal_ref: "in-3:x" }, false],
    ["readiness = ready and goal_ref and goal_ref != none and risk = plan", { readiness: "ready", goal_ref: "in-3:x", risk: "plan" }, true],
    ["readiness = ready and goal_ref and goal_ref != none and risk = plan", { readiness: "ready", goal_ref: "none", risk: "plan" }, false],
    ["readiness = ready and goal_ref and goal_ref != none and risk != plan", { readiness: "ready", goal_ref: "in-3:x", risk: "low" }, true],
    ["readiness = ready and goal_ref and goal_ref != none and risk != plan", { readiness: "needs_context", goal_ref: "in-3:x", risk: "low" }, false],
    ["prove.json.reproduced = true", { "prove.json": '{"reproduced":true}' }, true],
    ["prove.json.reproduced = true", {}, false],
    ["prove.json.reproduced = false", { "prove.json": '{"reproduced":false}' }, true],
    ["prove.json.reproduced = false", {}, false],
    // No proof at all, whatever the hand said: never a dead end (ct-57659).
    ["prove.json.reproduced != true and prove.json.reproduced != false", {}, true],
    ["prove.json.reproduced != true and prove.json.reproduced != false", { "prove.json": '{"reproduced":false}' }, false],
    ["red.json.red = true", { "red.json": '{"red":true}' }, true],
    ["red.json.red = true", { "red.json": '{"red":false}' }, false],
    ["red.json.red != true", {}, true],
    ["red.json.red != true", { "red.json": '{"red":true}' }, false],
    ["outcome = success and category != prompt and category != line", { outcome: "success", category: "code" }, true],
    ["outcome = success and category != prompt and category != line", { outcome: "success", category: "line" }, false],
    ["outcome = success and (category = prompt or category = line)", { outcome: "success", category: "line" }, true],
    ["outcome = success and (category = prompt or category = line)", { outcome: "failure", category: "prompt" }, false],
    // A profile command is a direct context key; absent from the profile it is empty.
    ["outcome = success and not line.commands.ship", { outcome: "success", "line.commands.ship": "" }, true],
    ["outcome = success and not line.commands.ship", { outcome: "success", "line.commands.ship": "bun ship.ts" }, false],
    ["outcome = success and line.commands.ship", { outcome: "success", "line.commands.ship": "bun ship.ts" }, true],
    ["outcome = success and line.commands.ship", { outcome: "success", "line.commands.ship": "" }, false],
    ["outcome = failure and eval.exit_code = 1", { outcome: "failure", "eval.exit_code": "1" }, true],
    ["outcome = failure and eval.exit_code = 1", { outcome: "failure", "eval.exit_code": "2" }, false],
    ["outcome = failure and eval.exit_code != 1", { outcome: "failure", "eval.exit_code": "2" }, true],
  ];
  for (const [cond, ctx, want] of cases) {
    test(`${cond} with ${JSON.stringify(ctx)} -> ${want}`, () => {
      expect(evalCondition(cond, ctx)).toBe(want);
    });
  }

  test("the list above covers every condition in the shipped workflow files", () => {
    const root = path.resolve(import.meta.dir, "../../../..");
    const dirs = ["packages/cli/src/workflow/templates", "packages/cli/workflows", "workflows"].map(d => path.join(root, d));
    const files: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".cast")) files.push(p);
      }
    };
    dirs.forEach(walk);
    expect(files.length).toBeGreaterThan(0);
    const covered = new Set(cases.map(c => c[0]));
    for (const f of files) {
      const g = parseWorkflowFile(f);
      for (const e of g.edges) {
        if (!e.condition) continue;
        expect({ file: path.basename(path.dirname(f)), condition: e.condition, covered: covered.has(e.condition) })
          .toEqual({ file: path.basename(path.dirname(f)), condition: e.condition, covered: true });
        expect(conditionError(e.condition)).toBeNull();
      }
    }
  });
});

describe("evalCondition: the language", () => {
  const ctx = { outcome: "success", count: "10", small: "9", name: "feature/login", flag: "true", off: "false", empty: "" };

  test("== and != (with and without spaces)", () => {
    expect(evalCondition("outcome == success", ctx)).toBe(true);
    expect(evalCondition("outcome != success", ctx)).toBe(false);
    expect(evalCondition("outcome!=failure", ctx)).toBe(true);
  });

  test("numeric comparison when both sides are numbers, string otherwise", () => {
    expect(evalCondition("count > small", ctx)).toBe(true); // 10 > 9, not "10" > "9"
    expect(evalCondition("count >= 10", ctx)).toBe(true);
    expect(evalCondition("count <= 9", ctx)).toBe(false);
    expect(evalCondition("count < 11", ctx)).toBe(true);
    expect(evalCondition("count = 10.0", ctx)).toBe(true);
    expect(evalCondition("'b' > 'a'", ctx)).toBe(false); // ordering needs numbers
    expect(evalCondition("outcome > 0", ctx)).toBe(false);
  });

  test("contains, quoted strings and literals", () => {
    expect(evalCondition("name contains login", ctx)).toBe(true);
    expect(evalCondition("name CONTAINS 'feature/'", ctx)).toBe(true);
    expect(evalCondition("name contains signup", ctx)).toBe(false);
    expect(evalCondition("'outcome' = outcome", ctx)).toBe(false); // quoted is never a lookup
    expect(evalCondition('"two words" = "two words"', ctx)).toBe(true);
  });

  test("and / or / not, symbolic forms, precedence and parentheses", () => {
    expect(evalCondition("outcome = success and count > 5", ctx)).toBe(true);
    expect(evalCondition("outcome = failure or count > 5", ctx)).toBe(true);
    expect(evalCondition("outcome = failure || count > 50", ctx)).toBe(false);
    expect(evalCondition("not outcome = failure", ctx)).toBe(true);
    expect(evalCondition("!(outcome = success)", ctx)).toBe(false);
    expect(evalCondition("outcome = failure or outcome = success and count > 50", ctx)).toBe(false);
    expect(evalCondition("(outcome = failure or outcome = success) && count > 5", ctx)).toBe(true);
  });

  test("a lone operand is true for a set, non-empty, non-false value", () => {
    expect(evalCondition("flag", ctx)).toBe(true);
    expect(evalCondition("off", ctx)).toBe(false);
    expect(evalCondition("empty", ctx)).toBe(false);
    expect(evalCondition("missing", ctx)).toBe(false);
    expect(evalCondition("not missing", ctx)).toBe(true);
  });

  test("malformed conditions never fire and report an error", () => {
    for (const bad of ["", "outcome =", "(outcome = success", "outcome = 'x", "and", "a = b c"]) {
      expect(evalCondition(bad, ctx)).toBe(false);
      expect(conditionError(bad)).not.toBeNull();
    }
  });

  test("no code runs: an expression-looking string is just text", () => {
    (globalThis as any).__pwned = false;
    expect(evalCondition("globalThis.__pwned=true", {})).toBe(false);
    expect((globalThis as any).__pwned).toBe(false);
  });
});

describe("$node.json.<path>", () => {
  test("extractJsonOutput: whole output, or the last fenced json block", () => {
    expect(extractJsonOutput('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonOutput("notes\n```json\n{\"a\":1}\n```\nmore\n```json\n{\"a\":2}\n```\n")).toEqual({ a: 2 });
    expect(extractJsonOutput("plain text")).toBeUndefined();
    expect(extractJsonOutput("42")).toBeUndefined();
  });

  test("recordNodeOutput exposes fields to lookups, conditions, prompts and scripts", () => {
    const ctx: Record<string, string> = {};
    recordNodeOutput(ctx, "scan", JSON.stringify({ summary: { failing: 2, name: "it's" }, items: [{ id: "a" }, { id: "b" }], ok: false }));
    expect(lookupContextVar(ctx, "scan.json.summary.failing")).toBe("2");
    expect(lookupContextVar(ctx, "scan.json.items")).toBe("2"); // arrays read as their length
    expect(lookupContextVar(ctx, "scan.json.items.1.id")).toBe("b");
    expect(lookupContextVar(ctx, "scan.json.ok")).toBe("false");
    expect(lookupContextVar(ctx, "scan.json.nope")).toBeUndefined();
    expect(evalCondition("scan.json.summary.failing > 1 and not scan.json.ok", ctx)).toBe(true);
    expect(expandPromptVars("failing: $scan.json.summary.failing", { name: "g", nodes: new Map(), edges: [] }, ctx)).toBe("failing: 2");
    expect(expandScriptVars("echo $scan.json.summary.name", ctx)).toBe(`echo 'it'\\''s'`);
  });

  test("a later non-JSON output clears the stale json", () => {
    const ctx: Record<string, string> = {};
    recordNodeOutput(ctx, "scan", '{"a":1}');
    recordNodeOutput(ctx, "scan", "now text");
    expect(ctx["scan.json"]).toBeUndefined();
  });

  test("script vars: an unresolved dotted tail stays literal", () => {
    expect(expandScriptVars("cp $file.bak", { file: "x" })).toBe("cp 'x'.bak");
    expect(expandScriptVars("echo $nothing.here", {})).toBe("echo $nothing.here");
  });
});
