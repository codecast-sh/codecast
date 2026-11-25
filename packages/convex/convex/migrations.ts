import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { normalizeRepository } from "./lib/gitRefs";
import { commitRecordedBy } from "./githubWebhooks";
import { repositoryOfCheckout } from "./users";
import { standingReportsToFields } from "./lib/standingSeat";
import { listSessionOwnerIds, stampSeatOwners } from "./sessionOwners";
import { backfillProjectCountsPage, resetProjectCounts } from "./lib/projectTaskCounts";
import { performReparentSession } from "./sessionOwnership";
import { rolesInBoundary } from "./lib/orgAccess";
import { sessionWork } from "./lib/orgOwnership";
import { ownsWork, roleManagers } from "@codecast/shared/contracts/orgLead";
import { dropLegacyEntry, legacyLines, managersMap } from "./orgPeople";
import { roleSubject, withOrgChange } from "./lib/orgChangeLog";
import { isHandBriefing } from "./spawn";
import { isOrphanOrSubagent } from "./inboxFilters";
import { closeRunningStations } from "./lib/runEnd";

// One-time backfill: stamp conversations.model from each conversation's newest
// assistant message carrying a real model id ("<synthetic>" = error banner, not
// a model). addMessages/addMessage roll the field forward on every new batch;
// this covers rows written before that rollup existed. Only conversations
// updated after `since` are stamped — older ones pick it up organically if they
// wake. Pass auto:true to self-drain page by page via the scheduler.
//   packages/convex/run.sh migrations:backfillConversationModels '{"dryRun":false,"auto":true}'
export const backfillConversationModels = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    since: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 50;
    // Stable across continuations — computed once on the first page.
    const since = args.since ?? Date.now() - 60 * 24 * 60 * 60 * 1000;
    const page = await ctx.db
      .query("conversations")
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems });

    let stamped = 0;
    for (const conv of page.page) {
      if (conv.model || conv.updated_at < since) continue;
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .take(12);
      const src = recent.find((m) => m.role === "assistant" && m.model && m.model !== "<synthetic>");
      if (!src?.model) continue;
      if (!dryRun) await ctx.db.patch(conv._id, { model: src.model });
      stamped++;
    }

    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillConversationModels, {
        dryRun,
        cursor: page.continueCursor,
        numItems,
        since,
        auto: true,
      });
    }
    return { dryRun, stamped, scanned: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});

export const setStaff = internalMutation({
  args: {
    email: v.string(),
    staff: v.boolean(),
  },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    const user = users.find((u) => u.email === args.email);
    if (!user) {
      return { success: false, error: `User with email ${args.email} not found` };
    }
    await ctx.db.patch(user._id, { staff: args.staff || undefined });
    return { success: true, userId: user._id, email: user.email, staff: args.staff };
  },
});

// internalQuery, not query: this samples the most recent conversations across
// EVERY user and returns titles plus a preview of each first message, and it
// walks `messages` (millions of rows) with no index. As a public function it
// was both a cross-tenant leak and a denial-of-service handed to anyone with
// the deployment URL. It has no callers; kept as internal for one-off use.
export const analyzeMessageRoles = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 50);

    const conversations = await ctx.db
      .query("conversations")
      .order("desc")
      .take(limit);

    const stats = {
      totalConversations: conversations.length,
      conversationsChecked: 0,
      conversationsWithMessages: 0,
      conversationsWithIssues: 0,
      firstMessageNotUser: 0,
      consecutiveAssistant: 0,
      examples: [] as Array<{
        conversationId: string;
        title: string | undefined;
        firstMessageRole: string;
        firstMessagePreview: string;
        messageCount: number;
      }>,
    };

    for (const conv of conversations) {
      stats.conversationsChecked++;

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .take(10);

      if (messages.length === 0) continue;
      stats.conversationsWithMessages++;

      messages.sort((a, b) => a.timestamp - b.timestamp);

      const firstMsg = messages[0];
      if (firstMsg.role !== "user") {
        stats.firstMessageNotUser++;
        stats.conversationsWithIssues++;

        if (stats.examples.length < 10) {
          stats.examples.push({
            conversationId: conv._id,
            title: conv.title,
            firstMessageRole: firstMsg.role,
            firstMessagePreview: (firstMsg.content || "").slice(0, 100),
            messageCount: conv.message_count,
          });
        }
      }

      for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === "assistant" && messages[i - 1].role === "assistant") {
          if (!messages[i].tool_calls?.length && !messages[i].thinking) {
            stats.consecutiveAssistant++;
            break;
          }
        }
      }
    }

    return stats;
  },
});

// One-time backfill: rewrite every indexed repository name to its canonical
// spelling (`normalizeRepository`: lower case). Every writer now stores that
// form and every reader searches for it, so a row stored with capitals before
// this rule existed can never be found by index. The installation table is in
// the list because every repository lookup splits the owner out and searches
// `by_account_login`. Idempotent: a row already canonical is skipped, so a
// re-run is a no-op. Pass auto:true to drain each table and continue with the
// next one via the scheduler.
//   packages/convex/run.sh migrations:canonicalizeRepositoryNames '{"dryRun":false,"auto":true}'
export const REPOSITORY_NAME_TABLES = [
  "pull_requests",
  "commits",
  "review_comments",
  "external_events",
  "github_check_suites",
  "github_app_installations",
] as const;
type RepositoryNameTable = (typeof REPOSITORY_NAME_TABLES)[number];

/** The field that carries the repository name (or, for installations, the owner login). */
function repositoryNameField(table: RepositoryNameTable): "repository" | "account_login" {
  return table === "github_app_installations" ? "account_login" : "repository";
}

export const canonicalizeRepositoryNames = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    table: v.optional(v.union(...REPOSITORY_NAME_TABLES.map((t) => v.literal(t)))),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 200;
    const table: RepositoryNameTable = args.table ?? REPOSITORY_NAME_TABLES[0];
    const field = repositoryNameField(table);
    const page = await ctx.db
      .query(table)
      .paginate({ cursor: args.cursor ?? null, numItems });

    let rewritten = 0;
    for (const row of page.page as Array<Record<string, any>>) {
      const stored = row[field];
      const canonical = normalizeRepository(stored);
      if (typeof stored !== "string" || stored === canonical) continue;
      if (!dryRun) await ctx.db.patch(row._id, { [field]: canonical });
      rewritten++;
    }

    const nextTable = page.isDone
      ? REPOSITORY_NAME_TABLES[REPOSITORY_NAME_TABLES.indexOf(table) + 1]
      : table;
    if (args.auto && nextTable) {
      await ctx.scheduler.runAfter(0, internal.migrations.canonicalizeRepositoryNames, {
        dryRun,
        table: nextTable,
        cursor: page.isDone ? undefined : page.continueCursor,
        numItems,
        auto: true,
      });
    }
    return { dryRun, table, rewritten, scanned: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});

// One-time backfill: give every legacy task→conversation link an association
// row (entity_conversations), so the reverse lookup is exact.
//
// tasks.conversation_ids is an array field, and an array field cannot be
// indexed for containment. The association rail is the reverse index, but every
// path only started dual-writing it on 2026-08-01, so links older than that
// exist solely in the array. tasks.webListByConversation reads the rail plus
// two narrower indexes and is correct without this backfill for the common
// shapes (the task a session filed, the task it is working); this closes the
// remaining case — a task linked to a SECOND session before the rail existed.
//
//   packages/convex/run.sh migrations:backfillTaskConversationLinks '{"dryRun":false,"auto":true}'
export const backfillTaskConversationLinks = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 100;
    const page = await ctx.db.query("tasks").paginate({
      cursor: args.cursor ?? null,
      numItems,
    });

    let linked = 0;
    let scanned = 0;
    for (const task of page.page) {
      const convIds = task.conversation_ids ?? [];
      if (convIds.length === 0) continue;
      scanned++;
      const entityId = String(task._id);
      const existing = await ctx.db
        .query("entity_conversations")
        .withIndex("by_entity", (q) => q.eq("entity_type", "task").eq("entity_id", entityId))
        .collect();
      const have = new Set(existing.map((row) => String(row.conversation_id)));
      for (const convId of convIds) {
        if (have.has(String(convId))) continue;
        // The conversation may be gone (a deleted session leaves the id behind
        // in the array); a dangling rail row would only be filtered on read, so
        // skip it here instead.
        if (!(await ctx.db.get(convId))) continue;
        linked++;
        if (dryRun) continue;
        await ctx.db.insert("entity_conversations", {
          user_id: task.user_id,
          team_id: task.team_id,
          entity_type: "task" as const,
          entity_id: entityId,
          conversation_id: convId,
          // The legacy array records no relationship; "work" is what every
          // linking path (dispatch, task start) writes.
          relationship: "work" as const,
          created_at: task.created_at ?? Date.now(),
        });
        have.add(String(convId));
      }
    }

    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillTaskConversationLinks, {
        ...args,
        cursor: page.continueCursor,
      });
    }
    return { dryRun, scanned_linked_tasks: scanned, rows_written: linked, isDone: page.isDone, cursor: page.continueCursor };
  },
});

// One-time repair: unlink commits a merge handed to the wrong session.
//
// Until 2026-09-22 a push that merged main into a branch linked every main
// commit it carried to the one session sitting on that branch (the branch
// fallback in conversationForCommit ignored GitHub's `distinct` flag), so a
// session's timeline filled with its team's unrelated main history. A row is
// unlinked only when all three hold: no edit row from that session names the
// sha; the row was first stored on another branch than the session's; and the
// GitHub commit event, written when the commit was first seen, names another
// session or none, so the link was added afterwards.
//   packages/convex/run.sh migrations:unlinkMergedCommits '{"dryRun":false,"auto":true}'
export const unlinkMergedCommits = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    auto: v.optional(v.boolean()),
    scanned: v.optional(v.number()),
    unlinked: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 200;
    const page = await ctx.db.query("commits").paginate({ cursor: args.cursor ?? null, numItems });

    let scanned = args.scanned ?? 0;
    let unlinked = args.unlinked ?? 0;
    const samples: string[] = [];
    for (const row of page.page) {
      scanned++;
      if (!row.conversation_id) continue;
      const conversation = await ctx.db.get(row.conversation_id);
      if (!conversation?.git_branch || !row.branch || row.branch === conversation.git_branch) continue;
      if ((await commitRecordedBy(ctx, row.sha)) === row.conversation_id) continue;
      const event = await ctx.db
        .query("external_events")
        .withIndex("by_dedupe_key", (q) => q.eq("dedupe_key", `commit:${row.sha}`))
        .first();
      if (!event || event.conversation_id === row.conversation_id) continue;
      unlinked++;
      if (samples.length < 5) samples.push(`${row.sha.slice(0, 7)} ${row.branch} -> ${row.conversation_id} (${conversation.git_branch})`);
      if (!dryRun) await ctx.db.patch(row._id, { conversation_id: undefined });
    }

    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.unlinkMergedCommits, {
        ...args,
        cursor: page.continueCursor,
        scanned,
        unlinked,
      });
    } else if (args.auto) {
      console.log(`[unlinkMergedCommits] done dryRun=${dryRun} scanned=${scanned} unlinked=${unlinked}`);
    }
    return { dryRun, scanned, unlinked, samples, isDone: page.isDone, cursor: page.continueCursor };
  },
});

// One-time: stamp directory_team_mappings.repository from the sessions
// recorded under each mapped checkout, so a rule written before the field
// existed reaches the owner's other clones and worktrees. Idempotent: rows
// that carry the key, or whose folder has no session with a remote, are
// skipped. Small table; one pass.
//   packages/convex/run.sh migrations:stampMappingRepositories '{"dryRun":false}'
export const stampMappingRepositories = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const rows = await ctx.db.query("directory_team_mappings").collect();
    const stamped: Array<{ path_prefix: string; repository: string }> = [];
    let skipped = 0;
    for (const row of rows) {
      if (row.repository) { skipped++; continue; }
      const repository = await repositoryOfCheckout(ctx, row.user_id, row.path_prefix);
      if (!repository) { skipped++; continue; }
      if (!dryRun) await ctx.db.patch(row._id, { repository });
      stamped.push({ path_prefix: row.path_prefix, repository });
    }
    return { dryRun, scanned: rows.length, stamped, skipped };
  },
});

// One-time cleanup (org-staffing.md S28): `cast escalate` is gone, and with it
// the `escalated_by_role` stamp it wrote on a role's session. Nothing reads
// the field any more; this clears it from every row that still carries it, so
// the schema can drop the field afterwards (Convex refuses a schema the rows
// do not fit). Dry by default.
//   packages/convex/run.sh migrations:clearEscalationStamps '{"dryRun":false}'
export const clearEscalationStamps = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.string()), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const page = await ctx.db.query("conversations").paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
    const stamped = page.page.filter((c: any) => c.escalated_by_role !== undefined);
    if (!dryRun) for (const c of stamped) await ctx.db.patch(c._id, { escalated_by_role: undefined });
    // A dry run reports its one page and stops: it must not walk the table by itself.
    if (!page.isDone && !dryRun) {
      await ctx.scheduler.runAfter(0, internal.migrations.clearEscalationStamps, { dryRun, cursor: page.continueCursor, numItems: args.numItems });
    }
    return { dryRun, scanned: page.page.length, cleared: stamped.length, done: page.isDone };
  },
});

// A seat's folder is its standing session's (lib/seatPlace): nothing reads
// anchors.project_path any more, and the copy went stale whenever the session
// moved machines. This clears it from every anchor so the schema can drop the
// field. Dry by default.
//   packages/convex/run.sh migrations:clearAnchorProjectPaths '{"dryRun":false}'
export const clearAnchorProjectPaths = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const stamped = (await ctx.db.query("anchors").collect()).filter((a: any) => a.project_path !== undefined);
    if (!dryRun) for (const a of stamped) await ctx.db.patch(a._id, { project_path: undefined } as any);
    return { dryRun, cleared: stamped.length };
  },
});

// One-time backfill (org-staffing.md S28): a role's standing session carries
// its parent role in `org_role_id` so it rides the parent lead's card. Roles
// seated before the rule have it unset; roles that report to a person must
// have it clear. Dry by default.
//   packages/convex/run.sh migrations:stampStandingSeats '{"dryRun":false}'
export const stampStandingSeats = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const roles = (await ctx.db.query("org_roles").collect()).filter((r: any) => r.status !== "retired");
    const out: Array<{ role: string; standing: string; from: string | null; to: string | null }> = [];
    for (const role of roles as any[]) {
      const anchor: any = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
      const standing: any = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
      if (!standing) continue;
      const { org_role_id } = standingReportsToFields(role);
      // The seat's owners are the people the role reports to (sessionOwners.stampSeatOwners).
      const bosses = roleManagers(role).flatMap((p: any) => (p.kind === "user" ? [String(p.user_id)] : [])).sort();
      const owners = (await listSessionOwnerIds(ctx, standing._id)).map(String);
      const ownersRight = JSON.stringify([...owners].sort()) === JSON.stringify(bosses);
      if (String(standing.org_role_id ?? "") === String(org_role_id ?? "") && ownersRight) continue;
      out.push({ role: role.handle, standing: standing.short_id ?? String(standing._id), from: `${standing.org_role_id ? String(standing.org_role_id) : "person"} owners=${owners.join(",") || "none"}`, to: `${org_role_id ? String(org_role_id) : "person"} owners=${bosses.join(",") || "none"}` });
      if (!dryRun) {
        await ctx.db.patch(standing._id, { org_role_id });
        // Written as the boss's own row, so the backfill hands nobody a ping.
        await stampSeatOwners(ctx, standing._id, role, (bosses[0] as any) ?? role.host_user_id);
      }
    }
    return { dryRun, roles: roles.length, stamped: out.length, changes: out };
  },
});

// Hand back what a lead holds only through the folder rule (org-staffing.md
// S35). A role holds a session for two reasons: bound to work the role owns,
// or filed there by a person or role. Before S35 a lead also took every
// session in its projects' folders; those are released here, to whoever
// started them, through the one reparent core, one org change batch per role
// so History and `cast org undo <batch>` take it back. Everything the role
// keeps is stamped with why (`org_role_hold`), so health and the binding rule
// read it from now on.
//
//   packages/convex/run.sh migrations:releaseFolderHeldSessions '{"dryRun":true,"team":"<team id>","role":"calling"}'
//
// Dry by default. `team` (an id) and `role` (a handle) narrow it; `limit`
// caps the sessions moved in one run (the rest wait for the next). A killed
// session is skipped: it is a retired row nobody reads, and moving it would
// only write log rows. A hand from before the stamp is known by its run
// (`workflow_run_id`, a line run), its parent chain, or its first message (the
// hand briefing). `release_live` counts released sessions whose status is
// active (the row is not completed or killed) and whose pinned state is not
// done; dormant and idle work count as live.
export const releaseFolderHeldSessions = internalMutation({
  args: { dryRun: v.optional(v.boolean()), team: v.optional(v.string()), role: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => releaseFolderHeld(ctx, args),
});

export async function releaseFolderHeld(ctx: { db: any; scheduler?: any }, args: { dryRun?: boolean; team?: string; role?: string; limit?: number }) {
  {
    const dryRun = args.dryRun ?? true;
    const limit = args.limit ?? 200;
    let roles = (await ctx.db.query("org_roles").collect()).filter((r: any) => r.status !== "retired");
    if (args.team) roles = roles.filter((r: any) => String(r.team_id ?? "") === args.team);
    if (args.role) {
      const handle = args.role.replace(/^@/, "").toLowerCase();
      roles = roles.filter((r: any) => r.handle === handle);
    }
    const byBoundary = new Map<string, any[]>();
    for (const r of roles) {
      const key = r.team_id ? `team:${r.team_id}` : `user:${r.scope_user_id}`;
      byBoundary.set(key, [...(byBoundary.get(key) ?? []), r]);
    }
    const rows: Array<{ role: string; session: string; title: string; state: string; work: string; updated_at: number; verdict: "release" | "keep" | "skip"; reason: string; return_to?: string }> = [];
    let released = 0;
    let stamped = 0;
    // A takeover leaves no row of its own per session: it folds into the row
    // of the change that caused it (lib/orgChangeLog noteOrgChange), listing
    // the sessions in `effects.takeover.sessions`. Read once per boundary, so
    // a released session can say which change took it.
    const takenBy = new Map<string, string>();
    for (const key of byBoundary.keys()) {
      const changes: any[] = await ctx.db.query("org_changes").withIndex("by_workspace_seq", (q: any) => q.eq("workspace", key)).collect();
      for (const ch of changes) {
        const t = ch.effects?.takeover;
        if (!t?.sessions?.length) continue;
        const batch: any = await ctx.db.get(ch.batch);
        const label = batch?.proposal?.short_id ?? `${ch.kind} change`;
        for (const s of t.sessions) if (s?.conversation_id) takenBy.set(String(s.conversation_id), label);
      }
    }
    for (const role of roles as any[]) {
      const boundaryRoles = await rolesInBoundary(ctx, role);
      const held: any[] = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id)).collect();
      const toRelease: any[] = [];
      for (const c of held) {
        if (c.standing_role_id || c.anchor_id) continue;
        const shortId = c.short_id ?? String(c._id).slice(0, 7);
        const state = c.inbox_killed_at ? "killed" : c.status ?? "active";
        const base = { role: role.handle, session: shortId, title: (c.title ?? "").trim(), state, work: c.thread_state_status ?? "-", updated_at: c.updated_at ?? 0 };
        if (c.inbox_killed_at) { rows.push({ ...base, verdict: "skip", reason: "killed: a retired row nobody reads" }); continue; }
        const keep = async (reason: string, hold: "bound" | "filed") => {
          rows.push({ ...base, verdict: "keep", reason });
          if (!dryRun && c.org_role_hold !== hold) { await ctx.db.patch(c._id, { org_role_hold: hold }); stamped++; }
        };
        if (ownsWork(role, await sessionWork(ctx, c), boundaryRoles)) { await keep("bound to work in its area", "bound"); continue; }
        if (c.org_role_hold === "filed") { await keep("filed by a person or role", "filed"); continue; }
        // Started by the role's line: a line run, a hand whose parent chain
        // reaches the role's standing session, or a hand briefed as one.
        let viaLine = !!c.workflow_run_id;
        let cur = c;
        for (let depth = 0; !viaLine && cur?.parent_conversation_id && depth < 8; depth++) {
          cur = await ctx.db.get(cur.parent_conversation_id);
          if (cur && String(cur.standing_role_id ?? "") === String(role._id)) viaLine = true;
        }
        if (!viaLine) {
          const first: any = await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", c._id)).order("asc").first();
          viaLine = isHandBriefing(first?.content);
        }
        if (viaLine) { await keep("started by the role's own line", "filed"); continue; }
        // The org log: a person's or role's own filing is a batch of kind
        // session; a takeover folds into a scope, role or hire batch.
        const last: any = await ctx.db.query("org_changes").withIndex("by_subject", (q: any) => q.eq("subject.id", String(c._id))).order("desc").first();
        const batch: any = last?.batch ? await ctx.db.get(last.batch) : null;
        const kinds = batch ? Object.keys(batch.kinds ?? {}) : [];
        if (batch && kinds.every((k) => k === "session")) { await keep(`filed by a person or role (${batch.door})`, "filed"); continue; }
        const returnTo = String(c.owner_user_id ?? c.user_id);
        const taken = takenBy.get(String(c._id)) ?? (batch ? `${kinds.join("+")} batch` : null);
        rows.push({ ...base, verdict: "release", reason: taken ? `taken over by the folder rule (${taken})` : `no record (folder ${c.project_path ?? "unknown"})`, return_to: returnTo });
        toRelease.push(c);
      }
      if (dryRun || !toRelease.length) continue;
      const slice = toRelease.slice(0, Math.max(0, limit - released));
      if (!slice.length) continue;
      await withOrgChange(ctx, role.host_user_id, { kind: "scope", subject: roleSubject(role), door: "cli", gesture: "command" }, async () => {
        for (const c of slice) {
          const starter = c.owner_user_id ?? c.user_id;
          await performReparentSession(ctx, starter, { session_id: String(c._id), target: { kind: "user", user_id: starter, mode: "add" }, note: `Folders decide nothing now: this session was under @${role.handle} only because of the folder it runs in.` });
          released++;
        }
      });
    }
    const counts = {
      release: rows.filter((r) => r.verdict === "release").length,
      release_live: rows.filter((r) => r.verdict === "release" && r.state === "active" && r.work !== "done").length,
      keep: rows.filter((r) => r.verdict === "keep").length,
      skipped: rows.filter((r) => r.verdict === "skip").length,
    };
    return { dryRun, roles: roles.length, ...counts, released, stamped, rows };
  }
}

// One-time backfill: stamp first_linked_conversation (the indexed copy of a
// task's conversation_ids[0] / a doc's related_conversation_ids[0]) on rows
// written before the change-feed interceptor stamped it, so a visibility change
// finds them by index (lib/access.ts recomputeWorkspaceForConversation). The
// field is churn-exempt, so these patches stream nothing to clients. Dry by
// default; pages through tasks, then docs.
//   packages/convex/run.sh migrations:stampFirstLinkedConversation '{"dryRun":false}'
export const stampFirstLinkedConversation = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    table: v.optional(v.union(v.literal("tasks"), v.literal("docs"))),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const table = args.table ?? "tasks";
    const page = await ctx.db.query(table).paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
    let stamped = 0;
    for (const row of page.page as any[]) {
      const first = (table === "tasks" ? row.conversation_ids : row.related_conversation_ids)?.[0];
      if (!first || row.first_linked_conversation === first) continue;
      stamped++;
      if (!dryRun) await ctx.db.patch(row._id, { first_linked_conversation: first });
    }
    const next = !page.isDone
      ? { table, cursor: page.continueCursor }
      : table === "tasks" ? { table: "docs" as const, cursor: undefined } : null;
    if (!dryRun && next) {
      await ctx.scheduler.runAfter(0, internal.migrations.stampFirstLinkedConversation, { dryRun, ...next, numItems: args.numItems });
    }
    return { dryRun, table, scanned: page.page.length, stamped, done: !next };
  },
});

// One-time backfill: stamp status_at on done decision_inbox rows written before
// setInboxStatus stamped it, from the decision's resolve time, so the recently
// handled reads (listForUserCore, listHandledByRoles) find them by index. Dry
// by default.
//   packages/convex/run.sh migrations:stampInboxStatusAt '{"dryRun":false}'
export const stampInboxStatusAt = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.string()), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const page = await ctx.db.query("decision_inbox").paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
    let stamped = 0;
    for (const row of page.page) {
      if (row.status !== "done" || row.status_at !== undefined) continue;
      const decision = await ctx.db.get(row.decision_id);
      stamped++;
      if (!dryRun) await ctx.db.patch(row._id, { status_at: decision?.resolved_at ?? row.created_at });
    }
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.stampInboxStatusAt, { dryRun, cursor: page.continueCursor, numItems: args.numItems });
    }
    return { dryRun, scanned: page.page.length, stamped, done: page.isDone };
  },
});

// Count every task into project_task_counts (lib/projectTaskCounts.ts), one page
// per run, scheduling the next until the cursor catches up. Safe while tasks
// are being written: the interceptor keeps counted tasks current and leaves
// newer ones to this walk. `reset` drops the counts first and recounts from
// zero (reconcile after a suspected drift).
//   packages/convex/run.sh migrations:backfillProjectTaskCounts '{}'
//   packages/convex/run.sh migrations:backfillProjectTaskCounts '{"reset":true}'
export const backfillProjectTaskCounts = internalMutation({
  args: { reset: v.optional(v.boolean()), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const dropped = args.reset ? await resetProjectCounts(ctx) : 0;
    const { scanned, done } = await backfillProjectCountsPage(ctx, args.numItems ?? 100);
    if (!done) await ctx.scheduler.runAfter(0, internal.migrations.backfillProjectTaskCounts, { numItems: args.numItems });
    return { dropped, scanned, done };
  },
});

// One-time cleanup: a parent's stash used to copy its stamp onto every nested
// child (isOrphanOrSubagent), and no restore of the parent cleared the copies,
// so each child stayed stashed as a card of its own after its parent came back
// or moved to another account. A child now rides its parent's stash, and a
// stamp of its own means an act on the child (the person stashed it, or its
// trigger run was folded). This clears the stamps that are provably copies:
// the parent is missing or another user's, the parent is stashed and the child
// was stamped at or after it, or a sibling carries the very same stamp (one
// gesture stamped the group). A trigger run (agent_task_id) is folded by its
// own stamp and is never touched, nor is a workflow sub without a parent
// pointer or any non-nested row. Running it twice clears nothing new. With
// `user_id` a dry run reports one page of that user's stashed rows (pass
// `cursor` on for the next) and a real run walks them all. Without it, a real
// run schedules one run per user, and a dry run reports a first page for each
// user in one page of the users table.
//   packages/convex/run.sh migrations:clearCopiedChildStashStamps '{"dry_run":true}'
//   packages/convex/run.sh migrations:clearCopiedChildStashStamps '{"dry_run":false}'
export const clearCopiedChildStashStamps = internalMutation({
  args: { user_id: v.optional(v.id("users")), dry_run: v.boolean(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { dry_run } = args;
    if (args.user_id) {
      const r = await clearCopiedStashPage(ctx, args.user_id, dry_run, args.cursor ?? null, 100);
      if (!dry_run && !r.done) {
        await ctx.scheduler.runAfter(0, internal.migrations.clearCopiedChildStashStamps, { user_id: args.user_id, dry_run, cursor: r.cursor ?? undefined });
      }
      return { dry_run, user_id: args.user_id, ...r };
    }
    const users = await ctx.db.query("users").paginate({ cursor: args.cursor ?? null, numItems: dry_run ? 10 : 100 });
    const perUser: any[] = [];
    for (const u of users.page) {
      if (!dry_run) {
        await ctx.scheduler.runAfter(0, internal.migrations.clearCopiedChildStashStamps, { user_id: u._id, dry_run });
        continue;
      }
      const r = await clearCopiedStashPage(ctx, u._id, true, "peek", 40);
      if (r.examined || !r.done) perUser.push({ user_id: u._id, ...r });
    }
    if (!dry_run && !users.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.clearCopiedChildStashStamps, { dry_run, cursor: users.continueCursor });
    }
    return { dry_run, users_scanned: users.page.length, users: perUser, cursor: users.continueCursor, done: users.isDone };
  },
});

// A "peek" reads a first page with take: Convex allows one paginate per
// function, and the all-users dry run already spends it on the users table.
async function clearCopiedStashPage(ctx: { db: any }, userId: any, dryRun: boolean, cursor: string | null | "peek", numItems: number) {
  const stashedRows = () => ctx.db
    .query("conversations")
    .withIndex("by_user_stashed", (q: any) => q.eq("user_id", userId).gt("inbox_stashed_at", 0));
  const page = cursor === "peek"
    ? await stashedRows().take(numItems).then((rows: any[]) => ({ page: rows, continueCursor: null, isDone: rows.length < numItems }))
    : await stashedRows().paginate({ cursor, numItems });
  // Whether another child of the same parent carries this exact stamp: the
  // rows sharing one stamp are one gesture, read off the same index.
  const shared = new Map<string, boolean>();
  const sharesStampWithSibling = async (row: any) => {
    const key = `${row.parent_conversation_id}:${row.inbox_stashed_at}`;
    let hit = shared.get(key);
    if (hit === undefined) {
      const twins = await ctx.db
        .query("conversations")
        .withIndex("by_user_stashed", (q: any) => q.eq("user_id", userId).eq("inbox_stashed_at", row.inbox_stashed_at))
        .filter((q: any) => q.eq(q.field("parent_conversation_id"), row.parent_conversation_id))
        .take(2);
      hit = twins.length > 1;
      shared.set(key, hit);
    }
    return hit;
  };
  const by_reason = { parent_missing: 0, parent_other_user: 0, copied_from_stashed_parent: 0, shared_with_sibling: 0 };
  let examined = 0;
  let kept = 0;
  for (const row of page.page) {
    if (!row.inbox_stashed_at || !isOrphanOrSubagent(row) || !row.parent_conversation_id || row.agent_task_id) continue;
    examined++;
    const parent: any = await ctx.db.get(row.parent_conversation_id);
    const reason: keyof typeof by_reason | null = !parent ? "parent_missing"
      : parent.user_id !== row.user_id ? "parent_other_user"
      : parent.inbox_stashed_at && row.inbox_stashed_at >= parent.inbox_stashed_at ? "copied_from_stashed_parent"
      : (await sharesStampWithSibling(row)) ? "shared_with_sibling"
      : null;
    if (!reason) { kept++; continue; }
    by_reason[reason]++;
    if (!dryRun) await ctx.db.patch(row._id, { inbox_stashed_at: undefined, inbox_stash_hidden: undefined });
  }
  const cleared = Object.values(by_reason).reduce((a, b) => a + b, 0);
  return {
    examined,
    [dryRun ? "would_clear" : "cleared"]: cleared,
    kept_explicit: kept,
    by_reason,
    cursor: page.continueCursor as string | null,
    done: page.isDone as boolean,
  };
}

// One-time repair: close the stations runs that ended before lib/runEnd.ts
// still mark running (a spinner and a clock counting on a failed run). Dry by
// default; a real run walks every page.
//   packages/convex/run.sh migrations:closeEndedRunStations '{"dryRun":false}'
export const closeEndedRunStations = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.string()), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const page = await ctx.db.query("workflow_runs").paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 100 });
    const closed: string[] = [];
    for (const run of page.page) {
      if ((run.status !== "completed" && run.status !== "failed") || !run.node_statuses.some((n) => n.status === "running")) continue;
      closed.push(String(run._id));
      // Closed at the run's own end, so a station's time reads to when the run stopped, not to today.
      if (!dryRun) await ctx.db.patch(run._id, { node_statuses: closeRunningStations(run.node_statuses, run.status, run.updated_at) });
    }
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.closeEndedRunStations, { dryRun, cursor: page.continueCursor, numItems: args.numItems });
    }
    return { dryRun, scanned: page.page.length, closed, cursor: page.continueCursor, done: page.isDone };
  },
});

// The people who report to a role move into each person's managers list, the
// one home (docs/architecture/org-people.md P3): every id in a team role's
// `reports_user_ids` joins that person's `team_memberships.managers` and
// leaves the role's list, and every row's one-person `reports_to_user_id`
// becomes its list. Personal roles keep their own list (no memberships).
// Dry by default; reruns change nothing once drained.
//   packages/convex/run.sh migrations:foldOrgManagers '{"dryRun":false}'
export const foldOrgManagers = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const out: Array<{ team: string; user: string; managers: string[] }> = [];
    const teams = new Set<string>();
    for (const role of (await ctx.db.query("org_roles").collect()) as any[]) {
      if (role.team_id && (role.reports_user_ids ?? []).length) teams.add(String(role.team_id));
    }
    for (const m of (await ctx.db.query("team_memberships").collect()) as any[]) {
      if (m.reports_to_user_id !== undefined) teams.add(String(m.team_id));
    }
    for (const teamId of teams) {
      const memberships: any[] = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId as any)).collect();
      const roles: any[] = await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", teamId as any)).collect();
      const live = new Set(roles.filter((r) => r.status !== "retired").map((r) => String(r._id)));
      const current = managersMap(memberships, live);
      // Only the entries that are reporting lines move, settled one at a time
      // so none of them loops; one that would close a loop stays on the role,
      // where it means goals only (orgPeople.legacyLines).
      const lines = legacyLines(memberships, live, roles);
      for (const m of memberships) {
        const mine = lines.filter((l) => l.uid === String(m.user_id));
        if (m.reports_to_user_id === undefined && !mine.length) continue;
        const list = [...(current.get(String(m.user_id)) ?? []), ...mine.map((l) => ({ kind: "role" as const, role_id: l.role._id }))];
        out.push({ team: teamId, user: String(m.user_id), managers: list.map((p) => (p.kind === "user" ? `user:${p.user_id}` : `role:${p.role_id}`)) });
        if (!dryRun) await ctx.db.patch(m._id, { managers: list.length ? list : undefined, reports_to_user_id: undefined });
      }
      if (!dryRun) for (const l of lines) await dropLegacyEntry(ctx, l.role._id, l.uid as any);
    }
    return { dryRun, teams: teams.size, people: out.length, changes: out };
  },
});
