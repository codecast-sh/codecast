import { internalMutation, mutation, query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { buildShareUpdate, isConversationTeamVisible, resolveCreationPrivacy } from "./privacy";
import { activeTeamMembershipFor, patchConversationVisibility } from "./lib/access";
import { enqueueStartSession } from "./devices";
import { fromConvexAgentType } from "@codecast/shared/contracts";
import { killConversation } from "./conversations";
import { enqueuePendingMessage, formatSessionMessage, getAuthenticatedUserId } from "./pendingMessages";
import { isHeadOfPeopleRole, roleGrants } from "./lib/orgAccess";
import { standingReportsToFields } from "./lib/standingSeat";
import { stampSeatOwners } from "./sessionOwners";
import { seatPlace } from "./lib/seatPlace";
import { DECISION_DISCUSSION_GUIDANCE, bootstrapMessage, roleBootstrapOf, type RoleBootstrap } from "./lib/anchorBootstrap";

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
// not enough (injecting a turn runs and bills code on the host's daemon). The
// rule itself lives in lib/orgAccess (roleGrants): an anchor and an org role
// carry the same boundary shape, so the two tables share one grant.
export async function userCanAccessAnchor(
  ctx: { db: any },
  userId: Id<"users">,
  anchor: { host_user_id?: Id<"users">; scope_user_id?: Id<"users">; team_id?: Id<"teams"> } | null,
): Promise<boolean> {
  return roleGrants(ctx, userId, anchor, () => true);
}

// Stricter gate for DESTRUCTIVE / config changes (retire, rename, persona): the
// host, the personal-anchor owner, or a team ADMIN — not every team member. Any
// member can wake/use the anchor (userCanAccessAnchor); only admins reshape it.
export async function userCanAdminAnchor(
  ctx: { db: any },
  userId: Id<"users">,
  anchor: { host_user_id?: Id<"users">; scope_user_id?: Id<"users">; team_id?: Id<"teams"> } | null,
): Promise<boolean> {
  return roleGrants(ctx, userId, anchor, (m) => m.role === "admin");
}

import { visibleAnchorsForUser } from "./lib/anchorRoster";
export { visibleAnchorsForUser };
export { DECISION_DISCUSSION_GUIDANCE, bootstrapMessage, roleBootstrapOf, type RoleBootstrap };

// The team that can read a personal agent's standing conversation. A personal
// anchor's session resolves its privacy from its project path like any session
// (insertStandingConversation), so a directory with an auto-share mapping makes
// it readable by that team, and the opening must say so rather than promise
// privacy. A team anchor's conversation is always the team's, and its opening
// already says that.
async function sharedTeamOf(ctx: { db: any }, scopeType: "team" | "user", conversation: any): Promise<string | undefined> {
  if (scopeType !== "user" || !conversation || !(await isConversationTeamVisible(ctx, conversation))) return undefined;
  const team = await ctx.db.get(conversation.team_id);
  return team?.name ?? "a team";
}

export async function findExistingAnchor(
  ctx: { db: any },
  scope: { scope_type: "team" | "user"; team_id?: Id<"teams">; scope_user_id?: Id<"users">; org_role_id?: Id<"org_roles"> },
) {
  const rows: any[] = scope.scope_type === "team" && scope.team_id
    ? await ctx.db.query("anchors").withIndex("by_team", (q: any) => q.eq("team_id", scope.team_id)).collect()
    : scope.scope_user_id
      ? await ctx.db.query("anchors").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", scope.scope_user_id)).collect()
      : [];
  const live = rows.filter((a: any) => a.status !== "decommissioned");
  // A role's standing agent is one per role, whatever the boundary holds;
  // the workspace anchor stays one per scope (and never matches a role's).
  if (scope.org_role_id) return live.find((a: any) => String(a.org_role_id ?? "") === String(scope.org_role_id)) ?? null;
  const plain = live.find((a: any) => !a.org_role_id);
  if (plain) return plain;
  // The workspace's standing agent is a role's seat. Its row still answers as
  // the workspace anchor, so Slack, chat and `cast anchor say` keep working as
  // aliases of whichever role answers.
  const seated: { seat: any; role: any }[] = [];
  for (const a of live) {
    const role = a.org_role_id ? await ctx.db.get(a.org_role_id) : null;
    if (role && role.status !== "retired") seated.push({ seat: a, role });
  }
  const team = scope.scope_type === "team" && scope.team_id ? await ctx.db.get(scope.team_id) : null;
  const role = workspaceAgentRoleOf(seated.map((s) => s.role), { team_id: scope.scope_type === "team" ? scope.team_id : undefined, chosen_role_id: team?.workspace_agent_role_id });
  return role ? seated.find((s) => s.role === role)!.seat : null;
}

/** The workspace agent rule (org-staffing.md S12, S30): which of a boundary's
 *  seated roles answers for it (Slack, team chat, @anchor, decision talk).
 *  A team's is the role its admins chose, else its Head of People, else the
 *  team's own assistant. A person's own boundary is their global assistant,
 *  else their Head of People. Hiring a role never moves it; only a choice does. */
export function workspaceAgentRoleOf(roles: any[], boundary: { team_id?: unknown; chosen_role_id?: unknown }): any | null {
  const live = roles.filter((r) => r && r.status !== "retired");
  if (!boundary.team_id) {
    return live.find((r) => r.scope_type === "user" && r.assistant?.reach === "global")
      ?? live.find(isHeadOfPeopleRole)
      ?? null;
  }
  // A person's own assistant for a team lives in their boundary and is never
  // the team's agent.
  const team = live.filter((r) => r.scope_type === "team");
  return (boundary.chosen_role_id ? team.find((r) => String(r._id) === String(boundary.chosen_role_id)) : undefined)
    ?? team.find(isHeadOfPeopleRole)
    ?? team.find((r) => r.assistant?.reach === "team" && String(r.assistant.team_id) === String(boundary.team_id))
    ?? null;
}

/** Choose the role that answers for a team (workspaceAgentRoleOf). An admin's;
 *  null goes back to the Head of People. */
export async function performSetWorkspaceAgent(ctx: { db: any }, userId: Id<"users">, args: { team_id: Id<"teams">; role_id: Id<"org_roles"> | null }) {
  if (!(await userCanAdminAnchor(ctx, userId, { team_id: args.team_id }))) throw new Error("Only a team admin can choose who answers for the team");
  if (args.role_id) {
    const role: any = await ctx.db.get(args.role_id);
    if (!role || role.status === "retired" || role.scope_type !== "team" || String(role.team_id) !== String(args.team_id)) throw new Error("That role is not one of this team's");
    if (!(await findExistingAnchor(ctx, { scope_type: "team", team_id: args.team_id, org_role_id: args.role_id }))) throw new Error("That role has no standing session to answer with");
  }
  await ctx.db.patch(args.team_id, { workspace_agent_role_id: args.role_id ?? undefined });
}

export const setWorkspaceAgent = mutation({
  args: { team_id: v.id("teams"), role_id: v.union(v.id("org_roles"), v.null()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await performSetWorkspaceAgent(ctx, userId, args);
  },
});

// The workspace anchor of a boundary (a team's, or a person's own), or null.
export async function workspaceAnchorFor(ctx: { db: any }, boundary: { team_id?: Id<"teams">; scope_user_id?: Id<"users"> }): Promise<any | null> {
  return boundary.team_id
    ? findExistingAnchor(ctx, { scope_type: "team", team_id: boundary.team_id })
    : findExistingAnchor(ctx, { scope_type: "user", scope_user_id: boundary.scope_user_id });
}

// provisionStandingAgent — idempotently create (or return) a standing agent:
// mint its bot identity, its anchors row, and its persistent session, and
// queue the bootstrap turn. Shared by the workspace anchor (`cast anchor
// create`) and an org role's standing session (orgRoles.provision,
// org-roles-standing.md T1): a role IS an anchor row with `org_role_id` set,
// a `users.bot_kind` of "role", and a conversation that carries
// `standing_role_id`.
export type ProvisionStandingAgentOpts = {
  scope_type: "team" | "user";
  team_id?: Id<"teams">;
  name?: string;
  avatar_url?: string;
  persona?: string;
  project_path?: string;
  model?: string;
  agent_type?: "claude_code" | "codex" | "cursor" | "gemini" | "opencode" | "pi" | "grok" | "muse";
  bootstrap?: boolean;
  // Role provisioning: the role row and the extra bootstrap frame. `adopt` is
  // an existing conversation row that BECOMES the standing session
  // (org-staffing.md S6): no new session is started, the row is re-identified
  // as the role and the bootstrap lands in it as its next turn.
  // `announce` is the seating note (org-staffing.md S16): one message from
  // the acting person, delivered ahead of the bootstrap, that names the new
  // job and what did not change. Only an adopted session needs it; a fresh
  // session has no history to explain.
  role?: { _id: Id<"org_roles">; bootstrap: RoleBootstrap; adopt?: any; announce?: string };
};

// An adopted thread looks like the role (S16): its title becomes the role's
// display name and the old title is kept so unseating can restore it.
// `seat_previous` is also the mark that the seating was explained, so it is
// stamped even when the title already matches; an earlier stamp is kept, so a
// second seating never forgets the title the person chose.
export function seatTitlePatch(adopt: any, roleName: string): Record<string, any> {
  return { title: roleName, title_is_custom: true, seat_previous: adopt.seat_previous ?? { title: adopt.title ?? undefined, title_is_custom: adopt.title_is_custom ?? undefined } };
}

// The seating note lands as a plain turn ahead of the bootstrap.
export async function announceSeating(ctx: any, conversationId: Id<"conversations">, hostUserId: Id<"users">, announce: string | undefined): Promise<void> {
  if (!announce) return;
  const host = await ctx.db.get(hostUserId);
  const conversation = await ctx.db.get(conversationId);
  await enqueuePendingMessage(ctx, conversation, hostUserId, {
    content: formatSessionMessage("unknown", announce, { name: host?.name || host?.github_username || host?.email?.split("@")[0] || undefined }),
    client_id: `seat:${conversationId}:${Date.now()}`,
  });
}

export async function provisionStandingAgent(
  ctx: any,
  hostUserId: Id<"users">,
  args: ProvisionStandingAgentOpts,
): Promise<{
  anchor_id: Id<"anchors">;
  bot_user_id: Id<"users">;
  conversation_id: Id<"conversations"> | null;
  short_id?: string;
  already_existed: boolean;
}> {
  const now = Date.now();
  const name = (args.name ?? "Workspace agent").trim() || "Workspace agent";

  // Resolve + authorize scope.
  let teamId: Id<"teams"> | undefined;
  let scopeUserId: Id<"users"> | undefined;
  let scopeLabel: string;
  let teamName: string | undefined;
  if (args.scope_type === "team") {
    // Resolve the team: explicit team_id, else the host's active team.
    let resolved = args.team_id;
    if (!resolved) {
      resolved = (await activeTeamMembershipFor(ctx, hostUserId))?.teamId;
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
    teamName = team?.name ?? undefined;
    scopeLabel = `the ${team?.name ?? "team"} workspace`;
  } else {
    scopeUserId = hostUserId;
    scopeLabel = "your personal workspace";
  }
  const host = await ctx.db.get(hostUserId);
  const ownerName = host?.name || host?.github_username || host?.email?.split("@")[0] || undefined;

  // Idempotent: one anchor per scope, one standing agent per role.
  const existing = await findExistingAnchor(ctx, {
    scope_type: args.scope_type,
    team_id: teamId,
    scope_user_id: scopeUserId,
    org_role_id: args.role?._id,
  });
  if (existing) {
    return {
      anchor_id: existing._id,
      bot_user_id: existing.bot_user_id,
      conversation_id: existing.conversation_id ?? null,
      already_existed: true,
    };
  }

  // Seating the workspace anchor itself (org-staffing.md S12): its session
  // already has a bot, an anchors row and a machine. The row gains the role
  // pointer, the session gains the standing marker, and nothing restarts.
  // A role's standing session reports to what the role reports to (S28):
  // under a role it carries that role's id and rides its card.
  const seatRole = args.role ? await ctx.db.get(args.role._id) : null;
  const seat = seatRole ? standingReportsToFields(seatRole) : {};
  const adoptedAnchor = args.role?.adopt?.anchor_id && !args.role.adopt.standing_role_id ? await ctx.db.get(args.role.adopt.anchor_id) : null;
  if (adoptedAnchor && adoptedAnchor.status !== "decommissioned" && !adoptedAnchor.org_role_id
    && String(adoptedAnchor.team_id ?? "") === String(teamId ?? "") && String(adoptedAnchor.scope_user_id ?? "") === String(scopeUserId ?? "")) {
    await ctx.db.patch(adoptedAnchor._id, { org_role_id: args.role!._id, updated_at: now });
    await ctx.db.patch(adoptedAnchor.bot_user_id, { bot_kind: "role" });
    await ctx.db.patch(args.role!.adopt._id, { standing_role_id: args.role!._id, ...seat, persistent: true, updated_at: now, ...seatTitlePatch(args.role!.adopt, name) });
    await stampSeatOwners(ctx, args.role!.adopt._id, seatRole?.reports_to, hostUserId);
    await announceSeating(ctx, args.role!.adopt._id, hostUserId, args.role!.announce);
    if (args.bootstrap !== false) {
      await enqueuePendingMessage(ctx, await ctx.db.get(args.role!.adopt._id), hostUserId, {
        content: bootstrapMessage({ name, scopeType: args.scope_type, scopeLabel, ownerName, teamName, persona: adoptedAnchor.persona, role: args.role!.bootstrap, cleanChat: adoptedAnchor.clean_chat }),
      });
    }
    return {
      anchor_id: adoptedAnchor._id,
      bot_user_id: adoptedAnchor.bot_user_id,
      conversation_id: args.role!.adopt._id,
      short_id: args.role!.adopt.short_id ?? String(args.role!.adopt._id).slice(0, 7),
      already_existed: false,
    };
  }

  // Mint the synthetic bot identity (no login; identity only).
  const botUserId = await ctx.db.insert("users", {
    name,
    image: args.avatar_url,
    is_bot: true,
    bot_kind: args.role ? "role" : "anchor",
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
    model: args.model,
    status: "provisioning",
    org_role_id: args.role?._id,
    clean_chat: true,
    created_at: now,
    updated_at: now,
  });

  const adopt = args.role?.adopt ?? null;
  const conversationId: Id<"conversations"> = adopt ? adopt._id : await insertStandingConversation();

  async function insertStandingConversation(): Promise<Id<"conversations">> {
    // The persistent session: owned (run + billed) by the human host, rendered as
    // the bot, pinned, and exempt from auto-completion.
    const sessionId = crypto.randomUUID();
    // A team anchor always belongs to its team and is shared; a personal anchor
    // resolves team/privacy from its project path like any session.
    const privacy = args.scope_type === "user"
      ? await resolveCreationPrivacy(ctx, hostUserId, args.project_path)
      : { team_id: teamId, is_private: false, auto_shared: undefined };

    const agentType = args.agent_type ?? "claude_code";
    const conversationId = await ctx.db.insert("conversations", {
      user_id: hostUserId,
      acting_user_id: botUserId,
      anchor_id: anchorId,
      // The row IS the role's session (T1); inbox placement treats it as an
      // anchor's. org_role_id is the role's parent role when it has one (S28).
      standing_role_id: args.role?._id,
      ...seat,
      agent_type: agentType,
      session_id: sessionId,
      title: name,
      title_is_custom: true,
      project_path: args.project_path,
      git_root: args.project_path,
      model: args.model,
      started_at: now,
      updated_at: now,
      message_count: 0,
      ...privacy,
      status: "active",
      persistent: true,
      // Not pinned in the inbox — the anchor lives in its dedicated /anchor space
      // and only surfaces in the inbox when it's waiting on the user.
    });
    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    await enqueueStartSession(ctx, hostUserId, {
      conversationId,
      agentType: fromConvexAgentType(agentType),
      projectPath: args.project_path,
      sessionId,
      model: args.model,
      createdAt: now,
    });
    return conversationId;
  }

  // An adopted session keeps its owner, history and machine; it gains the
  // role's identity and the standing markers a provisioned row is born with.
  // A team seat is the team's: a private analyzer session that becomes the
  // head of people must be visible to every member, or the org page shows
  // the anchor with no session for everyone but the hirer. Visibility goes
  // through the chokepoint so linked work items get their key recomputed.
  if (adopt) {
    const markers = { acting_user_id: botUserId, anchor_id: anchorId, standing_role_id: args.role!._id, ...seat, persistent: true, updated_at: now, ...seatTitlePatch(adopt, name) };
    if (args.scope_type === "team" && adopt.is_private !== false) {
      await patchConversationVisibility(ctx, adopt, { ...(await buildShareUpdate(ctx, adopt, adopt.user_id)), ...markers });
    } else {
      await ctx.db.patch(conversationId, markers);
    }
    await announceSeating(ctx, conversationId, hostUserId, args.role!.announce);
  }

  await ctx.db.patch(anchorId, {
    conversation_id: conversationId,
    status: "active",
    updated_at: now,
  });
  if (seatRole) await stampSeatOwners(ctx, conversationId, seatRole.reports_to, hostUserId);

  if (args.bootstrap !== false) {
    const conversation = await ctx.db.get(conversationId);
    await enqueuePendingMessage(ctx, conversation, hostUserId, {
      content: bootstrapMessage({
        name,
        scopeType: args.scope_type,
        scopeLabel,
        ownerName,
        teamName,
        persona: args.persona,
        role: args.role?.bootstrap,
        sharedWithTeam: await sharedTeamOf(ctx, args.scope_type, conversation),
        cleanChat: true,
      }),
    });
  }

  return {
    anchor_id: anchorId,
    bot_user_id: botUserId,
    conversation_id: conversationId,
    short_id: adopt?.short_id ?? conversationId.toString().slice(0, 7),
    already_existed: false,
  };
}

// There is no door that provisions a bare workspace anchor (org-staffing.md
// S22): a workspace's standing agent is its root role, and `orgRoles.staff`
// is the one way to seat it. `cast anchor create` and the web onboarding go
// through that mutation.

// Deliver a message into an anchor's standing session, auto-resuming it if
// dormant (the normal pending-message rail does the resume). This is the
// primitive every trigger (Slack mention, schedule, a finished hand) funnels
// into. Shared by the auth'd `wakeAnchor` and the internal `wakeAnchorInternal`.
// `clientId` makes the delivery both idempotent and CANCELLABLE: the enqueue
// dedupes on it, and a caller that owns a deadline (chat's placeholder timeout)
// can find the queued row by the same key and drop it when the answer is no
// longer wanted. Without that, a wake queued while a laptop was shut is injected
// hours later and the agent spends a turn on a question nobody is waiting for.
export async function deliverToAnchor(
  ctx: any,
  anchorId: Id<"anchors">,
  message: string,
  clientId?: string,
) {
  const anchor = await ctx.db.get(anchorId);
  if (!anchor) throw new Error("No workspace agent found");
  if (anchor.status === "decommissioned") throw new Error("The workspace's agent is retired");
  if (!anchor.conversation_id) throw new Error("The workspace's agent has no session yet");
  const conversation = await ctx.db.get(anchor.conversation_id);
  if (!conversation) throw new Error("The workspace agent's session is missing");
  await enqueuePendingMessage(ctx, conversation, conversation.user_id, {
    content: message,
    client_id: clientId,
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
    if (!anchor) throw new Error("No workspace agent found");
    if (!(await userCanAccessAnchor(ctx, userId, anchor))) {
      throw new Error("Not authorized for this workspace's agent");
    }
    return await deliverToAnchor(ctx, args.anchor_id, args.message);
  },
});

// The briefing for an EXISTING anchor, rebuilt from its row. Used by
// rebriefAnchor so a running anchor can be handed the current frame (its scope,
// its routines, how it reaches people) without being retired and re-created.
// A role's standing session gets its role's opening, never the workspace
// agent's.
export async function briefingFor(ctx: { db: any }, anchor: any): Promise<string> {
  const team = anchor.team_id ? await ctx.db.get(anchor.team_id) : null;
  const owner = anchor.scope_user_id ? await ctx.db.get(anchor.scope_user_id) : null;
  const role = anchor.org_role_id ? await ctx.db.get(anchor.org_role_id) : null;
  const live = role && role.status !== "retired" ? role : null;
  const conversation = anchor.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  return bootstrapMessage({
    role: live ? { ...(await roleBootstrapOf(ctx, live)), rebrief: true } : undefined,
    name: live?.name ?? anchor.name,
    scopeType: anchor.scope_type,
    scopeLabel: anchor.scope_type === "team"
      ? `the ${team?.name ?? "team"} workspace`
      : `${owner?.name ?? "their"}'s personal workspace`,
    ownerName: owner?.name || owner?.github_username || owner?.email?.split("@")[0] || undefined,
    teamName: team?.name ?? undefined,
    persona: anchor.persona,
    sharedWithTeam: await sharedTeamOf(ctx, anchor.scope_type, conversation),
    cleanChat: anchor.clean_chat,
  });
}

// rebriefAnchor — re-send the standing briefing to a live anchor. Admin gated
// like every reshaping of the anchor: it changes how the agent behaves from
// here on. Backs `cast anchor brief` and the settings panel's "Re-brief".
export const rebriefAnchor = mutation({
  args: { api_token: v.optional(v.string()), anchor_id: v.id("anchors") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await ctx.db.get(args.anchor_id);
    if (!anchor) throw new Error("No workspace agent found");
    if (!(await userCanAdminAnchor(ctx, userId, anchor))) {
      throw new Error("Only an admin (or the host) can re-brief the workspace's agent");
    }
    const briefing = await briefingFor(ctx, anchor);
    return await deliverToAnchor(ctx, args.anchor_id, briefing, `anchor-brief:${Date.now()}`);
  },
});

// setCleanChat — turn a standing agent's clean chat on or off. Its thread
// follows at once, and the agent is re-sent its opening so it talks the way
// its thread now reads. Admin gated like rebriefAnchor. Returns whether a
// briefing went out.
export async function performSetCleanChat(ctx: any, userId: any, args: { anchor_id: Id<"anchors">; on: boolean }): Promise<boolean> {
  const anchor = await ctx.db.get(args.anchor_id);
  if (!anchor) throw new Error("No workspace agent found");
  if (!(await userCanAdminAnchor(ctx, userId, anchor))) {
    throw new Error("Only an admin (or the host) can change how the workspace's agent talks");
  }
  if (!!anchor.clean_chat === args.on) return false;
  await ctx.db.patch(args.anchor_id, { clean_chat: args.on, updated_at: Date.now() });
  return !!(await rebriefLiveAnchor(ctx, { ...anchor, clean_chat: args.on }, "clean-chat", { key: `${args.on ? "on" : "off"}:${Date.now()}` }));
}

export const setCleanChat = mutation({
  args: { api_token: v.optional(v.string()), anchor_id: v.id("anchors"), on: v.boolean() },
  handler: async (ctx, args): Promise<boolean> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return await performSetCleanChat(ctx, userId, args);
  },
});

type RebriefArgs = { dry_run?: boolean; key?: string; only?: string[] };

// Send one live anchor its current opening, once per `rail` and `key`: a repeat
// with the same key sends nothing new while the first is still waiting, so a
// later wording change needs a new key. The anchor's session, or null when it
// has none to send to.
async function rebriefLiveAnchor(ctx: any, anchor: any, rail: string, args: RebriefArgs): Promise<any | null> {
  const conversation = anchor && anchor.status !== "decommissioned" && anchor.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  if (!conversation) return null;
  if (!args.dry_run) await deliverToAnchor(ctx, anchor._id, await briefingFor(ctx, anchor), `${rail}:${args.key ?? "1"}:${anchor._id}`);
  return conversation;
}

// One sweep: send every live role its current opening, so a role started
// under earlier instructions works from the ones that ship now.
// `packages/convex/run.sh anchors:rebriefRoles '{"dry_run":true}'`.
export async function performRebriefRoles(ctx: any, args: RebriefArgs): Promise<{ dry_run: boolean; sent: Array<{ role: string; handle: string; conversation: string | null }>; skipped: number }> {
  const sent: Array<{ role: string; handle: string; conversation: string | null }> = [];
  let skipped = 0;
  // `only` (short ids) keeps it to the roles whose instructions changed.
  const only = args.only?.length ? new Set(args.only) : null;
  for (const role of await ctx.db.query("org_roles").collect()) {
    if (only && !only.has(role.short_id) && !only.has(String(role._id))) continue;
    const anchor = role.status !== "retired" && role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
    const conversation = await rebriefLiveAnchor(ctx, anchor, "role-rebrief", args);
    if (!conversation) { skipped++; continue; }
    sent.push({ role: role.short_id, handle: role.handle, conversation: conversation.short_id ?? null });
  }
  return { dry_run: !!args.dry_run, sent, skipped };
}

export const rebriefRoles = internalMutation({
  args: { dry_run: v.optional(v.boolean()), key: v.optional(v.string()), only: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => performRebriefRoles(ctx, args),
});

// The same sweep for the workspace agents that hold no role seat: a change to
// bootstrapMessage reaches a running workspace agent only through a rebrief.
// `only` takes anchor ids.
// `packages/convex/run.sh anchors:rebriefWorkspaceAgents '{"dry_run":true}'`.
export async function performRebriefWorkspaceAgents(ctx: any, args: RebriefArgs): Promise<{ dry_run: boolean; sent: Array<{ anchor: string; name: string; conversation: string | null }>; skipped: number }> {
  const sent: Array<{ anchor: string; name: string; conversation: string | null }> = [];
  let skipped = 0;
  const only = args.only?.length ? new Set(args.only) : null;
  for (const anchor of await ctx.db.query("anchors").collect()) {
    if (anchor.org_role_id || (only && !only.has(String(anchor._id)))) continue;
    const conversation = await rebriefLiveAnchor(ctx, anchor, "anchor-rebrief", args);
    if (!conversation) { skipped++; continue; }
    sent.push({ anchor: String(anchor._id), name: anchor.name, conversation: conversation.short_id ?? null });
  }
  return { dry_run: !!args.dry_run, sent, skipped };
}

export const rebriefWorkspaceAgents = internalMutation({
  args: { dry_run: v.optional(v.boolean()), key: v.optional(v.string()), only: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => performRebriefWorkspaceAgents(ctx, args),
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
      teamId = (await activeTeamMembershipFor(ctx, userId))?.teamId;
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
    // One workspace agent per boundary, looked up once each.
    const roots = new Map<string, Promise<any>>();
    const rootSeatId = (a: any) => {
      const team = a.scope_type === "team";
      const key = team ? `team:${a.team_id}` : `user:${a.scope_user_id}`;
      if (!roots.has(key)) roots.set(key, workspaceAnchorFor(ctx, team ? { team_id: a.team_id } : { scope_user_id: a.scope_user_id }).then((r) => r?._id ?? null));
      return roots.get(key)!;
    };
    // Enrich with the bot's display name/avatar, the scope's name, and the
    // session's coarse state — everything a picker or a status chip needs
    // without a second query per anchor.
    const out: any[] = [];
    for (const a of anchors) {
      const bot = await ctx.db.get(a.bot_user_id as Id<"users">);
      const team = a.team_id ? await ctx.db.get(a.team_id as Id<"teams">) : null;
      const conv = a.conversation_id ? await ctx.db.get(a.conversation_id as Id<"conversations">) : null;
      // Where the seat runs and as whom come from its session (lib/seatPlace).
      const place = seatPlace(a, conv);
      // The role this row is the seat of (org-staffing.md S22): the shell
      // draws the root role's face and name from this row alone, without
      // feeding the whole org tree.
      const role = a.org_role_id ? await ctx.db.get(a.org_role_id as Id<"org_roles">) : null;
      out.push({
        ...a,
        bot_name: bot?.name ?? a.name,
        // Set once the anchor is a role's seat (the head of people, S12).
        org_role_id: a.org_role_id ?? null,
        role: role && role.status !== "retired"
          ? { _id: role._id, short_id: role.short_id, name: role.name, handle: role.handle, avatar: role.avatar ?? null, icon: role.icon ?? null, status: role.status, given_name: role.given_name ?? null, assistant: role.assistant ?? null, scope_type: role.scope_type }
          : null,
        // The workspace's root (workspaceAgentRoleOf). Every other role's
        // standing session is a row here too, so a picker that takes the
        // first row of a workspace lands on whichever lead is oldest.
        is_root: String(await rootSeatId(a)) === String(a._id),
        bot_avatar: bot?.image ?? null,
        team_name: (team as any)?.name ?? null,
        in_my_team: a.team_id ? teamIds.has(a.team_id.toString()) : false,
        project_path: place.project_path ?? null,
        is_host: String(place.runner_user_id) === userId.toString(),
        conversation_short_id: (conv as any)?.short_id ?? null,
        conv_status: (conv as any)?.status ?? null,
        agent_status: (conv as any)?.agent_status ?? null,
        awaiting_input: (conv as any)?.awaiting_input ?? false,
        has_pending_messages: (conv as any)?.has_pending_messages ?? false,
        conv_updated_at: (conv as any)?.updated_at ?? a.created_at,
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
    if (!anchor) throw new Error("No workspace agent found");
    if (!(await userCanAdminAnchor(ctx, userId, anchor))) {
      throw new Error("Only an admin (or the host) can retire the workspace's agent");
    }
    await decommissionAnchorRow(ctx, anchor);
    return { decommissioned: true };
  },
});

// Retire one anchor: kill its host session, drop its channel bindings and
// roster seats, and mark the row. Shared by the admin verb above and by team
// deletion, which retires every anchor the team owned.
export async function decommissionAnchorRow(ctx: any, anchor: any): Promise<void> {
  if (anchor.conversation_id) {
    const conv = await ctx.db.get(anchor.conversation_id);
    if (conv) {
      // Persistence comes off first so the kill completes the row instead of
      // putting it to sleep; the kill then tears the agent down, cancels what
      // would revive it, and files the card under Killed, out of the inbox.
      await ctx.db.patch(anchor.conversation_id, { persistent: false, inbox_pinned_at: undefined });
      await killConversation(ctx, conv.user_id, { conversation_id: anchor.conversation_id, mark_completed: true }, { retiring: true, cause: "anchor_retire" });
    }
  }
  const chans = await ctx.db
    .query("anchor_channels")
    .withIndex("by_anchor", (q: any) => q.eq("anchor_id", anchor._id))
    .collect();
  for (const ch of chans) await ctx.db.delete(ch._id);
  // Remove the bot from team rosters so retired anchors don't pile up as dead
  // members. Keep the bot user row itself so its past messages still resolve an
  // author.
  const botMemberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", anchor.bot_user_id))
    .collect();
  for (const m of botMemberships) await ctx.db.delete(m._id);
  await ctx.db.patch(anchor._id, {
    status: "decommissioned",
    updated_at: Date.now(),
  });
}

// The Slack workspace installation bound to an anchor's scope (inline lookup to
// avoid importing slack.ts, which imports this module).
async function installForAnchor(ctx: any, anchor: any): Promise<any | null> {
  if (anchor.team_id) {
    return await ctx.db
      .query("slack_installations")
      .withIndex("by_team", (q: any) => q.eq("team_id", anchor.team_id))
      .first();
  }
  if (anchor.scope_user_id) {
    return await ctx.db
      .query("slack_installations")
      .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", anchor.scope_user_id))
      .first();
  }
  return null;
}

// getAnchorSpace — everything the dedicated Anchor page needs for one scope: the
// anchor (with bot identity + coarse status), its Slack connection, and channels.
// `anchor: null` means "none yet" → the page shows onboarding. The conversation
// itself is loaded by the page via the normal conversation queries.
export const getAnchorSpace = query({
  args: {
    api_token: v.optional(v.string()),
    scope_type: v.union(v.literal("team"), v.literal("user")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<any> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const scopeUserId = args.scope_type === "user" ? userId : undefined;
    let teamId = args.team_id;
    if (args.scope_type === "team" && !teamId) {
      teamId = (await activeTeamMembershipFor(ctx, userId))?.teamId;
    }
    if (args.scope_type === "team") {
      if (!teamId) return { scope_type: args.scope_type, anchor: null, no_team: true };
      const member = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
        .first();
      if (!member) return { scope_type: args.scope_type, anchor: null, forbidden: true };
    }
    const anchor = await findExistingAnchor(ctx, {
      scope_type: args.scope_type,
      team_id: teamId,
      scope_user_id: scopeUserId,
    });
    if (!anchor) return { scope_type: args.scope_type, anchor: null };

    const bot = await ctx.db.get(anchor.bot_user_id as Id<"users">);
    const conv = anchor.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
    const channels = await ctx.db
      .query("anchor_channels")
      .withIndex("by_anchor", (q: any) => q.eq("anchor_id", anchor._id))
      .collect();
    const install = await installForAnchor(ctx, anchor);

    return {
      scope_type: args.scope_type,
      anchor: {
        _id: anchor._id,
        name: anchor.name,
        persona: anchor.persona ?? null,
        project_path: (conv as any)?.project_path ?? null,
        model: anchor.model ?? null,
        status: anchor.status,
        team_id: anchor.team_id ?? null,
        conversation_id: anchor.conversation_id ?? null,
        conversation_short_id: (conv as any)?.short_id ?? null,
        bot_name: (bot as any)?.name ?? anchor.name,
        bot_avatar: (bot as any)?.image ?? null,
        conv_status: (conv as any)?.status ?? null,
        agent_status: (conv as any)?.agent_status ?? null,
        awaiting_input: (conv as any)?.awaiting_input ?? false,
        message_count: (conv as any)?.message_count ?? 0,
        has_pending_messages: (conv as any)?.has_pending_messages ?? false,
        updated_at: (conv as any)?.updated_at ?? anchor.created_at,
        team_name: teamId ? ((await ctx.db.get(teamId)) as any)?.name ?? null : null,
      },
      slack: {
        connected: !!install,
        workspace_name: install?.workspace_name ?? null,
      },
      channels: channels.map((c: any) => ({
        channel_key: c.channel_key,
        workspace_key: c.workspace_key ?? null,
        project_path: c.project_path ?? null,
      })),
    };
  },
});

// updateAnchor — edit an anchor's presentation (name/avatar/persona/model) from
// the settings panel. Name/avatar mirror onto the bot identity so the chip updates.
export const updateAnchor = mutation({
  args: {
    api_token: v.optional(v.string()),
    anchor_id: v.id("anchors"),
    name: v.optional(v.string()),
    avatar_url: v.optional(v.string()),
    persona: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await ctx.db.get(args.anchor_id);
    if (!anchor) throw new Error("No workspace agent found");
    if (!(await userCanAdminAnchor(ctx, userId, anchor))) {
      throw new Error("Only an admin (or the host) can edit the workspace's agent");
    }
    const patch: Record<string, any> = { updated_at: Date.now() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.persona !== undefined) patch.persona = args.persona;
    if (args.model !== undefined) patch.model = args.model;
    await ctx.db.patch(args.anchor_id, patch);
    const botPatch: Record<string, any> = {};
    if (args.name !== undefined) botPatch.name = args.name;
    if (args.avatar_url !== undefined) botPatch.image = args.avatar_url;
    if (Object.keys(botPatch).length) await ctx.db.patch(anchor.bot_user_id as Id<"users">, botPatch);
    return { ok: true };
  },
});
