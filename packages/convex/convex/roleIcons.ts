// Role icons (org-staffing.md S13, shared/contracts/roleIcon): the drawn face
// that says what a role looks after. Set by hand (`cast role icon --svg`, an
// agent drawing to ROLE_ICON_LANGUAGE) or drawn by the generator
// (lib/roleIconGenerator) when a role is hired, on a Redraw, or by the
// backfill. Every write goes through performSetRoleIcon's checks: valid
// shapes, a concept no other live role in the boundary holds, an accent.
//
// Model spend: the generator runs on the deployment's own key like the other
// codecast features that call a model for the product itself (titles, the
// router, template learning), not on a team's model budget (lib/teamBudget),
// which meters the calls a product's own loop makes inside a cap its people
// set. About seven Opus calls a drawing; the action reports what it cost.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { requireRole, resolveRoleRef, rolesInBoundary, userCanAccessRole } from "./lib/orgAccess";
import { callModelMetered, modelCost } from "./lib/anthropic";
import { roleIconValidator } from "./lib/roleIconValidator";
import { ICON_MODEL, generateRoleIcon, type Ask, type IconBrief } from "./lib/roleIconGenerator";
import {
  ROLE_ICON_LANGUAGE, isRoleIcon, normalizeConcept, parseRoleIconSvg, pickRoleIconAccent, roleIconProblems, roleIconSvg,
  type RoleIcon, type RoleIconAccent,
} from "@codecast/shared/contracts/roleIcon";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";

type Ctx = { db: any; storage?: any };

/** The boundary's other live roles that wear a valid icon. */
async function siblingIcons(ctx: Ctx, role: any): Promise<Array<{ role: any; icon: RoleIcon }>> {
  const roles = await rolesInBoundary(ctx, role);
  return roles.filter((r) => String(r._id) !== String(role._id) && isRoleIcon(r.icon)).map((r) => ({ role: r, icon: r.icon as RoleIcon }));
}

export type SetIconInput = { icon?: RoleIcon; svg?: string; concept?: string; accent?: RoleIconAccent };

/**
 * The one write: an icon given whole, or hand-drawn SVG plus its concept.
 * The concept must be free in the boundary; the accent, when not given, is
 * the role's current one, else the hue its siblings use least. Throws a
 * sentence the drawer can act on, every problem at once.
 */
export async function performSetRoleIcon(ctx: Ctx, role: any, input: SetIconInput, opts: { preview_id?: Id<"_storage"> } = {}): Promise<RoleIcon> {
  if (role.status === "retired") throw new Error("That role is retired");
  const siblings = await siblingIcons(ctx, role);
  let icon: RoleIcon;
  if (input.icon) {
    icon = input.icon;
  } else {
    if (typeof input.svg !== "string" || !input.svg.trim()) throw new Error("Give the icon as svg with a concept (cast role icon @handle --svg file --concept \"coin\")");
    const parsed = parseRoleIconSvg(input.svg);
    if (parsed.problems.length) throw new Error(`The SVG can't be used: ${parsed.problems.join("; ")}`);
    icon = { v: 1, concept: (input.concept ?? "").trim(), accent: undefined as any, shapes: parsed.shapes };
  }
  const accent = input.accent ?? (input.icon ? input.icon.accent : undefined) ?? (isRoleIcon(role.icon) ? role.icon.accent : pickRoleIconAccent(siblings.map((s) => s.icon.accent), String(role._id)));
  icon = { ...icon, concept: icon.concept.trim(), accent };
  const problems = roleIconProblems(icon);
  if (problems.length) throw new Error(`The icon can't be used: ${problems.join("; ")}`);
  const holder = siblings.find((s) => normalizeConcept(s.icon.concept) === normalizeConcept(icon.concept));
  if (holder) throw new Error(`"${icon.concept}" is already the icon of @${holder.role.handle} (${holder.role.name}); every role in a workspace needs its own concept, so draw a different object`);
  // A preview belongs to the drawing it shows: a new icon replaces it, and a
  // hand-drawn one has none.
  if (role.icon_preview_id && String(role.icon_preview_id) !== String(opts.preview_id ?? "")) await ctx.storage?.delete(role.icon_preview_id).catch(() => {});
  await ctx.db.patch(role._id, { icon, icon_preview_id: opts.preview_id, updated_at: Date.now() });
  return icon;
}

// `cast role icon @handle --svg <file> --concept <c>` and any surface that
// sets an icon directly. The same gate as the avatar: whoever may reshape
// the role, its own agent included.
export const setIcon = mutation({
  args: {
    api_token: v.optional(v.string()),
    role_id: v.string(),
    icon: v.optional(roleIconValidator),
    svg: v.optional(v.string()),
    concept: v.optional(v.string()),
    // Any string: a wrong one is refused by roleIconProblems with the list of accents.
    accent: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, role_id, accent, ...input }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const role = await requireRole(ctx, userId, role_id, "admin");
    const icon = await performSetRoleIcon(ctx, role, { ...input, accent: accent as RoleIconAccent | undefined });
    return { role_id: String(role._id), handle: role.handle, icon, svg: roleIconSvg(icon) };
  },
});

/** The charter a drawer reads: the doc when the role has one, else the row's short text. */
async function charterOf(ctx: Ctx, role: any): Promise<string> {
  const doc = role.charter_doc_id ? await ctx.db.get(role.charter_doc_id) : null;
  return String(doc?.content ?? role.charter ?? "").trim();
}

/** Everything a drawer needs for one role, model or agent. */
async function iconBriefOf(ctx: Ctx, role: any, hint?: string): Promise<IconBrief> {
  const siblings = await siblingIcons(ctx, role);
  const own = normalizeConcept(role.name);
  return {
    role_id: String(role._id),
    title: role.name,
    handle: role.handle,
    charter: (await charterOf(ctx, role)) || undefined,
    hint: hint?.trim() || undefined,
    siblings: siblings.map((s) => ({ title: s.role.name, handle: s.role.handle, icon: s.icon })),
    // The house examples, minus one titled like this role, so a drawer never copies an answer.
    examples: ROLE_ICON_EXAMPLES.filter((e) => normalizeConcept(e.title) !== own),
    accent: isRoleIcon(role.icon) ? role.icon.accent : pickRoleIconAccent(siblings.map((s) => s.icon.accent), String(role._id)),
  };
}

// `cast role icon @handle [--brief]`: the role's icon, its preview, and the
// brief an agent draws from by hand.
export const brief = query({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const role = await resolveRoleRef(ctx, args.role_id);
    if (!role || !(await userCanAccessRole(ctx, userId, role))) return null;
    const b = await iconBriefOf(ctx, role);
    const icon = isRoleIcon(role.icon) ? role.icon : null;
    return {
      role_id: String(role._id),
      short_id: role.short_id,
      handle: role.handle,
      name: role.name,
      icon,
      svg: icon ? roleIconSvg(icon) : null,
      preview_url: role.icon_preview_id ? await ctx.storage.getUrl(role.icon_preview_id) : null,
      language: ROLE_ICON_LANGUAGE,
      charter: b.charter ?? null,
      accent: b.accent,
      siblings: b.siblings.map((s) => ({ handle: s.handle, title: s.title, concept: s.icon.concept, svg: roleIconSvg(s.icon) })),
    };
  },
});

// ── The generator ───────────────────────────────────────────────────────────

/** The role and its brief for a generation; with a caller, only if they may reshape the role. */
export const generationBrief = internalQuery({
  args: { role_id: v.string(), api_token: v.optional(v.string()), as_caller: v.boolean(), hint: v.optional(v.string()) },
  handler: async (ctx, args): Promise<IconBrief & { skip?: string }> => {
    let role: any;
    if (args.as_caller) {
      const userId = await getAuthenticatedUserId(ctx, args.api_token);
      if (!userId) throw new Error("Authentication failed: invalid token or session");
      role = await requireRole(ctx, userId, args.role_id, "admin");
    } else {
      role = await resolveRoleRef(ctx, args.role_id);
      if (!role) throw new Error("Role not found");
    }
    if (role.status === "retired") throw new Error("That role is retired");
    return iconBriefOf(ctx, role, args.hint);
  },
});

export const saveGenerated = internalMutation({
  args: { role_id: v.id("org_roles"), icon: roleIconValidator, preview_id: v.id("_storage") },
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.role_id);
    if (!role) throw new Error("Role not found");
    return performSetRoleIcon(ctx, role, { icon: args.icon }, { preview_id: args.preview_id });
  },
});

export type GeneratedIcon = { icon: RoleIcon; svg: string; concept: string; rationale: string; preview_url: string | null; cost_usd: number; calls: number };

/** The model call the pipeline asks for, on the deployment's key; a sheet goes up to storage so the judge can read it by url. */
function deploymentAsk(ctx: any, scratch: Id<"_storage">[]): Ask {
  return async (req) => {
    let images: Array<{ label: string; url: string }> | undefined;
    if (req.image) {
      const id: Id<"_storage"> = await ctx.storage.store(new Blob([req.image as BlobPart], { type: "image/png" }));
      scratch.push(id);
      const url = await ctx.storage.getUrl(id);
      if (url) images = [{ label: "Contact sheet", url }];
    }
    const r = await callModelMetered({ model: ICON_MODEL, system: req.system, prompt: req.prompt, max_tokens: req.max_tokens, images, label: req.label, timeout_ms: 240_000 });
    return { text: r.reply?.text ?? null, usage: r.usage, error: r.error };
  };
}

async function runGeneration(ctx: any, brief: IconBrief): Promise<GeneratedIcon> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("This deployment has no model key, so it can't draw icons; draw one by hand with cast role icon @handle --brief");
  const scratch: Id<"_storage">[] = [];
  try {
    const result = await generateRoleIcon(brief, deploymentAsk(ctx, scratch));
    const cost_usd = modelCost(ICON_MODEL, result.usage);
    console.log(`role icon for @${brief.handle}: ${result.ok ? `"${result.icon.concept}"` : "none"} in ${result.rounds.length} round(s), ${result.calls} calls, $${cost_usd.toFixed(3)}`);
    if (!result.ok) throw new Error(`No icon for @${brief.handle}: ${result.reason}`);
    const preview_id: Id<"_storage"> = await ctx.storage.store(new Blob([result.preview as BlobPart], { type: "image/png" }));
    const icon: RoleIcon = await ctx.runMutation(internal.roleIcons.saveGenerated, { role_id: brief.role_id as Id<"org_roles">, icon: result.icon, preview_id });
    return { icon, svg: roleIconSvg(icon), concept: icon.concept, rationale: result.rationale, preview_url: await ctx.storage.getUrl(preview_id), cost_usd, calls: result.calls };
  } finally {
    for (const id of scratch) await ctx.storage.delete(id).catch(() => {});
  }
}

// The Redraw button and `cast role icon @handle --generate [--hint]`.
export const generate = action({
  args: { api_token: v.optional(v.string()), role_id: v.string(), hint: v.optional(v.string()) },
  handler: async (ctx, args): Promise<GeneratedIcon> => {
    const brief: IconBrief = await ctx.runQuery(internal.roleIcons.generationBrief, { role_id: args.role_id, api_token: args.api_token, as_caller: true, hint: args.hint });
    return runGeneration(ctx, brief);
  },
});

// A hire schedules this (orgRoles.performCreateRoleCore). A role that has an
// icon by the time it runs keeps it.
export const generateForRole = internalAction({
  args: { role_id: v.id("org_roles") },
  handler: async (ctx, args): Promise<void> => {
    if (!process.env.ANTHROPIC_API_KEY) return;
    const role: any = await ctx.runQuery(internal.roleIcons.roleRow, { role_id: args.role_id });
    if (!role || role.status === "retired" || isRoleIcon(role.icon)) return;
    const brief: IconBrief = await ctx.runQuery(internal.roleIcons.generationBrief, { role_id: String(args.role_id), as_caller: false });
    await runGeneration(ctx, brief).catch((err) => console.error(`role icon for @${role.handle} failed:`, err));
  },
});

export const roleRow = internalQuery({
  args: { role_id: v.id("org_roles") },
  handler: async (ctx, args) => ctx.db.get(args.role_id),
});

/** The next live role without an icon, in one boundary or anywhere, skipping ones already tried. */
export const nextWithoutIcon = internalQuery({
  args: { team_id: v.optional(v.id("teams")), scope_user_id: v.optional(v.id("users")), skip: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ role_id: Id<"org_roles">; handle: string } | null> => {
    const skip = new Set(args.skip);
    const roles: any[] = args.team_id || args.scope_user_id
      ? await rolesInBoundary(ctx, { team_id: args.team_id, scope_user_id: args.scope_user_id })
      : await ctx.db.query("org_roles").collect();
    const next = roles.find((r) => r.status !== "retired" && !isRoleIcon(r.icon) && !skip.has(String(r._id)));
    return next ? { role_id: next._id, handle: next.handle } : null;
  },
});

/**
 * Draws an icon for every live role that has none, one role per run so each
 * fits an action's time and sees the icons drawn before it (distinct
 * concepts depend on that). Optionally one boundary. Run after a deploy:
 *   npx convex run roleIcons:backfill '{"scope_user_id": "<user id>"}'
 */
export const backfill = internalAction({
  args: { team_id: v.optional(v.id("teams")), scope_user_id: v.optional(v.id("users")), skip: v.optional(v.array(v.string())), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ drew: string | null; failed?: string; remaining_limit: number }> => {
    const skip = args.skip ?? [];
    const limit = args.limit ?? 100;
    if (limit <= 0) return { drew: null, remaining_limit: 0 };
    const next = await ctx.runQuery(internal.roleIcons.nextWithoutIcon, { team_id: args.team_id, scope_user_id: args.scope_user_id, skip });
    if (!next) return { drew: null, remaining_limit: limit };
    let failed: string | undefined;
    try {
      const brief: IconBrief = await ctx.runQuery(internal.roleIcons.generationBrief, { role_id: String(next.role_id), as_caller: false });
      await runGeneration(ctx, brief);
    } catch (err) {
      failed = String((err as Error)?.message ?? err);
      console.error(`backfill: @${next.handle}:`, failed);
    }
    await ctx.scheduler.runAfter(0, internal.roleIcons.backfill, { team_id: args.team_id, scope_user_id: args.scope_user_id, skip: [...skip, String(next.role_id)], limit: limit - 1 });
    return { drew: failed ? null : next.handle, failed, remaining_limit: limit - 1 };
  },
});
