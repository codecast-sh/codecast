// The audit log of data access for regulated teams (HIPAA), a leaf module like
// teamPolicyGuard: every path that records an open, an export, a download or
// a staff read calls recordAccess, which writes nothing unless the object's
// team sets regulated_data in its managed policy. It imports nothing from
// ./functions, so the artifacts beacon, the CLI routes and accessLog.ts can
// all call it.
//
// One row per open: a repeat of the same action on the same object by the
// same actor inside ACCESS_REPEAT_WINDOW_MS writes nothing, so a reload, a
// re-mount or a paged CLI read is one entry.
import type { Id } from "../_generated/dataModel";
import { policyTeamOf } from "@codecast/shared/contracts";
import { teamPolicyOf } from "./teamPolicyGuard";

type DbCtx = { db: any };

export const ACCESS_REPEAT_WINDOW_MS = 5 * 60_000;

export type AccessAction = "open" | "export" | "download" | "staff_read" | "delete";
export type AccessClient = "web" | "desktop" | "mobile" | "cli" | "page" | "script";
export type AccessActor = { userId: Id<"users"> } | { label: string };
export type AccessObject = { table: string; id: string; shortId?: string | null };

/**
 * The team whose log an access to `row` goes to. This is routing (which
 * team's log the entry flows to), so a conversation answers with its
 * team_id even when it is private inside that team: its member opening it
 * is still an access to the team's data. A published page answers with its
 * team gate, which the server sets for every regulated team's page.
 */
export function accessTeamOf(table: string, row: any): Id<"teams"> | null {
  if (!row) return null;
  if (table === "conversations") return row.team_id ?? null;
  if (table === "artifacts" && row.team_gate) return row.team_gate;
  return (policyTeamOf(table, row) as Id<"teams"> | null) ?? null;
}

/** The short id an object shows, when it has one. */
export function accessShortIdOf(table: string, row: any): string | undefined {
  if (!row) return undefined;
  if (table === "artifacts") return row.slug ?? undefined;
  return typeof row.short_id === "string" ? row.short_id : undefined;
}

/** Whether `teamId` is a live team whose policy marks its data as regulated. */
export async function isRegulatedTeam(ctx: DbCtx, teamId: Id<"teams"> | null | undefined): Promise<boolean> {
  const p = await teamPolicyOf(ctx, teamId);
  return p?.policy.regulated_data === true;
}

function actorKey(actor: AccessActor): string {
  return "userId" in actor ? `u:${actor.userId}` : `l:${actor.label}`;
}

/** Write one row, unless the same actor did the same to the same object inside the repeat window. */
async function insertAccess(
  ctx: DbCtx,
  teamId: Id<"teams"> | undefined,
  e: { actor: AccessActor; action: AccessAction; object: AccessObject; client: AccessClient; detail?: string },
): Promise<boolean> {
  const now = Date.now();
  const repeatKey = `${actorKey(e.actor)}|${e.action}|${e.object.table}:${e.object.id}|${e.detail ?? ""}`;
  const recent = await ctx.db
    .query("access_log")
    .withIndex("by_repeat_key", (q: any) => q.eq("repeat_key", repeatKey).gt("at", now - ACCESS_REPEAT_WINDOW_MS))
    .first();
  if (recent) return false;
  await ctx.db.insert("access_log", {
    ...(teamId ? { team_id: teamId } : {}),
    ...("userId" in e.actor ? { actor_user_id: e.actor.userId } : { actor_label: e.actor.label.slice(0, 200) }),
    action: e.action,
    object_table: e.object.table,
    object_id: e.object.id,
    ...(e.object.shortId ? { object_short_id: e.object.shortId } : {}),
    client: e.client,
    ...(e.detail ? { detail: e.detail.slice(0, 2000) } : {}),
    at: now,
    repeat_key: repeatKey,
  });
  return true;
}

/**
 * Record an access to a team's object. Does nothing unless the team is
 * regulated; returns whether a row was written.
 */
export async function recordAccess(
  ctx: DbCtx,
  teamId: Id<"teams"> | null | undefined,
  e: { actor: AccessActor; action: AccessAction; object: AccessObject; client: AccessClient; detail?: string },
): Promise<boolean> {
  if (!teamId || !(await isRegulatedTeam(ctx, teamId))) return false;
  return insertAccess(ctx, teamId, e);
}

/** Record an access to `row` of `table`, routed to the team accessTeamOf names. */
export function recordRowAccess(
  ctx: DbCtx,
  table: string,
  row: any,
  e: { actor: AccessActor; action: AccessAction; client: AccessClient; detail?: string },
): Promise<boolean> {
  return recordAccess(ctx, accessTeamOf(table, row), {
    ...e,
    object: { table, id: String(row._id), shortId: accessShortIdOf(table, row) },
  });
}

/** The tables whose ids a staff run's arguments are checked against, to name the teams it touched. */
const STAFF_OBJECT_TABLES = ["conversations", "teams", "artifacts", "transcripts", "tasks", "docs", "plans", "users"] as const;

/** Every string in a JSON value, at any depth (bounded). */
function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 200 || depth > 6) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out, depth + 1);
  return out;
}

/**
 * A staff read (packages/convex/run.sh, the admin key): one row in each
 * regulated team whose object the arguments name, by id. A user id counts for
 * every regulated team that person belongs to. A run whose arguments name no
 * team's object is recorded once with no team, so the staff trail is whole;
 * no team admin sees those rows.
 */
export async function recordStaffRead(
  ctx: DbCtx,
  e: { actor: string; fn: string; args: unknown },
): Promise<number> {
  const detail = `${e.fn} ${JSON.stringify(e.args ?? {})}`;
  const touched = new Map<string, { teamId: Id<"teams">; object: AccessObject }>();
  let named = false;
  for (const s of stringsIn(e.args)) {
    for (const table of STAFF_OBJECT_TABLES) {
      const id = ctx.db.normalizeId(table, s);
      if (!id) continue;
      const row = await ctx.db.get(id);
      if (!row) continue;
      named = true;
      const object = { table, id: String(id), shortId: accessShortIdOf(table, row) };
      const teams: Id<"teams">[] = [];
      if (table === "teams") teams.push(id);
      else if (table === "users") {
        const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", id)).collect();
        teams.push(...memberships.map((m: any) => m.team_id));
      } else {
        const t = accessTeamOf(table, row);
        if (t) teams.push(t);
      }
      for (const teamId of teams) {
        const key = `${teamId}|${object.table}:${object.id}`;
        if (!touched.has(key) && (await isRegulatedTeam(ctx, teamId))) touched.set(key, { teamId, object });
      }
    }
  }
  const base = { actor: { label: e.actor }, action: "staff_read" as const, client: "script" as const, detail };
  let written = 0;
  for (const { teamId, object } of touched.values()) {
    if (await insertAccess(ctx, teamId, { ...base, object })) written++;
  }
  if (!named) {
    if (await insertAccess(ctx, undefined, { ...base, object: { table: "functions", id: e.fn } })) written++;
  }
  return written;
}
