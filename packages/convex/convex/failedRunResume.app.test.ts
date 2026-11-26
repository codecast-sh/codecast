// The app's Resume (failedRunResume.ts resume): the signed-in owner resumes their own failed run at a station, as
// `cast workflow resume --at` does; anyone else is refused, whether or not they can see the run.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

async function seed(workspace: "personal" | "team") {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Owner" } as any);
    const mate = await ctx.db.insert("users", { name: "Mate" } as any);
    const stranger = await ctx.db.insert("users", { name: "Stranger" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: now } as any);
    for (const user of [owner, mate]) await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: now } as any);
    // A personal Ship that stopped at Landing unknown, on the owner's machine.
    const run = await ctx.db.insert("workflow_runs", {
      user_id: owner, status: "failed", current_node_id: "unknown", fail_reason: "It is not known whether this run landed",
      node_statuses: [{ node_id: "round", status: "completed", outcome: "success" }, { node_id: "land", status: "completed", outcome: "failure" }, { node_id: "unknown", status: "completed" }],
      runner_device: "dev-laptop", created_at: now, updated_at: now,
      ...(workspace === "team" ? { workspace: `team:${team}`, team_id: team } : { workspace: "personal" }),
    } as any);
    return { owner, mate, stranger, run };
  });
  const as = (user: string) => t.withIdentity({ subject: `${user}|session` });
  const runRow = () => t.run((ctx) => ctx.db.get(ids.run)) as Promise<any>;
  return { t, ...ids, as, runRow };
}

describe("Resume from the app", () => {
  test("the owner resumes their run at land, as a new attempt on its own machine", async () => {
    const s = await seed("personal");
    expect(await s.as(s.owner).mutation(api.failedRunResume.resume, { run_id: s.run, at: "land" })).toMatchObject({ run_id: s.run, resumed_at: "land", queued: false });
    expect(await s.runRow()).toMatchObject({ status: "running", current_node_id: "land" });
  });

  test("anyone else is refused, whether or not they can see the run, and the run stays as it stopped", async () => {
    const s = await seed("team");
    await expect(s.as(s.mate).mutation(api.failedRunResume.resume, { run_id: s.run, at: "land" })).rejects.toThrow("Only the run's owner resumes it");
    await expect(s.as(s.stranger).mutation(api.failedRunResume.resume, { run_id: s.run, at: "land" })).rejects.toThrow("Run not found");
    await expect(s.t.mutation(api.failedRunResume.resume, { run_id: s.run, at: "land" })).rejects.toThrow("Not signed in");
    expect(await s.runRow()).toMatchObject({ status: "failed", current_node_id: "unknown" });
  });
});
