import { v } from "convex/values";
import { Id } from "../_generated/dataModel";

// Charters on projects and plans (docs/architecture/org-staffing.md S7): the
// direction a role reads before its task list. ONE module owns the field
// validators, the patch (projects.update, projects.webUpdate, plans.update,
// plans.webUpdate), the owner resolution, and the one line a charter becomes
// in a role's frame, its brief and a hand's briefing.

export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];

const priorityValidator = v.union(v.literal("p0"), v.literal("p1"), v.literal("p2"), v.literal("p3"));

// The wire fields. `owner` is a role ref ("@handle", "or-N" or an id) resolved
// inside the row's boundary; null clears it. An empty list clears a list.
export const planCharterArgs = {
  success_metrics: v.optional(v.array(v.string())),
  priority: v.optional(v.union(priorityValidator, v.null())),
  owner: v.optional(v.union(v.string(), v.null())),
  non_goals: v.optional(v.array(v.string())),
};
export const projectCharterArgs = {
  ...planCharterArgs,
  goal: v.optional(v.string()),
  risks: v.optional(v.array(v.string())),
  budget: v.optional(v.union(v.object({ tokens_per_day: v.optional(v.number()), hands_per_day: v.optional(v.number()) }), v.null())),
};

export type CharterArgs = {
  goal?: string;
  success_metrics?: string[];
  priority?: Priority | null;
  owner?: string | null;
  non_goals?: string[];
  risks?: string[];
  budget?: { tokens_per_day?: number; hands_per_day?: number } | null;
};

export type CharterRow = {
  goal?: string | null;
  success_metrics?: string[] | null;
  priority?: string | null;
  owner_role_id?: Id<"org_roles"> | null;
  non_goals?: string[] | null;
  risks?: string[] | null;
};

const lines = (xs: string[] | undefined): string[] | undefined => {
  if (xs === undefined) return undefined;
  const out = xs.map((x) => x.trim()).filter(Boolean);
  return out.length ? out : undefined;
};

// A project or plan row names its boundary the way a role does: team_id, or
// the owner's user_id for a personal row.
export async function resolveOwnerRole(ctx: { db: any }, row: { team_id?: any; user_id: any }, ref: string): Promise<any> {
  const trimmed = ref.trim();
  const handle = trimmed.replace(/^@/, "").toLowerCase();
  const byHandle = row.team_id
    ? await ctx.db.query("org_roles").withIndex("by_team_handle", (q: any) => q.eq("team_id", row.team_id).eq("handle", handle)).first()
    : await ctx.db.query("org_roles").withIndex("by_scope_user_handle", (q: any) => q.eq("scope_user_id", row.user_id).eq("handle", handle)).first();
  let role = byHandle;
  if (!role) {
    role = await ctx.db.query("org_roles").withIndex("by_short_id", (q: any) => q.eq("short_id", trimmed)).first();
    if (!role) {
      const id = typeof ctx.db.normalizeId === "function" ? ctx.db.normalizeId("org_roles", trimmed) : trimmed;
      role = id ? await ctx.db.get(id) : null;
    }
  }
  if (!role || role.status === "retired") throw new Error(`No role ${trimmed} in this workspace`);
  const sameBoundary = row.team_id
    ? String(role.team_id ?? "") === String(row.team_id)
    : !role.team_id && String(role.scope_user_id ?? "") === String(row.user_id);
  if (!sameBoundary) throw new Error(`Role @${role.handle} is in another workspace`);
  return role;
}

// The patch a charter edit becomes. Undefined fields are untouched; an empty
// string, an empty list or null clears. Only the fields present on the table
// are written (a plan has no risks or budget).
export async function charterPatch(ctx: { db: any }, row: { team_id?: any; user_id: any }, args: CharterArgs, table: "projects" | "plans"): Promise<Record<string, any>> {
  const patch: Record<string, any> = {};
  if (args.goal !== undefined) patch.goal = args.goal.trim() || undefined;
  if (args.success_metrics !== undefined) patch.success_metrics = lines(args.success_metrics);
  if (args.priority !== undefined) {
    if (args.priority !== null && !(PRIORITIES as readonly string[]).includes(args.priority)) throw new Error(`Priority must be one of ${PRIORITIES.join(", ")}`);
    patch.priority = args.priority ?? undefined;
  }
  if (args.owner !== undefined) patch.owner_role_id = args.owner === null || !args.owner.trim() ? undefined : (await resolveOwnerRole(ctx, row, args.owner))._id;
  if (args.non_goals !== undefined) patch.non_goals = lines(args.non_goals);
  if (table === "projects") {
    if (args.risks !== undefined) patch.risks = lines(args.risks);
    if (args.budget !== undefined) {
      const b = args.budget;
      const clean = b && (b.tokens_per_day !== undefined || b.hands_per_day !== undefined)
        ? { ...(b.tokens_per_day !== undefined ? { tokens_per_day: b.tokens_per_day } : {}), ...(b.hands_per_day !== undefined ? { hands_per_day: b.hands_per_day } : {}) }
        : undefined;
      for (const n of Object.values(clean ?? {})) if (typeof n !== "number" || n < 0) throw new Error("A budget is a non-negative number");
      patch.budget = clean;
    }
  }
  return patch;
}

export function hasCharter(row: CharterRow | null | undefined): boolean {
  return !!row && !!(row.goal || row.priority || row.success_metrics?.length);
}

// The line a charter becomes wherever a role or a hand reads it: the frame's
// "Your scope now", the brief's facts, a hand's briefing. Null when the row
// has no goal, priority or metrics, so a surface never prints an empty one.
export function charterLine(label: string, row: CharterRow | null | undefined): string | null {
  if (!hasCharter(row)) return null;
  const r = row!;
  const parts: string[] = [`${label}${r.priority ? ` [${r.priority}]` : ""}`];
  if (r.goal) parts.push(`goal: ${r.goal.trim()}`);
  if (r.success_metrics?.length) parts.push(`metrics: ${r.success_metrics.join("; ")}`);
  return parts.join(" · ");
}
