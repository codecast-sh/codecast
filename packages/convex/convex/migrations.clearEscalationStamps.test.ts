import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { clearEscalationStamps } from "./migrations";

// A dry run reports one page and stops; only a real run walks the table.

function world() {
  const db = makeFakeDb({
    conversations: Array.from({ length: 5 }, (_, i) => ({ _id: `c${i}`, _creationTime: i + 1, user_id: "u1", escalated_by_role: i % 2 ? "or-1" : undefined })),
  });
  const scheduled: any[] = [];
  return { db, scheduled, ctx: { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => void scheduled.push(args) } } as any };
}

describe("migrations.clearEscalationStamps", () => {
  test("a dry run schedules nothing and writes nothing", async () => {
    const w = world();
    const r = await (clearEscalationStamps as any)._handler(w.ctx, { numItems: 2 });
    expect(r).toMatchObject({ dryRun: true, scanned: 2, done: false });
    expect(w.scheduled).toEqual([]);
    expect(w.db._tables.conversations.filter((c: any) => c.escalated_by_role !== undefined)).toHaveLength(2);
  });

  test("a real run continues from its cursor until every stamp is cleared", async () => {
    const w = world();
    await (clearEscalationStamps as any)._handler(w.ctx, { dryRun: false, numItems: 2 });
    while (w.scheduled.length) await (clearEscalationStamps as any)._handler(w.ctx, w.scheduled.shift());
    expect(w.db._tables.conversations.filter((c: any) => c.escalated_by_role !== undefined)).toHaveLength(0);
  });
});
