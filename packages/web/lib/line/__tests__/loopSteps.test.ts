import { describe, expect, test } from "bun:test";
import { buildLoopSteps, heldCommentWords, productStepId, sourceLabel, type LoopJudgeRunRow, type LoopRows, type LoopSignal } from "../loopSteps";
import { lineLabelKey } from "../lineLabels";

const NOW = 1_790_000_000_000;
const H = 3_600_000;
const D = 24 * H;

let n = 0;
const sig = (over: Partial<LoopSignal>): LoopSignal => ({
  _id: `sg${++n}`, short_id: `sg-${n}`, source: "agentwatch", kind: "prompt_miss", title: "Asked twice for a time already given",
  observed_at: NOW - H, created_at: NOW - H, task_id: "t1", attach: "fingerprint", ...over,
});

const problems = [
  { _id: "t1", short_id: "ct-1", title: "Re-asks a known time", status: "open", created_at: NOW - 5 * D, cause: {} },
  { _id: "t2", short_id: "ct-2", title: "Wrong match sent", status: "open", created_at: NOW - D, cause: {} },
];

/** Union today: AgentWatch sends findings from its comms and match judges; invariants are declared and quiet. */
function findingsRows(): LoopRows {
  return {
    now: NOW,
    product: "Union",
    finders: [
      { id: "clusters", source: "agentwatch", kind: ["prompt_miss"], fingerprint: "union:cluster:<id>" },
      { id: "invariants", source: "union.invariant", kind: ["regression"], fingerprint: "union:invariant:<id>" },
    ],
    expectations: { version: 12, items: [{ id: "ex-aq-3", text: "Never ask twice", status: "active" }, { id: "ex-aq-4", text: "old", status: "retired" }] },
    problems,
    signals: [
      sig({ _id: "a1", judge: "comms", judge_version: "v7", severity: 8, subject: "ex-aq-3", detail_md: "Asked twice\n> what time works?", evidence_url: "https://u/1" }),
      sig({ _id: "a2", judge: "comms", judge_version: "v7", severity: 5, subject: "ex-aq-3", created_at: NOW - 2 * H }),
      sig({ _id: "a3", judge: "comms", judge_version: "v6", created_at: NOW - 3 * D, attach: "new" }),
      sig({ _id: "m1", judge: "match", judge_version: "v2", task_id: "t2", attach: "new", subject: "match", created_at: NOW - 4 * H }),
      sig({ _id: "p1", source: "person", judge: undefined, task_id: "t2", attach: "judge", created_at: NOW - 30 * H }),
    ],
    labels: [
      { run_id: "a1", node_id: productStepId("agentwatch", "comms"), verdict: "wrong", note: "the client asked again", by: "u1", at: NOW },
      { run_id: "a2", node_id: productStepId("agentwatch", "comms"), verdict: "right", by: "u2", at: NOW },
      { run_id: "m1", node_id: "group", verdict: "wrong", by: "u1", at: NOW },
    ],
    viewerId: "u1",
    names: new Map([["u1", "Ashot"]]),
  };
}

const run = (over: Partial<LoopJudgeRunRow>): LoopJudgeRunRow => ({
  _id: `jr${++n}`, judge: "comms", judge_version: "0123456789abcdef0123", moment_short_id: "mo-1", mode: "live", status: "ok", findings: 0, cost_usd: 0.001, at: NOW - H, ...over,
});

/** Codecast judging: one extractor, one live judge, its runs, and the finding it filed. */
function momentsRows(): LoopRows {
  const filed = sig({ _id: "j1", source: "judge:comms", judge: "comms", judge_version: "0123456789ab", subject: "ex-aq-3", detail_md: "Asked for a time again.\n> what time?", moment: "mo-1", attach: "similar" });
  return {
    now: NOW,
    problems,
    expectations: { version: 3, items: [{ id: "ex-aq-3", text: "Never ask twice", status: "active" }] },
    extractors: [
      { kind: "conversation", path: ".codecast/moments/conversation.ts", version: "aaaaaaaaaaaaaaaa", published_at: NOW - 9 * D },
      { kind: "conversation", path: ".codecast/moments/conversation.ts", version: "bbbbbbbbbbbbbbbb", published_at: NOW - D },
    ],
    moments: [
      { _id: "mo1", short_id: "mo-1", kind: "conversation", status: "ready", blocks: 6, extractor_version: "bbbbbbb", extracted_at: NOW - H, created_at: NOW - 2 * H },
      { _id: "mo2", short_id: "mo-2", kind: "conversation", status: "failed", error: "timed out", created_at: NOW - 2 * H },
      { _id: "mo3", short_id: "mo-3", kind: "conversation", status: "waiting", created_at: NOW - 2 * H },
    ],
    judges: [{ _id: "jg1", name: "comms", version: "0123456789abcdef0123", path: ".codecast/judges/comms.md", moment_kind: "conversation", model: "claude-haiku-5-5", mode: "live", published_at: NOW - D }],
    judgeRuns: [
      run({ _id: "r1", findings: 1, findings_json: JSON.stringify([{ expectation: "ex-aq-3", severity: 7, what_happened: "Asked for a time again.", quote: "what time?", markers: [] }]), signal_ids: ["j1"] }),
      run({ _id: "r2", moment_short_id: "mo-4", at: NOW - 2 * H }),
      run({ _id: "r3", status: "failed", reason: "the answer was not JSON", at: NOW - 3 * H }),
    ],
    signals: [filed],
    labels: [{ run_id: "r1", node_id: "judge:comms", verdict: "wrong", by: "u1", at: NOW }],
  };
}

describe("bring findings: the product's own judges are steps", () => {
  const loop = buildLoopSteps(findingsRows());

  test("one step per judge the findings name, plus declared sources that sent nothing", () => {
    expect(loop.mode).toBe("findings");
    expect(loop.order).toEqual(["expectations", "product:agentwatch/comms", "product:agentwatch/match", "product:union.invariant", "product:person", "group", "line"]);
    const comms = loop.steps["product:agentwatch/comms"];
    expect(comms).toMatchObject({ kind: "product", where: "product", label: "Comms judge", stage: "judge", stages: ["observe", "judge"], version: "v7", source: "agentwatch" });
    expect(loop.steps["product:person"]).toMatchObject({ kind: "person", where: "codecast", label: "People" });
  });

  test("health: found in the last day, marked wrong, and a declared source's silence", () => {
    const comms = loop.steps["product:agentwatch/comms"].health;
    expect(comms).toMatchObject({ tone: "ok", day: 2, week: 3, right: 1, wrong: 1, words: "2 found in the last day, 1 marked wrong" });
    expect(comms.spark.reduce((a, b) => a + b, 0)).toBe(3);
    expect(loop.steps["product:union.invariant"].health).toMatchObject({ tone: "quiet", words: "nothing sent yet" });
    expect(loop.steps["product:person"].health.tone).toBe("quiet");
  });

  // A product's finding can name its customers, so its card says which problem and how bad, and links back (findingShownTitle).
  test("a finding is the judge's decision, and its label lands by the label store's key", () => {
    const d = loop.steps["product:agentwatch/comms"].decisions[0];
    expect(d).toMatchObject({ id: "a1:product:agentwatch/comms", subject: { kind: "signal", id: "a1" }, decided: "A finding on ct-1, severity 8; details in AgentWatch", evidenceUrl: "https://u/1", problemIds: ["t1"] });
    expect(d.findings[0]).toMatchObject({ expectation: "ex-aq-3", severity: 8, quote: "what time works?", problemId: "t1" });
    expect(d.label).toMatchObject({ verdict: "wrong", note: "the client asked again", byName: "Ashot", mine: true });
    expect(lineLabelKey(d.subject.id, d.stepId, "u1")).toBe(`${d.id}:u1`);
  });

  test("grouping decisions say how each finding joined its problem", () => {
    const g = loop.steps.group;
    expect(g.decisions.map((d) => d.decided)).toEqual(["Joined ct-1 by its key", "Joined ct-1 by its key", "Opened ct-2, a new problem", "Joined ct-2: a reviewer read it as the same problem", "Opened ct-1, a new problem"]);
    expect(g.health.words).toBe("3 findings in the last day, 1 new problem, 1 marked wrong");
  });

  test("the day's new problems say how many closed in the same day", () => {
    const rows = findingsRows();
    const closed = { ...rows, problems: rows.problems!.map((p) => ({ ...p, status: "dropped" })) };
    expect(buildLoopSteps(closed).steps.group.health.words).toBe("3 findings in the last day, 1 new problem, all closed in the same day, 1 marked wrong");
  });

  test("edges: expectations reach only judges that cite them; every judge hands to problems; problems to the line", () => {
    const ids = loop.edges.map((e) => e.id);
    expect(ids).toContain("expectations->product:agentwatch/comms");
    expect(ids).not.toContain("expectations->product:agentwatch/match");
    expect(loop.edges.find((e) => e.id === "product:agentwatch/comms->group")!.count).toBe(3);
    expect(loop.edges.find((e) => e.id === "group->line")).toMatchObject({ words: "new problems", count: 2 });
    expect(loop.steps.expectations.health.words).toBe("1 written · 1 broken this week");
    expect(loop.steps.line.health.words).toBe("2 problems open");
  });

  test("a source whose findings name no judge is one step named for the source", () => {
    const loop2 = buildLoopSteps({ now: NOW, signals: [sig({ source: "union.invariant" })] });
    expect(loop2.steps["product:union.invariant"].label).toBe("Union invariant");
  });
});

describe("bring moments: codecast's extractors and judges are steps", () => {
  const loop = buildLoopSteps(momentsRows());

  test("observe and judge steps, with their kind, where they run, and their version", () => {
    expect(loop.mode).toBe("moments");
    expect(loop.order).toEqual(["expectations", "observe:conversation", "judge:comms", "group", "line"]);
    expect(loop.steps["observe:conversation"]).toMatchObject({ kind: "script", where: "product", version: "bbbbbbb", file: ".codecast/moments/conversation.ts" });
    expect(loop.steps["judge:comms"]).toMatchObject({ kind: "call", where: "codecast", mode: "live", version: "0123456", file: ".codecast/judges/comms.md", source: "judge:comms" });
    expect(loop.steps["observe:conversation"].decisions.map((d) => d.decided)).toEqual(["Extracted 6 blocks", "Could not extract: timed out"]);
  });

  test("a judge run is the judge's decision, with the problem its finding reached", () => {
    const j = loop.steps["judge:comms"];
    expect(j.decisions.map((d) => d.decided)).toEqual(["Found 1 break of ex-aq-3", "Nothing broke an expectation", "Failed: the answer was not JSON"]);
    const d = j.decisions[0];
    expect(d).toMatchObject({ id: "r1:judge:comms", subject: { kind: "judge_run", id: "r1", ref: "mo-1" }, problemIds: ["t1"], moment: "mo-1" });
    expect(d.findings[0]).toMatchObject({ expectation: "ex-aq-3", severity: 7, signalId: "j1", problemId: "t1" });
    expect(j.health).toMatchObject({ tone: "ok", day: 3, failed: 1, wrong: 1, words: "3 judged in the last day, 1 finding, 1 failed, 1 marked wrong" });
    expect(j.health.costUsd).toBeCloseTo(0.003);
  });

  test("a codecast judge's filed finding is not mistaken for a product judge", () => {
    expect(Object.keys(loop.steps).some((id) => id.startsWith("product:"))).toBe(false);
    expect(loop.steps.group.decisions[0].decided).toBe("Joined ct-1: it said what that problem's findings said");
    expect(loop.edges.map((e) => e.id)).toEqual(["observe:conversation->judge:comms", "expectations->judge:comms", "judge:comms->group", "group->line"]);
  });

  test("a judge held at $0, a shadow judge, and a removed one say so", () => {
    const rows = momentsRows();
    rows.judgeRuns = [run({ status: "skipped", reason: "no model budget this month" })];
    expect(buildLoopSteps(rows).steps["judge:comms"].health).toMatchObject({ tone: "off", words: "waiting on a model budget" });

    rows.judges = [{ ...rows.judges![0], mode: "shadow" }];
    rows.judgeRuns = [run({ mode: "shadow", findings: 1 })];
    const shadow = buildLoopSteps(rows);
    expect(shadow.steps["judge:comms"].purpose).toContain("filing nothing while in shadow");
    expect(shadow.edges.find((e) => e.id === "judge:comms->group")).toMatchObject({ words: "files nothing in shadow", count: 0 });

    rows.judges = [{ ...rows.judges![0], removed_at: NOW - H }];
    expect(buildLoopSteps(rows).steps["judge:comms"].health).toMatchObject({ tone: "off", words: "removed from the repo" });
  });

  test("both modes at once, as a product moves one judge to moments (LL5 phase 2)", () => {
    const rows = momentsRows();
    rows.signals = [...rows.signals, ...findingsRows().signals];
    const loop2 = buildLoopSteps(rows);
    expect(loop2.mode).toBe("both");
    expect(loop2.stages.find((s) => s.key === "judge")!.steps.slice(0, 2)).toEqual(["judge:comms", "product:agentwatch/comms"]);
  });

  test("a project with nothing yet still draws expectations, problems and the line", () => {
    const empty = buildLoopSteps({ now: NOW, signals: [] });
    expect(empty.mode).toBe("none");
    expect(empty.order).toEqual(["expectations", "group", "line"]);
    expect(empty.steps.expectations.health.words).toBe("none written yet");
  });
});

test("source labels read as words", () => {
  expect(sourceLabel("sdk:union-errors")).toBe("Union errors");
  expect(sourceLabel("union.reply")).toBe("Union reply");
});

describe("heldCommentWords (a problem that quotes customers)", () => {
  const run = (title: string, comment_type: string) => ({ text: "Dissolve: the last finding (Pat's thread from pat@example) stays open.", comment_type, session_info: { title } });
  test("a line step's report shows its plain outcome", () => {
    expect(heldCommentWords(run("Dissolve · ct-100", "progress"))).toBe("Dissolve reported what it found.");
    expect(heldCommentWords(run("Investigate · ct-100", "blocker"))).toBe("Investigate stopped and needs a person to decide.");
    expect(heldCommentWords(run("Investigate · ct-100", "review"))).toBe("Investigate asked a person to review what it found.");
  });
  test("the engine's stop note keeps its first paragraph and holds the quoted report", () => {
    const held = heldCommentWords({ text: "Workflow failed (no outgoing edge from investigate (outcome failure, review_verdict none)); task returned to open.\n\n```text\nPat's call with Sam\n```\n\nInvestigate session: jx7abc", comment_type: "blocker" });
    expect(held).toBe("Investigate failed, and the line had no next step for it. The problem is open again.");
  });
  test("people's comments, other sessions and the grounding note show as written", () => {
    expect(heldCommentWords({ text: "Looks right to me.\n\nShip it.", comment_type: "note" })).toBeNull();
    expect(heldCommentWords({ text: "Grounded: goal pr-1, code, risk plan, ready. One contact got mail from two personas.", comment_type: "note" })).toBeNull();
    expect(heldCommentWords({ text: "Done.", comment_type: "progress", session_info: { title: "Fix the sender" } })).toBeNull();
  });
});
