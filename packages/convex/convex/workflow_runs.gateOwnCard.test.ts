// Two runs one session started ask the same question at their gates (the change flow's "This change edits CI: merge
// it?"): each run gets its own card. The rail's re-ask merge (a session retrying the same question) once took the
// first run's open card for the second, so the answer reached one run and the other paused on a card it no longer held.
import { expect, test } from "bun:test";
import { pauseAtGateCore } from "./workflow_runs";
import { HOST, RUN, TASK, NOW, choices, seed } from "./workflow_runs.gate.testkit";

const OTHER_RUN = "workflow_runs_other";
const OTHER_TASK = "tasks_t2";

test("two runs from one session asking the same gate question each get their own card", async () => {
  const { ctx, tables } = await seed();
  tables.tasks.push({ ...tables.tasks[0], _id: OTHER_TASK, short_id: "ct-8", title: "The other change", workflow_run_id: OTHER_RUN });
  tables.workflow_runs.push({ ...tables.workflow_runs[0], _id: OTHER_RUN, task_id: OTHER_TASK, created_at: NOW + 1 });
  const ask = (run_id: string, doc_md: string) => pauseAtGateCore(ctx, { userId: HOST }, { run_id: run_id as any, node_id: "decide__decide", prompt: "This change edits CI: merge it?", choices, doc_md });

  const first = await ask(RUN, "# The first change");
  const second = await ask(OTHER_RUN, "# The other change");
  expect(first.ok && second.ok).toBe(true);
  expect(tables.session_decisions).toHaveLength(2);
  const [a, b] = tables.session_decisions;
  expect([a.workflow_run_id, a.task_id]).toEqual([RUN, TASK]);
  expect([b.workflow_run_id, b.task_id]).toEqual([OTHER_RUN, OTHER_TASK]);
  expect(tables.workflow_runs.find((r) => r._id === RUN).gate_decision_id).toBe(a._id);
  expect(tables.workflow_runs.find((r) => r._id === OTHER_RUN).gate_decision_id).toBe(b._id);
});

test("the same run asking its gate again still updates its open card rather than stacking another", async () => {
  const { ctx, tables } = await seed();
  const ask = () => pauseAtGateCore(ctx, { userId: HOST }, { run_id: RUN as any, node_id: "decide__decide", prompt: "This change edits CI: merge it?", choices });
  await ask();
  tables.workflow_runs[0].status = "running";
  await ask();
  expect(tables.session_decisions.filter((d) => d.status === "pending")).toHaveLength(1);
});
