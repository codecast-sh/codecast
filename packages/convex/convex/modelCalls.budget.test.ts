import { afterEach, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { runModelCall, withinBudget } from "./modelCalls";
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

// The reserve contends for the same row; nothing is spent before it lands, so a conflict asks again.
test("a reserve refused by write conflicts asks again, and other errors still throw", async () => {
  let tries = 0;
  const conflicted = {
    runMutation: async (fn: any) => {
      if (getFunctionName(fn) === "modelCalls:reserve" && ++tries < 3) throw new Error('Documents read from or written to the "team_budgets" table changed while this mutation was being run and on every subsequent retry.');
      return true;
    },
    scheduler: { runAfter: async () => {} },
  };
  expect(await withinBudget(conflicted, { workspace: "team:t" }, "grouping", 0.01, async () => "ok")).toEqual({ room: true, value: "ok" });
  expect(tries).toBe(3);
  const broken = { runMutation: async () => { throw new Error("Unauthorized"); }, scheduler: { runAfter: async () => {} } };
  await expect(withinBudget(broken, { workspace: "team:t" }, "grouping", 0.01, async () => "ok")).rejects.toThrow("Unauthorized");
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

// A workspace with no budget: the call is codecast's own (a goal judge, close
// advice). The same gate and the same answer, nothing reserved or recorded.
const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

test("an unbudgeted call asks the same gate, for the workspace and the content, and touches no budget", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "VERDICT: close" }], usage: { input_tokens: 10, output_tokens: 2 }, stop_reason: "end_turn" }), { status: 200 })) as any;
  const gates: any[] = [];
  const mutations: string[] = [];
  const ctx = {
    runQuery: async (_fn: any, args: any) => (gates.push(args), null),
    runMutation: async (fn: any) => (mutations.push(getFunctionName(fn)), true),
    scheduler: { runAfter: async () => {} },
  };
  const spec = { model: "claude-haiku-5-5", prompt: "p", max_tokens: 10, output: "text" as const };
  const r = await runModelCall(ctx, { workspace: "user:u" }, "judge", spec, "Test", 5_000, { budgeted: false, content: { conversationId: "c1", apiToken: "tok" } });
  expect(r).toMatchObject({ ok: true, text: "VERDICT: close" });
  expect(mutations).toEqual([]);
  // Two asks of the one gate scope: runModelCall's own, before anything is sent, and the send's.
  expect(gates.map((g) => [g.workspace, g.conversation_id, g.api_token])).toEqual([["user:u", "c1", "tok"], ["user:u", "c1", "tok"]]);
});
