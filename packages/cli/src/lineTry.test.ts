import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTemplateEdit, decisionFromRun, lineHunks, refusedCalls, runLineTry, type LineTryReport } from "./lineTry";
import { buildNodePrompt } from "./workflow/runner";
import { parseWorkflowSource } from "./workflow/parser";
import { applyUnattended } from "./unattended";

/** The brief a session station gets for `template`, rendered the way the runner renders it. */
function render(template: string, context: Record<string, string>, goal = "Cluster 12 fails to book") {
  const graph = parseWorkflowSource(`digraph g { graph [goal="${goal}"] start [shape=Mdiamond] exit [shape=Msquare] investigate [label="Investigate", backend=session, prompt="x"] start -> investigate -> exit }`);
  const node = graph.nodes.get("investigate")!;
  node.prompt = template;
  return applyUnattended(buildNodePrompt(node, graph, context));
}

const CONTEXT = {
  "bind.output": "{}",
  "bind.json": JSON.stringify({ cluster_id: "c-812", finding_count: 4, cluster_title: "Bookings stall at confirm" }),
  "shared.json": JSON.stringify({ report: "Pin your answer with cast state.\nOne line, then the json.", ladder: "1. read\n2. reason" }),
};

const OLD = [
  "You find the mechanism behind one cluster.",
  "",
  "- Cluster: $bind.json.cluster_id ($bind.json.finding_count findings)",
  "",
  "$bind.json.cluster_title",
  "",
  "## How to report",
  "",
  "$shared.json.report",
  "",
  "## Ladder",
  "",
  "$shared.json.ladder",
  "",
  "Say what you found in one line.",
].join("\n");

describe("applyTemplateEdit", () => {
  const cases: Array<[string, string]> = [
    ["a changed literal line", OLD.replace("Say what you found in one line.", "Say what you found in two lines, the second naming the file.")],
    ["an inserted line", OLD.replace("## Ladder", "Never guess a mechanism you did not trace.\n\n## Ladder")],
    ["a deleted line", OLD.replace("You find the mechanism behind one cluster.\n\n", "")],
    ["a changed line holding a value", OLD.replace("- Cluster: $bind.json.cluster_id ($bind.json.finding_count findings)", "- The cluster: $bind.json.cluster_id, with $bind.json.finding_count findings")],
    ["a value moved to a new line", OLD.replace("Say what you found in one line.", "Say what you found in one line about $bind.json.cluster_id.")],
    ["two separate changes", OLD.replace("You find", "You trace").replace("## Ladder", "## The ladder")],
  ];
  for (const [what, NEW] of cases) {
    test(`${what}: the patched brief is the brief the new template renders`, () => {
      const r = applyTemplateEdit(OLD, NEW, render(OLD, CONTEXT));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.text).toBe(render(NEW, CONTEXT));
    });
  }

  test("the goal is known to a new line from the brief's own header", () => {
    const NEW = OLD.replace("Say what you found in one line.", "Say what you found about $goal.");
    const r = applyTemplateEdit(OLD, NEW, render(OLD, CONTEXT));
    expect(r.ok && r.text).toBe(render(NEW, CONTEXT));
  });

  test("a value the brief never showed refuses the case, naming it", () => {
    const NEW = OLD.replace("Say what you found in one line.", "Compare with $propose.json.strategy.");
    const r = applyTemplateEdit(OLD, NEW, render(OLD, CONTEXT));
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("$propose.json.strategy") });
  });

  test("an edit that reads the cause's earlier attempts takes them from the case when its brief predates them", () => {
    const NEW = OLD.replace("Say what you found in one line.", "Read what was tried:\n$cause_history");
    const history = "This problem has had 3 earlier attempts.\n- Attempt 1 (Oct 7): Closed without a change at Dissolve.";
    const r = applyTemplateEdit(OLD, NEW, render(OLD, CONTEXT), { cause_history: history });
    expect(r.ok && r.text).toBe(render(NEW, { ...CONTEXT, cause_history: history }));
    expect(applyTemplateEdit(OLD, NEW, render(OLD, CONTEXT)).ok).toBe(false);
  });

  test("a brief that no longer holds the changed text refuses the case", () => {
    const r = applyTemplateEdit(OLD, OLD.replace("Say what you found in one line.", "x"), "something else entirely\n");
    expect(r.ok).toBe(false);
  });

  test("no edit is the brief as it was", () => {
    const brief = render(OLD, CONTEXT);
    expect(applyTemplateEdit(OLD, OLD, brief)).toEqual({ ok: true, text: brief, hunks: 0 });
  });

  const REAL = "/Users/ashot/src/union-mobile/outreach/line/agentwatch/investigate.md";
  test.skipIf(!fs.existsSync(REAL))("AgentWatch's investigate prompt: an edit lands as the runner would render it", () => {
    const template = fs.readFileSync(REAL, "utf8");
    const lines = template.split("\n");
    const at = lines.findIndex((l, i) => i > 5 && l.trim() && !l.includes("$") && l.length > 30);
    expect(at).toBeGreaterThan(0);
    const edited = [...lines.slice(0, at), "Before anything else, read the cluster's newest finding in full.", ...lines.slice(at + 1)].join("\n");
    const ctx = { ...CONTEXT, "shared.json": JSON.stringify(Object.fromEntries(["dissolution", "gone", "report", "ladder", "lifecycle", "workspace", "rulings", "evidence", "mechanism"].map((k) => [k, `the ${k} section\nof shared text`]))) };
    const r = applyTemplateEdit(template, edited, render(template, ctx));
    expect(r.ok && r.text).toBe(render(edited, ctx));
  });
});

describe("lineHunks", () => {
  test("ranges of the old text and what replaces them", () => {
    expect(lineHunks(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([{ start: 1, end: 2, added: ["x"] }, { start: 3, end: 3, added: ["d"] }]);
  });
});

describe("what a dry run decided", () => {
  const pin = `cast state --status done - <<'EOF'\nThe mechanism is a stale lock in the booking queue.\n\n\`\`\`json\n{ "cause": "stale-lock", "confidence": "high" }\n\`\`\`\nEOF`;
  const stream = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the cluster." }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cast task show ct-1" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: pin } }] } }),
    JSON.stringify({ type: "result", result: "Pinned." }),
  ].join("\n");

  test("the station's pin, refused by the guard, is read from the stream", () => {
    expect(decisionFromRun(stream, ["Reading the cluster.", "Pinned."])).toEqual({
      status: "done", words: "The mechanism is a stale lock in the booking queue.", result: { cause: "stale-lock", confidence: "high" },
    });
  });

  test("without a pin, the last message with a json block", () => {
    expect(decisionFromRun("", ["first", "Dissolved.\n```json\n{\"dissolved\": true}\n```"])).toEqual({ status: null, words: "Dissolved.", result: { dissolved: true } });
    expect(decisionFromRun("", ["nothing"])).toBeNull();
  });

  test("a pin piped in through printf is read from its arguments", () => {
    const cmd = `printf '%s\\n' "The window is never checked at dial." "" '\`\`\`json' '{"outcome":"mechanism","statement":"The contact'"'"'s window"}' '\`\`\`' | cast state --status done -`;
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } });
    expect(decisionFromRun(line, [])).toEqual({ status: "done", words: "The window is never checked at dial.", result: { outcome: "mechanism", statement: "The contact's window" } });
  });

  test("a pin passed as a quoted argument, after a refused heredoc, is read from the argument", () => {
    const tries = [
      "cast state --status done - <<'EOF'\nFirst try.\n\n```json\n{\"outcome\":\"dissolved\"}\n```\nEOF",
      'cast state --status done "Found it.\n\n\\`\\`\\`json\n{\\"outcome\\":\\"mechanism\\",\\"note\\":\\"the pool\'s gate\\"}\n\\`\\`\\`"',
    ];
    const stream = tries.map((command) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } })).join("\n");
    expect(decisionFromRun(stream, [])).toEqual({ status: "done", words: "Found it.", result: { outcome: "mechanism", note: "the pool's gate" } });
  });

  test("refused writes come from the guard's log", () => {
    expect(refusedCalls("task show ct-1\nLIVE task show ct-1\nstate --status done -\nREFUSED state --status done -\n")).toEqual(["state --status done -"]);
  });
});

describe("runLineTry", () => {
  const OLDT = "Investigate $bind.json.cluster_id.\n\nAnswer in one line.";
  const NEWT = "Investigate $bind.json.cluster_id.\n\nAnswer in two lines.";
  const brief = render(OLDT, CONTEXT);

  test("each case runs on its patched brief, read-only in the checkout, and reports what it decided", async () => {
    const reports: Array<[string, LineTryReport]> = [];
    const prompts: string[] = [];
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "line-try-"));
    const tally = await runLineTry({
      try_id: "t1", root: "/repo", file: "g.cast", node: "investigate", model: "opus", old_template: OLDT, new_template: NEWT,
      cases: [{ row_id: "r1", run_id: "run1", received: brief }, { row_id: "r2", run_id: "run2", received: null }],
    }, {
      report: async (id, r) => { reports.push([id, r]); },
      harness: async (argv) => {
        expect(argv).toContain("--read-only");
        expect(argv[argv.indexOf("--cwd") + 1]).toBe("/repo");
        const dir = argv[argv.indexOf("--run") + 1];
        prompts.push(fs.readFileSync(argv[argv.indexOf("--prompt") + 1], "utf8"));
        fs.writeFileSync(path.join(dir, "out.json"), JSON.stringify({ result: "ok", total_cost_usd: 0.42, num_turns: 3 }));
        fs.writeFileSync(path.join(dir, "said.json"), JSON.stringify(["Found it.\n```json\n{\"cause\":\"x\"}\n```"]));
        fs.writeFileSync(path.join(dir, "calls.log"), "REFUSED state --status done -\n");
        return 0;
      },
      fromCheckpoint: () => null,
      runDir: (t, r) => path.join(base, t, r),
      harnessScript: "/h.ts",
    });
    expect(tally).toEqual({ ran: 1, not_tryable: 1, failed: 0 });
    expect(prompts).toEqual([render(NEWT, CONTEXT)]);
    const done = reports.find(([id, r]) => id === "r1" && r.status === "done")![1];
    expect(done).toMatchObject({ via: "patch", cost_usd: 0.42, turns: 3, refused: ["state --status done -"], decision: { result: { cause: "x" } } });
    expect(reports.find(([id]) => id === "r2")![1]).toMatchObject({ status: "not_tryable", reason: expect.stringContaining("no checkpoint") });
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("a case whose brief cannot be patched renders from the run's checkpoint", async () => {
    const reports: Array<[string, LineTryReport]> = [];
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "line-try-"));
    await runLineTry({
      try_id: "t2", root: "/repo", file: "g.cast", node: "investigate", model: "opus", old_template: OLDT, new_template: NEWT,
      cases: [{ row_id: "r1", run_id: "run1", received: "an unrelated brief" }],
    }, {
      report: async (id, r) => { reports.push([id, r]); },
      harness: async () => 1,
      fromCheckpoint: async (runId) => (runId === "run1" ? "rendered from the checkpoint" : null),
      runDir: (t, r) => path.join(base, t, r),
      harnessScript: "/h.ts",
    });
    expect(reports.map(([, r]) => r.status)).toEqual(["running", "failed"]);
    expect(reports[0][1].via).toBe("checkpoint");
    fs.rmSync(base, { recursive: true, force: true });
  });
});
