// The line's chat (line-workspace.md LW1 Chat): the opening line and the
// questions offered, read from the real AgentWatch graph and Union's runs,
// and the thread as the chat draws it.
import { describe, expect, test } from "bun:test";
import { buildLineModel, type LineModelRows } from "../lineModel";
import type { MapRun } from "../lineMap";
import { answererWords, greetingWords, lineChatThread, suggestedQuestions, type LineChatItem } from "../lineChat";
import { agentwatchGraph } from "./agentwatchGraph.fixture";
import { union57382Run, union57467Run } from "./unionLineRuns.fixture";

const NOW = 1_791_500_000_000;
const aw = (run: typeof union57382Run, task: string): MapRun => ({ ...run, task_id: task, workflow_slug: "agentwatch", updated_at: run.updated_at ?? run.created_at } as unknown as MapRun);
const tasks = [
  { _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "open", created_at: 1 },
  { _id: "t2", short_id: "ct-57467", title: "A message leads with the result", status: "open", created_at: 1 },
];
const rows: LineModelRows = { runs: [aw(union57382Run, "t1"), aw(union57467Run, "t2")], tasks: tasks as LineModelRows["tasks"], graph: agentwatchGraph, now: NOW };
const model = buildLineModel(rows, "agentwatch");

describe("the opening", () => {
  test("says what the line is in its own numbers", () => {
    const words = greetingWords(model);
    expect(words).toMatch(/\d+ steps/);
    expect(words).toContain("2 runs so far");
    expect(words).toContain("Ask about any step");
  });
});

describe("suggested questions", () => {
  test("name real things from the record, at most three, never twice", () => {
    const qs = suggestedQuestions(model, null);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(3);
    expect(new Set(qs).size).toBe(qs.length);
  });

  test("with a step open, they are about that step", () => {
    const step = model.order.find((id) => model.steps[id].kind === "agent" && model.steps[id].prompt)!;
    const qs = suggestedQuestions(model, step);
    expect(qs.some((q) => q.includes(model.steps[step].label))).toBe(true);
  });
});

describe("the thread", () => {
  const row: LineChatItem = {
    _id: "p1",
    project_id: "p1",
    owner: { conversation_id: "c1", short_id: "jxlead1", name: "Agent Quality lead", via: "lead" },
    turns: [
      { client_id: "a", text: "Why did Dissolve close C119?", at: 10, graph: "agentwatch", conversation_id: "c1", delivered: true, reply: { text: "Because…", at: 20 } },
      { client_id: "b", text: "And Refine?", at: 30, graph: "agentwatch", conversation_id: "c1", delivered: true, reply: null },
    ],
  };

  test("asks with their replies, then words still travelling, each once", () => {
    const thread = lineChatThread(row, [{ client_id: "b", text: "And Refine?", at: 29 }, { client_id: "c", text: "Show me the runs", at: 40 }]);
    expect(thread.map((e) => [e.client_id, e.state])).toEqual([["a", "answered"], ["b", "waiting"], ["c", "sending"]]);
  });

  test("says who answers, and that a first message starts a session when nobody leads", () => {
    expect(answererWords(row.owner, true).name).toBe("Agent Quality lead");
    expect(answererWords(null, true).name).toBe("a new line session");
    expect(answererWords(undefined, false).why).toBe("");
  });
});
