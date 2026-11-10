// A run's detail as a trace (lib/line/runTrace.ts), on the real AgentWatch
// graph and Union's real ct-57382 run: where the problem came from, each
// visit numbered with its session and output, and the small readers the
// step panel uses.
import { describe, expect, test } from "bun:test";
import { buildLineModel, type LineModelRows } from "../lineModel";
import type { MapRun } from "../lineMap";
import { lastWord, outcomeLabel, readableOutput, runTrace, runVars, textHead, varValue, type TraceRun, expandCommand, toolLog } from "../runTrace";
import { agentwatchGraph } from "./agentwatchGraph.fixture";
import { union57382Run } from "./unionLineRuns.fixture";

const raw = { ...union57382Run, task_id: "t1", workflow_slug: "agentwatch", updated_at: union57382Run.updated_at ?? union57382Run.created_at } as unknown as MapRun;
const rows: LineModelRows = {
  runs: [raw],
  tasks: [{ _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "open", created_at: 1 }] as LineModelRows["tasks"],
  graph: agentwatchGraph,
  now: 1_791_500_000_000,
};
const m = buildLineModel(rows, "agentwatch");
const run = m.runs[0];


describe("runTrace", () => {
  const steps = runTrace(m, run, raw as unknown as TraceRun);
  test("numbers every visit in order, with the kind the graph gives it", () => {
    expect(steps.length).toBe(run.visits.length);
    expect(steps.map((s) => s.node)).toEqual(run.visits.map((v) => v.node));
    expect(steps[0].n).toBe("01");
    expect(steps.every((s, i) => s.i === i)).toBe(true);
    expect(steps.some((s) => s.kind === "agent")).toBe(true);
  });
  test("an agent step carries its session and what it pinned, json left out", () => {
    const agent = steps.find((s) => s.kind === "agent" && s.session)!;
    expect(agent.session!.id).toBeTruthy();
    expect(agent.pinned ?? "").not.toContain("```json");
    expect(agent.gist).toBeTruthy();
  });
  test("each step names the next, and the last failed step says how the run failed", () => {
    for (let i = 0; i < steps.length - 1; i++) expect(steps[i].next?.node).toBe(steps[i + 1].node);
    const last = steps[steps.length - 1];
    expect(last.next).toBeNull();
    // In words, never the engine's log line ("hand jx… killed after 30m at prove").
    if (last.status === "failed") { expect(last.failReason).toBeTruthy(); expect(last.failReason).not.toMatch(/\bhand jx|max_visits=|no outgoing edge/); }
  });
  test("a script's command and output come from the graph and the run row", () => {
    const run2 = { node_statuses: [{ node_id: "x", status: "completed", result_preview: "printed\nmore" }] } as TraceRun;
    const model = { steps: { x: { prompt: { kind: "script", text: "bun check.ts $task_id" } } } } as never;
    const visit = { node: "x", label: "X", kind: "script", status: "done", inferred: false, durationMs: 1000, sessionId: null, decided: { outcome: null, words: "Done", toWords: null } };
    const [s] = runTrace(model, { visits: [visit] } as never, run2);
    expect(s).toMatchObject({ command: "bun check.ts $task_id", output: "printed\nmore", gist: "printed", session: null });
    expect(outcomeLabel(s)).toBe("");
    expect(outcomeLabel({ outcome: "a", status: "done", inferred: false })).toBe("");
    expect(outcomeLabel({ outcome: "not_reproduced", status: "done", inferred: false })).toBe("not reproduced");
  });
  test("a script's printed JSON is its fields, the same reading the Decisions rows show", () => {
    const run2 = { node_statuses: [{ node_id: "x", status: "completed", result_preview: '{"dissolved":"judge_defect","moments":2}' }] } as TraceRun;
    const visit = { node: "x", label: "X", kind: "script", status: "done", inferred: false, durationMs: 1000, sessionId: null, decided: { outcome: null, words: "Done", result: { dissolved: "judge_defect", moments: 2 }, toWords: null } };
    const [s] = runTrace({ steps: {} } as never, { visits: [visit] } as never, run2);
    expect(s.produced).toEqual({ kind: "fields", fields: [{ key: "dissolved", value: "judge_defect" }, { key: "moments", value: "2" }], more: 0 });
    expect(s.gist).toBe("dissolved: judge_defect · moments: 2");
  });
  test("a gate step carries the card it was asked on, its choices and answer", () => {
    const run2 = { node_statuses: [], gate_node_id: "decide", gate_decision_short_id: "sd-5", gate_choices: [{ key: "s", label: "Ship" }, { key: "d", label: "Drop" }], gate_answer: "Ship" } as TraceRun;
    const visit = { node: "decide", label: "Decide", kind: "person", status: "done", inferred: false, durationMs: 1, sessionId: null, decided: { outcome: "s", words: "Ship", toWords: "Ship" } };
    const [s] = runTrace({ steps: {} } as never, { visits: [visit] } as never, run2);
    expect(s.gate).toEqual({ ref: "sd-5", question: null, choices: ["Ship", "Drop"], answer: "Ship", note: null });
  });
  test("a gate's card reads as the person saw it: the resolved question, choices by label, the chosen one, the note without its key", () => {
    const raw = { node_statuses: [], gate_node_id: "proposal_gate", gate_prompt: "Should the close note ask who else they would want to meet?\n\nThis is a trial: ...", gate_choices: [{ key: "A", label: "[A] Approve" }, { key: "R", label: "[R] Revise" }], gate_response: "A: Stand-in approval." } as TraceRun;
    const visit = { node: "proposal_gate", label: "Proposal", kind: "person", status: "done", inferred: false, durationMs: 1, sessionId: null, decided: { outcome: "a", words: "a" } };
    const [s] = runTrace({ steps: {} } as never, { visits: [visit] } as never, raw);
    expect(s.gate).toEqual({ ref: null, question: "Should the close note ask who else they would want to meet?", choices: ["Approve", "Revise"], answer: "Approve", note: "Stand-in approval." });
  });
  test("a ship the runner failed because the decision was taken back unanswered did not run: no failure, no fail reason (ct-59561 Run 5)", () => {
    const visit = { node: "ship", label: "Ship", kind: "script", status: "failed", inferred: false, durationMs: 14_000, sessionId: null, decided: { outcome: null, words: "Failed" } };
    const withdrawn = { node_statuses: [{ node_id: "ship", status: "failed" }], fail_reason: "gate withdrawn", gate_decision_status: "withdrawn" } as TraceRun;
    const [s] = runTrace({ steps: {} } as never, { visits: [visit] } as never, withdrawn);
    expect(s).toMatchObject({ notRun: "the decision was withdrawn", failReason: null });
    const [answered] = runTrace({ steps: {} } as never, { visits: [visit] } as never, { ...withdrawn, gate_answer: "Ship" });
    expect(answered).toMatchObject({ notRun: null, failReason: "The question was withdrawn." });
    const [noted] = runTrace({ steps: {} } as never, { visits: [{ ...visit, status: "noted", decided: { outcome: "failure", words: "Not landed" } }] } as never, withdrawn);
    expect(noted.notRun).toBe("the decision was withdrawn");
    // One that printed output ran: it refused, it did not skip.
    const ran = { ...withdrawn, node_statuses: [{ node_id: "ship", status: "failed", result_preview: "line: codecast/line-ct-59561 is behind origin/main; rebase it first" }] } as TraceRun;
    expect(runTrace({ steps: {} } as never, { visits: [visit] } as never, ran)[0].notRun).toBeNull();
  });
});

describe("readers", () => {
  test("textHead: the first lines, and how many are left", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const h = textHead(text, 10);
    expect(h.head.split("\n")).toHaveLength(10);
    expect(h.more).toBe(20);
    expect(textHead("short").more).toBe(0);
  });
  test("lastWord: the newest assistant text, tags stripped, and the tool calls", () => {
    const w = lastWord([
      { role: "user", content: "go" },
      { role: "assistant", content: "Looking.", tool_calls: [1, 2] },
      { role: "assistant", content: "Found it.<system-reminder>x</system-reminder>", timestamp: 5 },
      { role: "assistant", content: "", tool_calls: [3] },
    ]);
    expect(w).toEqual({ text: "Found it.", at: 5, tools: 3 });
    expect(lastWord([]).text).toBeNull();
  });
  test("lastWord: a leading addressee tag a station wrote for the line is no word of its (ct-58694's Prove)", () => {
    expect(lastWord([{ role: "assistant", content: "[the gate] Done: the line's recorded runs show it." }]).text).toBe("Done: the line's recorded runs show it.");
    expect(lastWord([{ role: "assistant", content: "[x] still a checkbox" }]).text).toBe("[x] still a checkbox");
  });
});

test("a script's JSON cut off by the record's cap still fills the fields its head holds", () => {
  const cut = `{"task":"ct-1","attempt_id":"at-9","findings":"sg-1 sev 5 ${"x".repeat(900)}`.slice(0, 800);
  const vars = runVars({ id: "r1", visits: [], caseId: "t1", caseRef: "ct-1", caseTitle: "T" }, { node_statuses: [{ node_id: "bind", status: "completed", result_preview: cut }] } as never);
  expect(varValue("bind.json.attempt_id", vars)).toBe("at-9");
  expect(varValue("bind.json.findings", vars)).toBeNull();
});

test("a script's JSON output reads one field a line, whole or cut off", () => {
  expect(readableOutput('{"task":"ct-1","note":"a\\nb"}')).toBe('{\n  "task": "ct-1",\n  "note": "a\n  b"\n}');
  expect(readableOutput('{"task":"ct-1","note":"a\\nb')).toBe('{"task":"ct-1",\n"note":"a\nb');
  expect(readableOutput("ok Completed ct-1")).toBe("ok Completed ct-1");
});

describe("expandCommand", () => {
  const vals: Record<string, string> = { "dissolve.json.note": "1 fits, 11 left behind", task_id: "ct-57487" };
  const resolve = (n: string) => vals[n] ?? null;
  const said = (parts: ReturnType<typeof expandCommand>) => parts.map((p) => p.text).join("");
  test("fills the run's values and the shell's own assignments", () => {
    const cmd = 'note="$dissolve.json.note"; cast task done $task_id -m "Dissolved before investigation.${note:+ $note}"';
    expect(said(expandCommand(cmd, resolve))).toBe('note="1 fits, 11 left behind"; cast task done ct-57487 -m "Dissolved before investigation. 1 fits, 11 left behind"');
  });
  test("an empty conditional drops, a default stands in, a script's own variable stays", () => {
    expect(said(expandCommand('x=""; echo "a${x:+ $x}" ${y:-none} $HOME', resolve))).toBe('x=""; echo "a" none $HOME');
  });
  test("a step value the run did not keep is marked unset", () => {
    expect(expandCommand("echo $build.json.sha", resolve).find((p) => p.unset)?.name).toBe("build.json.sha");
  });
});

describe("a step's nuts and bolts", () => {
  test("an agent's tool calls read in order, each with what it acted on and how it came back", () => {
    const log = toolLog([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "Bash", input: JSON.stringify({ command: "cast task show ct-1\necho" }) }, { id: "b", name: "Read", input: { file_path: "/x/a.ts" } }], timestamp: 5 },
      { role: "user", tool_results: [{ tool_use_id: "a" }, { tool_use_id: "b", is_error: true }] },
      { role: "assistant", content: "", tool_calls: [{ id: "c", name: "Grep", input: { pattern: "foo" } }] },
    ]);
    expect(log.map((r) => [r.tool, r.target, r.status])).toEqual([["Bash", "cast task show ct-1", "ok"], ["Read", "/x/a.ts", "error"], ["Grep", "foo", "open"]]);
  });

});
