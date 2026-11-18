// The repair for role checks that died before ct-95585 (roleCheckRepair.repairRoleChecks).
//
//   rearm      a dead check on a seat nothing else checks is stamped with the
//              role, handed to the seat's runner and armed for its next slot,
//              whatever else unrelated runs on the seat (ADV1)
//   adopt      a live trigger carrying the check's title becomes the role's
//              check and the dead one is cancelled; the role is not down (ADV2)
//   ambiguous  a hand-armed trigger that only looks like a check (Calling's
//              tr-7252) is listed for a person and both are left alone, until
//              a person names it in `adopt`
//   create     an active role with a seat and no check gets one
//   paused     a paused role's dead check stays; its stranded live trigger moves
//   parity     every row the dry run lists is what the real run writes (ADV4),
//              and a second run finds nothing left to do
// Run: bun test convex/migrations.repairRoleChecks.test.ts
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { performRepairRoleChecks } from "./roleCheckRepair";
import { findRoleRoutineInAnyStatus, roleRoutineFor } from "./lib/orgRoutine";
import { checkFaultOf } from "@codecast/shared/contracts/orgAreas";

const DAY = 24 * 60 * 60 * 1000;
const REFUSED = "Failed: Injection failed: Unauthorized: can only send messages to your own conversations";

type Seed = { status: string; owner: "ashot" | "samvit" | "cam"; short_id: string; title?: string; role?: boolean; prompt?: string; schedule_type?: "recurring" | "event" };

async function world() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const users = await t.run(async (ctx) => {
    const ashot = await ctx.db.insert("users", { name: "Ashot" });
    const samvit = await ctx.db.insert("users", { name: "Samvit" });
    const cam = await ctx.db.insert("users", { name: "Cam" });
    const team = await ctx.db.insert("teams", { name: "Union", features: { org: true }, invite_code: "union-repair", created_at: now });
    for (const u of [ashot, samvit, cam]) await ctx.db.insert("team_memberships", { team_id: team, user_id: u, role: "admin", joined_at: now });
    return { ashot, samvit, cam, team };
  });
  const asAshot = t.withIdentity({ subject: `${users.ashot}|test` });
  // A role seated in a session `runner` runs, with its triggers as `seeds` left them.
  async function role(handle: string, name: string, runner: "ashot" | "samvit" | "cam", seeds: Seed[], status = "active") {
    const r = await asAshot.mutation(anyApi.orgRoles.create, { name, handle, team_id: users.team, provision: false });
    return t.run(async (ctx) => {
      const bot = await ctx.db.insert("users", { name, is_bot: true });
      const conv = await ctx.db.insert("conversations", {
        user_id: users[runner], team_id: users.team, agent_type: "claude_code", session_id: `sess-${handle}`,
        started_at: now, updated_at: now, message_count: 3, is_private: false, status: "active", short_id: `jx-${handle}`,
      } as any);
      const anchor = await ctx.db.insert("anchors", { scope_type: "team", team_id: users.team, bot_user_id: bot, host_user_id: users.ashot, conversation_id: conv, name, status: "active", org_role_id: r._id, created_at: now });
      await ctx.db.patch(r._id, { anchor_id: anchor, status } as any);
      const ids: Record<string, any> = {};
      for (const c of seeds) {
        const failed = c.status === "failed";
        ids[c.short_id] = await ctx.db.insert("agent_tasks", {
          user_id: users[c.owner], short_id: c.short_id, title: c.title ?? roleRoutineFor({ handle, name }).title, prompt: c.prompt ?? "Check your area.",
          originating_conversation_id: conv, schedule_type: c.schedule_type ?? "recurring", mode: "apply", status: c.status,
          ...(c.schedule_type === "event" ? { event_filter: { event_type: "session.needs_input" } } : { interval_ms: DAY, run_at: now - 40 * DAY }),
          ...(c.role === false ? {} : { role_id: r._id }),
          retry_count: failed ? 3 : 0, max_retries: 3, run_count: 2, created_at: now - 50 * DAY,
          last_run_at: now - 40 * DAY, last_run_failed: failed, last_run_summary: failed ? REFUSED : undefined,
        } as any);
      }
      return { role: r, conv, ids };
    });
  }
  const roles = {
    quality: await role("agent-quality", "Agent Quality lead", "samvit", [{ status: "failed", owner: "ashot", short_id: "tr-1154" }]),
    // Armed by hand with `cast trigger add`: no role id, its own title.
    calling: await role("calling", "Calling lead", "cam", [
      { status: "failed", owner: "ashot", short_id: "tr-1155" },
      { status: "scheduled", owner: "cam", short_id: "tr-7252", title: "Calling daily sweep", role: false, prompt: "Check your area. Run `cast brief` and act on what moved." },
    ]),
    // A replacement armed under the check's own title, still under the old account.
    escalations: await role("escalations", "Escalations lead", "cam", [
      { status: "failed", owner: "ashot", short_id: "tr-1509" },
      { status: "scheduled", owner: "ashot", short_id: "tr-8001", role: false },
    ]),
    // ADV1: someone's own CI watch on the seat is no reason to touch the check.
    growth: await role("growth", "Market Growth lead", "samvit", [
      { status: "failed", owner: "ashot", short_id: "tr-1151" },
      { status: "scheduled", owner: "samvit", short_id: "tr-9000", title: "Watch CI on main", role: false, prompt: "Watch CI on main and report red builds." },
    ]),
    // A dead check that never carried the role's id.
    ads: await role("paid-ads", "Paid Ads lead", "samvit", [{ status: "failed", owner: "ashot", short_id: "tr-2576", role: false }]),
    infra: await role("cold-email-infra-lead", "Volume lead", "samvit", []),
    desk: await role("desk", "Desk lead", "samvit", [
      { status: "failed", owner: "ashot", short_id: "tr-3452" },
      { status: "scheduled", owner: "ashot", short_id: "tr-3453", title: "A session under you needs input", schedule_type: "event" },
    ], "paused"),
  };
  return { t, users, roles };
}

// A created check's id exists only after the real run.
const line = (r: any) => `${r.action} @${r.handle} ${r.action === "create" ? "new" : r.trigger ?? "-"}${r.replaced_by ? ` ${r.action === "ambiguous" ? "vs" : "for"} ${r.replaced_by}` : ""}${r.owner ? ` ${r.owner.from}->${r.owner.to}` : ""}`;
const plan = (out: any) => out.rows.filter((r: any) => r.trigger || r.action === "create").map(line).sort();
const repair = (w: any, args: Record<string, unknown> = {}) => w.t.run((ctx: any) => performRepairRoleChecks(ctx, { team_id: w.users.team, ...args }));
const get = (w: any, id: any) => w.t.run((ctx: any) => ctx.db.get(id));
const checkFault = (w: any, r: any) => w.t.run(async (ctx: any) => {
  const role = await ctx.db.get(r.role._id);
  const t = await findRoleRoutineInAnyStatus(ctx, role, await ctx.db.get(r.conv));
  return checkFaultOf(t ? { trigger_id: String(t._id), short_id: t.short_id ?? null, title: t.title, status: t.status, run_at: t.run_at ?? null, last_run_at: t.last_run_at ?? null, last_run_summary: t.last_run_summary ?? null, interval_ms: t.interval_ms ?? null, last_run_failed: !!t.last_run_failed } : null);
});

test("the dry run lists every row and writes nothing", async () => {
  const w = await world();
  const before = await w.t.run((ctx: any) => ctx.db.query("agent_tasks").collect());
  const out = await repair(w);
  expect(out.dryRun).toBe(true);
  expect(plan(out)).toEqual([
    "adopt @escalations tr-8001 Ashot->Cam",
    "ambiguous @calling tr-7252 vs tr-1155",
    "cancel @escalations tr-1509 for tr-8001",
    "create @cold-email-infra-lead new",
    "rearm @agent-quality tr-1154 Ashot->Samvit",
    "rearm @growth tr-1151 Ashot->Samvit",
    "rearm @paid-ads tr-2576 Ashot->Samvit",
    "reown @desk tr-3453 Ashot->Samvit",
    "skip @desk tr-3452",
  ]);
  expect(out.rows.find((r: any) => r.action === "ambiguous")).toMatchObject({ title: "Calling daily sweep", check_title: "Check Calling lead's area" });
  expect(out.rows.find((r: any) => r.trigger === "tr-1154")?.reason).toContain("can only send messages to your own conversations");
  expect(await w.t.run((ctx: any) => ctx.db.query("agent_tasks").collect())).toEqual(before);
}, 60_000);

test("the real run writes exactly what the dry run listed, and a second run finds nothing left", async () => {
  const w = await world();
  const dry = await repair(w);
  const real = await repair(w, { dryRun: false });
  expect(plan(real)).toEqual(plan(dry));
  const { ids } = Object.values(w.roles).reduce((acc: any, r: any) => ({ ids: { ...acc.ids, ...r.ids } }), { ids: {} });
  const nameOf = { Ashot: w.users.ashot, Samvit: w.users.samvit, Cam: w.users.cam } as Record<string, any>;
  for (const row of dry.rows.filter((r: any) => r.trigger && ids[r.trigger])) {
    const t = await get(w, ids[row.trigger]);
    // Every owner change listed is the owner the row ends with.
    if (row.owner) expect(String(t.user_id)).toBe(String(nameOf[row.owner.to]));
    if (row.action === "rearm") expect(t).toMatchObject({ status: "scheduled", retry_count: 0, last_run_failed: false });
    if (row.action === "rearm" || row.action === "adopt") expect(t.role_id).toBeDefined();
    if (row.action === "cancel") expect(t.status).toBe("completed");
    if (row.action === "skip") expect(t.status).toBe("failed");
  }
  // ADV1: the unrelated CI watch is untouched and the check is back.
  expect(await get(w, w.roles.growth.ids["tr-9000"])).toMatchObject({ status: "scheduled", title: "Watch CI on main" });
  expect((await get(w, w.roles.growth.ids["tr-9000"])).role_id).toBeUndefined();
  // ADV2: an adopted check is the role's check and the role is not down; so is a re-armed one (ADV3).
  expect(await get(w, w.roles.escalations.ids["tr-8001"])).toMatchObject({ title: "Check Escalations lead's area", status: "scheduled" });
  expect(await checkFault(w, w.roles.escalations)).toBeNull();
  expect(await checkFault(w, w.roles.quality)).toBeNull();
  // Ambiguous: both left exactly as they were.
  expect(await get(w, w.roles.calling.ids["tr-1155"])).toMatchObject({ status: "failed" });
  expect((await get(w, w.roles.calling.ids["tr-7252"])).role_id).toBeUndefined();
  // Created under the seat's runner.
  const made = await w.t.run(async (ctx: any) => (await ctx.db.query("agent_tasks").collect()).find((t: any) => String(t.originating_conversation_id) === String(w.roles.infra.conv) && t.title === "Check Volume lead's area"));
  expect(String(made.user_id)).toBe(String(w.users.samvit));

  const again = await repair(w);
  expect(again.rows.filter((r: any) => !["skip", "ambiguous"].includes(r.action)).map(line)).toEqual([]);
}, 60_000);

test("a person names the look-alike: it becomes the role's check, the dead one is cancelled, and the role is not down", async () => {
  const w = await world();
  const out = await repair(w, { dryRun: false, adopt: ["tr-7252"] });
  expect(plan(out).filter((l: string) => l.includes("@calling"))).toEqual(["adopt @calling tr-7252", "cancel @calling tr-1155 for tr-7252"]);
  const adopted = await get(w, w.roles.calling.ids["tr-7252"]);
  expect(adopted).toMatchObject({ title: "Check Calling lead's area", status: "scheduled" });
  expect(String(adopted.role_id)).toBe(String(w.roles.calling.role._id));
  expect(await checkFault(w, w.roles.calling)).toBeNull();
}, 60_000);
