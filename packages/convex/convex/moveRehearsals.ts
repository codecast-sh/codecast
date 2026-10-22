/**
 * Rehearsals of session moves (schema: move_rehearsals). The offload review
 * asks for them when it opens (`request`); the machine holding the sessions'
 * files runs `cast migrate rehearse --request <id>`, which reads its rows
 * (`forRunner`) and reports each (`report`); the review reads them back
 * through the store (`listMine`), and resourceOffload.start holds a move to
 * the newest one (`latestFor`).
 */
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { REHEARSAL_TTL_MS, type MoveRehearsal } from "@codecast/shared/contracts/moveRehearsal";
import { getAuthenticatedUserId } from "./sessionMigrations";

/** How far back the review's feed reads. */
const LISTED_MS = REHEARSAL_TTL_MS;
/** A pending row whose runner never reported is shown as failed after this long. */
const RUNNER_DEADLINE_MS = 5 * 60_000;

export const request = mutation({
  args: {
    request_id: v.string(),
    source_device_id: v.string(),
    selections: v.array(v.object({ conversation_id: v.id("conversations"), session_id: v.string(), destination_id: v.string() })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    if (!/^rh_[a-z0-9]{8,32}$/.test(args.request_id)) throw new Error("Invalid rehearsal request id");
    if (!args.selections.length || args.selections.length > 50) throw new Error("Rehearse between 1 and 50 sessions");
    const source = await ctx.db.query("devices").withIndex("by_user_device", (q) => q.eq("user_id", userId).eq("device_id", args.source_device_id)).first();
    if (!source) throw new Error("Not your machine");
    if (await ctx.db.query("move_rehearsals").withIndex("by_request", (q) => q.eq("request_id", args.request_id)).first()) return { request_id: args.request_id, replayed: true };
    const now = Date.now();
    let rows = 0;
    for (const s of args.selections) {
      const conv = await ctx.db.get(s.conversation_id);
      if (!conv || conv.user_id !== userId || conv.session_id !== s.session_id) continue;
      await ctx.db.insert("move_rehearsals", {
        user_id: userId, request_id: args.request_id, source_device_id: args.source_device_id,
        conversation_id: conv._id, session_id: s.session_id, destination_id: s.destination_id,
        status: "pending", created_at: now,
      });
      rows++;
    }
    if (rows) {
      await ctx.db.insert("daemon_commands", {
        user_id: userId, command: "rehearse_moves" as const, args: JSON.stringify({ request_id: args.request_id }),
        created_at: now, target_device_id: args.source_device_id,
      });
    }
    return { request_id: args.request_id, rows };
  },
});

/** The rows of one request this machine runs. */
export const forRunner = query({
  args: { api_token: v.optional(v.string()), request_id: v.string(), device_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const rows = await ctx.db.query("move_rehearsals").withIndex("by_request", (q) => q.eq("request_id", args.request_id)).collect();
    return rows
      .filter((r) => r.user_id === userId && r.source_device_id === args.device_id && r.status === "pending")
      .map((r) => ({ rehearsal_id: r._id, session_id: r.session_id, destination_id: r.destination_id }));
  },
});

export const report = mutation({
  args: { api_token: v.optional(v.string()), rehearsal_id: v.id("move_rehearsals"), result: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication required");
    const row = await ctx.db.get(args.rehearsal_id);
    if (!row || row.user_id !== userId) throw new Error("No such rehearsal");
    if (args.result) {
      const parsed = JSON.parse(args.result) as MoveRehearsal;
      if (parsed.session_id !== row.session_id || parsed.destination_id !== row.destination_id) throw new Error("Rehearsal does not match its row");
    }
    await ctx.db.patch(row._id, {
      status: args.result ? "done" : "failed",
      ...(args.result ? { result: args.result.slice(0, 64_000) } : {}),
      ...(args.error ? { error: args.error.slice(0, 1000) } : {}),
      finished_at: Date.now(),
    });
  },
});

export type RehearsalRow = { _id: string; request_id: string; session_id: string; destination_id: string; status: "pending" | "done" | "failed"; result: MoveRehearsal | null; error: string | null; created_at: number };

function toRow(r: any, now: number): RehearsalRow {
  const stale = r.status === "pending" && now - r.created_at > RUNNER_DEADLINE_MS;
  let result: MoveRehearsal | null = null;
  try { result = r.result ? JSON.parse(r.result) : null; } catch { /* unreadable: shown as failed */ }
  return {
    _id: r._id, request_id: r.request_id, session_id: r.session_id, destination_id: r.destination_id,
    status: stale || (r.status === "done" && !result) ? "failed" : r.status,
    result, error: stale ? "The machine holding the session did not answer" : (r.error ?? null), created_at: r.created_at,
  };
}

/** The review's feed: this user's rehearsals of the last few minutes. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const now = Date.now();
    const rows = await ctx.db.query("move_rehearsals").withIndex("by_user_created", (q) => q.eq("user_id", userId).gte("created_at", now - LISTED_MS)).collect();
    return rows.map((r) => toRow(r, now));
  },
});

/** The newest finished rehearsal of one session's move to one destination, while it still speaks. */
export async function latestRehearsal(ctx: { db: any }, userId: Id<"users">, sessionId: string, destinationId: string, now = Date.now()): Promise<MoveRehearsal | null> {
  const rows = await ctx.db.query("move_rehearsals")
    .withIndex("by_session_destination", (q: any) => q.eq("session_id", sessionId).eq("destination_id", destinationId).gte("created_at", now - REHEARSAL_TTL_MS))
    .order("desc").take(5);
  for (const r of rows) {
    if (r.user_id !== userId || r.status !== "done" || !r.result) continue;
    try { return JSON.parse(r.result) as MoveRehearsal; } catch { continue; }
  }
  return null;
}
