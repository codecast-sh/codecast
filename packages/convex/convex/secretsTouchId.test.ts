// Touch ID as its own switch beside Ask first, and one decision for a read of several Ask first secrets.
import { expect, setDefaultTimeout, test } from "bun:test";
import { isPresenceRequired } from "@codecast/shared/contracts/secrets";
import { ANA_TOKEN, STRIPE, answer, api, read, seed, touch, useVaultTestEnv } from "./secrets.testkit";

setDefaultTimeout(60_000);
useVaultTestEnv();

test("Touch ID is its own switch: it gates reveal, Approve and turning a guard off, and Ask first works without it", async () => {
  const { t, as, ana, acme } = await seed();
  await as(ana).action(api.secrets.create, { name: "stripe-live", kind: "key", payload: { value: STRIPE }, team_id: acme });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true });
  const decisions = () => t.run(async (ctx: any) => ctx.db.query("session_decisions").collect());

  // Ask first without Touch ID: reveal and Approve are one press each, no grant.
  expect(await as(ana).action(api.secrets.reveal, { ref: "stripe-live" })).toEqual({ payload: { value: STRIPE } });
  await read(t, ["stripe-live"]);
  const [first] = await decisions();
  expect(first.touch_id).toBeUndefined();
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: first._id, status: "answered", answer_index: 0 });
  expect((await read(t, ["stripe-live"])).secrets[0].payload).toEqual({ value: STRIPE });

  // Touch ID on from a token; off only from a signed-in person, with a grant.
  expect(await t.mutation(api.secrets.setTouchId, { api_token: ANA_TOKEN, ref: "stripe-live", touch_id: true })).toMatchObject({ touch_id: true });
  expect((await t.mutation(api.secrets.setTouchId, { api_token: ANA_TOKEN, ref: "stripe-live", touch_id: false })).error).toMatch(/Only a person turns Touch ID off/);
  expect((await as(ana).query(api.secrets.show, { ref: "stripe-live" })).touch_id).toBe(true);

  // Re-armed, the next decision carries touch_id and its Approve takes a grant.
  expect(isPresenceRequired(await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: false }))).toBe(true);
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: false, grant: await touch(t, as, ana, "ask_first_off", "stripe-live") });
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: true });
  await read(t, ["stripe-live"]);
  const gated = (await decisions()).find((d: any) => d.status === "pending");
  expect(gated.touch_id).toBe(true);
  await expect(as(ana).mutation(api.sessionDecisions.resolve, { decision_id: gated._id, status: "answered", answer_index: 0 })).rejects.toThrow(/presence_required/);

  // Touch ID off takes its own grant, and clears the flag on the open decision, whose Approve is then one press.
  expect(isPresenceRequired(await as(ana).mutation(api.secrets.setTouchId, { ref: "stripe-live", touch_id: false }))).toBe(true);
  const off = await touch(t, as, ana, "touch_id_off", "stripe-live");
  expect(await as(ana).mutation(api.secrets.setTouchId, { ref: "stripe-live", touch_id: false, grant: off })).toMatchObject({ touch_id: false });
  expect((await t.run(async (ctx: any) => ctx.db.get(gated._id))).touch_id).toBeUndefined();
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: gated._id, status: "answered", answer_index: 0 });
  expect((await read(t, ["stripe-live"])).secrets[0].payload).toEqual({ value: STRIPE });
  expect(await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: false })).toMatchObject({ ask_first: false });
});

test("a read of several Ask first secrets files one decision: one Approve and one Touch ID open them all", async () => {
  const { t, as, ana, acme } = await seed();
  for (const name of ["stripe-live", "prod-db", "plain"]) await as(ana).action(api.secrets.create, { name, kind: "key", payload: { value: `${name}-value-123456` }, team_id: acme });
  for (const name of ["stripe-live", "prod-db"]) await as(ana).mutation(api.secrets.setAskFirst, { ref: name, ask_first: true });
  await as(ana).mutation(api.secrets.setTouchId, { ref: "prod-db", touch_id: true });

  const held = await read(t, ["stripe-live", "prod-db", "plain"]);
  expect(held.secrets).toBeUndefined();
  expect(held.approvals.map((a: any) => a.secret)).toEqual(["stripe-live", "prod-db"]);
  expect(new Set(held.approvals.map((a: any) => a.decision)).size).toBe(1);
  const decisions = await t.run(async (ctx: any) => ctx.db.query("session_decisions").collect());
  expect(decisions.length).toBe(1);
  expect(decisions[0].question).toBe("Wire up billing asks to use stripe-live and prod-db");
  expect(decisions[0].touch_id).toBe(true);
  // A repeat reuses it.
  expect((await read(t, ["stripe-live", "prod-db"])).approvals.every((a: any) => a.decision === held.needs_approval.decision)).toBe(true);
  expect(await t.run(async (ctx: any) => (await ctx.db.query("session_decisions").collect()).length)).toBe(1);

  // One grant for the decision approves both.
  await expect(as(ana).mutation(api.sessionDecisions.resolve, { decision_id: decisions[0]._id, status: "answered", answer_index: 0 })).rejects.toThrow(/presence_required/);
  await answer(t, as, ana, held.needs_approval.decision, 0);
  const ok = await read(t, ["stripe-live", "prod-db", "plain"]);
  expect(ok.secrets.map((x: any) => x.payload.value)).toEqual(["stripe-live-value-123456", "prod-db-value-123456", "plain-value-123456"]);
  expect((await t.run(async (ctx: any) => ctx.db.query("secret_approvals").collect())).map((a: any) => a.status)).toEqual(["approved", "approved"]);
});

test("switching off Ask first on one secret of a batched decision keeps it open for the rest", async () => {
  const { t, as, ana, acme } = await seed();
  for (const name of ["stripe-live", "prod-db"]) {
    await as(ana).action(api.secrets.create, { name, kind: "key", payload: { value: `${name}-value-123456` }, team_id: acme });
    await as(ana).mutation(api.secrets.setAskFirst, { ref: name, ask_first: true });
  }
  await as(ana).mutation(api.secrets.setTouchId, { ref: "stripe-live", touch_id: true });
  const held = await read(t, ["stripe-live", "prod-db"], { why: "refund order 123\n\nand check the ledger" });
  expect((await t.run(async (ctx: any) => ctx.db.query("session_decisions").first())).touch_id).toBe(true);
  await as(ana).mutation(api.secrets.setAskFirst, { ref: "stripe-live", ask_first: false, grant: await touch(t, as, ana, "ask_first_off", "stripe-live") });
  const [decision] = await t.run(async (ctx: any) => ctx.db.query("session_decisions").collect());
  expect(decision.status).toBe("pending");
  expect(decision.short_id).toBe(held.needs_approval.decision);
  // It names only what it still waits on, and no longer asks for the dropped secret's Touch ID.
  expect(decision.question).toBe("Wire up billing asks to use prod-db");
  expect(decision.context_md).toStartWith("Why: refund order 123\n\nand check the ledger\n\nprod-db (");
  expect(decision.context_md).not.toContain("stripe-live");
  expect(decision.touch_id).toBeUndefined();
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: decision._id, status: "answered", answer_index: 0 });
  expect((await read(t, ["stripe-live", "prod-db"])).secrets.length).toBe(2);
});
