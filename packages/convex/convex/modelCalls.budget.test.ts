import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { withinBudget } from "./modelCalls";
import { HOLD_OUTLIVES_ANY_CALL_MS, takeBudget } from "./lib/teamBudget";

// A settle the budget row refuses (write conflicts under a burst of judging)
// must still land: a hold left behind fills the cap for the rest of the month.
test("a settle that fails goes to the scheduler with the same hold and cost", async () => {
  const scheduled: any[] = [];
  const ctx = {
    runMutation: async (fn: any) => {
      if (getFunctionName(fn) === "modelCalls:settle") throw new Error('Documents read from or written to the "team_budgets" table changed');
      return true;
    },
    scheduler: { runAfter: async (ms: number, fn: any, args: any) => void scheduled.push({ ms, fn: getFunctionName(fn), args }) },
  };
  const r = await withinBudget(ctx, { workspace: "team:t" }, "judge", 0.18, async (charge) => (charge(0.02), "ok"));
  expect(r).toEqual({ room: true, value: "ok" });
  expect(scheduled).toEqual([{ ms: 0, fn: "modelCalls:settle", args: { workspace: "team:t", purpose: "judge", held: 0.18, cost: 0.02, project_ids: [] } }]);
});

// One budget row in a fake db: enough for takeBudget's read and patches.
function budgetDb(row: Record<string, any>) {
  const db = {
    row: { _id: "b1", workspace: "team:t", cap_usd: 400, month: "2026-10", by_purpose: { judge: 0, grouping: 0, call: 0 }, refused: 0, history: [], updated_at: 0, ...row },
    query: () => ({ withIndex: () => ({ first: async () => db.row }) }),
    patch: async (_id: string, p: Record<string, any>) => void Object.assign(db.row, p),
  };
  return db;
}
const OCT = Date.UTC(2026, 9, 16, 2);

test("a full cap with no hold granted for longer than any call runs releases the leftovers and grants again", async () => {
  const db = budgetDb({ spent_usd: 334.89, held_usd: 64.95, last_granted_at: OCT - HOLD_OUTLIVES_ANY_CALL_MS - 1 });
  expect(await takeBudget({ db }, "team:t", undefined, 0.18, OCT)).toBe(true);
  expect(db.row.held_usd).toBe(0.18);
});

test("holds granted within that window are calls still in flight and keep the cap full", async () => {
  const db = budgetDb({ spent_usd: 334.89, held_usd: 64.95, last_granted_at: OCT - 60_000 });
  expect(await takeBudget({ db }, "team:t", undefined, 0.18, OCT)).toBe(false);
  expect(db.row.held_usd).toBe(64.95);
  expect(db.row.refused).toBe(1);
});

test("a row never stamped starts the clock at its first refusal", async () => {
  const db = budgetDb({ spent_usd: 334.89, held_usd: 64.95 });
  expect(await takeBudget({ db }, "team:t", undefined, 0.18, OCT)).toBe(false);
  expect(db.row.last_granted_at).toBe(OCT);
  expect(await takeBudget({ db }, "team:t", undefined, 0.18, OCT + HOLD_OUTLIVES_ANY_CALL_MS + 1)).toBe(true);
});

test("spend alone filling the cap still refuses", async () => {
  const db = budgetDb({ spent_usd: 399.9, held_usd: 0, last_granted_at: 0 });
  expect(await takeBudget({ db }, "team:t", undefined, 0.18, OCT)).toBe(false);
});
