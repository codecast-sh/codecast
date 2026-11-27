// The world the priorities read tests share (priorities.test.ts,
// priorities.teammates.test.ts): Ada and Bea in Acme, Cy in Other, Ada also in
// Off, where the feature is off; Ada owns every priority.
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import type { Id } from "./_generated/dataModel";

export const pri = (api as any).priorities;
export const TOKEN = "cc_test_priorities_ada";
export const CY_TOKEN = "cc_test_priorities_cy";
export const DAY = 86_400_000;
export const NOW = Date.now();

/** A list answer's rows. */
export const rowsOf = async (asUser: any, args: Record<string, unknown>) => (await asUser.query(pri.list, args)).priorities;

export const step = (key: string, tier: "critical" | "polish", done = false) => ({ key, title: `Step ${key}`, tier, tier_set_by: "pass" as const, refs: [], done });

/**
 * Ada and Bea share team Acme (priorities on); Cy is in team Other. Ada is
 * also in team Off, where the feature is off. Ada owns every priority.
 */
export async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada" } as any);
    const bea = await ctx.db.insert("users", { name: "Bea" } as any);
    const cy = await ctx.db.insert("users", { name: "Cy" } as any);
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: NOW, features: { priorities: true } } as any);
    const off = await ctx.db.insert("teams", { name: "Off", created_at: NOW } as any);
    for (const [u, team] of [[ada, acme], [bea, acme], [cy, other], [ada, off]] as const) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 } as any);
    }
    for (const [u, token] of [[ada, TOKEN], [cy, CY_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(token), name: "cli", created_at: NOW, last_used_at: NOW } as any);
    }

    const ws = `team:${acme}`;
    const insertPriority = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("priorities", {
      user_id: ada, workspace: ws, short_id, title: `Priority ${short_id}`, summary: "", status: "active",
      steps: [], first_seen_at: NOW - 10 * DAY, last_active_at: NOW - DAY, pass_at: NOW, created_at: NOW, updated_at: NOW, ...fields,
    } as any);
    const p1 = await insertPriority("pri-1", { ai_rank: 1, steps: [step("s1", "critical", true), step("s2", "critical"), step("s3", "polish")] });
    const p2 = await insertPriority("pri-2", { ai_rank: 2 });
    const p3 = await insertPriority("pri-3", { last_active_at: NOW - 2 * DAY });
    const p4 = await insertPriority("pri-4", { status: "done", done_at: NOW - DAY });
    const personal = await insertPriority("pri-5", { workspace: `user:${ada}`, ai_rank: 1 });
    const dark = await insertPriority("pri-6", { workspace: `team:${off}`, ai_rank: 1 });

    const conv = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
      user_id: ada, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: `Session ${short_id}`,
      started_at: NOW, updated_at: NOW, message_count: 3, is_private: false, team_visibility: "full", status: "active", ...fields,
    } as any);
    const c1 = await conv("jx7one1", { priority_id: p1, priority_step_key: "s2" });
    const c2 = await conv("jx7two2", {});
    const c3 = await conv("jx7pvt3", { priority_id: p1, priority_step_key: "s1", is_private: true, team_visibility: "private" });
    const c4 = await conv("jx7per4", { priority_id: personal });
    // A teammate reads a priority only through a session of it listed to the team: one each for pri-2..4.
    for (const [short_id, priority_id] of [["jx7two5", p2], ["jx7thr6", p3], ["jx7fou7", p4]] as const) await conv(short_id, { priority_id, updated_at: NOW - 2 * DAY });

    const send = async (user: Id<"users">, c: Id<"conversations">, timestamp: number, extra: Record<string, unknown> = {}) => {
      const message = await ctx.db.insert("messages", { conversation_id: c, role: "user", content: "x", timestamp } as any);
      await ctx.db.insert("user_sends", { user_id: user, team_id: acme, conversation_id: c, message_id: message, timestamp, words: 1, text: "x", clipped: false, ...extra } as any);
    };
    await send(ada, c1, NOW - 60_000);
    await send(ada, c1, NOW - DAY);
    await send(ada, c2, NOW - 60_000);
    await send(ada, c1, NOW - 60_000, { decision: { question: "q", picked: true } });
    for (let i = 0; i < 3; i++) await send(bea, c1, NOW - 60_000);
    return { ada, bea, cy, acme, off, ws, p1, p2, p3, p4, personal, dark, c1, c2, c3, c4 };
  });
  const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|session` });
  return { t, as, ...ids };
}
