import { internalMutation } from "./functions";
import { v } from "convex/values";
import { ensureRoleRoutine, standingConversationOf } from "./orgRoles";
import { HEAD_INBOX_TITLE, ROLE_AGENDA_TITLE, findRoleRoutineInAnyStatus, isLiveTrigger, roleRoutineFor } from "./lib/orgRoutine";
import { handRoleTriggersToRunner, roleTriggerRunnerOf, tasksOriginatedBy } from "./lib/agentTaskRows";
import { applyCancel, applyReactivate } from "./agentTasks";

// Repair the role checks that died before ct-95585: a check armed under one
// account kept firing from it after its standing session moved to another,
// every injection was refused, and the recurring trigger ended "failed" for
// good. Per role with a standing session:
//   rearm      its dead check, stamped with the role, handed to the account
//              that runs the seat, armed for its next slot (applyReactivate)
//   adopt      a live trigger on the seat that carries the role's id or the
//              check's title becomes the role's check (both stamped, handed to
//              the runner); the dead check it replaces is cancelled
//   cancel     a dead check replaced by an adopted one, or an older copy of the
//              one being re-armed
//   ambiguous  a live trigger on the seat that only looks like a check (armed
//              by hand, no role id, another title): a person decides, and
//              naming it in `adopt` makes it the role's check. Both are left
//              alone until then.
//   create     a check for an active role with none in any status
//   reown      a live role trigger on the seat still under an account that no
//              longer runs it
//   skip       what is left alone, with why: a paused role's dead check, no
//              seat, a check a person cancelled
// Any other trigger on the seat is someone's own and never a reason to touch
// the check. The dry run (the default) writes nothing; every row it lists is
// what the real run writes.
//   packages/convex/run.sh roleCheckRepair:repairRoleChecks '{"team_id":"<id>"}'
//   packages/convex/run.sh roleCheckRepair:repairRoleChecks '{"team_id":"<id>","dryRun":false,"adopt":["tr-7252"]}'
type RoleCheckRepairRow = {
  role: string; handle: string; standing: string | null;
  action: "rearm" | "adopt" | "cancel" | "ambiguous" | "create" | "reown" | "skip";
  trigger: string | null; title?: string; owner?: { from: string; to: string }; replaced_by?: string; check_title?: string; reason: string;
};

// The recurring routines a role holds beside its check.
const ROLE_ROUTINES_BESIDE_CHECK = new Set([ROLE_AGENDA_TITLE, HEAD_INBOX_TITLE]);
// A hand-armed trigger that reads like an area check: worth a person's look,
// never acted on alone.
const looksLikeACheck = (t: any) => (/\bcheck\b/i.test(t.title ?? "") && /\barea\b/i.test(t.title ?? "")) || /cast brief/.test(t.prompt ?? "");

export async function performRepairRoleChecks(ctx: any, args: { dryRun?: boolean; team_id?: any; adopt?: string[] }): Promise<{ dryRun: boolean; rows: RoleCheckRepairRow[] }> {
  const dryRun = args.dryRun !== false;
  const chosen = new Set(args.adopt ?? []);
  const roles: any[] = args.team_id
    ? await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", args.team_id)).collect()
    : await ctx.db.query("org_roles").collect();
  const nameOf = async (id: any) => { const u: any = await ctx.db.get(id); return u?.name || u?.email || String(id); };
  const ref = (t: any) => t.short_id ?? String(t._id);
  const rows: RoleCheckRepairRow[] = [];
  for (const role of roles.filter((r) => r.status !== "retired")) {
    const standing = await standingConversationOf(ctx, role);
    const base = { role: role.short_id, handle: role.handle, standing: standing ? (standing.short_id ?? String(standing._id)) : null };
    if (!standing) { rows.push({ ...base, action: "skip", trigger: null, reason: "no standing session" }); continue; }
    const title = roleRoutineFor(role).title;
    const mine = (t: any) => String(t.role_id ?? "") === String(role._id);
    // The owner change a row makes once the row carries this role's id: what
    // handRoleTriggersToRunner then does to it.
    const ownerMove = async (t: any) => String(t.user_id) !== String(standing.user_id) ? { from: await nameOf(t.user_id), to: await nameOf(standing.user_id) } : undefined;
    const triggers = await tasksOriginatedBy(ctx, standing._id);
    const dead = triggers.filter((t) => t.status === "failed" && t.schedule_type === "recurring" && t.title === title && (!t.role_id || mine(t))).sort((a, b) => b.created_at - a.created_at);
    const liveRecurring = triggers.filter((t) => isLiveTrigger(t) && t.schedule_type === "recurring" && !ROLE_ROUTINES_BESIDE_CHECK.has(t.title));
    const adoptable = liveRecurring.find((t) => (mine(t) || t.title === title || chosen.has(ref(t))) && (!t.role_id || mine(t))) ?? null;
    const lookalikes = adoptable ? [] : liveRecurring.filter((t) => !t.role_id && looksLikeACheck(t));
    const stamps = adoptable ? { ...(mine(adoptable) ? {} : { role_id: role._id }), ...(adoptable.title === title ? {} : { title }) } : {};
    const adopting = !!adoptable && Object.keys(stamps).length > 0;

    // Live role triggers on the seat under the wrong account move, paused role or not.
    for (const t of triggers) {
      if (isLiveTrigger(t) && !(adopting && t === adoptable) && await roleTriggerRunnerOf(ctx, t)) rows.push({ ...base, action: "reown", trigger: ref(t), owner: await ownerMove(t), reason: "runs from an account that no longer runs the seat" });
    }
    if (role.status === "paused") {
      for (const t of dead) rows.push({ ...base, action: "skip", trigger: ref(t), reason: "role is paused" });
      if (!dryRun) await handRoleTriggersToRunner(ctx, standing._id);
      continue;
    }

    let rearmed: any = null;
    if (adoptable) {
      if (adopting) {
        rows.push({ ...base, action: "adopt", trigger: ref(adoptable), title: adoptable.title, check_title: title, owner: await ownerMove(adoptable), reason: chosen.has(ref(adoptable)) ? "named by a person as the role's check" : "a live trigger on the seat carries the check's title or the role" });
        if (!dryRun) await ctx.db.patch(adoptable._id, stamps);
      }
      for (const t of dead) {
        rows.push({ ...base, action: "cancel", trigger: ref(t), replaced_by: ref(adoptable), reason: "the seat's live check replaces it" });
        if (!dryRun) await applyCancel(ctx, await ctx.db.get(t._id));
      }
    } else if (lookalikes.length) {
      for (const t of lookalikes) rows.push({ ...base, action: "ambiguous", trigger: ref(t), title: t.title, check_title: title, ...(dead[0] ? { replaced_by: ref(dead[0]) } : {}), reason: "a person decides: adopt it as the role's check (adopt), or cancel it so the check comes back" });
    } else if (dead.length) {
      const [keep, ...older] = dead;
      rearmed = keep;
      rows.push({ ...base, action: "rearm", trigger: ref(keep), owner: await ownerMove(keep), reason: `failed ${keep.last_run_at ? new Date(keep.last_run_at).toISOString().slice(0, 10) : "before any run"}: ${String(keep.last_run_summary ?? "").split("\n")[0].slice(0, 120)}` });
      if (!dryRun && !mine(keep)) await ctx.db.patch(keep._id, { role_id: role._id });
      for (const t of older) {
        rows.push({ ...base, action: "cancel", trigger: ref(t), replaced_by: ref(keep), reason: "an older copy of the check being re-armed" });
        if (!dryRun) await applyCancel(ctx, await ctx.db.get(t._id));
      }
    } else {
      const any = await findRoleRoutineInAnyStatus(ctx, role, standing);
      if (any && !isLiveTrigger(any)) rows.push({ ...base, action: "skip", trigger: ref(any), reason: `its check is ${any.status === "completed" ? "off: a person cancelled it" : any.status}` });
      else if (!any) {
        rows.push({ ...base, action: "create", trigger: null, reason: "active role with a standing session and no check" });
        if (!dryRun) rows[rows.length - 1].trigger = ((made) => made.short_id ?? String(made.id))(await ensureRoleRoutine(ctx, role, standing));
      }
    }
    if (dryRun) continue;
    await handRoleTriggersToRunner(ctx, standing._id);
    if (rearmed) await applyReactivate(ctx, await ctx.db.get(rearmed._id));
  }
  return { dryRun, rows };
}

export const repairRoleChecks = internalMutation({
  args: { dryRun: v.optional(v.boolean()), team_id: v.optional(v.id("teams")), adopt: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => performRepairRoleChecks(ctx, args),
});
