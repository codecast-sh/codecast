import { expect, test } from "bun:test";
import { mineTasksFromInsights } from "./taskMining";
import { makeFakeDb } from "./testDb";

test("insight batches do not repeatedly scan the owner's entire task history", async () => {
  const tasks = Array.from({ length: 2_500 }, (_, i) => ({
    _id: `task-${i}`, user_id: "owner", status: "done", title: `Task ${i}`,
    description: "x".repeat(5_000), created_from_insight: `insight-${i}`,
  }));
  const db = makeFakeDb({ tasks, plans: [], conversations: [] });
  const query = db.query.bind(db);
  const fullScanBytes = tasks.reduce((total, row) => total + JSON.stringify(row).length, 0);
  let readBytes = 0;
  db.query = (table: string) => {
    const builder = query(table);
    let index = "";
    const withIndex = builder.withIndex.bind(builder);
    builder.withIndex = (name: string, fn: any) => { index = name; return withIndex(name, fn); };
    for (const method of ["collect", "first"] as const) {
      const read = builder[method].bind(builder);
      builder[method] = async () => {
        const result = await read();
        readBytes += table === "tasks" && index === "by_user_id" ? fullScanBytes : JSON.stringify(result).length;
        if (readBytes > 100 * 1024 * 1024) throw new Error("Convex read byte budget exceeded");
        return result;
      };
    }
    return builder;
  };
  const insights = tasks.slice(0, 25).map((task) => ({
    _id: task.created_from_insight, conversation_id: "conversation", generated_at: 1,
    summary: task.title, outcome_type: "shipped", themes: [],
  }));
  const result = await (mineTasksFromInsights as any)._handler({ db }, { user_id: "owner", insights });
  expect(result.tasks_created).toBe(0);
  expect(readBytes).toBeLessThan(fullScanBytes * 2);
  expect(db._inserted).toHaveLength(0);
});
