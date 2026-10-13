// The shipped judge-review graph (learning-loop.md LL11): one short session
// diagnoses the wrong finding named in the goal, and a script files its
// answer through `cast signal diagnosis`.
import { describe, expect, test } from "bun:test";
import { JUDGE_REVIEW_GRAPH } from "@codecast/shared/contracts/judgeReview";
import { parseWorkflowSource, validateWorkflow } from "./parser";
import { expandScriptVars } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES, LINE_TEMPLATE_FILES, resolveWorkflowSource } from "./templates";
import { graphForDaemonRun } from "./daemonGraph";

describe("judge-review", () => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES[JUDGE_REVIEW_GRAPH]);

  test("is a valid shipped graph: start, a diagnosis session with its own prompt file, the record step, exit", () => {
    expect(validateWorkflow(graph)).toEqual([]);
    expect([...graph.nodes.keys()]).toEqual(["start", "exit", "diagnose", "record"]);
    const diagnose = graph.nodes.get("diagnose")!;
    expect(diagnose).toMatchObject({ backend: "session", agent: "claude" });
    expect(diagnose.prompt).toBe(LINE_TEMPLATE_FILES["line/diagnose.md"]);
    expect(diagnose.isolated).toBeUndefined();
    expect(resolveWorkflowSource(JUDGE_REVIEW_GRAPH, "/nonexistent")?.label).toBe(`builtin:${JUDGE_REVIEW_GRAPH}`);
  });

  test("a daemon run of the slug takes the finding as its goal, and the record step files the session's JSON for it", () => {
    const run = graphForDaemonRun({ workflow_name: JUDGE_REVIEW_GRAPH, goal_override: "sg-41", project_path: "/nonexistent" }, null, "/nonexistent")!;
    expect(run.goal).toBe("sg-41");
    const result = JSON.stringify({ answer: "misread", fact: "No meeting was booked; the rep's voicemail said there was.", why: "It's in M1." });
    const script = expandScriptVars(run.nodes.get("record")!.script!, { goal: "sg-41", "diagnose.json": result });
    expect(script).toBe(`cast signal diagnosis 'sg-41' --result '${result.replace(/'/g, `'\\''`)}'`);
  });

  test("the prompt asks the one question and names its three answers, reading only", () => {
    const prompt = LINE_TEMPLATE_FILES["line/diagnose.md"];
    expect(prompt).toContain("$goal");
    for (const word of ["missing", "misread", "upheld", "Read only"]) expect(prompt).toContain(word);
    expect(prompt).toContain('{"answer": "missing" | "misread" | "upheld", "fact": "...", "why": "..."}');
  });
});
