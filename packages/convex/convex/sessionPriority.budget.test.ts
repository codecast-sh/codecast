// The Deploys board names the priority each session serves, with its rank as
// the viewer reads it (lib/sessionPriority, the reader deployTargetsState's
// queue and deploy lines use): its owners' active groups are read once per
// owner and workspace, however many sessions and priorities the board holds.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { sessionPriorityReader } from "./lib/sessionPriority";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(120_000);
const NOW = Date.now();
const PER_OWNER = 30;

test("a board of sixty sessions over sixty priorities reads each owner's group once and stays small", async () => {
  const t = convexTest(schema, allModules);
  const { bea, acme, convs } = await t.run(async (ctx: any) => {
    const ada = await ctx.db.insert("users", { name: "Ada" });
    const bea = await ctx.db.insert("users", { name: "Bea" });
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } });
    for (const u of [ada, bea]) await ctx.db.insert("team_memberships", { user_id: u, team_id: acme, role: "member", joined_at: 1 });
    const convs: Id<"conversations">[] = [];
    let n = 0;
    for (const owner of [ada, bea]) {
      for (let rank = 1; rank <= PER_OWNER; rank++) {
        const p = await ctx.db.insert("priorities", {
          user_id: owner, workspace: `team:${acme}`, short_id: `pri-${n++}`, title: "p", summary: "", status: "active", ai_rank: rank, steps: [],
          first_seen_at: NOW, last_active_at: NOW - rank, pass_at: NOW, created_at: NOW, updated_at: NOW,
        });
        convs.push(await ctx.db.insert("conversations", {
          user_id: owner, team_id: acme, agent_type: "claude_code", session_id: `s${n}`, short_id: `jx7s${n}`, title: "s",
          started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p,
        }));
      }
    }
    return { bea, acme, convs };
  });
  const { groups, calls, docs, ranks } = await t.run(async (ctx: any) => {
    let groups = 0, calls = 0, docs = 0;
    const tally = (r: any) => { docs += Array.isArray(r) ? r.length : r ? 1 : 0; return r; };
    const wrap = (q: any, table: string): any => new Proxy(q, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v !== "function") return v;
        return (...args: any[]) => {
          if (prop === "withIndex" && table === "priorities" && args[0] === "by_user_workspace_status_active") groups++;
          const out = v.apply(target, args);
          if (["first", "take", "collect", "unique"].includes(String(prop))) { calls++; return Promise.resolve(out).then(tally); }
          return out && typeof out === "object" && typeof out.then !== "function" ? wrap(out, table) : out;
        };
      },
    });
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        const v = target[prop];
        if (prop === "get") return (...args: any[]) => (calls++, Promise.resolve(v.apply(target, args)).then(tally));
        if (prop === "query") return (...args: any[]) => wrap(v.apply(target, args), String(args[0]));
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const counted = { ...ctx, db };
    const priorityOf = await sessionPriorityReader(counted, bea, acme);
    const ranks: Array<number | null> = [];
    for (const id of convs) ranks.push((await priorityOf(await ctx.db.get(id)))?.rank ?? null);
    return { groups, calls, docs, ranks };
  });
  console.log(`deploys board priorities: ${groups} group reads, ${calls} db calls, ${docs} documents for ${convs.length} sessions`);
  expect(groups).toBe(2);
  expect(ranks.filter((r) => r != null)).toHaveLength(2 * PER_OWNER);
  expect(docs).toBeLessThan(1_000);
});
