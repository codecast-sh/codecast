// Seat billing for teams under convex-test (ct-70845): Starter holds three
// members plus pending invites, the fourth invite or join is refused with the
// data the invite UI needs, Pro is bought through checkout with a trial, the
// shared Stripe webhook maps a team's subscription onto the team (never a
// wallet), and the seat sync sets the quantity to the members with proration.
// With no seat price nothing is limited. The failure policy (fail open on an
// unconfirmed plan, block on a confirmed lapse) is the pure `decideSeat`.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { signWebhook } from "@platform/billing";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { STRIPE_WEBHOOK_PATH } from "./billing";
import { CHECKOUT_GRACE_MS, decideSeat, type SeatInput } from "./lib/teamSeats";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

const SECRET = "whsec_seats_test";
const ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_PRICE_TEAM_SEAT: "price_seat",
  TEAM_SEAT_TRIAL_DAYS: "14",
};
const ENV_NAMES = Object.keys(ENV) as (keyof typeof ENV)[];

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, ENV);
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  globalThis.fetch = savedFetch;
  setSystemTime();
});

// ---------------------------------------------------------------------------
// The decision

describe("decideSeat", () => {
  const base: SeatInput = { on: true, row: null, counts: { members: 2, pending: 0 }, adding: 1, now: 1_000_000 };
  const decide = (patch: Partial<SeatInput>) => decideSeat({ ...base, ...patch });

  test("off: everything is allowed", () => {
    expect(decide({ on: false, counts: { members: 9, pending: 9 } })).toMatchObject({ kind: "allowed", why: "billing_off" });
  });

  test("Starter allows up to three members plus pending invites, and refuses the fourth with the counts", () => {
    expect(decide({ counts: { members: 2, pending: 0 } })).toMatchObject({ kind: "allowed", why: "within_free" });
    const refused = decide({ counts: { members: 2, pending: 1 }, row: { stripe_customer_id: "cus_1" } as any });
    expect(refused).toEqual({
      kind: "blocked",
      limit: expect.objectContaining({ code: "upgrade_required", current_seats: 2, pending_invites: 1, free_capacity: 3, action_label: "Upgrade to Pro" }),
    });
  });

  test("Pro allows any number while the subscription is live, past_due included", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(decide({ counts: { members: 40, pending: 3 }, row: { subscription_status: status } as any })).toMatchObject({ kind: "allowed", plan: "pro" });
    }
  });

  test("a confirmed lapse blocks seats past the free capacity, and only those", () => {
    const row = { stripe_customer_id: "cus_1", subscription_status: "canceled", subscription_read_at: 5 } as any;
    expect(decide({ row, counts: { members: 5, pending: 0 } })).toMatchObject({ kind: "blocked", limit: { code: "subscription_lapsed", action_label: "Renew Pro" } });
    expect(decide({ row, counts: { members: 1, pending: 0 } })).toMatchObject({ kind: "allowed", plan: "starter" });
    // A checkout opened after the lapse does not unblock it: Stripe has said no.
    expect(decide({ row: { ...row, checkout_started_at: base.now - 1000 }, counts: { members: 5, pending: 0 } }).kind).toBe("blocked");
  });

  test("an unconfirmed plan fails open: a checkout landing, a first payment processing, a failed Stripe read", () => {
    const over = { counts: { members: 3, pending: 0 } };
    expect(decide({ ...over, row: { stripe_customer_id: "cus_1", checkout_started_at: base.now - 1000 } as any })).toMatchObject({ kind: "fail_open", why: "checkout_pending" });
    expect(decide({ ...over, row: { stripe_customer_id: "cus_1", checkout_started_at: base.now - CHECKOUT_GRACE_MS - 1 } as any }).kind).toBe("blocked");
    expect(decide({ ...over, row: { stripe_customer_id: "cus_1", subscription_status: "incomplete" } as any })).toMatchObject({ kind: "fail_open", why: "payment_processing" });
    expect(decide({ ...over, row: { stripe_customer_id: "cus_1", subscription_status: "canceled", subscription_read_at: 5, refresh_failed_at: 9 } as any })).toMatchObject({ kind: "fail_open", why: "plan_unconfirmed" });
  });

  test("a team over the free capacity that never subscribed is grandfathered; one that lapsed is not", () => {
    expect(decide({ counts: { members: 5, pending: 0 } })).toMatchObject({ kind: "allowed", why: "grandfathered" });
    expect(decide({ counts: { members: 2, pending: 0 }, row: { grandfathered_at: 1 } as any, adding: 4 })).toMatchObject({ kind: "allowed", why: "grandfathered" });
    expect(decide({ counts: { members: 5, pending: 0 }, row: { stripe_customer_id: "cus_1", subscription_status: "canceled" } as any }).kind).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// End to end

type Sub = {
  id: string; customer: string; status: string; metadata: Record<string, string>;
  items: { data: { id: string; price: { id: string }; quantity: number }[] };
  cancel_at_period_end?: boolean; trial_end?: number;
};
type Call = { method: string; path: string; form: Record<string, string>; headers: Record<string, string> };

function fakeStripe() {
  const state = {
    calls: [] as Call[],
    subscriptions: new Map<string, Sub>(),
    unreachable: false,
    put(sub: Sub) { state.subscriptions.set(sub.id, structuredClone(sub)); },
    posts: (path: string) => state.calls.filter((c) => c.method === "POST" && c.path === path),
  };
  globalThis.fetch = (async (url: string, init: { method: string; body?: string; headers?: Record<string, string> }) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/v1\//, "");
    const call: Call = { method: init.method, path, form: Object.fromEntries(new URLSearchParams(init.body ?? "")), headers: init.headers ?? {} };
    state.calls.push(call);
    if (state.unreachable) throw new TypeError("fetch failed");
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path === "prices/price_seat") return reply(200, { id: "price_seat", active: true, unit_amount: 1200, currency: "usd", recurring: { interval: "month", interval_count: 1 } });
    if (path === "checkout/sessions") return reply(200, { id: "cs_team", url: "https://checkout.stripe.test/team" });
    if (path === "billing_portal/sessions") return reply(200, { id: "bps_team", url: "https://billing.stripe.test/team" });
    if (path === "subscriptions") return reply(200, { data: [...state.subscriptions.values()].filter((s) => s.customer === parsed.searchParams.get("customer")) });
    const item = path.match(/^subscription_items\/(.+)$/);
    if (item) {
      for (const sub of state.subscriptions.values()) {
        const it = sub.items.data.find((i) => i.id === item[1]);
        if (it) { it.quantity = Number(call.form.quantity); return reply(200, it); }
      }
      return reply(404, { error: { message: "no item" } });
    }
    const subMatch = path.match(/^subscriptions\/(.+)$/);
    if (subMatch) {
      const sub = state.subscriptions.get(subMatch[1]);
      if (!sub) return reply(404, { error: { message: "no sub" } });
      if (init.method === "POST" && call.form.cancel_at_period_end) sub.cancel_at_period_end = call.form.cancel_at_period_end === "true";
      return reply(200, sub);
    }
    return reply(404, { error: { message: `unknown ${path}` } });
  }) as unknown as typeof fetch;
  return state;
}

let eventSeq = 0;
async function deliver(t: ReturnType<typeof convexTest>, type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_team_${++eventSeq}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const response = await t.fetch(STRIPE_WEBHOOK_PATH, {
    method: "POST",
    headers: { "Stripe-Signature": await signWebhook(payload, SECRET), "Content-Type": "application/json" },
    body: payload,
  });
  return (await response.json()) as { outcome?: string };
}

async function setup(memberCount = 2) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", invite_code_expires_at: Date.now() + 86_400_000, created_at: 1 });
    const users: Id<"users">[] = [];
    for (let i = 0; i < memberCount; i++) {
      const user = await ctx.db.insert("users", { email: `m${i}@acme.test`, name: `M${i}`, team_id: team });
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: i === 0 ? "admin" : "member", joined_at: i });
      users.push(user);
    }
    // A bot is a membership but never a seat.
    const bot = await ctx.db.insert("users", { name: "Anchor", is_bot: true });
    await ctx.db.insert("team_memberships", { user_id: bot, team_id: team, role: "member", joined_at: 99 });
    const outsiders: Id<"users">[] = [];
    for (let i = 0; i < 3; i++) outsiders.push(await ctx.db.insert("users", { email: `o${i}@else.test`, name: `O${i}` }));
    return { team, users, outsiders };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: user });
  const admin = as(ids.users[0]);
  const row = () => t.run((ctx) => ctx.db.query("team_subscriptions").withIndex("by_team", (q) => q.eq("team_id", ids.team)).first());
  return { t, ...ids, as, admin, row };
}

const seatSub = (team: Id<"teams">, status: string, quantity = 2, extra: Partial<Sub> = {}): Sub => ({
  id: "sub_team", customer: "cus_team", status, metadata: { kind: "team_seats", team_id: team },
  items: { data: [{ id: "si_team", price: { id: "price_seat" }, quantity }] }, ...extra,
});

async function seatRefusalOf(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (error instanceof ConvexError) return error.data as Record<string, unknown>;
    throw error;
  }
  throw new Error("expected a seat refusal");
}

describe("Starter limits", () => {
  test("a third seat by invite is fine; the fourth invite answers upgrade_required with the counts", async () => {
    const { admin, team } = await setup(2);
    fakeStripe();
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "new1@acme.test" })).toEqual({ sent: true });
    // Sending again to the same address takes no second seat.
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "NEW1@acme.test" })).toEqual({ sent: true });
    const refused = await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "new2@acme.test" });
    expect(refused).toEqual({
      sent: false,
      upgrade_required: expect.objectContaining({ code: "upgrade_required", current_seats: 2, pending_invites: 1, free_capacity: 3 }),
    });
    const state = await admin.query(api.teamBilling.getSeatState, { team_id: team });
    expect(state).toMatchObject({ enforced: true, plan: "starter", members: 2, pending: 1, full: true, is_admin: true });
  });

  test("a new invite link revokes the pending invites and frees their seats", async () => {
    const { admin, team } = await setup(2);
    await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "new1@acme.test" });
    await admin.mutation(api.teams.regenerateInviteCode, { team_id: team });
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "new2@acme.test" })).toEqual({ sent: true });
  });

  test("joining by link: the invited person takes the seat their invite held; a fourth stranger is refused", async () => {
    const { t, as, admin, team, outsiders } = await setup(2);
    const code = (await t.run((ctx) => ctx.db.get(team)))!.invite_code;
    await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "o0@else.test" });
    // A stranger cannot take the seat the invite holds.
    expect(await seatRefusalOf(as(outsiders[1]).mutation(api.teams.joinTeam, { invite_code: code }))).toMatchObject({ code: "upgrade_required", current_seats: 2, pending_invites: 1 });
    await as(outsiders[0]).mutation(api.teams.joinTeam, { invite_code: code });
    expect(await admin.query(api.teamBilling.getSeatState, { team_id: team })).toMatchObject({ members: 3, pending: 0, full: true });
    expect(await seatRefusalOf(as(outsiders[2]).mutation(api.teams.joinTeam, { invite_code: code }))).toMatchObject({ code: "upgrade_required", current_seats: 3 });
  });

  test("an operator add skips the gate", async () => {
    const { t, team, outsiders, admin } = await setup(3);
    await t.mutation(internal.teams.addMemberByOperator, { user_id: outsiders[0], team_id: team });
    expect(await admin.query(api.teamBilling.getSeatState, { team_id: team })).toMatchObject({ members: 4 });
  });

  test("a team already over three is grandfathered and stamped once", async () => {
    const { admin, team, row } = await setup(4);
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "new@acme.test" })).toEqual({ sent: true });
    expect((await row())?.grandfathered_at).toBeNumber();
    expect(await admin.query(api.teamBilling.getSeatState, { team_id: team })).toMatchObject({ grandfathered: true, full: false });
  });

  test("with no seat price, nothing is limited and the state says billing is off", async () => {
    delete process.env.STRIPE_PRICE_TEAM_SEAT;
    const { admin, team, row } = await setup(3);
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "new@acme.test" })).toEqual({ sent: true });
    expect(await admin.query(api.teamBilling.getSeatState, { team_id: team })).toEqual({ enforced: false });
    expect(await row()).toBeNull();
    expect(await admin.action(api.teamBilling.startSeatCheckout, { team_id: team })).toMatchObject({ ok: false, code: "unavailable" });
  });

  test("without the Stripe secrets there is no way to upgrade, so nothing is limited", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { admin, team } = await setup(3);
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "new@acme.test" })).toEqual({ sent: true });
  });
});

describe("upgrade", () => {
  test("the offer reads the seat price from Stripe, with the trial for a first subscription", async () => {
    const { admin, team } = await setup(3);
    fakeStripe();
    expect(await admin.action(api.teamBilling.seatOffer, { team_id: team })).toEqual({ ok: true, unit_amount: 1200, currency: "usd", interval: "month", interval_count: 1, trial_days: 14, seats: 3 });
  });

  test("checkout sells one seat per member on the seat price, with the trial and the team in metadata; members cannot start it", async () => {
    const { admin, as, users, team, row } = await setup(3);
    const stripe = fakeStripe();
    expect(await as(users[1]).action(api.teamBilling.startSeatCheckout, { team_id: team })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await admin.action(api.teamBilling.startSeatCheckout, { team_id: team })).toEqual({ ok: true, url: "https://checkout.stripe.test/team", via: "checkout" });
    const [checkout] = stripe.posts("checkout/sessions");
    expect(checkout.form).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_seat",
      "line_items[0][quantity]": "3",
      "subscription_data[trial_period_days]": "14",
      "subscription_data[metadata][kind]": "team_seats",
      "subscription_data[metadata][team_id]": team,
      "metadata[team_id]": team,
      customer_email: "m0@acme.test",
    });
    expect(checkout.headers["Idempotency-Key"]).toStartWith(`team-checkout:${team}:`);
    expect((await row())?.checkout_started_at).toBeNumber();
  });

  test("the webhook maps the team's subscription onto the team, never a wallet; then the team is Pro", async () => {
    const { t, admin, team, row } = await setup(3);
    const stripe = fakeStripe();
    stripe.put(seatSub(team, "trialing", 3, { trial_end: 2_000_000_000 }));
    const outcome = await deliver(t, "checkout.session.completed", { id: "cs_team", mode: "subscription", customer: "cus_team", subscription: "sub_team", metadata: { kind: "team_seats", team_id: team } });
    expect(outcome.outcome).toBe("team:trialing");
    expect(await row()).toMatchObject({ stripe_customer_id: "cus_team", stripe_subscription_id: "sub_team", subscription_status: "trialing", quantity: 3, trial_end: 2_000_000_000_000 });
    expect(await t.run((ctx) => ctx.db.query("wallets").collect())).toEqual([]);
    expect(await admin.query(api.teamBilling.getSeatState, { team_id: team })).toMatchObject({ plan: "pro", status: "trialing", full: false, has_billing: true });
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "fourth@acme.test" })).toEqual({ sent: true });
    // A team Stripe already holds a live subscription for gets the portal.
    expect(await admin.action(api.teamBilling.startSeatCheckout, { team_id: team })).toMatchObject({ ok: true, via: "portal" });
    expect(await admin.action(api.teamBilling.openSeatPortal, { team_id: team })).toMatchObject({ ok: true, url: "https://billing.stripe.test/team" });
  });

  test("an older read arriving late is skipped", async () => {
    const { t, team, row } = await setup(3);
    fakeStripe();
    const later = Date.now() + 10_000;
    await t.mutation(internal.teamBilling.applyTeamSubscription, { subscription_json: JSON.stringify(seatSub(team, "active", 3)), read_at: later });
    expect(await t.mutation(internal.teamBilling.applyTeamSubscription, { subscription_json: JSON.stringify(seatSub(team, "incomplete", 3)), read_at: later - 5 })).toBe("ignored:stale_read");
    expect((await row())?.subscription_status).toBe("active");
  });
});

describe("seat sync", () => {
  async function pro(memberCount = 3) {
    const env = await setup(memberCount);
    const stripe = fakeStripe();
    stripe.put(seatSub(env.team, "active", memberCount));
    await env.t.mutation(internal.teamBilling.applyTeamSubscription, { subscription_json: JSON.stringify(seatSub(env.team, "active", memberCount)), read_at: Date.now(), sync: false });
    return { ...env, stripe };
  }

  test("a member joining raises the quantity with proration; leaving lowers it; bots never count", async () => {
    const { t, as, admin, team, users, outsiders, stripe, row } = await pro(3);
    const code = (await t.run((ctx) => ctx.db.get(team)))!.invite_code;
    await as(outsiders[0]).mutation(api.teams.joinTeam, { invite_code: code });
    expect(await t.action(internal.teamBilling.syncSeats, { team_id: team, reason: "member_joined" })).toBe("synced");
    const [update] = stripe.posts("subscription_items/si_team");
    expect(update.form).toEqual({ quantity: "4", proration_behavior: "create_prorations" });
    expect((await row())?.quantity).toBe(4);

    await admin.mutation(api.teams.removeFromTeam, { team_id: team, user_id: users[1] });
    expect(await t.action(internal.teamBilling.syncSeats, { team_id: team, reason: "member_left" })).toBe("synced");
    expect(stripe.posts("subscription_items/si_team").at(-1)!.form.quantity).toBe("3");
    // Nothing changed since: no Stripe write.
    expect(await t.action(internal.teamBilling.syncSeats, { team_id: team, reason: "subscription_changed" })).toBe("unchanged");
    expect(stripe.posts("subscription_items/si_team")).toHaveLength(2);
  });

  test("a deleted team's subscription ends at the period's end", async () => {
    const { t, team, stripe, row } = await pro(2);
    await t.run((ctx) => ctx.db.patch(team, { deleted_at: Date.now() }));
    expect(await t.action(internal.teamBilling.syncSeats, { team_id: team, reason: "team_deleted" })).toBe("cancel_at_period_end");
    expect(stripe.posts("subscriptions/sub_team")[0].form).toEqual({ cancel_at_period_end: "true" });
    expect((await row())?.cancel_at_period_end).toBe(true);
  });

  test("Stripe unreachable: the plan is marked unconfirmed, so a lapsed team's next seat fails open", async () => {
    const { t, admin, team, stripe, row } = await pro(3);
    await t.mutation(internal.teamBilling.applyTeamSubscription, { subscription_json: JSON.stringify(seatSub(team, "canceled", 3)), read_at: Date.now() + 1, sync: false });
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "x@acme.test" })).toMatchObject({ sent: false, upgrade_required: { code: "subscription_lapsed" } });
    stripe.unreachable = true;
    // The failure must come after the canceled read; a fast runner can land both in one millisecond.
    setSystemTime(Date.now() + 1000);
    expect(await t.action(internal.teamBilling.syncSeats, { team_id: team, reason: "member_joined" })).toBe("refresh_failed");
    expect((await row())?.refresh_failed_at).toBeNumber();
    expect(await admin.mutation(api.teams.sendInviteEmail, { team_id: team, email: "x@acme.test" })).toEqual({ sent: true });
  });
});
