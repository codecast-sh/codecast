// Every device's checkouts of a repository (contracts/checkouts.ts, ct-98780):
// a daemon reports the checkouts its level sweep visits when one changes, and
// the pipeline page reads a team's. A row is keyed by device and path and
// lives in the repository's team's workspace (else the reporter's own), read
// through workspaceGrantsAccess like deploy_targets and pipelines.

import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { normalizeRepository } from "./lib/gitRefs";
import { findDeployTeam } from "./changesDeploy";
import { teamKey } from "./deployTargetsCi";
import { parseOwnerRepo } from "@codecast/shared/contracts";
import { checkoutHash, withPageAsks, type CheckoutPageAsk, type CheckoutReport } from "@codecast/shared/contracts/checkouts";

/** The most a single checkout's report may weigh (its lists are capped by the daemon). */
export const CHECKOUT_REPORT_MAX_BYTES = 64 * 1024;
const REPORTS_MAX = 100;

function refusal(r: any): string | null {
  if (!r || typeof r !== "object") return "a checkout report is an object";
  for (const k of ["repository", "device_id", "path"]) if (typeof r[k] !== "string" || !r[k]) return `a checkout report names its ${k}`;
  if (!r.level || !["level", "stuck", "off"].includes(r.level.state)) return `${r.path}: level.state is level, stuck or off`;
  if (!r.uncommitted || !Array.isArray(r.uncommitted.sessions) || !Array.isArray(r.uncommitted.unattributed)) return `${r.path}: uncommitted names its sessions and unattributed paths`;
  const bytes = new TextEncoder().encode(JSON.stringify(r)).length;
  return bytes > CHECKOUT_REPORT_MAX_BYTES ? `${r.path}: the report is ${bytes} bytes, over ${CHECKOUT_REPORT_MAX_BYTES}` : null;
}

/** A device's changed checkouts, each replacing its row, and the ones gone from disk removed. Only the device's owner reports it. */
export const report = mutation({
  args: { api_token: v.optional(v.string()), device_id: v.string(), reports: v.array(v.any()), gone: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const device = await ctx.db.query("devices").withIndex("by_user_device", (q) => q.eq("user_id", userId).eq("device_id", args.device_id)).first();
    if (!device) throw new Error(`${args.device_id} is not one of your devices`);
    if (args.reports.length > REPORTS_MAX) throw new Error(`at most ${REPORTS_MAX} checkouts a report`);
    const now = Date.now();
    const teams = new Map<string, Id<"teams"> | null>();
    let written = 0;
    for (const raw of args.reports as CheckoutReport[]) {
      const why = refusal(raw);
      if (why) throw new Error(why);
      if (raw.device_id !== args.device_id) throw new Error(`${raw.path}: reported for ${raw.device_id}, not ${args.device_id}`);
      const parsed = parseOwnerRepo(raw.repository);
      if (!parsed) throw new Error(`"${raw.repository}" is not an owner/name repository`);
      const repository = normalizeRepository(parsed);
      if (!teams.has(repository)) teams.set(repository, await findDeployTeam(ctx, userId, repository));
      const teamId = teams.get(repository) ?? null;
      const workspace = teamId ? teamKey(teamId) : `user:${userId}`;
      const { repository: _r, device_id: _d, path: _p, ...rest } = raw;
      const hash = checkoutHash(rest);
      const row: Doc<"checkouts"> | null = await ctx.db.query("checkouts").withIndex("by_device_path", (q) => q.eq("device_id", args.device_id).eq("path", raw.path)).first();
      const fields = { workspace, ...(teamId ? { team_id: teamId } : {}), repository, report: rest, hash, device_label: device.label || undefined, reporter_user_id: userId, reported_at: now, updated_at: now };
      if (row && row.hash === hash && row.workspace === workspace && row.device_label === fields.device_label) continue;
      if (row) await ctx.db.patch(row._id, { ...fields, ...(teamId ? {} : { team_id: undefined }) });
      else await ctx.db.insert("checkouts", { ...fields, device_id: args.device_id, path: raw.path });
      written++;
    }
    let removed = 0;
    for (const p of args.gone ?? []) {
      const row = await ctx.db.query("checkouts").withIndex("by_device_path", (q) => q.eq("device_id", args.device_id).eq("path", p)).first();
      if (row && row.reporter_user_id === userId) { await ctx.db.delete(row._id); removed++; }
    }
    return { written, removed };
  },
});

// The page's asks this episode read as told, beside the daemon's (contracts/checkouts withPageAsks).
const rowOut = (r: Doc<"checkouts">) => ({ ...(r.report ?? {}), ...(r.report?.level ? { level: withPageAsks(r.report.level, r.asks as CheckoutPageAsk[] | undefined) } : {}), _id: r._id, workspace: r.workspace, repository: r.repository, device_id: r.device_id, path: r.path, reported_at: r.reported_at, device_label: r.device_label ?? null });

/** A team's checkouts, every device's, of one repository or all of them: contracts/checkouts CheckoutRow. */
export const forTeam = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), repository: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const workspace = teamKey(args.team_id);
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return [];
    const parsed = args.repository ? parseOwnerRepo(args.repository) : null;
    const repository = parsed ? normalizeRepository(parsed) : null;
    const rows = await ctx.db
      .query("checkouts")
      .withIndex("by_workspace_repository", (q) => (repository ? q.eq("workspace", workspace).eq("repository", repository) : q.eq("workspace", workspace)))
      .take(500);
    return rows.map(rowOut);
  },
});
