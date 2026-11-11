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
//   default      the repo profile's `[line] project`, sent as default_project,
//                else the project its source's finders are published on as the
//                profile's default (a server filer, like an event source, has no
//                repo profile to send): where the problem is filed until Ground
//                places it, since the line starts only a problem in a project
//   none         nothing named a project and no profile publishes its source
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
 * Where a source's published finders put a signal. `source` settles it: every
 * published finder of this source declares a project of its own, and they
 * agree. A finder declares one with `single_purpose`; a finder published onto a
 * project that is not its profile's default could only get there by naming
 * that project, so it counts too (profiles published before the flag).
 * Otherwise `default` is the project a finder of this source is published on
 * as its profile's default, which only holds the problem until Ground places it.
 */
export async function sourcePlacement(ctx: { db: any }, workspace: string, source: string): Promise<Placement | null> {
  const want = source.trim().toLowerCase();
  const projects: Doc<"projects">[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).collect();
  const owners = new Set<string>();
  let profileDefault: Doc<"projects"> | null = null;
  for (const p of projects) {
    for (const f of p.line_profile?.finders ?? []) {
      if (f.source !== want) continue;
      if (!f.single_purpose && p.line_profile?.default !== false) profileDefault ??= p;
      else owners.add(String(p._id));
    }
  }
  if (!profileDefault && owners.size === 1) return { project_id: projects.find((p) => owners.has(String(p._id)))!._id, placed: "source" };
  return profileDefault ? { project_id: profileDefault._id, placed: "default" } : null;
}

/** Every step in order, for a signal filed in this workspace. `project` is the filer's; `default_project` the repo profile's. */
export async function placeSignal(ctx: { db: any }, workspace: string, signal: { source: string; subject?: string }, refs: { project?: string; default_project?: string }): Promise<Placement> {
  const expectation = await expectationProject(ctx, workspace, signal.subject);
  if (expectation) return { project_id: expectation, placed: "expectation" };
  const filer = await resolveWorkspaceProject(ctx as any, workspace, refs.project);
  if (filer) return { project_id: filer._id, placed: "filer" };
  const source = await sourcePlacement(ctx, workspace, signal.source);
  if (source?.placed === "source") return source;
  // A default that no longer resolves falls through rather than refusing the signal.
  const fallback = await resolveWorkspaceProject(ctx as any, workspace, refs.default_project).catch(() => null);
  if (fallback) return { project_id: fallback._id, placed: "default" };
  return source ?? { project_id: null, placed: "none" };
}

/** The project a signal's judge and new cause are scoped to: only a settled one; a default looks across the workspace. */
export const scopeProject = (p: Placement): Id<"projects"> | null => (isPlaced(p.placed) ? p.project_id : null);
