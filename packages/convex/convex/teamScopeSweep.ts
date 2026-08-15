import { v } from "convex/values";
import { internalMutation, internalAction } from "./functions";
import { internal } from "./_generated/api";
import { computeWorkspaceKey, linkedConversationId } from "./lib/access";

// Workspace reconciler + backfill for the stored ACCESS key on work items.
//
// Every task/plan/doc/project carries `workspace` ("team:<id>" | "user:<id>"),
// written at create and rewritten by recomputeWorkspaceForConversation when a
// linked conversation's visibility changes. A stored value can only go stale
// if that propagation misses a row, so this sweep is the proof: it recomputes
// the key from today's rules (linked conversation's team visibility, else the
// raw team tag, else personal to the row's OWNER) and reports every row whose
// stored key disagrees. With apply it writes the recomputed key — which is
// also the one-time backfill for rows minted before the field existed.
//
//   npx convex run teamScopeSweep:sweep '{}'                 # report only
//   npx convex run teamScopeSweep:sweep '{"apply": true}'    # backfill / repair
//
// The reconciler NEVER touches team_id: that is routing, and a mismatch
// between team_id and workspace is the legitimate "routed to team T, readable
// only by the owner" state, not drift.

const TABLES = ["tasks", "plans", "docs", "projects"] as const;

export const sweepPage = internalMutation({
  args: {
    table: v.union(v.literal("tasks"), v.literal("plans"), v.literal("docs"), v.literal("projects")),
    cursor: v.optional(v.string()),
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.query(args.table as any).paginate({
      cursor: (args.cursor || null) as any,
      numItems: 200,
    });

    const convCache = new Map<string, any>();
    const convOf = async (id: string | undefined) => {
      if (!id) return null;
      if (!convCache.has(id)) convCache.set(id, await ctx.db.get(id as any));
      return convCache.get(id) ?? null;
    };

    const findings: any[] = [];
    let missing = 0;
    let stale = 0;
    for (const row of page.page as any[]) {
      const conv = await convOf(linkedConversationId(row));
      const expected = computeWorkspaceKey(row, conv);
      const stored = typeof row.workspace === "string" && row.workspace ? row.workspace : undefined;
      if (stored === expected) continue;
      if (stored) stale++; else missing++;
      if (stored) {
        findings.push({
          table: args.table,
          short_id: row.short_id || String(row._id),
          title: row.title,
          stored,
          expected,
          reason: conv ? "linked conversation visibility" : "raw team tag / owner",
        });
      }
      if (args.apply) await ctx.db.patch(row._id, { workspace: expected });
    }

    return {
      findings,
      missing,
      stale,
      cursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
    };
  },
});

export const sweep = internalAction({
  args: { apply: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const findings: any[] = [];
    let scanned = 0;
    let missing = 0;
    let stale = 0;
    for (const table of TABLES) {
      let cursor: string | undefined;
      for (;;) {
        const res: any = await ctx.runMutation(internal.teamScopeSweep.sweepPage, {
          table,
          cursor,
          apply: args.apply,
        });
        findings.push(...res.findings);
        scanned += res.scanned;
        missing += res.missing;
        stale += res.stale;
        if (res.isDone) break;
        cursor = res.cursor;
      }
    }
    return { scanned, missing, stale, applied: !!args.apply, findings };
  },
});
