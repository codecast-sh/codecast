// Deploy backfill (docs/architecture/deploys.md DP6): the run.sh tools that
// record deploy markers already in external_events as deploys, and recompute
// the carries of deploys recorded from markers.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import { normalizeRepository } from "./lib/gitRefs";
import { normalizeDeployTarget } from "@codecast/shared/contracts/deploys";
import { carriesForMarker, recordDeployMarker, type DeployMarker } from "./deploys";

/**
 * Record every deploy marker already in external_events as a deploy object,
 * oldest first so each one's carries read the deploys before it. Idempotent:
 * a marker whose meta.deploy is set is skipped. One source or repository per
 * call; `dry` counts without writing.
 */
export const backfill = internalMutation({
  args: {
    source_id: v.optional(v.id("event_sources")),
    repository: v.optional(v.string()),
    // Resume after this created_at (the last call's `next`).
    since: v.optional(v.number()),
    dry: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const PAGE = 3000;
    const since = args.since ?? 0;
    let events: any[] = [];
    if (args.source_id) {
      events = await ctx.db.query("external_events").withIndex("by_source_created", (q: any) => q.eq("source_id", args.source_id).gt("created_at", since)).order("asc").take(PAGE);
    } else if (args.repository) {
      events = await ctx.db.query("external_events").withIndex("by_repository_created", (q: any) => q.eq("repository", normalizeRepository(args.repository!)).gt("created_at", since)).order("asc").take(PAGE);
    } else throw new Error("pass source_id or repository");
    let next: number | null = events.length === PAGE ? events[events.length - 1].created_at : null;
    const markers = events.filter((e) => e.kind === "deploy");
    // Each recorded marker reads the workspace's merges and deploys: a few per call keeps a call well under its read limit.
    const PER_CALL = 10;
    let recorded = 0, skipped = 0, notLive = 0;
    for (const e of markers) {
      if (e.meta?.deploy) { skipped++; continue; }
      if (recorded >= PER_CALL) { next = e.created_at - 1; break; }
      const marker = await markerOfEvent(ctx, e);
      if (!marker) { notLive++; continue; }
      if (args.dry) { recorded++; continue; }
      const id = await recordDeployMarker(ctx, marker);
      if (id) recorded++; else notLive++;
    }
    return { markers: markers.length, recorded, skipped, not_live: notLive, dry: !!args.dry, next };
  },
});

/** The marker a stored deploy event describes, in the shape recordDeployMarker takes. */
export async function markerOfEvent(ctx: any, e: any): Promise<DeployMarker | null> {
  const target = normalizeDeployTarget(e.meta?.surface ?? e.data?.environment ?? null) ?? "deploy";
  let workspace: string | null = e.workspace ?? null;
  if (e.source_id) {
    const source = await ctx.db.get(e.source_id);
    workspace = workspace ?? source?.workspace ?? null;
  }
  if (!workspace && e.team_id) workspace = `team:${e.team_id}`;
  if (!workspace) return null;
  const actor = e.actor_user_id ? await ctx.db.get(e.actor_user_id) : null;
  return {
    workspace,
    ...(e.team_id ? { team_id: e.team_id } : {}),
    target,
    ...(e.sha ? { sha: e.sha } : {}),
    ...(e.meta?.version ?? e.data?.release ? { version: e.meta?.version ?? e.data?.release } : {}),
    ...(e.repository ? { repository: e.repository } : {}),
    source: e.data?.source_name ?? (e.source === "codecast" ? "cast ship mark" : e.source),
    ...(e.source_id ? { source_id: e.source_id } : {}),
    event_id: e._id,
    ...(actor ? { started_by: { kind: "person" as const, name: actor.name ?? actor.github_username ?? "someone", user_id: actor._id } } : e.source_id ? { started_by: { kind: "source" as const, name: e.data?.source_name ?? "source" } } : {}),
    at: e.created_at,
  };
}

/** The sources and repositories the backfill walks (deploys.md DP6): run.sh deploysBackfill:backfillTargets. */
export const backfillTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sources = await ctx.db.query("event_sources").take(500);
    const repos = new Set<string>();
    for (const r of await ctx.db.query("repo_sources").take(2000)) repos.add(normalizeRepository(r.repository));
    return { sources: sources.map((s: any) => ({ _id: String(s._id), name: s.name })), repositories: [...repos].sort() };
  },
});

/**
 * Recompute the carries of deploys recorded from markers (trigger outside),
 * oldest first, after the merges the rule reads changed (landed fixes joined
 * them). A deploy the line sent keeps what it sent. Ten per call; pass the
 * returned `next` as `since` until it is null.
 */
export const recarry = internalMutation({
  args: { workspace: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const PER_CALL = 10;
    const rows = await ctx.db
      .query("deploys")
      .withIndex("by_workspace_created", (q: any) => q.eq("workspace", args.workspace).gt("created_at", args.since ?? 0))
      .order("asc")
      .take(PER_CALL);
    const now = Date.now();
    let changed = 0;
    for (const d of rows) {
      if (d.trigger !== "outside" || d.status !== "live") continue;
      // A marker's deploy names no project (it ships the code); one recorded before that rule lets go of its project.
      const wide = d.project_id ? { ...d, project_id: undefined } : d;
      const carries = await carriesForMarker(ctx, wide, now);
      if (d.project_id || JSON.stringify(carries) !== JSON.stringify(d.carries)) { await ctx.db.patch(d._id, { carries, project_id: undefined, updated_at: now }); changed++; }
    }
    return { read: rows.length, changed, next: rows.length === PER_CALL ? rows[rows.length - 1].created_at : null };
  },
});
