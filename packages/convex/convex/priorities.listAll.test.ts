// priorities.list with no workspace, as /priorities and the inbox feed it:
// every workspace the viewer holds in one answer, the pass timing of the one
// `timing_for` names (the viewer's active workspace), and each row's owner's face.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(60_000);

const pri = (api as any).priorities;
const NOW = Date.now();
const HOUR = 3_600_000;

test("a list of every workspace carries the timing of the workspace timing_for names, and each row its owner's face", async () => {
  const t = convexTest(schema, allModules);
  const { ada, ws } = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada", image: "https://faces.test/ada.png" } as any);
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } } as any);
    await ctx.db.insert("team_memberships", { user_id: ada, team_id: acme, role: "member", joined_at: 1 } as any);
    const row = { user_id: ada, summary: "", status: "active", steps: [], first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW, ai_rank: 1 };
    await ctx.db.insert("priorities", { ...row, workspace: `team:${acme}`, short_id: "pri-1", title: "Team one" } as any);
    await ctx.db.insert("priorities", { ...row, workspace: `user:${ada}`, short_id: "pri-2", title: "Personal one" } as any);
    await ctx.db.insert("priority_pass_runs", { user_id: ada, workspace: `team:${acme}`, started_at: NOW - 9 * HOUR, finished_at: NOW - 9 * HOUR, status: "ok", cursor_at: NOW - 8 * HOUR, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } } as any);
    return { ada: ada as Id<"users">, ws: `team:${acme}` };
  });
  const as = t.withIdentity({ subject: `${ada}|session` });

  const all = await as.query(pri.list, {});
  expect(all.priorities.map((r: any) => r.short_id).sort()).toEqual(["pri-1", "pri-2"]);
  expect(all.behind_by_ms).toBeNull();
  const timed = await as.query(pri.list, { timing_for: ws });
  expect(timed.priorities.map((r: any) => r.short_id).sort()).toEqual(["pri-1", "pri-2"]);
  expect(Math.floor(timed.behind_by_ms / HOUR)).toBe(8);
  expect(timed.priorities.every((r: any) => r.owner_image === "https://faces.test/ada.png")).toBe(true);
  // A workspace the viewer does not hold times nothing.
  expect((await as.query(pri.list, { timing_for: "team:nobody" })).behind_by_ms).toBeNull();
});
