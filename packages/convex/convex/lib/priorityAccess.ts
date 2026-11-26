// Who may read a priority, and what of it (priorities.ts reads through this).
//
// A priority is readable by its owner, and by a teammate holding its
// `workspace` key only while the owner lists their sessions to that team
// (lib/prioritySessionVisibility, the one predicate the pass uses too), and
// not while it needs a rewrite (prioritiesSchema needs_rewrite): its title and
// summary may tell of a session gone from the team.

import { accessStampFor, accessStampFromDoc, authorizedFor, heldKeysFor, parseWorkspaceKey } from "./accessKeys";
import { teamHasFeature, workspaceHasFeature } from "./teamFeatureGuard";
import { sessionVisibility, type SessionVisibility } from "./prioritySessionVisibility";
import { isSessionOwner } from "../sessionOwners";
import type { PriorityRef, PriorityStep } from "@codecast/shared/contracts/priorities";
import type { Doc, Id } from "../_generated/dataModel";
import { findConversationByAnyRefWhere } from "../conversationSessionLookup";

export const FEATURE = "priorities" as const;
/**
 * A teammate's priority: the newest sessions read to decide whether they may
 * read it (none of these listed to the team: hidden, failing closed) and the
 * ones its row counts ("4+" past that).
 */
export const TEAMMATE_SESSIONS = 4;

type Ctx = { db: any };
type Priority = Doc<"priorities">;

/** Is the feature on for the workspace a key names? Unknown keys are off. Memoized per call. */
export function featureCheck(ctx: Ctx): (key: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (key) => {
    if (!seen.has(key)) {
      const ws = parseWorkspaceKey(key);
      seen.set(key, !ws ? Promise.resolve(false)
        : ws.type === "team" ? teamHasFeature(ctx, ws.teamId, FEATURE)
        : workspaceHasFeature(ctx, { user_id: ws.userId }, FEATURE));
    }
    return seen.get(key)!;
  };
}

/**
 * Everything one call decides about who sees what, read once per call. Team
 * questions all go through lib/prioritySessionVisibility (`vis`), the one
 * predicate the pass uses too.
 */
export type Reader = {
  viewer: Id<"users">;
  held: Set<string>;
  vis: SessionVisibility;
  /** The newest `n` sessions mapped to a priority (by_priority), one read per priority per call. */
  sessionsOf: (p: Priority, n: number) => Promise<Doc<"conversations">[]>;
  /**
   * Whether a session is listed to the viewer (its title, its chip, a count):
   * their own, one they co-own, or one listed to a team of theirs. Nothing
   * here opens a transcript, so nothing needs the content level.
   */
  listed: (c: Doc<"conversations">) => Promise<boolean>;
  /**
   * Who may read a priority (the feature check is the caller's): its owner;
   * a teammate holding its workspace key only while it needs no rewrite and
   * at least one of its newest TEAMMATE_SESSIONS sessions is listed to that
   * team.
   */
  canRead: (p: Priority) => Promise<boolean>;
  /** The priority's steps as the viewer may see them (stepsFor). */
  stepsFor: (p: Priority) => Promise<PriorityStep[]>;
};

export async function readerFor(ctx: Ctx, viewer: Id<"users">): Promise<Reader> {
  const held = await heldKeysFor(ctx, viewer);
  const vis = sessionVisibility(ctx);
  const reads = new Map<string, { n: number; rows: Promise<Doc<"conversations">[]> }>();
  const sessionsOf = async (p: Priority, n: number) => {
    const key = String(p._id);
    const had = reads.get(key);
    if (had && had.n >= n) return (await had.rows).slice(0, n);
    const rows: Promise<Doc<"conversations">[]> = ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)).order("desc").take(n);
    reads.set(key, { n, rows });
    return rows;
  };
  const listed = async (c: Doc<"conversations">) => {
    if (String(c.user_id) === String(viewer) || String(c.owner_user_id ?? "") === String(viewer)) return true;
    if (c.team_id && held.has(`team:${c.team_id}`) && (await vis.listedTo(c, c.team_id))) return true;
    return isSessionOwner(ctx, c._id, viewer);
  };
  const canRead = async (p: Priority) => {
    if (String(p.user_id) === String(viewer)) return true;
    if (p.needs_rewrite || !authorizedFor(accessStampFromDoc("priorities", p), String(viewer), held)) return false;
    const ws = parseWorkspaceKey(p.workspace);
    if (ws?.type !== "team") return false;
    for (const c of (await sessionsOf(p, TEAMMATE_SESSIONS + 1)).slice(0, TEAMMATE_SESSIONS)) if (await vis.listedTo(c, ws.teamId)) return true;
    return false;
  };

  // A step ref shown to a teammate: a session listed to them, a task they can read, a pull request or commit in a repository of the team's.
  const shown = new Map<string, Promise<boolean>>();
  const refShown = (ref: PriorityRef, teamId: string | null, owner: string) => {
    const key = `${ref.kind}:${ref.id}:${owner}`;
    if (!shown.has(key)) {
      shown.set(key, (async () => {
        if (ref.kind === "session") {
          // A short id other conversations share: it means the priority owner's own.
          const conv: Doc<"conversations"> | null = await findConversationByAnyRefWhere(ctx, ref.id, (c) => String(c.user_id) === owner);
          return !!conv && (await listed(conv));
        }
        if (ref.kind === "task") {
          const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.id)).first();
          return !!task && authorizedFor(await accessStampFor(ctx, "tasks", task), String(viewer), held);
        }
        const repository = ref.id.split(ref.kind === "pr" ? "#" : "@")[0];
        if (!teamId || !repository) return false;
        for (const table of ["pull_requests", "commits"]) {
          if (await ctx.db.query(table).withIndex("by_team_repository", (q: any) => q.eq("team_id", teamId).eq("repository", repository)).first()) return true;
        }
        return false;
      })());
    }
    return shown.get(key)!;
  };
  /**
   * No one sees a step the person dropped (a tombstone only the pass reads).
   * The owner sees every other step whole. A teammate sees each step's refs
   * they may read, and not at all a step whose refs were all sessions none of
   * which is listed to them (its title came from work they cannot see).
   */
  const stepsFor = async (p: Priority): Promise<PriorityStep[]> => {
    if (String(p.user_id) === String(viewer)) return p.steps.filter((s) => !s.dropped);
    const ws = parseWorkspaceKey(p.workspace);
    const teamId = ws?.type === "team" ? String(ws.teamId) : null;
    const out: PriorityStep[] = [];
    for (const step of p.steps) {
      if (step.dropped) continue;
      const refs: PriorityRef[] = [];
      for (const ref of step.refs) if (await refShown(ref, teamId, String(p.user_id))) refs.push(ref);
      if (!refs.length && step.refs.length && step.refs.every((ref) => ref.kind === "session")) continue;
      out.push({ ...step, refs });
    }
    return out;
  };
  return { viewer, held, vis, sessionsOf, listed, canRead, stepsFor };
}
