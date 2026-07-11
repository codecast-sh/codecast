import { v } from "convex/values";
import { internalMutation, internalAction } from "./functions";
import { internal } from "./_generated/api";
import { teamVisibleConvTeam, resolveTeamForPath, DirectoryMapping } from "./privacy";

// Sweep for misfiled work items: tasks/plans/docs whose team_id contradicts
// what creation resolves today (directory mapping of the owner, or a
// team-visible linked conversation). These rows were minted by the old
// active-team fallback, which attached items from private ("Only Me")
// directories to the creator's team — e.g. ct-38419.
//
// Run read-only first, then apply:
//   npx convex run teamScopeSweep:sweep '{}'
//   npx convex run teamScopeSweep:sweep '{"apply": true}'
//
// Rows with no linked conversation AND no project_path are skipped — there is
// nothing to contradict, and an explicit team choice in the web UI looks
// exactly like that. Expected scope mirrors the creation flow: a team-visible
// linked conversation wins; otherwise the owner's directory mapping for the
// item's path decides; unmapped means personal (team_id cleared).

const TABLES = ["tasks", "plans", "docs"] as const;

function linkedConvId(row: any): any {
  return (
    row.created_from_conversation ||
    row.conversation_ids?.[0] ||
    row.created_from_conversation_id ||
    row.conversation_id ||
    undefined
  );
}

export const sweepPage = internalMutation({
  args: {
    table: v.union(v.literal("tasks"), v.literal("plans"), v.literal("docs")),
    cursor: v.optional(v.string()),
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.query(args.table as any).paginate({
      cursor: (args.cursor || null) as any,
      numItems: 200,
    });

    const mappingsByUser = new Map<string, DirectoryMapping[]>();
    const nameCache = new Map<string, string>();
    const nameOf = async (id: any): Promise<string> => {
      if (!id) return "(personal)";
      const key = String(id);
      if (!nameCache.has(key)) {
        const doc = await ctx.db.get(id);
        nameCache.set(key, (doc as any)?.name || (doc as any)?.github_username || key);
      }
      return nameCache.get(key)!;
    };

    const findings: any[] = [];
    for (const row of page.page as any[]) {
      if (!row.team_id) continue;

      let expected: any = undefined;
      let reason = "";
      let determinate = false;

      const cid = linkedConvId(row);
      if (cid) {
        const conv = await ctx.db.get(cid);
        if (conv) {
          determinate = true;
          expected = teamVisibleConvTeam(conv as any);
          reason = expected ? "team-visible conversation" : "private conversation";
        }
      }

      const path = row.project_path || row.git_root;
      if (!expected && path) {
        let mappings = mappingsByUser.get(String(row.user_id));
        if (!mappings) {
          mappings = (await ctx.db
            .query("directory_team_mappings")
            .withIndex("by_user_id", (q: any) => q.eq("user_id", row.user_id))
            .collect()) as any;
          mappingsByUser.set(String(row.user_id), mappings!);
        }
        const r = resolveTeamForPath(mappings!, path, undefined);
        expected = r.teamId;
        determinate = true;
        reason = expected
          ? "directory mapping"
          : `${reason ? reason + ", " : ""}unmapped path`;
      }

      if (!determinate) continue;
      if (String(expected || "") === String(row.team_id || "")) continue;

      findings.push({
        table: args.table,
        short_id: row.short_id || String(row._id),
        title: row.title,
        owner: await nameOf(row.user_id),
        project_path: path || null,
        current_team: await nameOf(row.team_id),
        expected_team: await nameOf(expected),
        reason,
      });
      if (args.apply) {
        await ctx.db.patch(row._id, { team_id: expected });
      }
    }

    return {
      findings,
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
        if (res.isDone) break;
        cursor = res.cursor;
      }
    }
    return { scanned, misfiled: findings.length, applied: !!args.apply, findings };
  },
});
