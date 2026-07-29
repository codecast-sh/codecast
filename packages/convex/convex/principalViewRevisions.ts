import type { Id } from "./_generated/dataModel";
import { advanceLocalViewRevision } from "./localViewRevisions";
import {
  BOOKMARKS_VIEW_CONTRACT_ID,
  BOOKMARKS_VIEW_KEY,
  CURRENT_USER_VIEW_CONTRACT_ID,
  CURRENT_USER_VIEW_KEY,
  FAVORITES_VIEW_CONTRACT_ID,
  FAVORITES_VIEW_KEY,
  TEAM_MEMBERS_VIEW_CONTRACT_ID,
  TEAMS_VIEW_CONTRACT_ID,
  TEAMS_VIEW_KEY,
  projectCurrentUserMetadata,
  projectTeamMembership,
  sameProjection,
  teamMembersViewKey,
} from "./smallViewContracts";

type RevisionDb = any;
type TrackedPrincipalTable =
  | "users"
  | "teams"
  | "team_memberships"
  | "conversations";

const TRACKED_TABLES: readonly TrackedPrincipalTable[] = [
  "users",
  "teams",
  "team_memberships",
  // Conversation patches are handled by the favorite writer so receipt mode
  // advances exactly once. The interceptor covers insert/replace/delete, which
  // can also add or remove a favorite membership.
  "conversations",
];

function trackedTableOf(db: RevisionDb, id: unknown): TrackedPrincipalTable | null {
  for (const table of TRACKED_TABLES) {
    if (db.normalizeId(table, id)) return table;
  }
  return null;
}

function stringIds(values: Array<Id<"users"> | undefined>): Id<"users">[] {
  return [...new Map(
    values.filter((value): value is Id<"users"> => value !== undefined)
      .map((value) => [String(value), value]),
  ).values()].sort((left, right) => String(left).localeCompare(String(right)));
}

async function teamMemberIds(db: RevisionDb, teamId: Id<"teams">): Promise<Id<"users">[]> {
  const memberships = await db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
    .collect();
  return stringIds(memberships.map((membership: any) => membership.user_id));
}

export async function advanceCurrentUserViewRevision(
  db: RevisionDb,
  principalId: Id<"users">,
): Promise<void> {
  await advanceLocalViewRevision(
    { db } as any,
    principalId,
    CURRENT_USER_VIEW_CONTRACT_ID,
    CURRENT_USER_VIEW_KEY,
  );
}

export async function advanceTeamsViewRevision(
  db: RevisionDb,
  principalId: Id<"users">,
): Promise<void> {
  await advanceLocalViewRevision(
    { db } as any,
    principalId,
    TEAMS_VIEW_CONTRACT_ID,
    TEAMS_VIEW_KEY,
  );
}

export async function advanceTeamMembersViewRevision(
  db: RevisionDb,
  principalId: Id<"users">,
  teamId: Id<"teams">,
): Promise<void> {
  await advanceLocalViewRevision(
    { db } as any,
    principalId,
    TEAM_MEMBERS_VIEW_CONTRACT_ID,
    teamMembersViewKey(teamId),
  );
}

export async function advanceFavoritesViewRevision(
  db: RevisionDb,
  principalId: Id<"users">,
): Promise<void> {
  await advanceLocalViewRevision(
    { db } as any,
    principalId,
    FAVORITES_VIEW_CONTRACT_ID,
    FAVORITES_VIEW_KEY,
  );
}

export async function advanceBookmarksViewRevision(
  db: RevisionDb,
  principalId: Id<"users">,
): Promise<void> {
  await advanceLocalViewRevision(
    { db } as any,
    principalId,
    BOOKMARKS_VIEW_CONTRACT_ID,
    BOOKMARKS_VIEW_KEY,
  );
}

async function advanceMembershipTransition(
  db: RevisionDb,
  before: any | null,
  after: any | null,
  beforeViewers: Id<"users">[],
): Promise<void> {
  for (const principalId of stringIds([before?.user_id, after?.user_id])) {
    await advanceTeamsViewRevision(db, principalId);
  }

  const teamIds = [...new Map(
    [before?.team_id, after?.team_id]
      .filter(Boolean)
      .map((teamId) => [String(teamId), teamId as Id<"teams">]),
  ).values()];
  for (const teamId of teamIds) {
    const afterViewers = await teamMemberIds(db, teamId);
    for (const principalId of stringIds([...beforeViewers, ...afterViewers])) {
      await advanceTeamMembersViewRevision(db, principalId, teamId);
    }
  }
}

async function advanceTeamTransition(
  db: RevisionDb,
  teamId: Id<"teams">,
  beforeViewers: Id<"users">[],
): Promise<void> {
  const afterViewers = await teamMemberIds(db, teamId);
  for (const principalId of stringIds([...beforeViewers, ...afterViewers])) {
    await advanceTeamsViewRevision(db, principalId);
  }
}

function favoritePrincipal(doc: any | null): Id<"users"> | undefined {
  return doc?.is_favorite ? doc.user_id : undefined;
}

function sameFavoriteMembership(before: any | null, after: any | null): boolean {
  return String(favoritePrincipal(before) ?? "") === String(favoritePrincipal(after) ?? "");
}

function teamCatalogFields(team: any | null) {
  if (!team) return null;
  return {
    _id: team._id,
    name: team.name,
    icon: team.icon,
    icon_color: team.icon_color,
  };
}

async function advanceFavoriteReplacement(
  db: RevisionDb,
  before: any | null,
  after: any | null,
): Promise<void> {
  if (sameFavoriteMembership(before, after)) return;
  for (const principalId of stringIds([favoritePrincipal(before), favoritePrincipal(after)])) {
    await advanceFavoritesViewRevision(db, principalId);
  }
}

/**
 * Mutation-wide revision interceptor for the small views without optimistic
 * command surfaces. It is composed with the existing change-log writer in
 * functions.ts, so ordinary domain code cannot forget current-user/team view
 * coverage. Bookmark writes and favorite flag patches use explicit receipt-
 * aware writers instead and therefore are deliberately excluded here.
 */
export function makePrincipalViewTrackedDb(db: RevisionDb): RevisionDb {
  if (typeof db.normalizeId !== "function") return db;
  return {
    get: (...args: any[]) => db.get(...args),
    query: (...args: any[]) => db.query(...args),
    normalizeId: (...args: any[]) => db.normalizeId(...args),
    system: db.system,

    async insert(table: string, doc: any) {
      const id = await db.insert(table, doc);
      if (table === "users") {
        await advanceCurrentUserViewRevision(db, id as Id<"users">);
      } else if (table === "teams") {
        await advanceTeamTransition(db, id as Id<"teams">, []);
      } else if (table === "team_memberships") {
        await advanceMembershipTransition(db, null, { _id: id, ...doc }, []);
      } else if (table === "conversations" && doc.is_favorite) {
        await advanceFavoritesViewRevision(db, doc.user_id);
      }
      return id;
    },

    async patch(id: any, fields: any) {
      const table = trackedTableOf(db, id);
      const beforeDoc = table ? await db.get(id) : null;
      // Convex documents are immutable snapshots. Some test adapters mutate
      // their backing row in place, so retain the same semantic guarantee here.
      const before = beforeDoc ? { ...beforeDoc } : null;
      const beforeViewers = table === "teams" && before
        ? await teamMemberIds(db, before._id)
        : table === "team_memberships" && before
          ? await teamMemberIds(db, before.team_id)
          : [];
      const result = await db.patch(id, fields);
      const after = table ? await db.get(id) : null;
      if (
        table === "users"
        && (before || after)
        && !sameProjection(
          before ? projectCurrentUserMetadata(before) : null,
          after ? projectCurrentUserMetadata(after) : null,
        )
      ) {
        await advanceCurrentUserViewRevision(db, (after?._id ?? before._id) as Id<"users">);
      } else if (
        table === "teams"
        && (before || after)
        && !sameProjection(teamCatalogFields(before), teamCatalogFields(after))
      ) {
        await advanceTeamTransition(db, (after?._id ?? before._id) as Id<"teams">, beforeViewers);
      } else if (
        table === "team_memberships"
        && !sameProjection(
          before ? projectTeamMembership(before) : null,
          after ? projectTeamMembership(after) : null,
        )
      ) {
        await advanceMembershipTransition(db, before, after, beforeViewers);
      } else if (table === "conversations" && "user_id" in fields) {
        // Favorite flag changes use favoriteViewWrites so receipt mode advances
        // exactly once. Ownership moves are distinct and must invalidate both
        // old and new principal relations when the row is currently favorite.
        await advanceFavoriteReplacement(db, before, after);
      }
      // Favorite flag patches go through favoriteViewWrites.ts. Ignoring all
      // conversation patches here prevents a receipt-backed set from advancing
      // twice and prevents unrelated heartbeat fields from creating a hotspot.
      return result;
    },

    async replace(id: any, doc: any) {
      const table = trackedTableOf(db, id);
      const beforeDoc = table ? await db.get(id) : null;
      const before = beforeDoc ? { ...beforeDoc } : null;
      const beforeViewers = table === "teams" && before
        ? await teamMemberIds(db, before._id)
        : table === "team_memberships" && before
          ? await teamMemberIds(db, before.team_id)
          : [];
      const result = await db.replace(id, doc);
      const after = table ? await db.get(id) : null;
      if (
        table === "users"
        && (before || after)
        && !sameProjection(
          before ? projectCurrentUserMetadata(before) : null,
          after ? projectCurrentUserMetadata(after) : null,
        )
      ) {
        await advanceCurrentUserViewRevision(db, (after?._id ?? before._id) as Id<"users">);
      } else if (
        table === "teams"
        && (before || after)
        && !sameProjection(teamCatalogFields(before), teamCatalogFields(after))
      ) {
        await advanceTeamTransition(db, (after?._id ?? before._id) as Id<"teams">, beforeViewers);
      } else if (
        table === "team_memberships"
        && !sameProjection(
          before ? projectTeamMembership(before) : null,
          after ? projectTeamMembership(after) : null,
        )
      ) {
        await advanceMembershipTransition(db, before, after, beforeViewers);
      } else if (table === "conversations") {
        await advanceFavoriteReplacement(db, before, after);
      }
      return result;
    },

    async delete(id: any) {
      const table = trackedTableOf(db, id);
      const before = table ? await db.get(id) : null;
      const beforeViewers = table === "teams" && before
        ? await teamMemberIds(db, before._id)
        : table === "team_memberships" && before
          ? await teamMemberIds(db, before.team_id)
          : [];
      const result = await db.delete(id);
      if (table === "users" && before) {
        await advanceCurrentUserViewRevision(db, before._id);
      } else if (table === "teams" && before) {
        await advanceTeamTransition(db, before._id, beforeViewers);
      } else if (table === "team_memberships" && before) {
        await advanceMembershipTransition(db, before, null, beforeViewers);
      } else if (table === "conversations" && before?.is_favorite) {
        await advanceFavoritesViewRevision(db, before.user_id);
      }
      return result;
    },
  };
}
