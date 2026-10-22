// Where a signal's problem lives (docs/architecture/the-line-model.md LM1,
// line-profile.md LP1): decided by what the problem is about, never by the
// finder that saw it. In order:
//
//   expectation  its subject is the expectation it breaks, `ex-<prefix>-<n>`,
//                and the prefix names the project holding that expectation
//   filer        the filer named the project (`cast signal add --project`, a
//                product that computes it per signal, an event source's own
//                project)
//   source       every finder declaring its source names one project of its
//                own: a single-purpose source (LP3)
//   default      the repo profile's `[line] project`, sent as default_project:
//                where the problem is filed until Ground places it
//   none         nothing named a project; Ground places it
//
// Nothing declares that a project owns a metric, surface or file today, so no
// step reads a subject that way; an initiative metric names the projects it
// carries, which is several, not an owner.
//
// The first three settle the project. The last two leave it to Ground
// (lineGround.ts), which names the project in the same call that grounds the
// cause and records `placed: "ground"`; until then only a settled project
// scopes the attach judge or is recorded apart.
import type { Doc, Id } from "../_generated/dataModel";
import { expectationIdPrefix, isExpectationId } from "@codecast/shared/contracts/expectations";
import { resolveWorkspaceProject } from "./projectRef";
import type { Placed } from "./signalPlacedValidator";

export type { Placed };

export type Placement = { project_id: Id<"projects"> | null; placed: Placed };

/** Whether a project was decided by what the problem is about, so nothing moves it. */
export const isPlaced = (placed: Placed): boolean => placed !== "default" && placed !== "none";

/** The project holding the expectation a subject cites, in this workspace; null for any other subject. */
export async function expectationProject(ctx: { db: any }, workspace: string, subject: string | undefined): Promise<Id<"projects"> | null> {
  if (!isExpectationId(subject)) return null;
  const doc = await ctx.db.query("project_expectations").withIndex("by_workspace_prefix", (q: any) => q.eq("workspace", workspace).eq("prefix", expectationIdPrefix(subject))).first();
  return doc?.project_id ?? null;
}

/**
 * The project a single-purpose source files into: every published finder of
 * this source in the workspace declares a project of its own, and they agree.
 * A finder declares one with `single_purpose`; a finder published onto a
 * project that is not its profile's default could only get there by naming
 * that project, so it counts too (profiles published before the flag).
 */
export async function sourceProject(ctx: { db: any }, workspace: string, source: string): Promise<Id<"projects"> | null> {
  const want = source.trim().toLowerCase();
  const projects: Doc<"projects">[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).collect();
  const owners = new Set<string>();
  let any = false;
  for (const p of projects) {
    for (const f of p.line_profile?.finders ?? []) {
      if (f.source !== want) continue;
      any = true;
      if (!f.single_purpose && p.line_profile?.default !== false) return null;
      owners.add(String(p._id));
    }
  }
  if (!any || owners.size !== 1) return null;
  return projects.find((p) => owners.has(String(p._id)))!._id;
}

/** Every step in order, for a signal filed in this workspace. `project` is the filer's; `default_project` the repo profile's. */
export async function placeSignal(ctx: { db: any }, workspace: string, signal: { source: string; subject?: string }, refs: { project?: string; default_project?: string }): Promise<Placement> {
  const expectation = await expectationProject(ctx, workspace, signal.subject);
  if (expectation) return { project_id: expectation, placed: "expectation" };
  const filer = await resolveWorkspaceProject(ctx as any, workspace, refs.project);
  if (filer) return { project_id: filer._id, placed: "filer" };
  const source = await sourceProject(ctx, workspace, signal.source);
  if (source) return { project_id: source, placed: "source" };
  // A default that no longer resolves files nowhere rather than refusing the signal.
  const fallback = await resolveWorkspaceProject(ctx as any, workspace, refs.default_project).catch(() => null);
  return fallback ? { project_id: fallback._id, placed: "default" } : { project_id: null, placed: "none" };
}

/** The project a signal's judge and new cause are scoped to: only a settled one; a default looks across the workspace. */
export const scopeProject = (p: Placement): Id<"projects"> | null => (isPlaced(p.placed) ? p.project_id : null);
