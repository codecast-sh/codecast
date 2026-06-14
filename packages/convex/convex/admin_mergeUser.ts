import { internalMutation } from "./functions";
import { v } from "convex/values";

// (table, field, indexName | null) — when indexName is present, use the
// indexed query; otherwise fall back to a small filter scan. All app tables
// that reference v.id("users") in the schema are covered, plus the two auth
// tables that carry a userId.
const USER_REFS: Array<{ table: string; field: string; index: string | null }> = [
  // App tables with by_user_id (or equivalent leading-on-user) index.
  { table: "daemon_commands", field: "user_id", index: "by_user_pending" },
  { table: "team_memberships", field: "user_id", index: "by_user_id" },
  { table: "directory_team_mappings", field: "user_id", index: "by_user_id" },
  { table: "conversations", field: "user_id", index: "by_user_id" },
  { table: "bookmarks", field: "user_id", index: "by_user_id" },
  { table: "decisions", field: "user_id", index: "by_user_id" },
  { table: "patterns", field: "user_id", index: "by_user_id" },
  { table: "file_touches", field: "user_id", index: "by_user_file" },
  { table: "comments", field: "user_id", index: "by_user_id" },
  { table: "sync_cursors", field: "user_id", index: "by_user_id" },
  { table: "rate_limits", field: "user_id", index: "by_user_endpoint" },
  { table: "api_tokens", field: "user_id", index: "by_user_id" },
  { table: "managed_sessions", field: "user_id", index: "by_user_id" },
  { table: "session_metrics", field: "user_id", index: "by_user_collected" },
  { table: "reviews", field: "reviewer_user_id", index: "by_reviewer" },
  { table: "team_activity_events", field: "actor_user_id", index: "by_actor" },
  { table: "session_insights", field: "actor_user_id", index: "by_actor_generated_at" },
  { table: "day_timelines", field: "user_id", index: "by_user_date" },
  { table: "digests", field: "user_id", index: "by_user_scope_date" },
  { table: "notifications", field: "recipient_user_id", index: "by_recipient" },
  { table: "agent_tasks", field: "user_id", index: "by_user_run_at" },
  { table: "projects", field: "user_id", index: "by_user_id" },
  { table: "plans", field: "user_id", index: "by_user_id" },
  { table: "tasks", field: "user_id", index: "by_user_id" },
  { table: "orchestration_events", field: "user_id", index: "by_user_id" },
  { table: "progress_events", field: "user_id", index: "by_user_id" },
  { table: "docs", field: "user_id", index: "by_user_id" },
  { table: "doc_presence", field: "user_id", index: "by_user_doc" },
  { table: "workflows", field: "user_id", index: "by_user_id" },
  { table: "workflow_runs", field: "user_id", index: "by_user_id" },
  { table: "client_state", field: "user_id", index: "by_user_id" },
  { table: "daemon_logs", field: "user_id", index: "by_user_id" },
  { table: "plan_templates", field: "user_id", index: "by_user_id" },
  { table: "entity_subscriptions", field: "user_id", index: "by_user" },
  { table: "authSessions", field: "userId", index: "userId" },
  { table: "authAccounts", field: "userId", index: "userIdAndProvider" },
  { table: "pending_messages", field: "from_user_id", index: "by_user_status" },
  // App tables without an index on the user field — small filter scans.
  // Caller may need to re-run if `more` returns true.
  { table: "public_conversations", field: "user_id", index: null },
  { table: "public_comments", field: "user_id", index: null },
  { table: "review_comments", field: "author_user_id", index: null },
  { table: "pending_permissions", field: "resolved_by", index: null },
  { table: "github_app_installations", field: "installed_by_user_id", index: null },
  { table: "message_shares", field: "user_id", index: null },
  { table: "system_config", field: "updated_by", index: null },
  { table: "plans", field: "owner_id", index: null },
];

// Tables we deliberately skip because they have no user-keyed index and are
// too large to scan within one mutation's read budget. The caller gets a
// `skipped_tables` field listing them so the gap is visible — typically
// these only carry historical provenance and don't affect access checks.
const SKIPPED_LARGE_TABLES: Array<{ table: string; field: string; reason: string }> = [
  { table: "messages", field: "from_user_id", reason: "no index on optional field; messages table too large to scan" },
  { table: "notifications", field: "actor_user_id", reason: "no index on actor; large table" },
  { table: "task_history", field: "user_id", reason: "no index; potentially large" },
];

// Caps to keep one mutation under the 100MB read budget. Indexed tables can
// pull up to LIMIT matching rows; filter-scan tables are capped tighter
// because each call pays for a full-table read up to FILTER_SCAN_LIMIT.
const INDEXED_LIMIT = 1000;
const FILTER_SCAN_LIMIT = 200;

// Lift any fields present on `from` but missing on `to` over to `to`. Used
// before the row-rewrite step so the surviving user inherits everything
// unique to the duplicate (daemon state, role, sync_projects, skills, etc.)
// without overwriting fresher values already on the survivor.
export const claimUniqueFields = internalMutation({
  args: {
    from_user_id: v.id("users"),
    to_user_id: v.id("users"),
    dry_run: v.boolean(),
  },
  handler: async (ctx, args) => {
    const from = await ctx.db.get(args.from_user_id);
    const to = await ctx.db.get(args.to_user_id);
    if (!from || !to) throw new Error("from or to user not found");
    if (from.email && to.email && from.email.toLowerCase() !== to.email.toLowerCase()) {
      throw new Error(`email mismatch — from=${from.email} to=${to.email}`);
    }

    const patch: Record<string, any> = {};
    const skipped: Record<string, { from: any; to: any }> = {};
    const SYSTEM_FIELDS = new Set(["_id", "_creationTime"]);
    for (const [k, v] of Object.entries(from as any)) {
      if (SYSTEM_FIELDS.has(k)) continue;
      if (v == null) continue;
      const existing = (to as any)[k];
      if (existing == null) {
        patch[k] = v;
      } else if (JSON.stringify(existing) !== JSON.stringify(v)) {
        skipped[k] = { from: v, to: existing };
      }
    }
    if (!args.dry_run && Object.keys(patch).length > 0) {
      await ctx.db.patch(args.to_user_id, patch);
    }
    return {
      dry_run: args.dry_run,
      patched_fields: Object.keys(patch),
      patch,
      skipped_because_survivor_has_different_value: skipped,
    };
  },
});

// Delete a merged-away user record AFTER all foreign refs have been
// migrated. Uses only indexed lookups (no full-table scans) so it doesn't
// race with concurrent daemonHeartbeat writes on the users table.
export const deleteMergedUser = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const u = await ctx.db.get(args.user_id);
    if (!u) return { deleted: false, reason: "not found" };
    // Indexed straggler check — same indexes mergeDuplicateUser used.
    for (const { table, field, index } of USER_REFS) {
      if (!index) continue; // skipped tables won't block deletion
      const row = await ctx.db
        .query(table as any)
        .withIndex(index as any, (q: any) => q.eq(field, args.user_id))
        .first();
      if (row) {
        return {
          deleted: false,
          reason: `${table}.${field} still references this user (e.g. ${row._id})`,
        };
      }
    }
    await ctx.db.delete(args.user_id);
    return { deleted: true };
  },
});

export const mergeDuplicateUser = internalMutation({
  args: {
    from_user_id: v.id("users"),
    to_user_id: v.id("users"),
    dry_run: v.boolean(),
    delete_source: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.from_user_id === args.to_user_id) {
      throw new Error("from_user_id must differ from to_user_id");
    }

    const from = await ctx.db.get(args.from_user_id);
    const to = await ctx.db.get(args.to_user_id);
    if (!from || !to) {
      throw new Error("from or to user not found");
    }
    if (from.email && to.email && from.email.toLowerCase() !== to.email.toLowerCase()) {
      throw new Error(
        `email mismatch — from=${from.email} to=${to.email}; aborting to avoid merging unrelated accounts`,
      );
    }

    const perTable: Record<string, number> = {};
    let totalUpdated = 0;
    let more = false;

    for (const { table, field, index } of USER_REFS) {
      let rows: any[];
      if (index) {
        rows = await ctx.db
          .query(table as any)
          .withIndex(index as any, (q: any) => q.eq(field, args.from_user_id))
          .take(INDEXED_LIMIT + 1);
        if (rows.length > INDEXED_LIMIT) {
          more = true;
          rows.length = INDEXED_LIMIT;
        }
      } else {
        rows = await ctx.db
          .query(table as any)
          .filter((q) => q.eq(q.field(field), args.from_user_id))
          .take(FILTER_SCAN_LIMIT + 1);
        if (rows.length > FILTER_SCAN_LIMIT) {
          more = true;
          rows.length = FILTER_SCAN_LIMIT;
        }
      }
      if (rows.length === 0) continue;
      const key = `${table}.${field}`;
      perTable[key] = (perTable[key] ?? 0) + rows.length;
      totalUpdated += rows.length;
      if (!args.dry_run) {
        for (const row of rows) {
          await ctx.db.patch(row._id, { [field]: args.to_user_id } as any);
        }
      }
    }

    // users.muted_members — array of user ids. The list of users that could
    // have the source in their muted list is small (hundreds at most).
    const mutedScans = await ctx.db
      .query("users")
      .filter((q) => q.neq(q.field("muted_members"), undefined))
      .take(500);
    let mutedTouched = 0;
    for (const u of mutedScans) {
      const muted = (u as any).muted_members as string[] | undefined;
      if (!muted || !muted.includes(args.from_user_id)) continue;
      mutedTouched++;
      if (!args.dry_run) {
        const updated = muted.map((m) => (m === args.from_user_id ? args.to_user_id : m));
        await ctx.db.patch(u._id, { muted_members: updated } as any);
      }
    }
    if (mutedTouched > 0) {
      perTable["users.muted_members"] = mutedTouched;
      totalUpdated += mutedTouched;
    }

    let sourceDeleted = false;
    if (!args.dry_run && args.delete_source && !more) {
      // Refuse if any remaining row still references from_user_id.
      let stragglers = 0;
      for (const { table, field, index } of USER_REFS) {
        const row = index
          ? await ctx.db
              .query(table as any)
              .withIndex(index as any, (q: any) => q.eq(field, args.from_user_id))
              .first()
          : await ctx.db
              .query(table as any)
              .filter((q) => q.eq(q.field(field), args.from_user_id))
              .first();
        if (row) stragglers++;
      }
      if (stragglers > 0) {
        throw new Error(
          `cannot delete source user — ${stragglers} table(s) still reference ${args.from_user_id}`,
        );
      }
      await ctx.db.delete(args.from_user_id);
      sourceDeleted = true;
    }

    return {
      from: { _id: from._id, email: (from as any).email, name: (from as any).name },
      to: { _id: to._id, email: (to as any).email, name: (to as any).name },
      dry_run: args.dry_run,
      total_updated: totalUpdated,
      per_table: perTable,
      more,
      source_deleted: sourceDeleted,
      skipped_tables: SKIPPED_LARGE_TABLES,
    };
  },
});
