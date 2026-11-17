// Sign-in autofill: only a person turns it on, only for one of their laptops;
// on, every open sign-in request in the workspace goes to that laptop as a
// vault_capture_signin, AUTOFILL_PARALLEL at a time, never a site Google keeps
// or one tried within AUTOFILL_RETRY_MS, and nothing while the laptop is away.
// Run: cd packages/convex && bun test convex/signinAutofill.test.ts
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { workspaceKey } from "./lib/access";
import { AUTOFILL_PARALLEL } from "./signinAutofill";

const api: any = anyApi;

async function seed() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx: any) => {
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "a" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: acme, role: "member", joined_at: now } as any);
    await ctx.db.insert("devices", { user_id: ana, device_id: "ana-laptop", label: "Ana's Mac", platform: "darwin", last_seen: now } as any);
    await ctx.db.insert("devices", { user_id: ana, device_id: "ana-cloud", label: "Cloud", platform: "darwin", last_seen: now, is_remote: true } as any);
    const workspace = workspaceKey({ type: "team", teamId: acme });
    const ask = (name: string, kind: string, sites?: string[]) =>
      ctx.db.insert("secrets", { workspace, team_id: acme, short_id: `sec-${name}`, name, kind, status: "requested", sites, created_by: ana, created_at: now, updated_at: now } as any);
    for (const host of ["fly.io", "sentry.io", "zoom.us", "expo.dev", "railway.com", "posthog.com"]) await ask(`${host.split(".")[0]}-signin`, "signin", [host]);
    await ask("google-signin", "signin", ["accounts.google.com"]);
    await ask("calendly", "key");
    return { acme, ana };
  });
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 5));
    await t.finishInProgressScheduledFunctions();
  };
  const sent = () => t.run(async (ctx: any) => (await ctx.db.query("daemon_commands").collect()).map((c: any) => ({ ...JSON.parse(c.args), device: c.target_device_id, command: c.command, id: c._id })));
  const runAll = () => t.run(async (ctx: any) => { for (const c of await ctx.db.query("daemon_commands").collect()) await ctx.db.patch(c._id, { executed_at: Date.now() }); });
  const grantId = () => t.run(async (ctx: any) => (await ctx.db.query("signin_autofill").first())?._id);
  return { t, ...ids, as: t.withIdentity({ subject: `${ids.ana}|test` }), settle, sent, runAll, grantId };
}

test("a token without a person, or a cloud host, cannot turn it on", async () => {
  const { t, as, acme } = await seed();
  expect(await t.mutation(api.signinAutofill.set, { team_id: acme, device_id: "ana-laptop" })).toMatchObject({ error: expect.any(String) });
  expect(await as.mutation(api.signinAutofill.set, { team_id: acme, device_id: "ana-cloud" })).toMatchObject({ error: expect.stringMatching(/laptop/) });
  expect(await as.query(api.signinAutofill.mine, { team_id: acme })).toBeNull();
});

test("on, open sign-in requests go to the laptop a few at a time, each once, never Google's own login or a key", async () => {
  const { t, as, acme, settle, sent, runAll, grantId } = await seed();
  expect(await as.mutation(api.signinAutofill.set, { team_id: acme, device_id: "ana-laptop" })).toEqual({ ok: true });
  expect(await as.query(api.signinAutofill.mine, { team_id: acme })).toMatchObject({ device_id: "ana-laptop" });
  await settle();

  const first = await sent();
  expect(first).toHaveLength(AUTOFILL_PARALLEL);
  expect(first[0]).toMatchObject({ command: "vault_capture_signin", device: "ana-laptop", site: "fly.io", name: "fly-signin", team_id: acme });

  // Full: nothing more until the laptop answers.
  await t.mutation(api.signinAutofill.fillGrant, { grant_id: await grantId() });
  expect(await sent()).toHaveLength(AUTOFILL_PARALLEL);

  await runAll();
  await t.mutation(api.signinAutofill.fillGrant, { grant_id: await grantId() });
  const names = (await sent()).map((c: any) => c.name);
  expect(names).toEqual(["fly-signin", "sentry-signin", "zoom-signin", "expo-signin", "railway-signin", "posthog-signin"]);

  // Tried and still asked for (Chrome signed out there): not again until the retry is due.
  await runAll();
  await t.mutation(api.signinAutofill.fillGrant, { grant_id: await grantId() });
  expect(await sent()).toHaveLength(6);

  expect(await as.mutation(api.signinAutofill.set, { team_id: acme })).toEqual({ ok: true });
  expect(await as.query(api.signinAutofill.mine, { team_id: acme })).toBeNull();
});

test("a laptop that is away gets nothing until it is back", async () => {
  const { t, as, acme, settle, sent, grantId } = await seed();
  await as.mutation(api.signinAutofill.set, { team_id: acme, device_id: "ana-laptop" });
  await t.run(async (ctx: any) => {
    const d = await ctx.db.query("devices").filter((q: any) => q.eq(q.field("device_id"), "ana-laptop")).first();
    await ctx.db.patch(d._id, { last_seen: Date.now() - 3_600_000 });
    for (const c of await ctx.db.query("daemon_commands").collect()) await ctx.db.delete(c._id);
  });
  await settle();
  await t.run(async (ctx: any) => { for (const c of await ctx.db.query("daemon_commands").collect()) await ctx.db.delete(c._id); });
  await t.mutation(api.signinAutofill.fillGrant, { grant_id: await grantId() });
  expect(await sent()).toHaveLength(0);
});

test("a new sign-in request is taken up at once", async () => {
  const { t, as, acme, settle, sent, runAll } = await seed();
  await as.mutation(api.signinAutofill.set, { team_id: acme, device_id: "ana-laptop" });
  await settle();
  await runAll();
  await t.run(async (ctx: any) => { for (const c of await ctx.db.query("daemon_commands").collect()) await ctx.db.delete(c._id); });
  await as.mutation(api.secrets.request, { name: "vercel-signin", kind: "signin", sites: ["vercel.com"], team_id: acme });
  await settle();
  await settle();
  expect((await sent()).map((c: any) => c.name)).toContain("vercel-signin");
});
