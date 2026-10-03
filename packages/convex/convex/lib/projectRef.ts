import type { Doc } from "../_generated/dataModel";
import { matchProject } from "@codecast/shared/contracts/projectRef";
import { notFound } from "./auth";

// A `--project` ref (an id, a short id, or a title substring) resolved inside
// ONE workspace: the one a write lands in, or the one a read was scoped to
// (line-profile.md LP1). Projects are read by their access key, so a project
// of another workspace never matches, whatever its title. The matching rule
// is the CLI's own (shared/contracts/projectRef).

type Ctx = { db: any };

/** The project the ref names in `workspaceKey`; null for an empty ref. */
export async function resolveWorkspaceProject(ctx: Ctx, workspaceKey: string, ref: string | undefined): Promise<Doc<"projects"> | null> {
  const needle = ref?.trim();
  if (!needle) return null;
  const id = ctx.db.normalizeId("projects", needle);
  if (id) {
    const project = await ctx.db.get(id);
    if (!project || project.workspace !== workspaceKey) notFound(`Project ${needle} is not in this workspace`);
    return project;
  }
  const rows: Doc<"projects">[] = await ctx.db
    .query("projects")
    .withIndex("by_workspace", (q: any) => q.eq("workspace", workspaceKey))
    .take(2000);
  const match = matchProject(rows.map((p) => ({ _id: String(p._id), short_id: p.short_id, title: p.title })), needle);
  if (match.kind === "one" || match.kind === "id") return rows.find((p) => String(p._id) === match.id) ?? null;
  if (match.kind === "ambiguous") {
    throw new Error(`Project "${needle}" is ambiguous in this workspace: ${match.matches.map((p) => `${p.short_id ?? p._id} ${p.title}`).join("; ")}`);
  }
  notFound(`No project matching "${needle}" in this workspace (cast project ls)`);
}
