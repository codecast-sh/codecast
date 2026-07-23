import type { Id } from "./_generated/dataModel";
import type { ViewCoverageTarget } from "./localViewRevisions";

export const CURRENT_USER_VIEW_CONTRACT_ID = "users.current/v2";
export const CURRENT_USER_VIEW_KEY = "users:current";
export const CURRENT_USER_GRANT_KEY = "current-user-metadata";

export const TEAMS_VIEW_CONTRACT_ID = "teams.forPrincipal/v2";
export const TEAMS_VIEW_KEY = "teams:principal";
export const TEAMS_GRANT_KEY = "principal-team-catalog";

export const TEAM_MEMBERS_VIEW_CONTRACT_ID = "team-memberships.byTeam/v2";

export const FAVORITES_VIEW_CONTRACT_ID = "favorites.principal/v2";
export const FAVORITES_VIEW_KEY = "favorites:principal";
export const FAVORITES_GRANT_KEY = "principal-favorites";

export const BOOKMARKS_VIEW_CONTRACT_ID = "bookmarks.principal/v2";
export const BOOKMARKS_VIEW_KEY = "bookmarks:principal";
export const BOOKMARKS_GRANT_KEY = "principal-bookmarks";

// Deliberately excludes daemon liveness/backlog, activity cursors, installed
// skills/agents, CLI/device capability facts, machine-local roots, provider
// credentials, push tokens, and encryption key material. Those are operational
// overlays, per-device facts, or secrets—not durable principal preferences.
// Keeping the field list explicit means a new users-table field cannot silently
// expand the persisted local contract.
const CURRENT_USER_METADATA_FIELDS = [
  "email",
  "alternate_emails",
  "emailVerificationTime",
  "name",
  "image",
  "isAnonymous",
  "created_at",
  "team_id",
  "role",
  "is_bot",
  "bot_kind",
  "active_team_id",
  "theme",
  "github_id",
  "github_username",
  "github_avatar_url",
  "notifications_enabled",
  "notification_preferences",
  "pr_auto_comment_enabled",
  "bio",
  "title",
  "status",
  "timezone",
  "hide_activity",
  "username",
  "public_profile_enabled",
  "share_session_metadata",
  "activity_visibility",
  "encryption_enabled",
  "sync_mode",
  "sync_projects",
  "team_share_paths",
  "muted_members",
  "agent_permission_modes",
  "agent_default_params",
] as const;

/** Canonical v2 current-user projection shared by the endpoint and interceptor. */
export function projectCurrentUserMetadata(
  user: Record<string, any>,
): Record<string, any> {
  const projected: Record<string, any> = { _id: user._id };
  for (const field of CURRENT_USER_METADATA_FIELDS) {
    if (user[field] !== undefined) projected[field] = user[field];
  }
  return projected;
}

/** Stable comparison for JSON-compatible Convex projection values. */
export function sameProjection(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function projectPrincipalTeam(team: Record<string, any>, membership: Record<string, any>) {
  return {
    _id: team._id,
    name: team.name,
    ...(team.icon !== undefined ? { icon: team.icon } : {}),
    ...(team.icon_color !== undefined ? { icon_color: team.icon_color } : {}),
    role: membership.role,
    joined_at: membership.joined_at,
    visibility: membership.visibility || "summary",
  };
}

/** Exact membership facts only; profile and liveness are separate projections. */
export function projectTeamMembership(membership: Record<string, any>) {
  return {
    _id: membership._id,
    user_id: membership.user_id,
    team_id: membership.team_id,
    role: membership.role,
    joined_at: membership.joined_at,
    visibility: membership.visibility || "summary",
  };
}

/** Favorites are a relation, not a second copy of conversation entities. */
export function projectFavoriteMembership(conversation: Record<string, any>) {
  return { conversation_id: conversation._id };
}

/** Canonical bookmark row; conversation/message enrichment stays query-owned. */
export function projectBookmark(bookmark: Record<string, any>) {
  return {
    _id: bookmark._id,
    conversation_id: bookmark.conversation_id,
    message_id: bookmark.message_id,
    created_at: bookmark.created_at,
    ...(bookmark.name !== undefined ? { name: bookmark.name } : {}),
    ...(bookmark.note !== undefined ? { note: bookmark.note } : {}),
  };
}

export function teamMembersViewKey(teamId: Id<"teams">): string {
  return `team-memberships:team:${teamId}`;
}

/** Opaque retention grant. Clients compare it; they do not parse or mint it. */
export function teamMembersGrantKey(teamId: Id<"teams">): string {
  return `team-membership-grant:${teamId}`;
}

export function currentUserCoverageTarget(
  principalId?: Id<"users">,
): ViewCoverageTarget {
  return {
    contractId: CURRENT_USER_VIEW_CONTRACT_ID,
    viewKey: CURRENT_USER_VIEW_KEY,
    ...(principalId ? { revisionPrincipalId: principalId } : {}),
  };
}

export function teamsCoverageTarget(
  principalId?: Id<"users">,
): ViewCoverageTarget {
  return {
    contractId: TEAMS_VIEW_CONTRACT_ID,
    viewKey: TEAMS_VIEW_KEY,
    ...(principalId ? { revisionPrincipalId: principalId } : {}),
  };
}

export function teamMembersCoverageTarget(
  teamId: Id<"teams">,
  principalId?: Id<"users">,
): ViewCoverageTarget {
  return {
    contractId: TEAM_MEMBERS_VIEW_CONTRACT_ID,
    viewKey: teamMembersViewKey(teamId),
    ...(principalId ? { revisionPrincipalId: principalId } : {}),
  };
}

export function favoritesCoverageTarget(
  principalId?: Id<"users">,
): ViewCoverageTarget {
  return {
    contractId: FAVORITES_VIEW_CONTRACT_ID,
    viewKey: FAVORITES_VIEW_KEY,
    ...(principalId ? { revisionPrincipalId: principalId } : {}),
  };
}

export function bookmarksCoverageTarget(
  principalId?: Id<"users">,
): ViewCoverageTarget {
  return {
    contractId: BOOKMARKS_VIEW_CONTRACT_ID,
    viewKey: BOOKMARKS_VIEW_KEY,
    ...(principalId ? { revisionPrincipalId: principalId } : {}),
  };
}

export function revisionCoverage(revision: number) {
  return {
    kind: "view-revision" as const,
    revision: String(revision),
    revisionOrder: revision,
  };
}
