// TEMPORARY read profiler for ct-87999. Remove before handoff.
import { internalAction, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { computeOrgHealth } from "./orgHealth";
import { collectOrgSessions } from "./org";

const TABLES = ["conversations", "users", "docs", "tasks", "plans", "projects", "session_decisions", "org_roles", "org_anchors", "messages", "pending_messages", "chat_messages", "chat_channels", "agent_tasks", "team_memberships", "decision_inbox", "workflow_runs", "triggers"];

export const core = internalQuery({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")), now: v.number(), work: v.any(), decisions: v.any(), stage: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const tally: Record<string, { n: number; b: number }> = {};
    let total = 0;
    const rec = (key: string, d: any) => {
      if (!d) return;
      const t = (tally[key] ??= { n: 0, b: 0 });
      t.n++; t.b += JSON.stringify(d).length;
      if (++total % 2000 === 0) console.log("tally", total, JSON.stringify(tally));
    };
    const db: any = ctx.db;
    const wrapQ = (q: any, table: string): any => new Proxy(q, {
      get(t, p) {
        const val = t[p];
        if (p === Symbol.asyncIterator) return () => { const it = t[Symbol.asyncIterator](); return { next: async () => { const r = await it.next(); if (!r.done) rec(table, r.value); return r; } }; };
        if (p === "take" || p === "collect") return async (...a: any[]) => { const rows = await val.apply(t, a); for (const r of rows) rec(table, r); return rows; };
        if (p === "first" || p === "unique") return async () => { const r = await val.apply(t); rec(table, r); return r; };
        if (p === "paginate") return async (...a: any[]) => { const r = await val.apply(t, a); for (const x of r.page) rec(table, x); return r; };
        if (typeof val === "function") return (...a: any[]) => { const r = val.apply(t, a); return r && typeof r === "object" ? wrapQ(r, table) : r; };
        return val;
      },
    });
    const proxy = new Proxy(db, {
      get(t, p) {
        if (p === "query") return (table: string) => wrapQ(t.query(table), table);
        if (p === "get") return async (id: any) => { const d = await t.get(id); const table = TABLES.find((tb) => { try { return t.normalizeId(tb, String(id)) !== null; } catch { return false; } }) ?? "get:?"; rec(`get:${table}`, d); return d; };
        const val = t[p];
        return typeof val === "function" ? val.bind(t) : val;
      },
    });
    const pctx = new Proxy(ctx as any, { get: (t, p) => (p === "db" ? proxy : t[p]) });
    const argBytes = JSON.stringify(args.work).length;
    if (args.stage === "scan") {
      const scan = await collectOrgSessions(pctx, args.user_id, args.team_id, args.now);
      let rawBytes = 0; for (const { raw } of scan.sessions.values()) rawBytes += JSON.stringify(raw).length;
      return { argBytes, total, tally, sessions: scan.sessions.size, rawBytes, roles: scan.roles.length, anchors: scan.anchors.length, members: scan.memberIds.length, truncated: scan.truncated };
    }
    const health = await computeOrgHealth(pctx, args.user_id, args.team_id, args.now, { work: args.work, decisions: args.decisions });
    console.log("final", total, JSON.stringify(tally));
    return { argBytes, total, tally, roles: health.roles.length };
  },
});

export const run = internalAction({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")), stage: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const now = Date.now();
    const [decisions, work] = await Promise.all([
      ctx.runQuery((internal as any).orgWatch.decisionsPart, { ...args, now }),
      ctx.runQuery((internal as any).orgWatch.workPart, { ...args, now }),
    ]);
    return ctx.runQuery((internal as any).zzOrgHealthProfile.core, { ...args, now, work, decisions });
  },
});
