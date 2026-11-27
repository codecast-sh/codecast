// A run of a team's bot account (workflow_runs.ownsRun): the bot has no person of its own, so an admin of its team
// cancels and resumes the bot's runs in the team's workspace. Members, other teams' admins, a person's own run and the
// bot's private runs stay as they were.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

async function seed() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "Union", invite_code: "UNION123", created_at: now } as any);
    const other = await ctx.db.insert("teams", { name: "Other", invite_code: "OTHER123", created_at: now } as any);
    const admin = await ctx.db.insert("users", { name: "Admin" } as any);
    const member = await ctx.db.insert("users", { name: "Member" } as any);
    const person = await ctx.db.insert("users", { name: "Person" } as any);
    const otherAdmin = await ctx.db.insert("users", { name: "Other admin" } as any);
    const bot = await ctx.db.insert("users", { name: "Aivery", is_bot: true, team_id: team } as any);
    for (const [user, role] of [[admin, "admin"], [member, "member"], [person, "member"]] as const) {
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role, joined_at: now } as any);
    }
    await ctx.db.insert("team_memberships", { user_id: otherAdmin, team_id: other, role: "admin", joined_at: now } as any);
    // A line run that stopped at Landing unknown, on its account's own machine.
    const stopped = (user: any, workspace: string) => ctx.db.insert("workflow_runs", {
      user_id: user, status: "failed", current_node_id: "unknown", fail_reason: "It is not known whether this run landed",
      node_statuses: [{ node_id: "round", status: "completed", outcome: "success" }, { node_id: "land", status: "completed", outcome: "failure" }, { node_id: "unknown", status: "completed" }],
      runner_device: "mac-mini", created_at: now, updated_at: now, workspace, team_id: team,
    } as any);
    const waiting = (user: any) => ctx.db.insert("workflow_runs", {
      user_id: user, status: "running", current_node_id: "queue", node_statuses: [{ node_id: "queue", status: "running" }],
      runner_device: "mac-mini", created_at: now, updated_at: now, workspace: `team:${team}`, team_id: team,
    } as any);
    return {
      admin, member, person, otherAdmin, bot,
      botRun: await stopped(bot, `team:${team}`),
      personRun: await stopped(person, `team:${team}`),
      privateBotRun: await stopped(bot, `user:${bot}`),
      botWaiting: await waiting(bot),
      personWaiting: await waiting(person),
    };
  });
  const as = (user: string) => t.withIdentity({ subject: `${user}|session` });
  const row = (id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<any>;
  return { t, ...ids, as, row };
}

describe("a team's admins answer for its bot's runs", () => {
  test("an admin of the bot's team resumes the bot's run at a station", async () => {
    const s = await seed();
    expect(await s.as(s.admin).mutation(api.failedRunResume.resume, { run_id: s.botRun, at: "land" })).toMatchObject({ run_id: s.botRun, resumed_at: "land", queued: false });
    expect(await s.row(s.botRun)).toMatchObject({ status: "running", current_node_id: "land", user_id: s.bot });
  });

  test("an admin of the bot's team cancels the bot's waiting run", async () => {
    const s = await seed();
    await s.as(s.admin).mutation(api.workflow_runs.cancel, { id: s.botWaiting });
    expect(await s.row(s.botWaiting)).toMatchObject({ status: "failed", fail_reason: "Cancelled by user" });
  });

  test("a member who is not an admin is refused, and the bot's runs stay as they were", async () => {
    const s = await seed();
    await expect(s.as(s.member).mutation(api.failedRunResume.resume, { run_id: s.botRun, at: "land" })).rejects.toThrow("Only the run's owner resumes it");
    await expect(s.as(s.member).mutation(api.workflow_runs.cancel, { id: s.botWaiting })).rejects.toThrow("not your run");
    expect(await s.row(s.botRun)).toMatchObject({ status: "failed", current_node_id: "unknown" });
    expect(await s.row(s.botWaiting)).toMatchObject({ status: "running", current_node_id: "queue" });
  });

  test("a person's own run stays theirs, admin or not", async () => {
    const s = await seed();
    await expect(s.as(s.admin).mutation(api.failedRunResume.resume, { run_id: s.personRun, at: "land" })).rejects.toThrow("Only the run's owner resumes it");
    await expect(s.as(s.admin).mutation(api.workflow_runs.cancel, { id: s.personWaiting })).rejects.toThrow("not your run");
    expect(await s.row(s.personWaiting)).toMatchObject({ status: "running" });
  });

  test("the bot's private run and another team's admin get nothing", async () => {
    const s = await seed();
    await expect(s.as(s.admin).mutation(api.failedRunResume.resume, { run_id: s.privateBotRun, at: "land" })).rejects.toThrow("Run not found");
    await expect(s.as(s.otherAdmin).mutation(api.failedRunResume.resume, { run_id: s.botRun, at: "land" })).rejects.toThrow("Run not found");
    await expect(s.as(s.otherAdmin).mutation(api.workflow_runs.cancel, { id: s.botWaiting })).rejects.toThrow("Not found");
  });
});
