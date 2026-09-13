import { mutation, query, action, internalMutation, internalQuery } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createTeamFeedFilter, isTeamAdmin } from "./privacy";
import {
  PRESENCE_FRESH_MS,
  bucketTs,
  derivePresenceState,
} from "./presenceState";
import { authorizeRoom, liveMembers } from "./callRooms";
import { normalizeTeamTaskStatuses } from "@codecast/shared/tasks";
import { purgeChatMembership } from "./chat";
import { decommissionAnchorRow } from "./anchors";
import { readLocalViewRevision } from "./localFirstCommands";
import { bumpWindow } from "./ipRateLimit";
import {
  TEAM_MEMBERS_VIEW_CONTRACT_ID,
  TEAMS_GRANT_KEY,
  TEAMS_VIEW_CONTRACT_ID,
  TEAMS_VIEW_KEY,
  forbiddenView,
  grantedView,
  missingView,
  projectPrincipalTeam,
  projectTeamMembership,
  teamMembersGrantKey,
  teamMembersViewKey,
  unauthenticatedView,
} from "./smallViewContracts";

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export const TEAM_ICONS = [
  "rocket", "flame", "zap", "star", "diamond", "crown",
  "shield", "sword", "anchor", "compass", "mountain", "tree",
  "sun", "moon", "cloud", "bolt", "atom", "dna",
  "hexagon", "triangle", "cube", "sphere", "infinity", "omega"
] as const;

export const TEAM_COLORS = [
  "cyan", "blue", "violet", "magenta", "green", "yellow", "orange"
] as const;

function getRandomIcon(): string {
  return TEAM_ICONS[Math.floor(Math.random() * TEAM_ICONS.length)];
}

function getRandomColor(): string {
  return TEAM_COLORS[Math.floor(Math.random() * TEAM_COLORS.length)];
}

export const TEAM_NAME_MAX_LENGTH = 40;

export function isTeamIcon(value: unknown): value is (typeof TEAM_ICONS)[number] {
  return typeof value === "string" && (TEAM_ICONS as readonly string[]).includes(value);
}

export function isTeamColor(value: unknown): value is (typeof TEAM_COLORS)[number] {
  return typeof value === "string" && (TEAM_COLORS as readonly string[]).includes(value);
}

/**
 * Pure validation for createTeam. Trims the name and rejects an empty or
 * too long name with a plain error. An absent or unknown icon or color falls
 * back to a random pick, so a stale client never blocks team creation.
 */
export function validateTeamCreateArgs(args: {
  name: string;
  icon?: string;
  icon_color?: string;
}): { name: string; icon: string; icon_color: string } {
  const name = args.name.trim();
  if (name.length === 0) {
    throw new Error("Team name is required");
  }
  if (name.length > TEAM_NAME_MAX_LENGTH) {
    throw new Error(`Team name must be ${TEAM_NAME_MAX_LENGTH} characters or fewer`);
  }
  return {
    name,
    icon: isTeamIcon(args.icon) ? args.icon : getRandomIcon(),
    icon_color: isTeamColor(args.icon_color) ? args.icon_color : getRandomColor(),
  };
}

export const getUserTeams = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    const teams = await Promise.all(
      memberships.map(async (m) => {
        const team = await ctx.db.get(m.team_id);
        if (!team) return null;
        return {
          _id: team._id,
          name: team.name,
          icon: team.icon,
          icon_color: team.icon_color,
          task_statuses: team.task_statuses,
          features: team.features,
          role: m.role,
          joined_at: m.joined_at,
          visibility: m.visibility || "summary",
          // The client's own create key, echoed back. A create whose dispatch
          // was parked (no binding at click time) resolves its stub against
          // this instead of being declared failed.
          client_key: team.client_key,
        };
      })
    );
    return teams.filter(Boolean);
  },
});

/** Complete principal team catalog. Empty `teams` is authoritative. */
export const getUserTeamsV2 = query({
  args: {},
  handler: async (ctx) => {
    const identity = { contractId: TEAMS_VIEW_CONTRACT_ID, viewKey: TEAMS_VIEW_KEY };
    const userId = await getAuthUserId(ctx);
    if (!userId) return unauthenticatedView(identity);

    const [memberships, viewRevision] = await Promise.all([
      ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect(),
      readLocalViewRevision(ctx, userId, identity.contractId, identity.viewKey),
    ]);
    const projected = (await Promise.all(memberships.map(async (membership) => {
      const team = await ctx.db.get(membership.team_id);
      return team ? projectPrincipalTeam(team, membership) : null;
    })))
      .filter((team): team is NonNullable<typeof team> => team !== null)
      .sort((left, right) =>
        left.joined_at - right.joined_at
        || String(left._id).localeCompare(String(right._id)));

    return grantedView(identity, { grantKeys: [TEAMS_GRANT_KEY], viewRevision }, {
      teams: projected,
    });
  },
});

export const getActiveTeamContext = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    const team = await ctx.db.get(args.team_id);
    if (!team) {
      return null;
    }
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();

    if (!membership) {
      return null;
    }

    const memberCount = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();

    return {
      ...team,
      role: membership.role,
      memberCount: memberCount.length,
    };
  },
});

export const createTeam = mutation({
  args: {
    name: v.string(),
    // Deprecated/ignored: the creator is the authenticated caller, never a
    // client-supplied id. Kept optional so existing callers don't break.
    user_id: v.optional(v.id("users")),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    client_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    // Idempotency: a retried create (replayed dispatch, timeout after
    // commit) returns the team it already made instead of a duplicate.
    // Membership proves the caller owns the earlier create; the key alone
    // is client data.
    if (args.client_key) {
      const existing = await ctx.db
        .query("teams")
        .withIndex("by_client_key", (q) => q.eq("client_key", args.client_key))
        .first();
      if (existing) {
        // A deleted team is a tombstone. The replayed create that made it
        // (an outbox entry delivered after the delete) must not mint it again.
        if (existing.deleted_at) {
          throw new Error("This team was deleted");
        }
        const membership = await ctx.db
          .query("team_memberships")
          .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", existing._id))
          .unique();
        if (membership) return existing._id;
      }
    }
    const identity = validateTeamCreateArgs(args);
    const inviteCode = generateInviteCode();
    const now = Date.now();
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
    const teamId = await ctx.db.insert("teams", {
      ...identity,
      created_at: now,
      invite_code: inviteCode,
      invite_code_expires_at: now + sevenDaysInMs,
      client_key: args.client_key,
    });
    await ctx.db.insert("team_memberships", {
      user_id: authUserId,
      team_id: teamId,
      role: "admin",
      joined_at: now,
    });
    await ctx.db.patch(authUserId, {
      team_id: teamId,
      role: "admin",
      active_team_id: teamId,
    });
    return teamId;
  },
});

export const joinTeam = mutation({
  args: {
    invite_code: v.string(),
    // Deprecated/ignored: the joiner is the authenticated caller, never a
    // client-supplied id (trusting it let anyone join any user to any team).
    user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    const team = await ctx.db
      .query("teams")
      .withIndex("by_invite_code", (q) => q.eq("invite_code", args.invite_code))
      .unique();
    if (!team || team.deleted_at) {
      throw new Error("Invalid invite code");
    }
    if (team.invite_code_expires_at && Date.now() > team.invite_code_expires_at) {
      throw new Error("Invite code expired");
    }
    const existingMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", team._id))
      .unique();
    if (existingMembership) {
      return team._id;
    }
    const now = Date.now();
    await ctx.db.insert("team_memberships", {
      user_id: authUserId,
      team_id: team._id,
      role: "member",
      joined_at: now,
    });
    const user = await ctx.db.get(authUserId);
    if (!user?.team_id) {
      await ctx.db.patch(authUserId, {
        team_id: team._id,
        role: "member",
        active_team_id: team._id,
      });
    }

    const actorName = user?.name || user?.email || "A member";
    await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
      team_id: team._id,
      actor_user_id: authUserId,
      event_type: "member_joined" as const,
      title: `${actorName} joined ${team.name}`,
      description: "Joined via invite code",
    });

    return team._id;
  },
});

export const getTeam = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) return null;
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", args.team_id))
      .first();
    if (!membership) return null;
    const team = await ctx.db.get(args.team_id);
    return team && !team.deleted_at ? team : null;
  },
});

export const getTeamByInviteCode = query({
  args: {
    invite_code: v.string(),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_invite_code", (q) => q.eq("invite_code", args.invite_code))
      .unique();

    if (!team || team.deleted_at) {
      return null;
    }

    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", team._id))
      .collect();

    const isExpired = !!(team.invite_code_expires_at && Date.now() > team.invite_code_expires_at);

    return {
      _id: team._id,
      name: team.name,
      icon: team.icon,
      icon_color: team.icon_color,
      memberCount: memberships.length,
      isExpired,
    };
  },
});

// Message counters in the roster's session preview move on every streamed turn.
// They are shown only as a coarse hover figure, so step them before they leave
// the server — the same trick bucketTs plays on the presence timestamps. The web
// store already steps this field by 16 (COUNTER_QUANTUM, inboxStore.ts), so the
// value a client renders is unchanged.
const MEMBER_COUNTER_STEP = 16;
function stepCount(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  return Math.floor(n / MEMBER_COUNTER_STEP) * MEMBER_COUNTER_STEP;
}

export const getTeamMembers = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    // Membership gate: this returns member emails and recent session previews,
    // so only a member of this team may read it (team_id is guessable).
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }
    const callerMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", args.team_id))
      .unique();
    if (!callerMembership) {
      return [];
    }
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();
    // Visibility gate for the avatar-bar session preview: the most recent
    // conversation may be private (team_id is routing, not visibility), so we
    // must not expose its title/last-message. Pick the most recent *team-visible*
    // session in this team instead.
    const feedFilter = await createTeamFeedFilter(ctx, args.team_id);
    const now = Date.now();
    const members = await Promise.all(
      memberships.map(async (m) => {
        const user = await ctx.db.get(m.user_id);
        if (!user) return null;
        // Person presence (active/idle/away/offline), derived in one place
        // (presenceState.ts) from the same rows push routing trusts. Devices
        // are read only for machine-wide opt-ins with a live app surface —
        // the same short-circuit readPresence uses.
        const presenceRow = await ctx.db
          .query("user_presence")
          .withIndex("by_user", (q) => q.eq("user_id", user._id))
          .first();
        const surfaceAlive =
          !!presenceRow && now - presenceRow.last_seen < PRESENCE_FRESH_MS;
        const devices =
          surfaceAlive && (user.machine_wide_presence ?? true)
            ? await ctx.db
                .query("devices")
                .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
                .collect()
            : [];
        const presenceState = derivePresenceState(
          {
            presence: presenceRow,
            devices,
            machineWide: user.machine_wide_presence,
            daemonLastSeen: user.daemon_last_seen,
          },
          now,
        );
        // Which huddle (if any) this member is sitting in. The raw room key
        // is itself metadata (a dm key names its people; a session key names
        // a possibly-private conversation; a channel key a possibly-private
        // room), so the VIEWER gets the key only for rooms they could join
        // right now — the same authorizer every call path uses. Everyone
        // else sees a bare "in a huddle" boolean.
        const callRows = await ctx.db
          .query("call_members")
          .withIndex("by_user", (q) => q.eq("user_id", user._id))
          .collect();
        const liveCall = liveMembers(callRows, now)[0];
        let visibleRoomKey: string | undefined;
        if (liveCall) {
          const auth = await authorizeRoom(ctx, authUserId, liveCall.room_key);
          if (auth.ok) visibleRoomKey = liveCall.room_key;
        }
        const recentConvos = await ctx.db
          .query("conversations")
          .withIndex("by_team_user_updated", (q) =>
            q.eq("team_id", args.team_id).eq("user_id", user._id)
          )
          .order("desc")
          .take(10);
        const recentConvo = recentConvos.find((c) => feedFilter.isVisible(c));
        return {
          _id: user._id,
          name: user.name,
          email: user.email,
          image: user.image,
          // Agent accounts (Mr Bot, Anchors). Callers that offer a member picker
          // for a HUMAN-only role (e.g. the session owners multi-select) filter
          // these out — a bot's inbox is nobody's, so it can't be an owner.
          is_bot: !!user.is_bot,
          role: m.role,
          daemon_last_seen: user.daemon_last_seen,
          github_username: user.github_username,
          github_avatar_url: user.github_avatar_url,
          title: user.title,
          bio: user.bio,
          status: user.status,
          // THE WALKIE DOOR, so the sender can be told the truth about what
          // their burst is about to do. The strip says "Jordan hears you" only
          // off Jordan's seat in the room; with no seat these two decide
          // between "away" (not there) and "busy" (there, door shut), which is
          // the same rule the receiver's own client applies (walkieDoorOpen).
          // Both move only when a person deliberately sets them, so neither
          // adds churn to a roster that re-pushes on presence.
          walkie_pref: user.walkie_pref,
          walkie_snoozed_until: user.walkie_snoozed_until,
          timezone: user.timezone,
          // Coarse person presence. Timestamps are bucketed to the minute so a
          // 30s heartbeat usually yields a byte-identical result and Convex
          // skips the push (the client additionally quantizes; see
          // quantizePresence in the store's sync registry).
          presence_state: presenceState,
          presence_input_at: bucketTs(presenceRow?.last_input_at),
          in_huddle: !!liveCall,
          in_room_key: visibleRoomKey,
          recent_session_title: recentConvo?.title,
          // Coarse for the same reason as the presence fields above: this
          // roster is always mounted, and a teammate's streaming agent bumps
          // updated_at and message_count several times a second. Bucketed, most
          // of those turns yield a byte-identical result and Convex skips the
          // push; invalidation is unchanged. Both feed a hover figure and a
          // relative age only.
          recent_session_messages: stepCount(recentConvo?.message_count),
          recent_session_updated: bucketTs(recentConvo?.updated_at),
          recent_session_last_message: recentConvo?.last_message_preview,
        };
      })
    );
    return members.filter(Boolean);
  },
});

/**
 * Complete exact-team membership relation. It deliberately contains no user
 * profile, daemon liveness, or recent-session joins; those have different
 * ownership and update rates and cannot share this revision domain safely.
 */
export const getTeamMembersV2 = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const identity = {
      contractId: TEAM_MEMBERS_VIEW_CONTRACT_ID,
      viewKey: teamMembersViewKey(args.team_id),
    };
    const grantKey = teamMembersGrantKey(args.team_id);
    const userId = await getAuthUserId(ctx);
    if (!userId) return unauthenticatedView(identity);

    const team = await ctx.db.get(args.team_id);
    if (!team) return missingView(identity, [grantKey]);
    const callerMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) =>
        q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();
    if (!callerMembership) return forbiddenView(identity, [grantKey]);

    const [memberships, viewRevision] = await Promise.all([
      ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
        .collect(),
      readLocalViewRevision(ctx, userId, identity.contractId, identity.viewKey),
    ]);
    const projected = memberships
      .map(projectTeamMembership)
      .sort((left, right) =>
        left.joined_at - right.joined_at
        || String(left._id).localeCompare(String(right._id)));
    return grantedView(identity, { grantKeys: [grantKey], viewRevision }, {
      memberships: projected,
    });
  },
});

// End one user's membership in one team, and everything that rides on it:
// the roster row, chat state (reads, follows, room seats, queued pushes), the
// directory mappings that would keep stamping new conversations with the team,
// and the user's own pointers when they name this team. The fallback pointer is
// the user's oldest remaining team (never index order), else no team. Every
// path that ends a membership goes through here: admin removal, self leave,
// team deletion and test cleanup, so none of them can diverge on what "gone"
// means.
export async function endMembership(
  ctx: { db: any },
  userId: Id<"users">,
  teamId: Id<"teams">,
): Promise<void> {
  const rows = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  await purgeChatMembership(ctx as any, userId, teamId);
  const mappings = await ctx.db
    .query("directory_team_mappings")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .collect();
  for (const dm of mappings) await ctx.db.delete(dm._id);

  const user = await ctx.db.get(userId);
  if (!user) return;
  const pointsHere = (id: unknown) => !!id && String(id) === String(teamId);
  if (!pointsHere(user.team_id) && !pointsHere(user.active_team_id)) return;
  const remaining = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const fallback = remaining
    .slice()
    .sort((a: any, b: any) => (a.joined_at ?? 0) - (b.joined_at ?? 0))[0];
  const patch: Record<string, unknown> = {};
  if (pointsHere(user.team_id)) {
    patch.team_id = fallback?.team_id;
    patch.role = fallback?.role;
  }
  if (pointsHere(user.active_team_id)) patch.active_team_id = fallback?.team_id;
  await ctx.db.patch(userId, patch);
}

// Retire a team: end every membership, drop every directory mapping to it,
// decommission its anchors, and leave the row as a tombstone (deleted_at) that
// carries the roster for a later restore. The team's shared work stays in the
// database under a key nobody holds any more.
export async function retireTeam(
  ctx: { db: any },
  team: { _id: Id<"teams">; name: string },
  actorId: Id<"users"> | undefined,
): Promise<{ members: number; anchors: number }> {
  const now = Date.now();
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", team._id))
    .collect();
  const roster = memberships.map((m: any) => ({
    user_id: m.user_id,
    role: m.role,
    joined_at: m.joined_at ?? now,
    visibility: m.visibility,
  }));
  // The tombstone lands first so the roster survives even if a later step
  // throws; the whole mutation is one transaction either way.
  await ctx.db.patch(team._id, {
    deleted_at: now,
    deleted_by: actorId,
    deleted_members: roster,
    invite_code_expires_at: now,
  });
  for (const m of memberships) await endMembership(ctx, m.user_id, team._id);
  // Mappings owned by non-members (a user removed earlier, a mapping created
  // before their membership ended) would otherwise outlive the team.
  const strays = await ctx.db
    .query("directory_team_mappings")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", team._id))
    .collect();
  for (const dm of strays) await ctx.db.delete(dm._id);
  const anchors = await ctx.db
    .query("anchors")
    .withIndex("by_team", (q: any) => q.eq("team_id", team._id))
    .collect();
  let retired = 0;
  for (const anchor of anchors) {
    if (anchor.status === "decommissioned") continue;
    await decommissionAnchorRow(ctx, anchor);
    retired++;
  }
  return { members: memberships.length, anchors: retired };
}

// Admin delete. The caller types the team's name; the server checks it too, so
// a stray call with the wrong id cannot delete a team. Returns where the
// caller's workspace pointer landed so the client mirror can follow in the
// same dispatch.
export const deleteTeam = mutation({
  args: {
    team_id: v.id("teams"),
    confirm_name: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Not authenticated");
    const team = await ctx.db.get(args.team_id);
    if (!team || team.deleted_at) throw new Error("Team not found");
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", args.team_id))
      .unique();
    if (!membership || membership.role !== "admin") {
      throw new Error("Only admins can delete a team");
    }
    if (args.confirm_name.trim() !== team.name.trim()) {
      throw new Error("Type the team name exactly to confirm");
    }
    const result = await retireTeam(ctx, team, authUserId);
    const me = await ctx.db.get(authUserId);
    return {
      deleted: true as const,
      name: team.name,
      active_team_id: me?.active_team_id ?? null,
      ...result,
    };
  },
});

// Operator recovery for a team retired by deleteTeam: clears the tombstone and
// re-seats the roster it recorded. Users who left since, or whose account is
// gone, are skipped. Directory mappings and chat state are not restored; they
// are per-user choices the members make again.
export const restoreTeam = internalMutation({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.team_id);
    if (!team) throw new Error("Team not found");
    if (!team.deleted_at) return { restored: false, members: 0 };
    let seated = 0;
    for (const m of team.deleted_members ?? []) {
      const user = await ctx.db.get(m.user_id);
      if (!user) continue;
      const existing = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q) => q.eq("user_id", m.user_id).eq("team_id", args.team_id))
        .unique();
      if (existing) continue;
      await ctx.db.insert("team_memberships", {
        user_id: m.user_id,
        team_id: args.team_id,
        role: m.role,
        joined_at: m.joined_at,
        visibility: m.visibility,
      });
      seated++;
    }
    await ctx.db.patch(args.team_id, {
      deleted_at: undefined,
      deleted_by: undefined,
      deleted_members: undefined,
    });
    return { restored: true, members: seated };
  },
});

export const removeMember = mutation({
  args: {
    // Deprecated/ignored: the requester is the authenticated caller.
    requesting_user_id: v.optional(v.id("users")),
    member_user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    const requestingUser = await ctx.db.get(authUserId);
    if (!requestingUser) {
      throw new Error("Requesting user not found");
    }
    const teamId = args.team_id || requestingUser.team_id;
    if (!teamId) {
      throw new Error("No team specified");
    }
    const requesterMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", teamId))
      .unique();
    if (!requesterMembership || requesterMembership.role !== "admin") {
      throw new Error("Only admins can remove members");
    }
    const memberMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.member_user_id).eq("team_id", teamId))
      .unique();
    if (!memberMembership) {
      throw new Error("User is not a member of this team");
    }
    if (authUserId === args.member_user_id) {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();
      const adminCount = teamMemberships.filter(m => m.role === "admin").length;
      if (adminCount <= 1) {
        throw new Error("Cannot remove yourself as the last admin");
      }
    }
    const memberUser = await ctx.db.get(args.member_user_id);
    const team = await ctx.db.get(teamId);
    await endMembership(ctx, args.member_user_id, teamId);
    const memberName = memberUser?.name || memberUser?.email || "A member";
    await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
      team_id: teamId,
      actor_user_id: args.member_user_id,
      event_type: "member_left" as const,
      title: `${memberName} left ${team?.name || "the team"}`,
      description: authUserId === args.member_user_id ? "Left team" : "Removed by admin",
    });
  },
});

export const renameTeam = mutation({
  args: {
    team_id: v.id("teams"),
    // Deprecated/ignored: the requester is the authenticated caller.
    requesting_user_id: v.optional(v.id("users")),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", args.team_id))
      .first();
    if (!membership || membership.role !== "admin") {
      throw new Error("Only admins can rename the team");
    }
    await ctx.db.patch(args.team_id, { name: args.name.trim() });
  },
});

export const inviteToTeam = mutation({
  args: {
    team_id: v.id("teams"),
    // Deprecated/ignored: the requester is the authenticated caller.
    requesting_user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", args.team_id))
      .first();
    if (!membership || membership.role !== "admin") {
      throw new Error("Only admins can generate invite codes");
    }
    const newCode = generateInviteCode();
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
    await ctx.db.patch(args.team_id, {
      invite_code: newCode,
      invite_code_expires_at: Date.now() + sevenDaysInMs,
    });
    return newCode;
  },
});

export const sendInviteEmail = mutation({
  args: {
    team_id: v.id("teams"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    // Any member may email the invite — the same audience that can already
    // copy the invite link out of the modal.
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", args.team_id))
      .first();
    if (!membership) {
      throw new Error("Not a member of this team");
    }
    const team = await ctx.db.get(args.team_id);
    if (!team?.invite_code) {
      throw new Error("This team has no invite link yet");
    }
    if (team.invite_code_expires_at && Date.now() > team.invite_code_expires_at) {
      throw new Error("The invite link has expired — regenerate it first");
    }
    const email = args.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Invalid email address");
    }
    // Outbound email to arbitrary addresses is a spam vector — cap per sender.
    const limit = await bumpWindow(ctx.db, `invite-email:${authUserId}`, 30, 60 * 60 * 1000);
    if (!limit.ok) {
      throw new Error("Too many invites sent this hour — try again later");
    }
    const inviter = await ctx.db.get(authUserId);
    await ctx.scheduler.runAfter(0, internal.emails.send.sendTeamInvite, {
      to: email,
      inviter_name: inviter?.name ?? inviter?.email ?? "A teammate",
      inviter_email: inviter?.email,
      team_name: team.name,
      invite_url: `https://codecast.sh/join/${team.invite_code}`,
      expires_at: team.invite_code_expires_at,
    });
    return { sent: true };
  },
});

export const regenerateInviteCode = mutation({
  args: {
    team_id: v.id("teams"),
    // Deprecated/ignored: the requester is the authenticated caller.
    requesting_user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", args.team_id))
      .first();
    if (!membership || membership.role !== "admin") {
      throw new Error("Only admins can regenerate invite codes");
    }
    const newCode = generateInviteCode();
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
    await ctx.db.patch(args.team_id, {
      invite_code: newCode,
      invite_code_expires_at: Date.now() + sevenDaysInMs,
    });
    return newCode;
  },
});

export const setMemberRole = mutation({
  args: {
    // Deprecated/ignored: the requester is the authenticated caller.
    requesting_user_id: v.optional(v.id("users")),
    member_user_id: v.id("users"),
    role: v.union(v.literal("member"), v.literal("admin")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    const requestingUser = await ctx.db.get(authUserId);
    if (!requestingUser) {
      throw new Error("Requesting user not found");
    }
    const teamId = args.team_id || requestingUser.team_id;
    if (!teamId) {
      throw new Error("No team specified");
    }
    const requesterMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", teamId))
      .unique();
    if (!requesterMembership || requesterMembership.role !== "admin") {
      throw new Error("Only admins can change member roles");
    }
    const memberMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.member_user_id).eq("team_id", teamId))
      .unique();
    if (!memberMembership) {
      throw new Error("User not in this team");
    }
    if (args.role === "member" && memberMembership.role === "admin") {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();
      const adminCount = teamMemberships.filter(m => m.role === "admin").length;
      if (adminCount <= 1) {
        throw new Error("Cannot demote the last admin");
      }
    }
    await ctx.db.patch(memberMembership._id, { role: args.role });
    const memberUser = await ctx.db.get(args.member_user_id);
    if (memberUser?.team_id?.toString() === teamId.toString()) {
      await ctx.db.patch(args.member_user_id, { role: args.role });
    }
  },
});

export const removeFromTeam = mutation({
  args: {
    team_id: v.id("teams"),
    user_id: v.id("users"),
    // Deprecated/ignored: the requester is the authenticated caller.
    requesting_user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }
    const requesterMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", authUserId).eq("team_id", args.team_id))
      .unique();
    if (!requesterMembership || requesterMembership.role !== "admin") {
      throw new Error("Only admins can remove members");
    }
    const memberMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.user_id).eq("team_id", args.team_id))
      .unique();
    if (!memberMembership) {
      throw new Error("User not in this team");
    }
    if (authUserId === args.user_id) {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
        .collect();
      const adminCount = teamMemberships.filter(m => m.role === "admin").length;
      if (adminCount <= 1) {
        throw new Error("Cannot remove yourself as the last admin");
      }
    }
    const userToRemove = await ctx.db.get(args.user_id);
    const team = await ctx.db.get(args.team_id);
    await endMembership(ctx, args.user_id, args.team_id);
    const memberName = userToRemove?.name || userToRemove?.email || "A member";
    await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
      team_id: args.team_id,
      actor_user_id: args.user_id,
      event_type: "member_left" as const,
      title: `${memberName} left ${team?.name || "the team"}`,
      description: authUserId === args.user_id ? "Left team" : "Removed by admin",
    });
  },
});

// Admin check by real team membership, callable from actions (which have no
// ctx.db). Authoritative source for "is this user an admin of THIS team".
export const isTeamAdminInternal = internalQuery({
  args: { user_id: v.id("users"), team_id: v.id("teams") },
  handler: async (ctx, args) => {
    return await isTeamAdmin(ctx, args.user_id, args.team_id);
  },
});

export const syncGithubOrg = action({
  args: {
    requesting_user_id: v.id("users"),
    org_name: v.string(),
  },
  handler: async (ctx, args): Promise<{
    imported: Array<{
      github_username: string;
      name: string;
      role: "admin" | "member";
    }>;
    skipped: Array<{
      github_username: string;
      reason: string;
    }>;
    total: number;
  }> => {
    const requestingUser = await ctx.runQuery(api.users.getCurrentUser);
    if (!requestingUser || requestingUser._id !== args.requesting_user_id) {
      throw new Error("Not authenticated");
    }
    if (!requestingUser.team_id) {
      throw new Error("You must be part of a team to sync");
    }
    // Authorize against the ACTUAL team membership, not the denormalized
    // users.role (which reflects whichever team was last activated and drifts).
    const isAdmin = await ctx.runQuery(internal.teams.isTeamAdminInternal, {
      user_id: requestingUser._id,
      team_id: requestingUser.team_id,
    });
    if (!isAdmin) {
      throw new Error("Only admins can sync GitHub organizations");
    }
    if (!requestingUser.github_access_token) {
      throw new Error("GitHub account not connected");
    }

    const membersResponse = await fetch(
      `https://api.github.com/orgs/${args.org_name}/members`,
      {
        headers: {
          Authorization: `Bearer ${requestingUser.github_access_token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!membersResponse.ok) {
      const errorText = await membersResponse.text();
      throw new Error(`Failed to fetch GitHub org members: ${errorText}`);
    }

    const members = await membersResponse.json();
    const imported = [];
    const skipped = [];

    for (const member of members) {
      const membershipResponse = await fetch(
        `https://api.github.com/orgs/${args.org_name}/memberships/${member.login}`,
        {
          headers: {
            Authorization: `Bearer ${requestingUser.github_access_token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );

      let role: "admin" | "member" = "member";
      if (membershipResponse.ok) {
        const membership = await membershipResponse.json();
        role = membership.role === "admin" ? "admin" : "member";
      }

      const existingUser = await ctx.runQuery(api.teams.getUserByGithubId, {
        github_id: String(member.id),
      });

      if (existingUser) {
        if (existingUser.team_id?.toString() === requestingUser.team_id.toString()) {
          skipped.push({
            github_username: member.login,
            reason: "Already a team member",
          });
          continue;
        }
        await ctx.runMutation(internal.teams.updateUserTeamAndRole, {
          user_id: existingUser._id,
          team_id: requestingUser.team_id,
          role,
        });
        imported.push({
          github_username: member.login,
          name: existingUser.name,
          role,
        });
      } else {
        const newUserId = await ctx.runMutation(internal.teams.createUserFromGithub, {
          github_id: String(member.id),
          github_username: member.login,
          github_avatar_url: member.avatar_url,
          team_id: requestingUser.team_id,
          role,
        });
        imported.push({
          github_username: member.login,
          name: member.login,
          role,
        });
      }
    }

    return {
      imported,
      skipped,
      total: members.length,
    };
  },
});

export const getUserByGithubId = query({
  args: {
    github_id: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_github_id", (q) => q.eq("github_id", args.github_id))
      .unique();
    if (!user) return null;
    // Public function, and a github_id is public information — so project to
    // profile fields only. The raw row carries github_access_token,
    // encryption_master_key and push_token.
    return {
      _id: user._id,
      name: user.name ?? null,
      username: user.username ?? null,
      github_username: user.github_username ?? null,
      github_avatar_url: user.github_avatar_url ?? null,
      team_id: user.team_id ?? null,
    };
  },
});

// internal: only syncGithubOrg calls this, after authenticating the caller as a
// team admin. Was a public `mutation` that trusted every argument — anyone could
// make themselves admin of any team. Now unreachable from clients.
export const updateUserTeamAndRole = internalMutation({
  args: {
    user_id: v.id("users"),
    team_id: v.id("teams"),
    role: v.union(v.literal("member"), v.literal("admin")),
  },
  handler: async (ctx, args) => {
    const existingMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.user_id).eq("team_id", args.team_id))
      .unique();
    if (existingMembership) {
      await ctx.db.patch(existingMembership._id, { role: args.role });
    } else {
      await ctx.db.insert("team_memberships", {
        user_id: args.user_id,
        team_id: args.team_id,
        role: args.role,
        joined_at: Date.now(),
      });
    }
    await ctx.db.patch(args.user_id, {
      team_id: args.team_id,
      role: args.role,
    });
  },
});

// internal: only syncGithubOrg calls this, after authenticating the caller as a
// team admin. Was a public `mutation` that let anyone insert a user + membership
// into any team. Now unreachable from clients.
export const createUserFromGithub = internalMutation({
  args: {
    github_id: v.string(),
    github_username: v.string(),
    github_avatar_url: v.string(),
    team_id: v.id("teams"),
    role: v.union(v.literal("member"), v.literal("admin")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      github_id: args.github_id,
      github_username: args.github_username,
      github_avatar_url: args.github_avatar_url,
      image: args.github_avatar_url,
      name: args.github_username,
      team_id: args.team_id,
      role: args.role,
      active_team_id: args.team_id,
      created_at: now,
    });
    await ctx.db.insert("team_memberships", {
      user_id: userId,
      team_id: args.team_id,
      role: args.role,
      joined_at: now,
    });
    return userId;
  },
});

// internal: removes throwaway teams created by agent test runs. Guarded by a
// name check so a wrong id cannot delete a real team. Same retirement as the
// admin delete, so a test team leaves the same tombstone and nothing dangles.
export const cleanupTestTeams = internalMutation({
  args: { team_ids: v.array(v.id("teams")) },
  handler: async (ctx, args) => {
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const teamId of args.team_ids) {
      const team = await ctx.db.get(teamId);
      if (!team || team.deleted_at) continue;
      if (!/^(flow test|critique round)/i.test(team.name)) {
        skipped.push(team.name);
        continue;
      }
      await retireTeam(ctx, team, undefined);
      deleted.push(team.name);
    }
    return { deleted, skipped };
  },
});

export const migrateToMultiTeam = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let migratedCount = 0;
    let skippedCount = 0;

    for (const user of users) {
      if (user.team_id) {
        const existingMembership = await ctx.db
          .query("team_memberships")
          .withIndex("by_user_team", (q) => q.eq("user_id", user._id).eq("team_id", user.team_id!))
          .unique();

        if (!existingMembership) {
          await ctx.db.insert("team_memberships", {
            user_id: user._id,
            team_id: user.team_id,
            role: user.role || "member",
            joined_at: user.created_at || Date.now(),
          });
          migratedCount++;
        } else {
          skippedCount++;
        }

        if (!user.active_team_id) {
          await ctx.db.patch(user._id, { active_team_id: user.team_id });
        }

        if (user.team_share_paths && user.team_share_paths.length > 0) {
          for (const path of user.team_share_paths) {
            const existingMapping = await ctx.db
              .query("directory_team_mappings")
              .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
              .filter((q) => q.eq(q.field("path_prefix"), path))
              .first();

            if (!existingMapping) {
              await ctx.db.insert("directory_team_mappings", {
                user_id: user._id,
                path_prefix: path,
                team_id: user.team_id,
                auto_share: true,
                created_at: Date.now(),
              });
            }
          }
        }
      }
    }

    return { migratedCount, skippedCount };
  },
});

export const setActiveTeam = mutation({
  args: {
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    if (args.team_id) {
      const membership = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id!))
        .unique();
      if (!membership) {
        throw new Error("Not a member of this team");
      }
      await ctx.db.patch(userId, {
        active_team_id: args.team_id,
        team_id: args.team_id,
        role: membership.role,
      });
    } else {
      await ctx.db.patch(userId, {
        active_team_id: undefined,
        team_id: undefined,
        role: undefined,
      });
    }
    return { success: true };
  },
});

export const setTeamVisibility = mutation({
  args: {
    team_id: v.id("teams"),
    visibility: v.union(
      v.literal("hidden"),
      v.literal("activity"),
      v.literal("summary"),
      v.literal("full")
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();

    if (!membership) {
      throw new Error("Not a member of this team");
    }

    await ctx.db.patch(membership._id, { visibility: args.visibility });
    return { success: true };
  },
});

export const updateTeamIcon = mutation({
  args: {
    team_id: v.id("teams"),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();

    if (!membership || membership.role !== "admin") {
      throw new Error("Only admins can change the team icon");
    }

    const updates: { icon?: string; icon_color?: string } = {};

    if (args.icon !== undefined) {
      if (!isTeamIcon(args.icon)) {
        throw new Error("Invalid icon");
      }
      updates.icon = args.icon;
    }

    if (args.icon_color !== undefined) {
      if (!isTeamColor(args.icon_color)) {
        throw new Error("Invalid color");
      }
      updates.icon_color = args.icon_color;
    }

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(args.team_id, updates);
    }

    return { success: true };
  },
});

// Replace the team's task-status list wholesale (the editor saves the whole
// list; it is tiny and edited rarely). Validation lives in the shared
// contract — normalizeTeamTaskStatuses enforces names, categories, unique ids
// and the one-status-per-category floor — so the web editor and this mutation
// can never disagree about what a legal list is. Loose arg validator on
// purpose: the normalizer is the authority and produces human messages.
export const updateTaskStatuses = mutation({
  args: {
    team_id: v.id("teams"),
    statuses: v.array(v.object({
      id: v.string(),
      name: v.string(),
      category: v.string(),
      color: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();
    if (!membership || membership.role !== "admin") {
      throw new Error("Only admins can edit task statuses");
    }
    const statuses = normalizeTeamTaskStatuses(args.statuses);
    await ctx.db.patch(args.team_id, { task_statuses: statuses });
    return { success: true };
  },
});
