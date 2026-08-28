// TEMPORARY debug query — safe to delete. Inspects why a conversation keeps
// reappearing after dismiss: dumps dismiss-relevant fields + recent activity.
import { internalQuery, internalMutation, internalAction } from "./functions";
import { anyApi } from "convex/server";
import { internalMutation as rawInternalMutation } from "./_generated/server";
import { scanInboxConversations, computeSessionsLiveness, computeInboxSessions, setConvGitDiff, setConvStableContext } from "./conversations";
import { shouldShowInInbox } from "./inboxFilters";
import { v } from "convex/values";
import { BUCKETS_VIEW_CONTRACT_ID, BUCKETS_VIEW_KEY } from "./buckets";
import { advanceLocalViewRevision } from "./localFirstCommands";
import { performWebActiveSessions } from "./tasks";

// TEMPORARY: insert a switch_account daemon command scoped to ONE conversation
// — exercises the daemon's swap+kill+continue handler end-to-end without
// selecting the whole blocked fleet the way requestAccountSwitch does.
export const insertSwitchAccountForOne = internalMutation({
  args: { conversation_id: v.id("conversations"), profile: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return { error: "not found" };
    const id = await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "switch_account" as const,
      args: JSON.stringify({
        profile: args.profile,
        conversation_ids: [conv._id],
        session_ids: { [conv._id]: conv.session_id },
        continue_blocked: true,
      }),
      created_at: Date.now(),
      target_device_id: conv.owner_device_id,
    });
    return { command_id: id };
  },
});

// Set a user's alternate_emails (assignee-resolution aliases) by primary email.
export const setAlternateEmails = internalMutation({
  args: { email: v.string(), alternate_emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q: any) => q.eq("email", args.email))
      .first();
    if (!user) return { error: "no user" };
    await ctx.db.patch(user._id, { alternate_emails: args.alternate_emails });
    return { user_id: user._id, name: user.name, alternate_emails: args.alternate_emails };
  },
});

export const inspectConversation = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    let conversation = null;
    const convId = ctx.db.normalizeId("conversations", args.id);
    if (convId) conversation = await ctx.db.get(convId);
    if (!conversation) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.id))
        .first();
    }
    if (!conversation) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.id))
        .first();
    }
    if (!conversation) return { error: "not found" };

    const ownerRows = await ctx.db
      .query("session_owners")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", conversation._id))
      .collect();

    const recentMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
      .order("desc")
      .take(5);

    const pending = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
      .order("desc")
      .take(5);

    const managed = conversation.session_id
      ? await ctx.db
          .query("managed_sessions")
          .withIndex("by_session_id", (q) => q.eq("session_id", conversation.session_id!))
          .first()
      : null;

    return {
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        session_id: conversation.session_id,
        user_id: conversation.user_id,
        status: conversation.status,
        inbox_dismissed_at: conversation.inbox_dismissed_at,
        inbox_stashed_at: (conversation as any).inbox_stashed_at,
        inbox_pinned_at: (conversation as any).inbox_pinned_at,
        owner_user_id: (conversation as any).owner_user_id,
        updated_at: conversation.updated_at,
        started_at: conversation.started_at,
        parent_conversation_id: (conversation as any).parent_conversation_id,
        is_subagent: (conversation as any).is_subagent,
        active_plan_id: (conversation as any).active_plan_id,
        owner_device_id: (conversation as any).owner_device_id,
        project_path: conversation.project_path,
      },
      now: Date.now(),
      sessionOwners: ownerRows.map((r) => ({
        user_id: r.user_id,
        added_by: r.added_by,
        added_at: r.added_at,
      })),
      recentMessages: recentMessages.map((m) => ({
        _id: m._id,
        role: m.role,
        timestamp: m.timestamp,
        _creationTime: m._creationTime,
        preview: (m.content ?? "").slice(0, 80),
      })),
      pendingMessages: pending.map((p) => ({
        _id: p._id,
        status: p.status,
        created_at: p.created_at,
        _creationTime: p._creationTime,
      })),
      managedSession: managed
        ? {
            agent_status: managed.agent_status,
            last_heartbeat: managed.last_heartbeat,
            last_metrics_at: managed.last_metrics_at,
          }
        : null,
    };
  },
});

// TEMPORARY diagnostics for attachment persistence. Returns only attachment
// metadata and short text previews, never file contents.
export const inspectConversationImages = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    let conversation = null;
    const convId = ctx.db.normalizeId("conversations", args.id);
    if (convId) conversation = await ctx.db.get(convId);
    if (!conversation) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.id))
        .first();
    }
    if (!conversation) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.id))
        .first();
    }
    if (!conversation) return { error: "not found" };

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
      .collect();
    const pending = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
      .collect();

    return {
      conversation_id: conversation._id,
      messages: messages
        .filter((message) => message.role === "user")
        .map((message) => ({
          _id: message._id,
          timestamp: message.timestamp,
          client_id: message.client_id,
          preview: (message.content ?? "").slice(0, 120),
          images: message.images?.map((image) => ({
            storage_id: image.storage_id,
            media_type: image.media_type,
          })),
        })),
      pending: pending.map((message) => ({
        _id: message._id,
        created_at: message.created_at,
        status: message.status,
        client_id: message.client_id,
        preview: (message.content ?? "").slice(0, 120),
        image_storage_id: message.image_storage_id,
        image_storage_ids: message.image_storage_ids,
      })),
    };
  },
});

// TEMPORARY one-shot repair for the 2026-07-30 Codex app-server image-path
// corruption. The buggy mapper uploaded a base64-decoded local path on every
// streaming rebuild, producing image-only duplicate rows. This detaches those
// corrupt images, deletes only otherwise-empty rows, and keeps message_count in
// sync. expected_remaining makes every bounded batch fail closed if the target
// set changes between inspection and repair.
export const repairCodexImagePathCorruption = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    start_timestamp: v.number(),
    end_timestamp: v.number(),
    expected_remaining: v.number(),
    limit: v.optional(v.number()),
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");

    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q
          .eq("conversation_id", args.conversation_id)
          .gte("timestamp", args.start_timestamp)
          .lte("timestamp", args.end_timestamp)
      )
      .collect();
    const affected = rows.filter((message) =>
      message.role === "assistant" && (message.images?.length ?? 0) > 0
    );
    if (affected.length !== args.expected_remaining) {
      throw new Error(
        `Repair target changed: expected ${args.expected_remaining} rows, found ${affected.length}`,
      );
    }

    const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
    const batch = affected.slice(0, limit);
    const summary = {
      targetedRows: affected.length,
      targetedImages: affected.reduce((count, message) => count + (message.images?.length ?? 0), 0),
      batchRows: batch.length,
      removableRows: batch.filter((message) =>
        !message.content?.trim() &&
        !message.thinking?.trim() &&
        !(message.tool_calls?.length) &&
        !(message.tool_results?.length)
      ).length,
    };
    if (!args.apply) return { ...summary, applied: false, remaining: affected.length };

    let removedRows = 0;
    let clearedRows = 0;
    let imagesDetached = 0;
    for (const message of batch) {
      imagesDetached += message.images?.length ?? 0;
      const hasOtherContent =
        !!message.content?.trim() ||
        !!message.thinking?.trim() ||
        !!message.tool_calls?.length ||
        !!message.tool_results?.length;
      if (hasOtherContent) {
        await ctx.db.patch(message._id, { images: undefined });
        clearedRows++;
      } else {
        await ctx.db.delete(message._id);
        removedRows++;
      }
    }
    if (removedRows > 0) {
      await ctx.db.patch(conversation._id, {
        message_count: Math.max(0, (conversation.message_count ?? 0) - removedRows),
      });
    }
    return {
      ...summary,
      applied: true,
      removedRows,
      clearedRows,
      imagesDetached,
      remaining: affected.length - batch.length,
    };
  },
});

// TEMPORARY: clear archived_at on a bucket stranded by the dropped-undefined
// dispatch bug (unarchive never reached the server). Safe to delete.
export const unarchiveBucket = internalMutation({
  args: { bucket_id: v.id("inbox_buckets") },
  handler: async (ctx, args) => {
    const bucket = await ctx.db.get(args.bucket_id);
    if (!bucket) return { error: "not found" };
    await ctx.db.patch(args.bucket_id, { archived_at: undefined, updated_at: Date.now() });
    await advanceLocalViewRevision(
      ctx,
      bucket.user_id,
      BUCKETS_VIEW_CONTRACT_ID,
      BUCKETS_VIEW_KEY,
    );
    return { name: bucket.name, was_archived_at: bucket.archived_at ?? null };
  },
});

// TEMPORARY: sample conversation doc weight — how many docs carry the orphaned
// title_embedding (1024 float64s) and what the average doc size is, newest or
// oldest first. Sizes the strip-migration payoff. Safe to delete.
export const sampleConversationWeight = internalQuery({
  args: { take: v.optional(v.number()), oldest: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const n = Math.min(args.take ?? 200, 400);
    const rows = await ctx.db
      .query("conversations")
      .order(args.oldest ? "asc" : "desc")
      .take(n);
    let withEmb = 0;
    let bytes = 0;
    let embBytes = 0;
    for (const c of rows) {
      bytes += JSON.stringify(c).length;
      const emb = (c as any).title_embedding;
      if (emb) {
        withEmb++;
        embBytes += JSON.stringify(emb).length;
      }
    }
    return {
      sampled: rows.length,
      with_embedding: withEmb,
      avg_doc_bytes: rows.length ? Math.round(bytes / rows.length) : 0,
      embedding_bytes_total: embBytes,
      newest_first: !args.oldest,
    };
  },
});

// TEMPORARY: sample docs of any table by creation-time seek — how many carry an
// orphaned embedding field (writers removed 2026-06-28, data never stripped) and
// average doc size. after = ms epoch to seek to. Safe to delete.
export const sampleEmbeddingEra = internalQuery({
  args: {
    table: v.union(v.literal("messages"), v.literal("conversations"), v.literal("docs")),
    after: v.number(),
    take: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const n = Math.min(args.take ?? 300, 400);
    const rows = await (ctx.db.query(args.table as any) as any)
      .withIndex("by_creation_time", (q: any) => q.gt("_creationTime", args.after))
      .take(n);
    const field = args.table === "conversations" ? "title_embedding" : "embedding";
    let withEmb = 0;
    let bytes = 0;
    let embBytes = 0;
    for (const r of rows) {
      bytes += JSON.stringify(r).length;
      const emb = r[field];
      if (emb) {
        withEmb++;
        embBytes += JSON.stringify(emb).length;
      }
    }
    return {
      table: args.table,
      sampled: rows.length,
      with_embedding: withEmb,
      avg_doc_bytes: rows.length ? Math.round(bytes / rows.length) : 0,
      avg_emb_bytes: withEmb ? Math.round(embBytes / withEmb) : 0,
      first_at: rows.length ? new Date(rows[0]._creationTime).toISOString() : null,
    };
  },
});

// TEMPORARY: time the managed_sessions per-user scan two ways — the unbounded
// by_user_id collect (suspected SystemTimeoutError source in listConversations)
// vs a by_user_heartbeat window seek. Safe to delete.
export const timeManagedScan = internalQuery({
  args: {
    who: v.string(), // email, username, or github_username
    mode: v.union(v.literal("full"), v.literal("window")),
    windowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user =
      (await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", args.who))
        .first()) ??
      (await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", args.who))
        .first()) ??
      (await ctx.db
        .query("users")
        .withIndex("by_github_username", (q) => q.eq("github_username", args.who))
        .first());
    if (!user) return { error: "no user" };
    const now = Date.now();
    const t0 = Date.now();
    const rows =
      args.mode === "full"
        ? await ctx.db
            .query("managed_sessions")
            .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
            .collect()
        : await ctx.db
            .query("managed_sessions")
            .withIndex("by_user_heartbeat", (q) =>
              q.eq("user_id", user._id).gte("last_heartbeat", now - (args.windowMs ?? 90 * 1000))
            )
            .collect();
    const ages = rows.map((s) => Math.round((now - s.last_heartbeat) / 1000)).sort((a, b) => a - b);
    return {
      mode: args.mode,
      user_id: user._id,
      user_email: (user as any).email ?? null,
      scan_ms: Date.now() - t0,
      rows: rows.length,
      live_90s: rows.filter((s) => now - s.last_heartbeat < 90 * 1000).length,
      heartbeat_ages_s: ages.slice(0, 5).concat(ages.length > 10 ? [-1] : [], ages.slice(-5)),
    };
  },
});

// TEMPORARY: run the real tasks.webActiveSessions body for a user and time it
// (the query timed out in prod with "too many system operations"). Safe to delete.
export const timeWebActiveSessions = internalQuery({
  args: { who: v.string() },
  handler: async (ctx, args) => {
    const user =
      (await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", args.who))
        .first()) ??
      (await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", args.who))
        .first());
    if (!user) return { error: "no user" };
    const t0 = Date.now();
    const map = await performWebActiveSessions(ctx, user._id);
    return { ms: Date.now() - t0, tasks_with_live_sessions: Object.keys(map).length };
  },
});

// TEMPORARY: list users that have a role set (find the admin account). Safe to delete.
export const listRoleUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => u.role)
      .map((u) => ({ id: u._id, email: u.email, role: u.role }));
  },
});

// TEMPORARY: verify the session-state notification replacement (one row per
// conversation). Lists a conversation's notification rows per recipient.
// Safe to delete.
export const listConvNotifRows = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    let conv = null;
    const convId = ctx.db.normalizeId("conversations", args.id);
    if (convId) conv = await ctx.db.get(convId);
    if (!conv) {
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.id))
        .first();
    }
    if (!conv) return { error: "not found" };
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_conversation", (q) =>
        q.eq("recipient_user_id", conv!.user_id).eq("conversation_id", conv!._id),
      )
      .collect();
    return {
      conversation_id: conv._id,
      title: conv.title,
      needs_input_notified_key: (conv as any).needs_input_notified_key,
      message_count: conv.message_count,
      rows: rows.map((n) => ({
        _id: n._id,
        type: n.type,
        read: n.read,
        created_at: n.created_at,
        message: (n.message ?? "").slice(0, 60),
      })),
    };
  },
});

// TEMPORARY: clear the needs-input dedupe key so checkNeedsInput can re-fire
// for the current waiting episode (what a new turn does naturally). Safe to delete.
export const clearNeedsInputKey = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversation_id, { needs_input_notified_key: undefined });
    return { cleared: true };
  },
});

// TEMPORARY one-shot repair for jx7byyk (2026-07-31): the user's composer
// pastes uploaded to storage but the send carried no image ids, so the
// transcript row has none. Re-attaches the verified orphaned uploads.
// Fail-closed: the target must be a user row, currently image-less, and its
// content must start with the expected prefix.
export const attachImagesToUserMessage = internalMutation({
  args: {
    message_id: v.id("messages"),
    expected_content_prefix: v.string(),
    images: v.array(v.object({ storage_id: v.id("_storage"), media_type: v.string() })),
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.message_id);
    if (!message) throw new Error("Message not found");
    if (message.role !== "user") throw new Error(`Target is role=${message.role}, expected user`);
    if (message.images && message.images.length > 0) throw new Error("Target already has images");
    if (!(message.content ?? "").startsWith(args.expected_content_prefix)) {
      throw new Error("Content prefix mismatch");
    }
    for (const image of args.images) {
      const url = await ctx.storage.getUrl(image.storage_id);
      if (!url) throw new Error(`Storage id ${image.storage_id} does not resolve`);
    }
    if (!args.apply) {
      return { wouldAttach: args.images.length, content: (message.content ?? "").slice(0, 80), applied: false };
    }
    await ctx.db.patch(args.message_id, { images: args.images });
    return { attached: args.images.length, applied: true };
  },
});

// TEMPORARY: mobile huddles e2e — scratch team + channel for test users.
// Same shape as the torn-down web-e2e helper. Safe to delete.
export const e2eSetupMobile = internalMutation({
  args: { members: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const NAME = "Huddle E2E";
    let team = (await ctx.db.query("teams").collect()).find((t) => t.name === NAME);
    const now = Date.now();
    const teamId =
      team?._id ??
      (await ctx.db.insert("teams", {
        name: NAME,
        icon: "atom",
        icon_color: "violet",
        created_at: now,
        invite_code: `E2E${now}`,
      }));
    for (const uid of args.members) {
      const existing = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q) => q.eq("user_id", uid).eq("team_id", teamId))
        .unique();
      if (!existing) {
        await ctx.db.insert("team_memberships", {
          user_id: uid,
          team_id: teamId,
          role: "member",
          joined_at: now,
        });
      }
      await ctx.db.patch(uid, { active_team_id: teamId });
    }
    let channel = (await ctx.db.query("chat_channels").collect()).find(
      (c) => String(c.team_id) === String(teamId) && c.name === "e2e-huddle",
    );
    if (!channel) {
      const chId = await ctx.db.insert("chat_channels", {
        team_id: teamId,
        name: "e2e-huddle",
        created_by: args.members[0],
        created_at: now,
        updated_at: now,
      });
      channel = (await ctx.db.get(chId)) ?? undefined;
    }
    return { teamId, channelId: channel!._id };
  },
});

export const e2eTeardownMobile = internalMutation({
  args: {},
  handler: async (ctx) => {
    const team = (await ctx.db.query("teams").collect()).find((t) => t.name === "Huddle E2E");
    if (!team) return { removed: false };
    for (const c of (await ctx.db.query("chat_channels").collect()).filter(
      (c) => String(c.team_id) === String(team._id),
    )) {
      await ctx.db.delete(c._id);
    }
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", team._id))
      .collect();
    for (const m of memberships) {
      await ctx.db.delete(m._id);
      const u = await ctx.db.get(m.user_id);
      if (u && String(u.active_team_id ?? "") === String(team._id)) {
        await ctx.db.patch(m.user_id, { active_team_id: u.team_id ?? undefined });
      }
    }
    await ctx.db.delete(team._id);
    return { removed: true };
  },
});

// TEMPORARY (e2e): seed one team-visible conversation for the sim user so the
// session-screen huddle button can be verified. Remove with e2eTeardownMobile.
export const e2eSeedConversation = internalMutation({
  args: { user_id: v.id("users"), team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      user_id: args.user_id,
      team_id: args.team_id,
      agent_type: "claude_code",
      session_id: `e2e-huddle-${now}`,
      started_at: now,
      updated_at: now,
      title: "Huddle e2e session",
      is_private: false,
      status: "completed",
    } as any);
    return id;
  },
});

// TEMPORARY (e2e): seat `from` in the room and ring `to`, exactly as
// calls.invite would (fresh row, TTL sweep scheduled). Lets the CallKit
// simulator pass run without the headless web rig.
export const e2eRing = internalMutation({
  args: { from: v.id("users"), to: v.id("users"), room_key: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const from = await ctx.db.get(args.from);
    await ctx.db.insert("call_members", {
      room_key: args.room_key,
      team_id: "k9737ctz1grqeghvbwdevxp69d8cks7s" as any,
      user_id: args.from,
      user_name: from?.name ?? from?.email ?? "Teammate",
      joined_at: now,
      last_seen: now,
      muted: true,
      camera: false,
      sharing: false,
    } as any);
    const inviteId = await ctx.db.insert("call_invites", {
      room_key: args.room_key,
      team_id: "k9737ctz1grqeghvbwdevxp69d8cks7s" as any,
      from_user: args.from,
      to_user: args.to,
      status: "ringing",
      created_at: now,
    } as any);
    return String(inviteId);
  },
});

// TEMPORARY: find users with an Expo push token whose email matches, to
// verify EAS's push key still delivers after the January key was revoked.
export const e2eFindPushUsers = internalQuery({
  args: { email_contains: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("users").take(2000);
    return all
      .filter((u: any) => u.push_token && String(u.email ?? "").toLowerCase().includes(args.email_contains))
      .map((u: any) => ({ id: u._id, email: u.email, token: u.push_token, voip: !!u.voip_push_token }));
  },
});

// TEMPORARY: census of the per-row db ops behind conversations:sessionsLiveness
// ("too many system operations" timeout). Runs the shared scan, then COUNTS the
// reads enrichLivenessFields would issue per row instead of issuing them.
// Safe to delete.
export const livenessOpCensus = internalQuery({
  args: { who: v.string() },
  handler: async (ctx, args) => {
    const user =
      (await ctx.db
        .query("users")
        .withIndex("email", (q: any) => q.eq("email", args.who))
        .first()) ??
      (await ctx.db
        .query("users")
        .withIndex("by_username", (q: any) => q.eq("username", args.who))
        .first()) ??
      (await ctx.db
        .query("users")
        .withIndex("by_github_username", (q: any) => q.eq("github_username", args.who))
        .first());
    if (!user) return { error: "no user" };
    const now = Date.now();
    const t0 = Date.now();
    const { conversations, maps } = await scanInboxConversations(ctx, user._id, now, {
      includeLiveness: true,
    });
    const scanMs = Date.now() - t0;
    const uid = user._id.toString();
    const candidateIds = new Set(conversations.map((c: any) => c._id.toString()));
    let shown = 0;
    let missingRoleReads = 0; // fallback last-message read per un-backfilled row
    let foreignRows = 0; // mergeForeignConversationLiveness reads (1 each)
    let statusRows = 0;
    let dismissed = 0;
    let stashed = 0;
    for (const c of conversations) {
      if (!shouldShowInInbox(c)) continue;
      shown++;
      if (c.inbox_dismissed_at) dismissed++;
      if (c.inbox_stashed_at) stashed++;
      if (!c.last_message_role && c.message_count > 0) missingRoleReads++;
      if (c.user_id.toString() !== uid) foreignRows++;
      if (maps.agentStatusMap.has(c._id.toString())) statusRows++;
    }
    const liveNotInWindow = [...maps.liveConvIds].filter((id) => !candidateIds.has(id)).length;
    return {
      user_id: user._id,
      scan_ms: scanMs,
      candidates: conversations.length,
      shown,
      dismissed,
      stashed,
      missing_last_message_role_reads: missingRoleReads,
      foreign_rows: foreignRows,
      live_conv_ids: maps.liveConvIds.size,
      live_not_in_window_gets: liveNotInWindow,
      agent_status_rows: statusRows,
    };
  },
});

// TEMPORARY: time the REAL sessionsLiveness path for a user (full enrichment,
// AUQ probes and all) + count owner rows. Safe to delete.
export const timeSessionsLiveness = internalQuery({
  args: { who: v.string(), _n: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user =
      (await ctx.db.query("users").withIndex("email", (q: any) => q.eq("email", args.who)).first()) ??
      (await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", args.who)).first()) ??
      (await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", args.who)).first());
    if (!user) return { error: "no user" };
    const ownerRows = await ctx.db
      .query("session_owners")
      .withIndex("by_user", (q: any) => q.eq("user_id", user._id))
      .collect();
    const t0 = Date.now();
    const liveness = await computeSessionsLiveness(ctx, user._id);
    return {
      ms: Date.now() - t0,
      rows: Object.keys(liveness).length,
      owner_rows_total: ownerRows.length,
    };
  },
});

// TEMPORARY: cost-attribution harness for the inbox enrichment. Date.now() is
// frozen inside a query, so timing happens OUTSIDE (wall-clock around
// `npx convex run`). Each variant skips one class of per-row reads; comparing
// wall times attributes the cost. Safe to delete.
async function debugResolveUser(ctx: any, who: string) {
  return (
    (await ctx.db.query("users").withIndex("email", (q: any) => q.eq("email", who)).first()) ??
    (await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", who)).first()) ??
    (await ctx.db.query("users").withIndex("by_github_username", (q: any) => q.eq("github_username", who)).first())
  );
}

const inboxVariant = (skip: { children?: boolean; auq?: boolean; refs?: boolean } | null, scanOnly = false) =>
  internalQuery({
    args: { who: v.string(), _n: v.optional(v.number()) },
    handler: async (ctx: any, args: { who: string; _n?: number }) => {
      const user = await debugResolveUser(ctx, args.who);
      if (!user) return { error: "no user" };
      if (scanOnly) {
        const { conversations } = await scanInboxConversations(ctx, user._id, Date.now(), { includeLiveness: false });
        return { candidates: conversations.length };
      }
      const { sessions } = await computeInboxSessions(ctx, user._id, {
        includeLiveness: false,
        ...(skip ? { _skip: skip } : {}),
      });
      return { rows: sessions.length };
    },
  });

export const timeInboxScanOnly = inboxVariant(null, true);
export const timeInboxFull = inboxVariant(null);
export const timeInboxNoChildren = inboxVariant({ children: true });
export const timeInboxNoAuq = inboxVariant({ auq: true });
export const timeInboxNoRefs = inboxVariant({ refs: true });
export const timeInboxBare = inboxVariant({ children: true, auq: true, refs: true });

// TEMPORARY: in-process timing matrix. Actions have a live clock, so timing
// each variant via runQuery isolates backend cost from CLI startup. Reports
// min/median over N reps per variant. Safe to delete.
export const timeInboxMatrix = internalAction({
  args: { who: v.string(), reps: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const reps = args.reps ?? 5;
    const variants = [
      "timeInboxScanOnly", "timeInboxBare", "timeInboxNoChildren", "timeInboxNoAuq",
      "timeInboxNoRefs", "timeInboxFull", "timeSessionsLiveness",
    ] as const;
    const out: Record<string, { min: number; median: number; all: number[] }> = {};
    for (const name of variants) {
      const samples: number[] = [];
      for (let i = 0; i < reps; i++) {
        const t0 = Date.now();
        // Fresh args per rep so Convex can't serve the previous rep's cached result.
        await ctx.runQuery(anyApi.debugTmp[name], { who: args.who, _n: Date.now() + i });
        samples.push(Date.now() - t0);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      out[name] = { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], all: samples };
    }
    const census = await ctx.runQuery(anyApi.debugTmp.managedSessionCensus, { who: args.who });
    return { ...out, census };
  },
});

export const managedSessionCensus = internalQuery({
  args: { who: v.string() },
  handler: async (ctx, args) => {
    const user = await debugResolveUser(ctx, args.who);
    if (!user) return { error: "no user" };
    const rows = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();
    const now = Date.now();
    const alive = rows.filter((r: any) => now - r.last_heartbeat < 6 * 60 * 1000).length;
    const withConv = rows.filter((r: any) => r.conversation_id).length;
    const bytes = JSON.stringify(rows).length;
    return { managed_sessions_total: rows.length, alive_6m: alive, with_conversation: withConv, approx_bytes: bytes };
  },
});

// TEMPORARY: what the inbox scan reads vs what survives the filter. Safe to delete.
export const inboxScanCensus = internalQuery({
  args: { who: v.string(), _n: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await debugResolveUser(ctx, args.who);
    if (!user) return { error: "no user" };
    const now = Date.now();
    const { conversations } = await scanInboxConversations(ctx, user._id, now, { includeLiveness: false });
    const c = { candidates: 0, shown: 0, subagent: 0, workflow_sub: 0, orphan: 0, killed: 0, noise: 0, empty_completed: 0, dismissed: 0, stashed: 0, bytes_all: 0, bytes_shown: 0, max_doc_bytes: 0 };
    const big: Array<{ id: string; bytes: number; title: string }> = [];
    for (const conv of conversations) {
      const bytes = JSON.stringify(conv).length;
      c.candidates++; c.bytes_all += bytes;
      if (bytes > c.max_doc_bytes) c.max_doc_bytes = bytes;
      big.push({ id: conv._id.toString(), bytes, title: (conv.title ?? "").slice(0, 40) });
      if (conv.is_subagent) c.subagent++;
      else if (conv.is_workflow_sub) c.workflow_sub++;
      else if (conv.parent_conversation_id && !conv.parent_message_uuid) c.orphan++;
      if (conv.inbox_killed_at && !conv.inbox_pinned_at) c.killed++;
      if (conv.status === "completed" && conv.message_count === 0) c.empty_completed++;
      if (shouldShowInInbox(conv)) {
        c.shown++; c.bytes_shown += bytes;
        if (conv.inbox_dismissed_at) c.dismissed++;
        else if (conv.inbox_stashed_at) c.stashed++;
      }
    }
    big.sort((a, b) => b.bytes - a.bytes);
    // Field-size histogram across all candidate docs: which fields carry the bytes.
    const fieldBytes: Record<string, number> = {};
    for (const conv of conversations) {
      for (const [k, val] of Object.entries(conv)) {
        fieldBytes[k] = (fieldBytes[k] ?? 0) + JSON.stringify(val ?? null).length;
      }
    }
    const topFields = Object.entries(fieldBytes).sort((a, b) => b[1] - a[1]).slice(0, 12);
    return { ...c, top_docs: big.slice(0, 5), top_fields: topFields };
  },
});


// TEMPORARY: conversation doc diet. Sheds the two legacy blobs the inbox scan
// paid for on every recompute but nothing reads — available_skills (dropped;
// user_skills is the source) and git_status (moved to the conversation_git_diffs
// side row). Paced: one page per mutation, resumable by cursor. Safe to delete
// once every row has been swept.
//
// Raw (un-wrapped) internalMutation on purpose: the wrapped one appends every
// conversation patch to the sync log, which bumps a shared sync_heads row and
// OCC-collides with the live addMessages firehose on every retry. Nothing a
// client renders changes here, so there is no delta worth logging.
export const dietConversationPage = rawInternalMutation({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("conversations").paginate({ cursor: args.cursor, numItems: args.numItems });
    let patched = 0;
    let bytesShed = 0;
    for (const conv of page.page) {
      const hasSkills = conv.available_skills !== undefined;
      const hasStatus = conv.git_status !== undefined;
      const hasStable = conv.stable_context !== undefined;
      if (!hasSkills && !hasStatus && !hasStable) continue;
      bytesShed += (conv.available_skills?.length ?? 0) + (conv.git_status?.length ?? 0) + (conv.stable_context?.length ?? 0);
      patched++;
      if (args.dryRun) continue;
      if (hasStatus && conv.git_status) {
        const row = await ctx.db
          .query("conversation_git_diffs")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
          .first();
        await setConvGitDiff(ctx, conv._id, row?.git_diff, row?.git_diff_staged, row?.git_status ?? conv.git_status);
      }
      if (hasStable && conv.stable_context) {
        const row = await ctx.db
          .query("conversation_context")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
          .first();
        if (!row?.stable_context) await setConvStableContext(ctx, conv._id, conv.stable_context);
      }
      await ctx.db.patch(conv._id, { available_skills: undefined, git_status: undefined, stable_context: undefined });
    }
    return { scanned: page.page.length, patched, bytesShed, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const dietConversationDocs = internalAction({
  args: { cursor: v.optional(v.string()), maxPages: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    let cursor: string | null = args.cursor ?? null;
    const maxPages = args.maxPages ?? 300;
    const totals = { pages: 0, scanned: 0, patched: 0, bytesShed: 0 };
    let isDone = false;
    for (let i = 0; i < maxPages; i++) {
      let r: any = null;
      for (let attempt = 0; attempt < 5 && !r; attempt++) {
        try {
          r = await ctx.runMutation(anyApi.debugTmp.dietConversationPage, { cursor, numItems: 50, dryRun: args.dryRun });
        } catch (err) {
          if (attempt === 4) throw err;
          await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
        }
      }
      totals.pages++; totals.scanned += r.scanned; totals.patched += r.patched; totals.bytesShed += r.bytesShed;
      cursor = r.continueCursor;
      isDone = r.isDone;
      if (isDone) break;
      // Pacing: leave room between pages so live-session patches don't OCC-storm.
      await new Promise((res) => setTimeout(res, 40));
    }
    return { ...totals, isDone, resumeCursor: isDone ? null : cursor };
  },
});
