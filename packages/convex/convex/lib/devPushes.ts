// A dev watcher's pushes: recorded as dev pushes, never deploys, one row per pusher, machine and sha between deploys.

import type { Doc, Id } from "../_generated/dataModel";
import { normalizeRepository } from "./gitRefs";
import { targetDevPushes } from "../deployTargetsState";
import { normalizeDeployTarget } from "@codecast/shared/contracts/deploys";
import { latestLiveDeploy } from "./deployRows";
import { capNames, NAME_MAX, newNames, scheduleDroppedWork, type StartedBy } from "./droppedWork";

/** Whether two pushes were made by one pusher: the same account, else (neither has one) the same name. */
function samePusher(a: StartedBy, b: StartedBy): boolean {
  if (a?.user_id || b?.user_id) return !!a?.user_id && !!b?.user_id && String(a.user_id) === String(b.user_id);
  return (a?.name ?? null) === (b?.name ?? null);
}

/**
 * A dev push's adds and drops after one more save: the net change of all its saves against what prod ran before the
 * row began. A name the save adds that the row had dropped is back as it was (off drops), else the row added it; a
 * name the save drops that the row had added never existed before the row (off adds), else the row dropped it.
 */
function netChange(row: Pick<Doc<"dev_pushes">, "adds" | "drops">, adds: ReadonlyArray<string>, drops: ReadonlyArray<string>): { adds: string[]; drops: string[] } {
  const added = new Set(row.adds), dropped = new Set(row.drops);
  for (const n of adds) if (!dropped.delete(n)) added.add(n);
  for (const n of drops) if (!added.delete(n)) dropped.add(n);
  return { adds: capNames([...added]), drops: capNames([...dropped]) };
}

// ── the dev watcher's pushes ──────────────────────────────────────────────────

export type DevPushMark = {
  workspace: string;
  team_id?: Id<"teams">;
  target: string;
  repository?: string;
  sha: string;
  machine?: string;
  started_by?: StartedBy;
  dirty?: number;
  /** Names the save put on the target and took off it; both sent, possibly empty, exactly when its diff ran. */
  adds?: string[];
  drops?: string[];
  at: number;
};

/**
 * Record a dev watcher's push: never a deploy (no deploys row, no event, no
 * trigger), a dev push. A save lands on its pusher's row of the same
 * repository, machine and sha that began after the target's live deploy went
 * live, and starts a row of its own otherwise: between deploys, one row per
 * pusher, machine and sha however many saves, and two people whose machines
 * share a hostname keep a row each. The row holds the net change of its saves
 * (netChange). What the save newly drops is told to whoever's uncommitted push
 * put it there (noticeDroppedWork). Returns the row, or null for a target no
 * user reaches.
 */
export async function recordDevPush(ctx: any, m: DevPushMark): Promise<Id<"dev_pushes"> | null> {
  const target = normalizeDeployTarget(m.target);
  if (!target) return null;
  const now = Date.now();
  const repository = m.repository ? normalizeRepository(m.repository) : undefined;
  const machine = m.machine?.trim().slice(0, NAME_MAX) || undefined;
  const sha = m.sha.trim().toLowerCase();
  const diffRan = Array.isArray(m.adds) || Array.isArray(m.drops);
  const adds = capNames(m.adds);
  const drops = capNames(m.drops);
  const live = await latestLiveDeploy(ctx, m.workspace, target, repository);
  const since = live ? live.live_at ?? live.created_at : null;
  const mine: Doc<"dev_pushes">[] = await ctx.db
    .query("dev_pushes")
    .withIndex("by_workspace_target_machine_sha", (q: any) => {
      const range = q.eq("workspace", m.workspace).eq("target", target).eq("machine", machine).eq("sha", sha);
      return since == null ? range : range.gt("created_at", since);
    })
    .order("desc")
    .take(20);
  const own = mine.find((p) => (p.repository ?? null) === (repository ?? null) && samePusher(p.started_by, m.started_by));
  const dropper = { workspace: m.workspace, target, repository, machine, deploy: null, on: live?.short_id ?? null };

  if (own) {
    // Another dev push saved since this row's last save put the target's names back as its tree has them: everything
    // this save drops is dropped again.
    const later = await targetDevPushes(ctx, m.workspace, target, 5, own.live_at);
    const wasLast = !later.some((p) => String(p._id) !== String(own._id) && (!p.repository || !repository || p.repository === repository));
    const next = diffRan ? netChange(own, adds, drops) : { adds: own.adds, drops: own.drops };
    await ctx.db.patch(own._id, { ...next, dirty: m.dirty ?? 0, live_at: m.at, updated_at: now });
    const dropped = !diffRan ? [] : wasLast ? newNames(next.drops, own.drops) : drops.filter((n) => next.drops.includes(n));
    await scheduleDroppedWork(ctx, { ...dropper, exclude: String(own._id) }, dropped, m.started_by);
    return own._id;
  }
  const id: Id<"dev_pushes"> = await ctx.db.insert("dev_pushes", {
    workspace: m.workspace,
    ...(m.team_id ? { team_id: m.team_id } : {}),
    ...(repository ? { repository } : {}),
    target,
    sha,
    ...(machine ? { machine } : {}),
    ...(m.started_by ? { started_by: m.started_by } : {}),
    dirty: m.dirty ?? 0,
    adds,
    drops,
    created_at: m.at,
    live_at: m.at,
    updated_at: now,
  });
  await scheduleDroppedWork(ctx, { ...dropper, exclude: String(id) }, drops, m.started_by);
  return id;
}
