// The hosted assistant's wallet under convex-test (plan pl-840,
// docs/architecture/hosted-assistant.md "Verification"): reservations racing a
// nearly full wallet let exactly the ones that fit through, the true-up moves
// money once per turn, a new period resets usage and keeps the top-up, and the
// top-up pays only after the plan allowance is spent.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { addMonths, credit, ensureWallet, LEAK_GRACE_MS, periodAt, settleTurn, summaryAt } from "./lib/wallet";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./wallet.ts": () => import("./wallet"),
};

type Figures = Partial<Pick<Doc<"wallets">, "plan" | "period_cap_usd" | "period_cost_usd" | "period_reserved_usd" | "topup_usd" | "period_end">>;

async function setup(figures: Figures = {}) {
  const t = convexTest(schema, modules);
  const { user, conversation } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {});
    const conversation = await ctx.db.insert("conversations", {
      user_id: user, agent_type: "codecast", session_id: "hosted", status: "active", message_count: 0,
      started_at: Date.now(), updated_at: Date.now(), is_private: true, title: "Inbox sweep",
    } as any);
    return { user, conversation };
  });
  const walletId = await t.mutation(internal.wallet.ensure, { user_id: user });
  if (Object.keys(figures).length) await t.run((ctx) => ctx.db.patch(walletId, figures));
  const turn = (status: Doc<"assistant_turns">["status"] = "running", on: Id<"conversations"> = conversation) =>
    t.run((ctx) => ctx.db.insert("assistant_turns", { conversation_id: on, user_id: user, status, cost_reserved_usd: 0 }));
  const wallet = () => t.run(async (ctx) => (await ctx.db.get(walletId))!);
  const ledger = () => t.run((ctx) => ctx.db.query("wallet_ledger").withIndex("by_user_at", (q) => q.eq("user_id", user)).collect());
  return { t, user, conversation, walletId, turn, wallet, ledger };
}

describe("reserve", () => {
  test("four reservations racing a nearly full wallet: only the ones that fit go through", async () => {
    const { t, user, turn, wallet, ledger } = await setup({ period_cap_usd: 2, period_cost_usd: 1.7 });
    const turns = await Promise.all([turn(), turn(), turn(), turn()]);
    const results = await Promise.all(turns.map((turn_id) => t.mutation(internal.wallet.reserve, { user_id: user, turn_id, amount_usd: 0.1 })));

    expect(results.filter(Boolean)).toHaveLength(3);
    expect((await wallet()).period_reserved_usd).toBe(0.3);
    expect((await ledger()).filter((row) => row.kind === "reserve")).toHaveLength(3);
    const held = await t.run(async (ctx) => Promise.all(turns.map(async (id) => (await ctx.db.get(id))!.cost_reserved_usd)));
    expect(held.sort()).toEqual([0, 0.1, 0.1, 0.1]);
  });

  test("a reservation larger than the room is refused whole", async () => {
    const { t, user, turn, wallet } = await setup({ period_cap_usd: 2, period_cost_usd: 1.5 });
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: await turn(), amount_usd: 0.6 })).toBe(false);
    expect((await wallet()).period_reserved_usd).toBe(0);
  });

  test("a refused reservation first gives back what ended turns leaked", async () => {
    const { t, user, turn, wallet, ledger } = await setup({ period_cap_usd: 2, period_cost_usd: 1 });
    const crashed = await turn();
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: crashed, amount_usd: 0.9 })).toBe(true);
    // Its action died: the turn is over but never released its hold.
    await t.run((ctx) => ctx.db.patch(crashed, { status: "failed", ended_at: Date.now() - LEAK_GRACE_MS }));

    // A live turn's hold is never taken back.
    const live = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: live, amount_usd: 0.05 });
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: await turn(), amount_usd: 0.5 })).toBe(true);
    expect((await wallet()).period_reserved_usd).toBe(0.55);
    expect((await ledger()).filter((row) => row.kind === "release").map((row) => row.turn_id)).toEqual([crashed]);
  });

  test("a leaked hold behind more than a scan window of ledger rows is still given back", async () => {
    const { t, user, conversation, turn, wallet } = await setup({ period_cap_usd: 2, period_cost_usd: 1 });
    const crashed = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: crashed, amount_usd: 0.9 });
    await t.run((ctx) => ctx.db.patch(crashed, { status: "failed", ended_at: Date.now() - LEAK_GRACE_MS }));
    // Months of settled turns later: its reserve row is far past the newest 1000.
    await t.run(async (ctx) => {
      for (let i = 0; i < 1100; i++) {
        await ctx.db.insert("wallet_ledger", { user_id: user, kind: "charge", amount_usd: 0, conversation_id: conversation, at: Date.now() + i });
      }
    });
    expect((await t.run((ctx) => ctx.db.get(crashed)))!.holding).toBe(true);
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: await turn(), amount_usd: 0.5 })).toBe(true);
    expect((await wallet()).period_reserved_usd).toBe(0.5);
    expect((await t.run((ctx) => ctx.db.get(crashed)))!.holding).toBeUndefined();
  });

  test("a turn ended for an approval gives back what its finish left held", async () => {
    const { t, user, turn, wallet } = await setup({ period_cap_usd: 2, period_cost_usd: 1 });
    const asked = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: asked, amount_usd: 0.9 });
    await t.run((ctx) => ctx.db.patch(asked, { status: "waiting", reason: "approval", ended_at: Date.now() - LEAK_GRACE_MS } as any));
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: await turn(), amount_usd: 0.5 })).toBe(true);
    expect((await wallet()).period_reserved_usd).toBe(0.5);
  });

  test("a turn that just ended keeps its hold for the settle on its way, so the room is never spent twice", async () => {
    const { t, user, turn, wallet } = await setup({ period_cap_usd: 2, period_cost_usd: 1 });
    const ending = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: ending, amount_usd: 1 });
    // Ended a moment ago, its charge not yet written.
    await t.run((ctx) => ctx.db.patch(ending, { status: "done", ended_at: Date.now() }));
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: await turn(), amount_usd: 0.5 })).toBe(false);
    await t.mutation(internal.wallet.settle, { turn_id: ending, cost_usd: 0.9 });
    const after = await wallet();
    expect([after.period_cost_usd, after.period_reserved_usd]).toEqual([1.9, 0]);
  });

  test("a refusal the leaked holds cannot cover still frees them, so a smaller ask fits", async () => {
    const { t, user, turn, wallet, ledger } = await setup({ period_cap_usd: 2, period_cost_usd: 1.6 });
    const crashed = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: crashed, amount_usd: 0.4 });
    await t.run((ctx) => ctx.db.patch(crashed, { status: "failed", ended_at: Date.now() - LEAK_GRACE_MS }));
    // Room 0 plus the leaked 0.4 is short of 1: refused, but the leak is given back.
    const next = await turn();
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: next, amount_usd: 1 })).toBe(false);
    expect((await wallet()).period_reserved_usd).toBe(0);
    expect((await ledger()).filter((row) => row.kind === "release").map((row) => row.turn_id)).toEqual([crashed]);
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: next, amount_usd: 0.4 })).toBe(true);
    // The hourly reconcile then finds nothing left to free.
    expect(await t.mutation(internal.wallet.reconcileOne, { user_id: user })).toBe(0);
  });

  test("a hold whose turn row was deleted is left by the lease and given back by the reconcile", async () => {
    const { t, user, conversation, turn, wallet, ledger } = await setup({ period_cap_usd: 2, period_cost_usd: 1 });
    const gone = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: gone, amount_usd: 0.9 });
    await t.run((ctx) => ctx.db.delete(gone));
    // The lease reads only holding turns, so it cannot see this hold and refuses without throwing.
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: await turn(), amount_usd: 0.5 })).toBe(false);
    expect(await t.mutation(internal.wallet.reconcile, {})).toEqual({ scanned: 1, scheduled: 1, done: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
    expect((await wallet()).period_reserved_usd).toBe(0);
    expect(await t.mutation(internal.wallet.reconcileOne, { user_id: user })).toBe(0);
    const release = (await ledger()).find((row) => row.kind === "release")!;
    expect([release.turn_id, release.amount_usd, release.conversation_id]).toEqual([gone, 0.9, conversation]);
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: await turn(), amount_usd: 0.5 })).toBe(true);
    expect((await wallet()).period_reserved_usd).toBe(0.5);
  });

  test("the reconcile never takes a live turn's hold or one still inside the grace", async () => {
    const { t, user, turn, wallet } = await setup({ period_cap_usd: 2, period_cost_usd: 0 });
    const live = await turn();
    const ending = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: live, amount_usd: 0.3 });
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: ending, amount_usd: 0.4 });
    await t.run((ctx) => ctx.db.patch(ending, { status: "done", ended_at: Date.now() }));
    expect(await t.mutation(internal.wallet.reconcileOne, { user_id: user })).toBe(0);
    expect((await wallet()).period_reserved_usd).toBe(0.7);
  });
});

describe("settle", () => {
  test("the true-up charges the actual cost, releases the rest, and moves nothing the second time", async () => {
    const { t, user, conversation, turn, wallet, ledger } = await setup({ period_cap_usd: 2, period_cost_usd: 0.5 });
    const turn_id = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id, amount_usd: 0.5 });

    const first = await t.mutation(internal.wallet.settle, { turn_id, cost_usd: 0.2, model: "claude-haiku-4-5-20251001" });
    expect(first).toEqual({ chargedUsd: 0.2, releasedUsd: 0.5, topupUsd: 0, repeat: false });
    const second = await t.mutation(internal.wallet.settle, { turn_id, cost_usd: 0.4 });
    expect(second).toEqual({ chargedUsd: 0.2, releasedUsd: 0, topupUsd: 0, repeat: true });
    expect(await t.mutation(internal.wallet.release, { turn_id })).toBe(0);

    const after = await wallet();
    expect(after.period_cost_usd).toBe(0.7);
    expect(after.period_reserved_usd).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(turn_id)))!.cost_usd).toBe(0.2);
    const kinds = (await ledger()).map((row) => [row.kind, row.amount_usd, row.conversation_id]);
    expect(kinds).toEqual([["reserve", 0.5, conversation], ["release", 0.5, conversation], ["charge", 0.2, conversation]]);
  });

  test("a settled or ended turn cannot reserve again, and a repeat settle sweeps a stray hold", async () => {
    const { t, user, walletId, turn, wallet } = await setup({ period_cap_usd: 2 });
    const turn_id = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id, amount_usd: 0.5 });
    await t.mutation(internal.wallet.settle, { turn_id, cost_usd: 0.2 });
    // A ceiling raise landing after the finish: the turn is settled, so it is refused.
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id, amount_usd: 0.3 })).toBe(false);
    expect((await wallet()).period_reserved_usd).toBe(0);

    const ended = await turn("done");
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: ended, amount_usd: 0.3 })).toBe(false);

    // A hold written past the charge some other way is given back by the next settle.
    await t.run(async (ctx) => {
      await ctx.db.insert("wallet_ledger", { user_id: user, kind: "reserve", amount_usd: 0.3, turn_id, at: Date.now() });
      await ctx.db.patch(walletId, { period_reserved_usd: 0.3 });
    });
    expect(await t.mutation(internal.wallet.settle, { turn_id, cost_usd: 0.2 })).toEqual({ chargedUsd: 0.2, releasedUsd: 0.3, topupUsd: 0, repeat: true });
    expect((await wallet())).toMatchObject({ period_reserved_usd: 0, period_cost_usd: 0.2 });
  });

  test("a cost that is not a number charges what the turn held, never nothing", async () => {
    const { t, user, turn, wallet } = await setup({ period_cap_usd: 2 });
    const turn_id = await turn();
    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id, amount_usd: 0.1 });
    const settled = await t.run((ctx) => settleTurn(ctx, turn_id, Number.NaN));
    expect(settled).toEqual({ chargedUsd: 0.1, releasedUsd: 0.1, topupUsd: 0, repeat: false });
    expect(await wallet()).toMatchObject({ period_cost_usd: 0.1, period_reserved_usd: 0 });
  });

  test("a turn that never reserved still settles once at zero", async () => {
    const { t, turn, ledger } = await setup();
    const turn_id = await turn("done");
    await t.mutation(internal.wallet.settle, { turn_id, cost_usd: 0 });
    await t.mutation(internal.wallet.settle, { turn_id, cost_usd: 0 });
    expect((await ledger()).map((row) => row.kind)).toEqual(["charge"]);
  });
});

describe("top-up", () => {
  test("is spent only after the plan allowance, and lets a turn past the allowance", async () => {
    const { t, user, turn, wallet } = await setup({ period_cap_usd: 2, period_cost_usd: 1.9 });
    const without = await turn();
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: without, amount_usd: 1 })).toBe(false);

    expect(await t.mutation(internal.wallet.topup, { user_id: user, amount_usd: 5, external_id: "pi_1" })).toBe(true);
    expect(await t.mutation(internal.wallet.topup, { user_id: user, amount_usd: 5, external_id: "pi_1" })).toBe(false);
    expect((await wallet()).topup_usd).toBe(5);
    // A purchase without the Stripe id it came from could land twice, so it is refused.
    await expect(t.run((ctx) => credit(ctx, user, "topup", 5))).rejects.toThrow(/Stripe id/);

    const turn_id = await turn();
    expect(await t.mutation(internal.wallet.reserve, { user_id: user, turn_id, amount_usd: 1 })).toBe(true);
    const settled = await t.mutation(internal.wallet.settle, { turn_id, cost_usd: 0.6 });
    expect(settled.topupUsd).toBe(0.5);
    const after = await wallet();
    expect(after.period_cost_usd).toBe(2);
    expect(after.topup_usd).toBe(4.5);
  });

  test("a grant adds to the same balance", async () => {
    const { t, user, wallet, ledger } = await setup();
    await t.mutation(internal.wallet.grant, { user_id: user, amount_usd: 1.25 });
    expect((await wallet()).topup_usd).toBe(1.25);
    expect((await ledger()).map((row) => row.kind)).toEqual(["grant"]);
  });
});

describe("period", () => {
  test("a new period resets usage, keeps the top-up and live holds, and records the reset", async () => {
    const { t, user, turn, wallet, ledger } = await setup({ plan: "plus", period_cap_usd: 1, period_cost_usd: 11.5, period_reserved_usd: 0.2, topup_usd: 3, period_end: Date.now() - 1000 });
    // The plan screen already reads the new period before anything writes it.
    const summary = await t.withIdentity({ subject: user }).query(api.wallet.mine, {});
    expect(summary).toMatchObject({ plan: "plus", cap_usd: 12, used_usd: 0, reserved_usd: 0.2, topup_usd: 3, remaining_usd: 14.8 });
    expect(summary!.period_end!).toBeGreaterThan(Date.now());

    await t.mutation(internal.wallet.reserve, { user_id: user, turn_id: await turn(), amount_usd: 1 });
    const after = await wallet();
    expect(after).toMatchObject({ period_cost_usd: 0, period_cap_usd: 12, topup_usd: 3, period_reserved_usd: 1.2, period_end: summary!.period_end });
    const resets = (await ledger()).filter((row) => row.kind === "period_reset");
    expect(resets.map((row) => row.amount_usd)).toEqual([11.5]);
  });

  test("a summary held across the period's end reads as the next period without a write", async () => {
    const { t, user, walletId } = await setup({ period_cap_usd: 2, period_cost_usd: 1.8, period_reserved_usd: 0.1, topup_usd: 0.5 });
    const held = (await t.withIdentity({ subject: user }).query(api.wallet.mine, {}))!;
    const created = await t.run(async (ctx) => (await ctx.db.get(walletId))!._creationTime);
    expect(held).toMatchObject({ period_anchor: created, used_usd: 1.8, remaining_usd: 0.6 });
    expect(summaryAt(held, held.period_end! - 1)).toBe(held);

    const next = summaryAt(held, held.period_end!);
    expect(next).toMatchObject({ cap_usd: 2, used_usd: 0, reserved_usd: 0.1, topup_usd: 0.5, remaining_usd: 2.4, period_start: held.period_end, period_end: addMonths(created, 2) });
    // Two periods on, it still lands on the one holding now.
    expect(summaryAt(held, addMonths(created, 2) + 5).period_start).toBe(addMonths(created, 2));
  });

  test("months count from the wallet's creation without drifting off the 31st", () => {
    const jan31 = Date.UTC(2026, 0, 31, 12);
    expect(new Date(addMonths(jan31, 1)).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(new Date(addMonths(jan31, 2)).toISOString()).toBe("2026-03-31T12:00:00.000Z");
    const p = periodAt(jan31, Date.UTC(2026, 2, 15));
    expect([new Date(p.start).toISOString(), new Date(p.end).toISOString()]).toEqual(["2026-02-28T12:00:00.000Z", "2026-03-31T12:00:00.000Z"]);
    expect(periodAt(jan31, jan31)).toEqual({ start: jan31, end: addMonths(jan31, 1) });
  });

  test("a new wallet's first period counts from its creation, whatever now the caller passes", async () => {
    const { t } = await setup();
    const made = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", {});
      return ensureWallet(ctx, user, Date.now() - 5 * 86_400_000);
    });
    expect({ start: made.period_start, end: made.period_end }).toEqual(periodAt(made._creationTime, made._creationTime));
    expect(made.period_start).toBe(Math.floor(made._creationTime));
    expect(periodAt(made._creationTime, made.period_end)).toEqual({ start: made.period_end, end: addMonths(made._creationTime, 2) });
  });

  test("setPlan with a failing renewal grants the free allowance, the rule billing uses", async () => {
    const { t, user, wallet } = await setup();
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "pro", subscription_status: "past_due" });
    expect(await wallet()).toMatchObject({ plan: "pro", period_cap_usd: 2, subscription_status: "past_due" });
  });

  test("setPlan moves the cap at once and keeps the period's usage", async () => {
    const { t, user, wallet } = await setup({ period_cost_usd: 1.5 });
    await t.mutation(internal.wallet.setPlan, { user_id: user, plan: "pro", stripe_customer_id: "cus_1", subscription_status: "active" });
    expect(await wallet()).toMatchObject({ plan: "pro", period_cap_usd: 40, period_cost_usd: 1.5, stripe_customer_id: "cus_1", subscription_status: "active" });
  });
});

describe("mine", () => {
  test("groups recent charges per conversation, newest first, with credits apart", async () => {
    const { t, user, conversation, turn } = await setup();
    const other = await t.run((ctx) => ctx.db.insert("conversations", {
      user_id: user, agent_type: "codecast", session_id: "hosted-2", status: "active", message_count: 0,
      started_at: Date.now(), updated_at: Date.now(), is_private: true, title: "Calendar",
    } as any));
    for (const [on, cost] of [[conversation, 0.1], [conversation, 0.2], [other, 0.05]] as const) {
      const turn_id = await turn("running", on);
      await t.mutation(internal.wallet.reserve, { user_id: user, turn_id, amount_usd: 0.3 });
      await t.mutation(internal.wallet.settle, { turn_id, cost_usd: cost });
    }
    await t.mutation(internal.wallet.grant, { user_id: user, amount_usd: 1 });

    const summary = (await t.withIdentity({ subject: user }).query(api.wallet.mine, {}))!;
    expect(summary).toMatchObject({ plan: "free", cap_usd: 2, used_usd: 0.35, reserved_usd: 0, topup_usd: 1, remaining_usd: 2.65 });
    expect(summary.conversations.map((line) => [line.conversation_id, line.cost_usd, line.turns])).toEqual([[other, 0.05, 1], [conversation, 0.3, 2]]);
    expect(summary.account.map((line) => [line.kind, line.amount_usd])).toEqual([["grant", 1]]);
    expect(await t.query(api.wallet.mine, {})).toBeNull();
  });
});
