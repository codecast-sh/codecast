import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { resolveTeamForPath } from "./privacy";
import { enqueueStartSession } from "./devices";
import { enqueuePendingMessage, getAuthenticatedUserId } from "./pendingMessages";

// An Anchor is codecast's standing agent member: one per team (shared) and one
// per user (personal). It owns a long-lived `persistent` conversation that is
// pinned in the inbox, rendered under a synthetic bot identity, woken by events,
// and delegates code work to ephemeral `cast spawn` hands.
//
// Identity is decoupled from hosting on purpose (see schema): `bot_user_id` is
// the name/avatar the session renders as; `host_user_id` (= the human caller) is
// who actually runs and bills it on their daemon. That lets a personal anchor run
// on a laptop and a team anchor run on whichever member hosts it, with no separate
// bot daemon or bot credentials in v1.

// Authorization for an anchor: the human host that runs it, the user a personal
// anchor belongs to, or any member of a team anchor's team. Every ACT path (wake,
// decommission) and the channel/post paths gate on this — authentication alone is
// not enough (injecting a turn runs and bills code on the host's daemon).
export async function userCanAccessAnchor(
  ctx: { db: any },
  userId: Id<"users">,
  anchor: { host_user_id?: Id<"users">; scope_user_id?: Id<"users">; team_id?: Id<"teams"> } | null,
): Promise<boolean> {
  if (!anchor) return false;
  if (anchor.host_user_id === userId) return true;
  if (anchor.scope_user_id && anchor.scope_user_id === userId) return true;
  if (anchor.team_id) {
    const m = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q: any) =>
        q.eq("user_id", userId).eq("team_id", anchor.team_id),
      )
      .first();
    if (m) return true;
  }
  return false;
}

// The anchors a caller may see/act on: their personal anchor plus the team anchor
// of every team they belong to, deduped and excluding decommissioned. Shared by
// listAnchors and the Slack channel listing so the two can't drift.
export async function visibleAnchorsForUser(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<any[]> {
  const personal = await ctx.db
    .query("anchors")
    .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
    .collect();
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const teamAnchors: any[] = [];
  for (const m of memberships) {
    const rows = await ctx.db
      .query("anchors")
      .withIndex("by_team", (q: any) => q.eq("team_id", m.team_id))
      .collect();
    teamAnchors.push(...rows);
  }
  const seen = new Set<string>();
  const out: any[] = [];
  for (const a of [...personal, ...teamAnchors]) {
    if (a.status === "decommissioned") continue;
    if (seen.has(a._id.toString())) continue;
    seen.add(a._id.toString());
    out.push(a);
  }
  return out;
}

// The default first turn that brings a freshly-provisioned anchor "online": it
// orients the agent to its standing role and asks for a one-line hello so the
// human can see it is live. The real persona comes from its project skill /
// CLAUDE.md; this only kicks the session into its first turn.
function bootstrapMessage(name: string, scopeLabel: string, persona?: string): string {
  return [
    `You are **${name}**, the standing Anchor for ${scopeLabel} in codecast — a persistent`,
    `agent member, not a one-shot task. You stay available, keep your own memory, are woken by`,
    `events (a teammate's message, a Slack mention, a finished delegated job), and act with a`,
    `peer's judgment.`,
    ``,
    `## How you work`,
    `- **Stay resident.** This conversation is long-lived; it never "completes". When you finish`,
    `  responding you go dormant and are woken again by the next event. Don't try to wrap up or`,
    `  sign off for good.`,
    `- **Keep durable memory.** Your live transcript gets compacted over time, so persist anything`,
    `  worth remembering to this project's memory dir and CLAUDE.md — including, right now, a short`,
    `  note recording that you are ${name}, the anchor for ${scopeLabel}, and how you operate.`,
    `- **Delegate to hands.** For real code work, start a fresh session with \`cast spawn "<task>"\``,
    `  rather than doing it inline — that keeps you responsive. Check results with \`cast sessions\``,
    `  and \`cast read <id>\`, or tell the hand to \`cast send <your id> "done: ..."\` when finished.`,
    `- **Reply where you were called.** If an event tells you it came from Slack, reply with the`,
    `  \`cast anchor say --channel <C> --thread <T> "..."\` command it gives you — that posts as you.`,
    `- **Decline, don't half-do.** If a request would exceed what's safe or you can't finish it`,
    `  properly, say so and escalate to the humans — never ship a truncated or guessed result.`,
    `- **Be concise and additive.** Don't repeat yourself across channels; say something only when`,
    `  it's new and useful.`,
    persona ? `\n## Your persona\nAdopt the **${persona}** persona/skill if it is available in this project.` : ``,
    ``,
    `Save your role to memory now, post a one-line hello confirming you are online, then stand by.`,
  ].filter(Boolean).join("\n");
}

async function findExistingAnchor(
  ctx: { db: any },
  scope: { scope_type: "team" | "user"; team_id?: Id<"teams">; scope_user_id?: Id<"users"> },
) {
  if (scope.scope_type === "team" && scope.team_id) {
    const rows = await ctx.db
      .query("anchors")
      .withIndex("by_team", (q: any) => q.eq("team_id", scope.team_id))
      .collect();
    return rows.find((a: any) => a.status !== "decommissioned") ?? null;
  }
  if (scope.scope_type === "user" && scope.scope_user_id) {
    const rows = await ctx.db
      .query("anchors")
      .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", scope.scope_user_id))
      .collect();
    return rows.find((a: any) => a.status !== "decommissioned") ?? null;
  }
  return null;
}

// provisionAnchor — idempotently create (or return) the anchor for a scope, mint
// its bot identity, and start its persistent session. Backs `cast anchor create`.
export const provisionAnchor = mutation({
  args: {
    api_token: v.optional(v.string()),
    scope_type: v.union(v.literal("team"), v.literal("user")),
    team_id: v.optional(v.id("teams")),
    name: v.optional(v.string()),
    avatar_url: v.optional(v.string()),
    persona: v.optional(v.string()),
    project_path: v.optional(v.string()),
    model: v.optional(v.string()),
    bootstrap: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const hostUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!hostUserId) throw new Error("Authentication failed: invalid token or session");

    const now = Date.now();
    const name = (args.name ?? "Anchor").trim() || "Anchor";

    // Resolve + authorize scope.
    let teamId: Id<"teams"> | undefined;
    let scopeUserId: Id<"users"> | undefined;
    let scopeLabel: string;
    if (args.scope_type === "team") {
      // Resolve the team: explicit team_id, else the host's active team.
      let resolved = args.team_id;
      if (!resolved) {
        const host = await ctx.db.get(hostUserId);
        resolved = host?.active_team_id ?? host?.team_id ?? undefined;
      }
      if (!resolved) {
        throw new Error("No team to anchor: pass --team <id> or set an active team");
      }
      const membership = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) =>
          q.eq("user_id", hostUserId).eq("team_id", resolved),
        )
        .first();
      if (!membership) throw new Error("Not a member of that team");
      teamId = resolved;
      const team = await ctx.db.get(resolved);
      scopeLabel = `the ${team?.name ?? "team"} workspace`;
    } else {
      scopeUserId = hostUserId;
      scopeLabel = "your personal workspace";
    }

    // Idempotent: one anchor per scope.
    const existing = await findExistingAnchor(ctx, {
      scope_type: args.scope_type,
      team_id: teamId,
      scope_user_id: scopeUserId,
    });
    if (existing) {
      return {
        anchor_id: existing._id,
        bot_user_id: existing.bot_user_id,
        conversation_id: existing.conversation_id ?? null,
        already_existed: true,
      };
    }

    // Mint the synthetic bot identity (no login; identity only).
    const botUserId = await ctx.db.insert("users", {
      name,
      image: args.avatar_url,
      is_bot: true,
      bot_kind: "anchor",
      created_at: now,
      team_id: teamId,
      active_team_id: teamId,
    });
    if (teamId) {
      await ctx.db.insert("team_memberships", {
        user_id: botUserId,
        team_id: teamId,
        role: "member",
        joined_at: now,
        visibility: "full",
      });
    }

    // Create the anchor row first so the conversation can back-link to it.
    const anchorId = await ctx.db.insert("anchors", {
      scope_type: args.scope_type,
      team_id: teamId,
      scope_user_id: scopeUserId,
      bot_user_id: botUserId,
      host_user_id: hostUserId,
      name,
      persona: args.persona,
      project_path: args.project_path,
      model: args.model,
      status: "provisioning",
      created_at: now,
      updated_at: now,
    });

    // The persistent session: owned (run + billed) by the human host, rendered as
    // the bot, pinned, and exempt from auto-completion.
    const sessionId = crypto.randomUUID();
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", hostUserId))
      .collect();
    // A team anchor always belongs to its team and is shared; a personal anchor
    // resolves team/privacy from its project path like any session.
    let resolvedTeamId: Id<"teams"> | undefined = teamId;
    let isPrivate = false;
    if (args.scope_type === "user") {
      const r = resolveTeamForPath(mappings, args.project_path, undefined);
      resolvedTeamId = r.teamId;
      isPrivate = r.isPrivate;
    }

    const conversationId = await ctx.db.insert("conversations", {
      user_id: hostUserId,
      acting_user_id: botUserId,
      anchor_id: anchorId,
      team_id: resolvedTeamId,
      agent_type: "claude_code",
      session_id: sessionId,
      title: name,
      title_is_custom: true,
      project_path: args.project_path,
      git_root: args.project_path,
      model: args.model,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: isPrivate,
      status: "active",
      persistent: true,
      inbox_pinned_at: now,
    });
    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    await ctx.db.patch(anchorId, {
      conversation_id: conversationId,
      status: "active",
      updated_at: now,
    });

    await enqueueStartSession(ctx, hostUserId, {
      conversationId,
      agentType: "claude",
      projectPath: args.project_path,
      sessionId,
      model: args.model,
      createdAt: now,
    });

    if (args.bootstrap !== false) {
      const conversation = await ctx.db.get(conversationId);
      await enqueuePendingMessage(ctx, conversation, hostUserId, {
        content: bootstrapMessage(name, scopeLabel, args.persona),
      });
    }

    return {
      anchor_id: anchorId,
      bot_user_id: botUserId,
      conversation_id: conversationId,
      short_id: conversationId.toString().slice(0, 7),
      already_existed: false,
    };
  },
});

// Deliver a message into an anchor's standing session, auto-resuming it if
// dormant (the normal pending-message rail does the resume). This is the
// primitive every trigger (Slack mention, schedule, a finished hand) funnels
// into. Shared by the auth'd `wakeAnchor` and the internal `wakeAnchorInternal`.
export async function deliverToAnchor(
  ctx: any,
  anchorId: Id<"anchors">,
  message: string,
) {
  const anchor = await ctx.db.get(anchorId);
  if (!anchor) throw new Error("Anchor not found");
  if (!anchor.conversation_id) throw new Error("Anchor has no session yet");
  const conversation = await ctx.db.get(anchor.conversation_id);
  if (!conversation) throw new Error("Anchor session missing");
  await enqueuePendingMessage(ctx, conversation, conversation.user_id, {
    content: message,
  });
  return { conversation_id: anchor.conversation_id, woke: true };
}

// wakeAnchor — auth'd entry (CLI / web): a human or their session pokes the anchor.
export const wakeAnchor = mutation({
  args: {
    api_token: v.optional(v.string()),
    anchor_id: v.id("anchors"),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await ctx.db.get(args.anchor_id);
    if (!anchor) throw new Error("Anchor not found");
    if (!(await userCanAccessAnchor(ctx, userId, anchor))) {
      throw new Error("Not authorized for this anchor");
    }
    return await deliverToAnchor(ctx, args.anchor_id, args.message);
  },
});

// wakeAnchorInternal — for adapters already authenticated by their own scheme
// (e.g. a Slack webhook verified by HMAC). No user token; never expose as public.
export const wakeAnchorInternal = internalMutation({
  args: { anchor_id: v.id("anchors"), message: v.string() },
  handler: async (ctx, args) => {
    return await deliverToAnchor(ctx, args.anchor_id, args.message);
  },
});

// resolveAnchorForScope — the lookup wake routing uses to find which anchor
// answers for a team or user. Public for the CLI; reused internally by adapters.
export const resolveAnchorForScope = query({
  args: {
    api_token: v.optional(v.string()),
    scope_type: v.union(v.literal("team"), v.literal("user")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const scopeUserId = args.scope_type === "user" ? userId : undefined;
    let teamId = args.team_id;
    if (args.scope_type === "team" && !teamId) {
      const host = await ctx.db.get(userId);
      teamId = host?.active_team_id ?? host?.team_id ?? undefined;
    }
    // Authorize team scope: only a member may resolve a team's anchor (team_id is
    // not a secret, so without this any user could fetch another team's anchor id).
    if (args.scope_type === "team") {
      if (!teamId) return null;
      const member = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
        .first();
      if (!member) return null;
    }
    const anchor = await findExistingAnchor(ctx, {
      scope_type: args.scope_type,
      team_id: teamId,
      scope_user_id: scopeUserId,
    });
    return anchor ?? null;
  },
});

// listAnchors — anchors visible to the caller: their personal one plus the team
// anchors of every team they belong to. Backs `cast anchor ls`.
export const listAnchors = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];

    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const teamIds = new Set(memberships.map((m: any) => m.team_id.toString()));

    const anchors = await visibleAnchorsForUser(ctx, userId);
    // Enrich with the bot's display name/avatar.
    const out: any[] = [];
    for (const a of anchors) {
      const bot = await ctx.db.get(a.bot_user_id as Id<"users">);
      out.push({
        ...a,
        bot_name: bot?.name ?? a.name,
        bot_avatar: bot?.image ?? null,
        in_my_team: a.team_id ? teamIds.has(a.team_id.toString()) : false,
      });
    }
    return out;
  },
});

// decommissionAnchor — the explicit retire path the never-complete invariant
// depends on: clear `persistent` (so the session may complete normally), unpin,
// mark it completed, drop channel mappings, and mark the anchor decommissioned so
// a fresh `cast anchor create` can provision a new one.
export const decommissionAnchor = mutation({
  args: { api_token: v.optional(v.string()), anchor_id: v.id("anchors") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await ctx.db.get(args.anchor_id);
    if (!anchor) throw new Error("Anchor not found");
    if (!(await userCanAccessAnchor(ctx, userId, anchor))) {
      throw new Error("Not authorized for this anchor");
    }
    if (anchor.conversation_id) {
      const conv = await ctx.db.get(anchor.conversation_id);
      if (conv) {
        await ctx.db.patch(anchor.conversation_id, {
          persistent: false,
          inbox_pinned_at: undefined,
          status: "completed",
        });
      }
    }
    const chans = await ctx.db
      .query("anchor_channels")
      .withIndex("by_anchor", (q: any) => q.eq("anchor_id", args.anchor_id))
      .collect();
    for (const ch of chans) await ctx.db.delete(ch._id);
    await ctx.db.patch(args.anchor_id, {
      status: "decommissioned",
      updated_at: Date.now(),
    });
    return { decommissioned: true };
  },
});
