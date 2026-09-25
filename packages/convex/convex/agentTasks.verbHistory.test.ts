import { describe, expect, test } from "bun:test";
import { applyCancel, insertTask, logVerb } from "./agentTasks";
import { makeFakeDb } from "./testDb";

// A verb that moves a trigger's status leaves a history row naming who did it
// and from where, so a trigger never stops without the history saying why.

const ME = ("u".repeat(31) + "m") as any;
const ctx = (d: any) => ({ db: d }) as any;

describe("verb history", () => {
  test("a cancel writes one history row with the actor, the surface and the status before", async () => {
    const d = makeFakeDb({ agent_tasks: [], agent_task_revisions: [], counters: [], conversations: [] });
    const { id } = await insertTask(ctx(d), ME, { title: "Check the area", prompt: "p", schedule_type: "recurring", interval_ms: 86_400_000 });
    expect(await logVerb(ctx(d), await d.get(id), { userId: ME, source: "web" }, applyCancel)).toBe(true);
    const rows = await d.query("agent_task_revisions").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: ME, source: "web", changed_fields: ["status"], revision: 1 });
    expect(rows[0].before.status).toBe("scheduled");
    expect((await d.get(id)).status).toBe("completed");
  });

  test("a verb that changes nothing writes nothing", async () => {
    const d = makeFakeDb({ agent_tasks: [], agent_task_revisions: [], counters: [], conversations: [] });
    const { id } = await insertTask(ctx(d), ME, { title: "Done already", prompt: "p", schedule_type: "recurring", interval_ms: 86_400_000 });
    await applyCancel(ctx(d), await d.get(id));
    await logVerb(ctx(d), await d.get(id), { userId: ME, source: "cli" }, applyCancel);
    expect(await d.query("agent_task_revisions").collect()).toHaveLength(0);
  });
});
