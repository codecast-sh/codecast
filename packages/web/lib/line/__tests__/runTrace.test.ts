// A run's detail as a trace (lib/line/runTrace.ts), on the real AgentWatch
// graph and Union's real ct-57382 run: where the problem came from, each
// visit numbered with its session and output, and the small readers the
// step panel uses.
import { describe, expect, test } from "bun:test";
import { buildLineModel, type LineModelRows } from "../lineModel";
import type { MapRun } from "../lineMap";
import { lastWord, namedInputs, outcomeLabel, readableOutput, runSource, runTrace, runVars, textHead, tokenWords, traceTotals, usdWords, varValue, type TraceRun, type TraceSignal, expandCommand } from "../runTrace";
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

const sig = (over: Partial<TraceSignal>): TraceSignal => ({ _id: "s", source: "agentwatch", title: "A finding", observed_at: 10, created_at: 10, task_id: "t1", ...over });

describe("runSource", () => {
  test("leads with the newest finding at the run's start, its quote, judge and evidence, and counts every source by then", () => {
    const src = runSource([
      sig({ _id: "a", severity: 4, observed_at: 5, created_at: 5 }),
      sig({ _id: "late", severity: 10, observed_at: 90, created_at: 90 }),
      sig({ _id: "b", short_id: "sg-1", judge: "comms", title: "Rep re-rolled the persona", evidence_url: "https://x/1", detail_md: "**Contact met two personas** (severity 9/10)\n\n> From now I'll classify all your emails as spam\n" }),
      sig({ _id: "c", source: "sentry", severity: 2, observed_at: 8, created_at: 8 }),
      sig({ _id: "d", task_id: "other", severity: 10 }),
    ], "t1", 50);
    expect(src.count).toBe(3);
    expect(src.later).toBe(1);
    expect(src.sources).toEqual([{ source: "agentwatch", count: 2 }, { source: "sentry", count: 1 }]);
    expect(src.lead).toMatchObject({ id: "b", ref: "sg-1", judge: "comms", severity: 9, headline: "Contact met two personas", quote: "From now I'll classify all your emails as spam", evidenceUrl: "https://x/1" });
  });
  test("a problem with no findings, or no problem, has no lead", () => {
    expect(runSource([sig({})], null)).toEqual({ count: 0, later: 0, sources: [], findings: [], lead: null });
    expect(runSource([sig({ task_id: "x" })], "t1").lead).toBeNull();
  });
});

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
    if (last.status === "failed") expect(last.failReason).toBe(union57382Run.fail_reason!);
  });
  test("a script's command and output come from the graph and the run row", () => {
    const run2 = { node_statuses: [{ node_id: "x", status: "completed", result_preview: "printed\nmore" }] } as TraceRun;
    const model = { steps: { x: { prompt: { kind: "script", text: "bun check.ts $task_id" } } } } as never;
    const visit = { node: "x", label: "X", kind: "script", status: "done", inferred: false, durationMs: 1000, sessionId: null, decided: { outcome: null, words: "Done", toWords: null } };
    const [s] = runTrace(model, { visits: [visit] } as never, run2);
    expect(s).toMatchObject({ command: "bun check.ts $task_id", output: "printed\nmore", gist: "printed", session: null });
    expect(outcomeLabel(s)).toBe("ok");
  });
  test("a gate step carries the card it was asked on, its choices and answer", () => {
    const run2 = { node_statuses: [], gate_node_id: "decide", gate_decision_short_id: "sd-5", gate_choices: [{ key: "s", label: "Ship" }, { key: "d", label: "Drop" }], gate_answer: "Ship" } as TraceRun;
    const visit = { node: "decide", label: "Decide", kind: "person", status: "done", inferred: false, durationMs: 1, sessionId: null, decided: { outcome: "s", words: "Ship", toWords: "Ship" } };
    const [s] = runTrace({ steps: {} } as never, { visits: [visit] } as never, run2);
    expect(s.gate).toEqual({ ref: "sd-5", choices: ["Ship", "Drop"], answer: "Ship", note: null });
  });
  test("totals count kinds, tokens and cost", () => {
    const t = traceTotals([{ kind: "agent", tokens: 1200, costUsd: 0.5 }, { kind: "script", tokens: null, costUsd: 0.25 }, { kind: "person" }] as never);
    expect(t).toEqual({ agent: 1, script: 1, person: 1, tokens: 1200, costUsd: 0.75 });
  });
});

describe("readers", () => {
  test("namedInputs: each $name once, in order", () => {
    expect(namedInputs("bun x.ts $task_id --why $shared.json.rulings $task_id")).toEqual(["task_id", "shared.json.rulings"]);
    expect(namedInputs(null)).toEqual([]);
  });
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
  test("money and tokens in a glance", () => {
    expect(usdWords(0.413)).toBe("$0.41");
    expect(usdWords(0.004)).toBe("<$0.01");
    expect(tokenWords(812)).toBe("812");
    expect(tokenWords(12_345)).toBe("12k");
    expect(tokenWords(1_234)).toBe("1.2k");
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
