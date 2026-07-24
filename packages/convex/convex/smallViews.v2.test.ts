import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getCurrentUser, getCurrentUserV2 } from "./users";
import { getTeamMembersV2, getUserTeams, getUserTeamsV2 } from "./teams";
import {
  listFavorites,
  listFavoritesV2,
  setFavoriteV2,
  toggleFavorite,
} from "./conversations";
import {
  listBookmarks,
  listBookmarksV2,
  setBookmarkV2,
  toggleBookmark,
} from "./bookmarks";
import { applyPatches } from "./dispatch";
import { makePrincipalViewTrackedDb } from "./principalViewRevisions";

const OWNER = "user-owner" as any;
const MEMBER = "user-member" as any;
const OTHER = "user-other" as any;
const TEAM = "team-main" as any;
const MISSING_TEAM = "team-missing" as any;
const CONVERSATION = "conversation-main" as any;
const OTHER_CONVERSATION = "conversation-other" as any;
const MESSAGE = "message-main" as any;
const OTHER_MESSAGE = "message-other" as any;

const CURRENT_CONTRACT = "users.current/v2";
const CURRENT_VIEW = "users:current";
const TEAMS_CONTRACT = "teams.forPrincipal/v2";
const TEAMS_VIEW = "teams:principal";
const MEMBERS_CONTRACT = "team-memberships.byTeam/v2";
const MEMBERS_VIEW = `team-memberships:team:${TEAM}`;
const FAVORITES_CONTRACT = "favorites.principal/v2";
const FAVORITES_VIEW = "favorites:principal";
const BOOKMARKS_CONTRACT = "bookmarks.principal/v2";
const BOOKMARKS_VIEW = "bookmarks:principal";

function user(_id: string, extra: Record<string, unknown> = {}) {
  return {
    _id,
    name: _id,
    email: `${_id}@example.test`,
    ...extra,
  };
}

function team(_id = TEAM, extra: Record<string, unknown> = {}) {
  return {
    _id,
    name: "Core",
    icon: "rocket",
    icon_color: "blue",
    created_at: 1,
    invite_code: "SECRET",
    ...extra,
  };
}

function membership(
  _id: string,
  userId: string,
  teamId = TEAM,
  extra: Record<string, unknown> = {},
) {
  return {
    _id,
    user_id: userId,
    team_id: teamId,
    role: "member",
    joined_at: 1,
    ...extra,
  };
}

function conversation(
  _id = CONVERSATION,
  owner = OWNER,
  extra: Record<string, unknown> = {},
) {
  return {
    _id,
    user_id: owner,
    session_id: `session-${_id}`,
    title: `Title ${_id}`,
    updated_at: 10,
    message_count: 1,
    agent_type: "claude_code",
    is_private: true,
    status: "active",
    ...extra,
  };
}

function message(
  _id = MESSAGE,
  conversationId = CONVERSATION,
  extra: Record<string, unknown> = {},
) {
  return {
    _id,
    conversation_id: conversationId,
    role: "user",
    content: `content ${_id}`,
    timestamp: 1,
    ...extra,
  };
}

function context(authenticatedUser: string | null, seed: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: [user(OWNER), user(MEMBER), user(OTHER)],
    user_skills: [],
    teams: [],
    team_memberships: [],
    conversations: [],
    messages: [],
    bookmarks: [],
    local_view_heads: [],
    local_command_receipts: [],
    session_owners: [],
    ...seed,
  });
  return {
    db,
    auth: {
      async getUserIdentity() {
        return authenticatedUser ? { subject: `${authenticatedUser}|session` } : null;
      },
    },
  } as any;
}

function head(ctx: any, contractId: string, viewKey: string, principalId = OWNER) {
  return ctx.db._tables.local_view_heads.find((row: any) =>
    String(row.principal_id) === String(principalId)
    && row.contract_id === contractId
    && row.view_key === viewKey);
}

describe("small v2 complete-view envelopes", () => {
  test("current user is explicit, stable metadata and remains principal-scoped", async () => {
    const unauthenticated = await (getCurrentUserV2 as any)._handler(context(null), {});
    expect(unauthenticated).toEqual({
      contractId: CURRENT_CONTRACT,
      viewKey: CURRENT_VIEW,
      access: "unauthenticated",
    });

    const missingCtx = context(OWNER, { users: [user(MEMBER), user(OTHER)] });
    expect(await (getCurrentUserV2 as any)._handler(missingCtx, {})).toEqual({
      contractId: CURRENT_CONTRACT,
      viewKey: CURRENT_VIEW,
      access: "missing",
      releasedGrantKeys: ["current-user-metadata"],
      removals: [],
    });

    const ctx = context(OWNER, {
      users: [user(OWNER, {
        name: "Owner",
        theme: "dark",
        daemon_last_seen: 999,
        daemon_pending_sync_count: 8,
        github_access_token: "must-not-persist",
        push_token: "must-not-persist",
        encryption_master_key: "must-not-persist",
        local_project_roots: ["/private/work"],
        team_conversations_last_seen: 777,
        cli_version: "9.9.9",
        cli_platform: "secret-device",
        autostart_enabled: true,
        has_tmux: true,
        available_agents: [{ id: "device-agent", name: "Device Agent" }],
        available_skills: "legacy",
      })],
      user_skills: [{
        _id: "skills-owner",
        user_id: OWNER,
        skills_json: "authoritative-skills",
        updated_at: 2,
      }],
      local_view_heads: [{
        _id: "head-current",
        principal_id: OWNER,
        contract_id: CURRENT_CONTRACT,
        view_key: CURRENT_VIEW,
        revision: 4,
        updated_at: 1,
      }],
    });
    const result = await (getCurrentUserV2 as any)._handler(ctx, {});
    expect(result).toMatchObject({
      contractId: CURRENT_CONTRACT,
      viewKey: CURRENT_VIEW,
      access: "granted",
      grantKeys: ["current-user-metadata"],
      viewRevision: 4,
      coverage: { kind: "view-revision", revision: "4", revisionOrder: 4 },
      user: {
        _id: OWNER,
        name: "Owner",
        theme: "dark",
      },
    });
    for (const field of [
      "daemon_last_seen",
      "daemon_pending_sync_count",
      "github_access_token",
      "push_token",
      "encryption_master_key",
      "local_project_roots",
      "team_conversations_last_seen",
      "cli_version",
      "cli_platform",
      "autostart_enabled",
      "has_tmux",
      "available_agents",
      "available_skills",
    ]) expect(field in result.user).toBe(false);

    // V1 remains byte-for-byte broad and keeps the skills overlay.
    const legacy = await (getCurrentUser as any)._handler(ctx, {});
    expect(legacy.daemon_last_seen).toBe(999);
    expect(legacy.github_access_token).toBe("must-not-persist");
    expect(legacy.available_skills).toBe("authoritative-skills");
  });

  test("principal teams is complete-empty and deterministic without leaking invite data", async () => {
    const empty = await (getUserTeamsV2 as any)._handler(context(OWNER), {});
    expect(empty).toEqual({
      contractId: TEAMS_CONTRACT,
      viewKey: TEAMS_VIEW,
      access: "granted",
      grantKeys: ["principal-team-catalog"],
      viewRevision: 0,
      coverage: { kind: "view-revision", revision: "0", revisionOrder: 0 },
      teams: [],
    });

    const ctx = context(OWNER, {
      teams: [team("team-z", { name: "Z" }), team("team-a", { name: "A" })],
      team_memberships: [
        membership("membership-z", OWNER, "team-z", { joined_at: 20, role: "admin" }),
        membership("membership-a", OWNER, "team-a", { joined_at: 10, visibility: "full" }),
      ],
    });
    const result = await (getUserTeamsV2 as any)._handler(ctx, {});
    expect(result.teams.map((row: any) => row._id)).toEqual(["team-a", "team-z"]);
    expect(result.teams[0]).toMatchObject({ role: "member", visibility: "full" });
    expect(result.teams[1]).toMatchObject({ role: "admin", visibility: "summary" });
    expect(result.teams.some((row: any) => "invite_code" in row)).toBe(false);

    const legacy = await (getUserTeams as any)._handler(ctx, {});
    expect(legacy).toHaveLength(2);
    expect(legacy[0]).toEqual(expect.objectContaining({
      _id: "team-z",
      role: "admin",
      visibility: "summary",
    }));
  });

  test("exact-team membership distinguishes missing, forbidden, and revoked access", async () => {
    const unauthenticated = await (getTeamMembersV2 as any)._handler(context(null), {
      team_id: TEAM,
    });
    expect(unauthenticated).toEqual({
      contractId: MEMBERS_CONTRACT,
      viewKey: MEMBERS_VIEW,
      access: "unauthenticated",
    });

    const missing = await (getTeamMembersV2 as any)._handler(context(OWNER), {
      team_id: MISSING_TEAM,
    });
    expect(missing).toEqual({
      contractId: MEMBERS_CONTRACT,
      viewKey: `team-memberships:team:${MISSING_TEAM}`,
      access: "missing",
      releasedGrantKeys: [`team-membership-grant:${MISSING_TEAM}`],
      removals: [],
    });

    const forbidden = await (getTeamMembersV2 as any)._handler(context(OTHER, {
      teams: [team()],
      team_memberships: [membership("membership-owner", OWNER)],
    }), { team_id: TEAM });
    expect(forbidden).toEqual({
      contractId: MEMBERS_CONTRACT,
      viewKey: MEMBERS_VIEW,
      access: "forbidden",
      revokedGrantKeys: [`team-membership-grant:${TEAM}`],
    });

    const ctx = context(OWNER, {
      users: [
        user(OWNER, { daemon_last_seen: 10, bio: "not in relation" }),
        user(MEMBER, { daemon_last_seen: 20 }),
      ],
      teams: [team()],
      team_memberships: [
        membership("membership-member", MEMBER, TEAM, { joined_at: 2 }),
        membership("membership-owner", OWNER, TEAM, { joined_at: 1, role: "admin" }),
      ],
      local_view_heads: [{
        _id: "head-members",
        principal_id: OWNER,
        contract_id: MEMBERS_CONTRACT,
        view_key: MEMBERS_VIEW,
        revision: 7,
        updated_at: 1,
      }],
    });
    const granted = await (getTeamMembersV2 as any)._handler(ctx, { team_id: TEAM });
    expect(granted).toMatchObject({
      access: "granted",
      grantKeys: [`team-membership-grant:${TEAM}`],
      viewRevision: 7,
      memberships: [
        { _id: "membership-owner", user_id: OWNER, role: "admin", visibility: "summary" },
        { _id: "membership-member", user_id: MEMBER, role: "member", visibility: "summary" },
      ],
    });
    expect("name" in granted.memberships[0]).toBe(false);
    expect("daemon_last_seen" in granted.memberships[0]).toBe(false);
    expect("recent_session_title" in granted.memberships[0]).toBe(false);

    ctx.db._tables.team_memberships = ctx.db._tables.team_memberships.filter(
      (row: any) => row.user_id !== OWNER,
    );
    expect(await (getTeamMembersV2 as any)._handler(ctx, { team_id: TEAM })).toEqual({
      contractId: MEMBERS_CONTRACT,
      viewKey: MEMBERS_VIEW,
      access: "forbidden",
      revokedGrantKeys: [`team-membership-grant:${TEAM}`],
    });
  });

  test("favorites and bookmarks expose normalized complete relations", async () => {
    const ctx = context(OWNER, {
      conversations: [
        conversation("conversation-z", OWNER, { is_favorite: true }),
        conversation("conversation-a", OWNER, { is_favorite: true }),
        conversation("conversation-no", OWNER, { is_favorite: false }),
        conversation("conversation-foreign", OTHER, { is_favorite: true }),
      ],
      messages: [message(), message(OTHER_MESSAGE, OTHER_CONVERSATION)],
      bookmarks: [{
        _id: "bookmark-old",
        user_id: OWNER,
        conversation_id: CONVERSATION,
        message_id: MESSAGE,
        name: "Old",
        created_at: 1,
      }, {
        _id: "bookmark-new",
        user_id: OWNER,
        conversation_id: OTHER_CONVERSATION,
        message_id: OTHER_MESSAGE,
        note: "New note",
        created_at: 2,
      }, {
        _id: "bookmark-foreign",
        user_id: OTHER,
        conversation_id: OTHER_CONVERSATION,
        message_id: OTHER_MESSAGE,
        created_at: 3,
      }],
    });

    const favorites = await (listFavoritesV2 as any)._handler(ctx, {});
    expect(favorites).toMatchObject({
      contractId: FAVORITES_CONTRACT,
      viewKey: FAVORITES_VIEW,
      access: "granted",
      favorites: [
        { conversation_id: "conversation-a" },
        { conversation_id: "conversation-z" },
      ],
    });
    expect("title" in favorites.favorites[0]).toBe(false);

    const bookmarks = await (listBookmarksV2 as any)._handler(ctx, {});
    expect(bookmarks).toMatchObject({
      contractId: BOOKMARKS_CONTRACT,
      viewKey: BOOKMARKS_VIEW,
      access: "granted",
      bookmarks: [
        {
          _id: "bookmark-new",
          conversation_id: OTHER_CONVERSATION,
          message_id: OTHER_MESSAGE,
          note: "New note",
        },
        {
          _id: "bookmark-old",
          conversation_id: CONVERSATION,
          message_id: MESSAGE,
          name: "Old",
        },
      ],
    });
    expect("conversation_title" in bookmarks.bookmarks[0]).toBe(false);
    expect("message_preview" in bookmarks.bookmarks[0]).toBe(false);

    const noAuthFavorites = await (listFavoritesV2 as any)._handler(context(null), {});
    expect(noAuthFavorites.access).toBe("unauthenticated");
    expect("favorites" in noAuthFavorites).toBe(false);
    const noAuthBookmarks = await (listBookmarksV2 as any)._handler(context(null), {});
    expect(noAuthBookmarks.access).toBe("unauthenticated");
    expect("bookmarks" in noAuthBookmarks).toBe(false);
  });
});

describe("favorite desired-state commands", () => {
  test("write, exact replay, and no-op each have deterministic positive coverage", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation(CONVERSATION, OWNER, { is_favorite: false })],
    });
    const args = {
      command_id: "favorite-once",
      conversation_id: CONVERSATION,
      is_favorite: true,
    };
    const first = await (setFavoriteV2 as any)._handler(ctx, args);
    const replay = await (setFavoriteV2 as any)._handler(ctx, args);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      commandName: "favorites.set/v2",
      status: "acknowledged",
      result: { conversationId: CONVERSATION, isFavorite: true },
      coverage: [{
        contractId: FAVORITES_CONTRACT,
        viewKey: FAVORITES_VIEW,
        revision: 1,
      }],
    });
    expect(ctx.db._tables.conversations[0].is_favorite).toBe(true);
    expect(ctx.db._tables.local_command_receipts).toHaveLength(1);
    expect(head(ctx, FAVORITES_CONTRACT, FAVORITES_VIEW).revision).toBe(1);
    expect(ctx.db._patched.filter((write: any) => write._id === CONVERSATION)).toHaveLength(1);

    const noOp = await (setFavoriteV2 as any)._handler(ctx, {
      ...args,
      command_id: "favorite-already-on",
    });
    expect(noOp).toMatchObject({
      status: "acknowledged",
      coverage: [{ revision: 2 }],
    });
    expect(head(ctx, FAVORITES_CONTRACT, FAVORITES_VIEW).revision).toBe(2);
    expect(ctx.db._patched.filter((write: any) => write._id === CONVERSATION)).toHaveLength(1);

    await expect((setFavoriteV2 as any)._handler(ctx, {
      ...args,
      is_favorite: false,
    })).rejects.toThrow("already bound to different intent");
    expect(ctx.db._tables.conversations[0].is_favorite).toBe(true);
  });

  test("missing and foreign conversations reject durably without a view advance", async () => {
    const missingCtx = context(OWNER);
    const missing = await (setFavoriteV2 as any)._handler(missingCtx, {
      command_id: "favorite-missing",
      conversation_id: CONVERSATION,
      is_favorite: true,
    });
    expect(missing).toMatchObject({
      status: "rejected",
      rejection: { code: "MISSING" },
      coverage: [],
    });
    expect(missingCtx.db._tables.local_command_receipts).toHaveLength(1);
    expect(missingCtx.db._tables.local_view_heads).toHaveLength(0);

    const foreignCtx = context(OWNER, {
      conversations: [conversation(CONVERSATION, OTHER)],
    });
    const forbidden = await (setFavoriteV2 as any)._handler(foreignCtx, {
      command_id: "favorite-foreign",
      conversation_id: CONVERSATION,
      is_favorite: true,
    });
    expect(forbidden).toMatchObject({
      status: "rejected",
      rejection: { code: "FORBIDDEN" },
      coverage: [],
    });
    expect(foreignCtx.db._tables.conversations[0].is_favorite).toBeUndefined();
  });

  test("legacy and generic-dispatch writes share the owner-derived revision choke", async () => {
    const legacyCtx = context(OWNER, {
      conversations: [conversation(CONVERSATION, OWNER, { is_favorite: false })],
    });
    expect(await (toggleFavorite as any)._handler(legacyCtx, {
      conversation_id: CONVERSATION,
    })).toBe(true);
    expect(head(legacyCtx, FAVORITES_CONTRACT, FAVORITES_VIEW).revision).toBe(1);

    const dispatchCtx = context(OWNER, {
      conversations: [conversation(CONVERSATION, OWNER, { is_favorite: false })],
    });
    await applyPatches(dispatchCtx, OWNER, {
      conversations: { [CONVERSATION]: { is_favorite: true } },
    });
    expect(dispatchCtx.db._tables.conversations[0].is_favorite).toBe(true);
    expect(head(dispatchCtx, FAVORITES_CONTRACT, FAVORITES_VIEW).revision).toBe(1);

    const secondaryCtx = context(MEMBER, {
      conversations: [conversation(CONVERSATION, OWNER, {
        is_favorite: false,
        owner_user_id: MEMBER,
      })],
    });
    await applyPatches(secondaryCtx, MEMBER, {
      conversations: { [CONVERSATION]: { is_favorite: true } },
    });
    expect(secondaryCtx.db._tables.conversations[0].is_favorite).toBe(false);
    expect(secondaryCtx.db._tables.local_view_heads).toHaveLength(0);
  });

  test("v1 favorites retain their enriched historical shape", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation(CONVERSATION, OWNER, { is_favorite: true })],
    });
    expect(await (listFavorites as any)._handler(ctx, {})).toEqual([{
      _id: CONVERSATION,
      title: `Title ${CONVERSATION}`,
      session_id: `session-${CONVERSATION}`,
      updated_at: 10,
      message_count: 1,
      agent_type: "claude_code",
      is_favorite: true,
    }]);
  });
});

describe("bookmark desired-state commands and containment", () => {
  test("create, replay, no-op, and delete advance exactly once per new command", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      messages: [message()],
    });
    const createArgs = {
      command_id: "bookmark-create",
      conversation_id: CONVERSATION,
      message_id: MESSAGE,
      bookmarked: true,
    };
    const created = await (setBookmarkV2 as any)._handler(ctx, createArgs);
    const replay = await (setBookmarkV2 as any)._handler(ctx, createArgs);
    expect(replay).toEqual(created);
    expect(created).toMatchObject({
      commandName: "bookmarks.set/v2",
      status: "acknowledged",
      result: {
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        bookmarked: true,
      },
      coverage: [{
        contractId: BOOKMARKS_CONTRACT,
        viewKey: BOOKMARKS_VIEW,
        revision: 1,
      }],
    });
    expect(ctx.db._tables.bookmarks).toHaveLength(1);
    expect(ctx.db._tables.local_command_receipts).toHaveLength(1);
    expect(head(ctx, BOOKMARKS_CONTRACT, BOOKMARKS_VIEW).revision).toBe(1);

    const noOp = await (setBookmarkV2 as any)._handler(ctx, {
      ...createArgs,
      command_id: "bookmark-already-created",
    });
    expect(noOp).toMatchObject({ status: "acknowledged", coverage: [{ revision: 2 }] });
    expect(ctx.db._tables.bookmarks).toHaveLength(1);

    const removed = await (setBookmarkV2 as any)._handler(ctx, {
      ...createArgs,
      command_id: "bookmark-remove",
      bookmarked: false,
    });
    expect(removed).toMatchObject({
      status: "acknowledged",
      result: { bookmarked: false },
      coverage: [{ revision: 3 }],
    });
    expect(ctx.db._tables.bookmarks).toHaveLength(0);

    const removeNoOp = await (setBookmarkV2 as any)._handler(ctx, {
      ...createArgs,
      command_id: "bookmark-already-removed",
      bookmarked: false,
    });
    expect(removeNoOp).toMatchObject({ status: "acknowledged", coverage: [{ revision: 4 }] });
    expect(head(ctx, BOOKMARKS_CONTRACT, BOOKMARKS_VIEW).revision).toBe(4);

    await expect((setBookmarkV2 as any)._handler(ctx, {
      ...createArgs,
      bookmarked: false,
    })).rejects.toThrow("already bound to different intent");
  });

  test("message/conversation mismatch and poisoned existing rows fail closed", async () => {
    const mismatchCtx = context(OWNER, {
      conversations: [conversation(), conversation(OTHER_CONVERSATION, OWNER)],
      messages: [message(OTHER_MESSAGE, OTHER_CONVERSATION)],
    });
    const mismatch = await (setBookmarkV2 as any)._handler(mismatchCtx, {
      command_id: "bookmark-wrong-conversation",
      conversation_id: CONVERSATION,
      message_id: OTHER_MESSAGE,
      bookmarked: true,
    });
    expect(mismatch).toMatchObject({
      status: "rejected",
      rejection: { code: "INVALID_RELATION" },
      coverage: [],
    });
    expect(mismatchCtx.db._tables.bookmarks).toHaveLength(0);
    expect(mismatchCtx.db._tables.local_view_heads).toHaveLength(0);

    const poisonCtx = context(OWNER, {
      conversations: [conversation(), conversation(OTHER_CONVERSATION, OWNER)],
      messages: [message()],
      bookmarks: [{
        _id: "bookmark-poison",
        user_id: OWNER,
        conversation_id: OTHER_CONVERSATION,
        message_id: MESSAGE,
        created_at: 1,
      }],
    });
    const poisoned = await (setBookmarkV2 as any)._handler(poisonCtx, {
      command_id: "bookmark-poisoned-row",
      conversation_id: CONVERSATION,
      message_id: MESSAGE,
      bookmarked: false,
    });
    expect(poisoned).toMatchObject({
      status: "rejected",
      rejection: { code: "INVALID_RELATION" },
      coverage: [],
    });
    expect(poisonCtx.db._tables.bookmarks).toHaveLength(1);

    await expect((toggleBookmark as any)._handler(mismatchCtx, {
      conversation_id: CONVERSATION,
      message_id: OTHER_MESSAGE,
    })).rejects.toThrow("does not belong to the conversation");
  });

  test("missing and foreign targets produce durable terminal receipts", async () => {
    const missingCtx = context(OWNER);
    const missing = await (setBookmarkV2 as any)._handler(missingCtx, {
      command_id: "bookmark-missing",
      conversation_id: CONVERSATION,
      message_id: MESSAGE,
      bookmarked: true,
    });
    expect(missing).toMatchObject({
      status: "rejected",
      rejection: { code: "MISSING" },
      coverage: [],
    });
    expect(missingCtx.db._tables.local_command_receipts).toHaveLength(1);

    const foreignCtx = context(OWNER, {
      conversations: [conversation(CONVERSATION, OTHER)],
      messages: [message()],
    });
    const forbidden = await (setBookmarkV2 as any)._handler(foreignCtx, {
      command_id: "bookmark-foreign",
      conversation_id: CONVERSATION,
      message_id: MESSAGE,
      bookmarked: true,
    });
    expect(forbidden).toMatchObject({
      status: "rejected",
      rejection: { code: "FORBIDDEN" },
      coverage: [],
    });
    expect(foreignCtx.db._tables.bookmarks).toHaveLength(0);
  });

  test("v1 bookmark enrichment remains unchanged", async () => {
    const ctx = context(OWNER, {
      conversations: [conversation()],
      messages: [message(MESSAGE, CONVERSATION, { content: "[Image: x] hello" })],
      bookmarks: [{
        _id: "bookmark-v1",
        user_id: OWNER,
        conversation_id: CONVERSATION,
        message_id: MESSAGE,
        name: "Named",
        created_at: 1,
      }],
    });
    expect(await (listBookmarks as any)._handler(ctx, {})).toEqual([{
      _id: "bookmark-v1",
      conversation_id: CONVERSATION,
      message_id: MESSAGE,
      created_at: 1,
      name: "Named",
      note: null,
      conversation_title: `Title ${CONVERSATION}`,
      conversation_updated_at: 10,
      conversation_message_count: 1,
      project_path: undefined,
      git_root: undefined,
      message_preview: "hello",
      message_role: "user",
      message_timestamp: 1,
    }]);
  });
});

describe("central small-view revision interceptor", () => {
  test("filters operational user patches but advances stable metadata and preferences", async () => {
    const raw = makeFakeDb({
      users: [user(OWNER, { name: "Before", daemon_last_seen: 1 })],
      user_skills: [{
        _id: "skills-owner",
        user_id: OWNER,
        skills_json: "before",
        updated_at: 1,
      }],
      teams: [],
      team_memberships: [],
      conversations: [],
      local_view_heads: [],
    });
    const db = makePrincipalViewTrackedDb(raw);
    await db.patch(OWNER, { daemon_last_seen: 2, last_heartbeat: 2 });
    expect(raw._tables.local_view_heads).toHaveLength(0);

    await db.patch(OWNER, { name: "After" });
    expect(raw._tables.local_view_heads[0]).toMatchObject({
      principal_id: OWNER,
      contract_id: CURRENT_CONTRACT,
      view_key: CURRENT_VIEW,
      revision: 1,
    });
    await db.patch("skills-owner", { skills_json: "after", updated_at: 2 });
    expect(raw._tables.local_view_heads[0].revision).toBe(1);

    await db.patch(OWNER, {
      agent_permission_modes: { codex: "full-access" },
    });
    expect(raw._tables.local_view_heads[0].revision).toBe(2);
  });

  test("team and membership transitions fan out only server-derived view domains", async () => {
    const raw = makeFakeDb({
      users: [user(OWNER), user(MEMBER), user(OTHER)],
      user_skills: [],
      teams: [team()],
      team_memberships: [
        membership("membership-owner", OWNER),
        membership("membership-member", MEMBER),
      ],
      conversations: [],
      local_view_heads: [],
    });
    const db = makePrincipalViewTrackedDb(raw);

    // Invite rotation is outside the local catalog projection.
    await db.patch(TEAM, { invite_code: "ROTATED" });
    expect(raw._tables.local_view_heads).toHaveLength(0);

    await db.patch(TEAM, { icon: "star" });
    expect(head({ db: raw }, TEAMS_CONTRACT, TEAMS_VIEW, OWNER)?.revision).toBe(1);
    expect(head({ db: raw }, TEAMS_CONTRACT, TEAMS_VIEW, MEMBER)?.revision).toBe(1);
    expect(head({ db: raw }, TEAMS_CONTRACT, TEAMS_VIEW, OTHER)).toBeUndefined();

    await db.insert("team_memberships", {
      user_id: OTHER,
      team_id: TEAM,
      role: "member",
      joined_at: 3,
    });
    expect(head({ db: raw }, TEAMS_CONTRACT, TEAMS_VIEW, OTHER)?.revision).toBe(1);
    for (const principal of [OWNER, MEMBER, OTHER]) {
      expect(head({ db: raw }, MEMBERS_CONTRACT, MEMBERS_VIEW, principal)?.revision).toBe(1);
    }

    await db.delete("membership-member");
    expect(head({ db: raw }, TEAMS_CONTRACT, TEAMS_VIEW, MEMBER)?.revision).toBe(2);
    expect(head({ db: raw }, MEMBERS_CONTRACT, MEMBERS_VIEW, MEMBER)?.revision).toBe(2);
    expect(head({ db: raw }, MEMBERS_CONTRACT, MEMBERS_VIEW, OWNER)?.revision).toBe(2);
    expect(head({ db: raw }, MEMBERS_CONTRACT, MEMBERS_VIEW, OTHER)?.revision).toBe(2);
  });

  test("favorite insert, replace, and delete membership transitions are covered", async () => {
    const raw = makeFakeDb({
      users: [user(OWNER)],
      user_skills: [],
      teams: [],
      team_memberships: [],
      conversations: [],
      local_view_heads: [],
    });
    const db = makePrincipalViewTrackedDb(raw);
    const { _id: _discardedInsertId, ...insertValue } = conversation("conversation-new", OWNER, {
      is_favorite: true,
    });
    const id = await db.insert("conversations", insertValue);
    expect(head({ db: raw }, FAVORITES_CONTRACT, FAVORITES_VIEW)?.revision).toBe(1);

    const { _id: _discardedReplaceId, ...renamedValue } = conversation(id, OWNER, {
      is_favorite: true,
      title: "renamed",
    });
    await db.replace(id, renamedValue);
    expect(head({ db: raw }, FAVORITES_CONTRACT, FAVORITES_VIEW)?.revision).toBe(1);

    const { _id: _discardedOffId, ...offValue } = conversation(id, OWNER, { is_favorite: false });
    await db.replace(id, offValue);
    expect(head({ db: raw }, FAVORITES_CONTRACT, FAVORITES_VIEW)?.revision).toBe(2);

    const { _id: _discardedOnId, ...onValue } = conversation(id, OWNER, { is_favorite: true });
    await db.replace(id, onValue);
    await db.delete(id);
    expect(head({ db: raw }, FAVORITES_CONTRACT, FAVORITES_VIEW)?.revision).toBe(4);
  });

  test("moving a favorite conversation advances both principal relations", async () => {
    const raw = makeFakeDb({
      users: [user(OWNER), user(OTHER)],
      user_skills: [],
      teams: [],
      team_memberships: [],
      conversations: [conversation(CONVERSATION, OWNER, { is_favorite: true })],
      local_view_heads: [],
    });
    const db = makePrincipalViewTrackedDb(raw);
    await db.patch(CONVERSATION, { user_id: OTHER });
    expect(head({ db: raw }, FAVORITES_CONTRACT, FAVORITES_VIEW, OWNER)?.revision).toBe(1);
    expect(head({ db: raw }, FAVORITES_CONTRACT, FAVORITES_VIEW, OTHER)?.revision).toBe(1);
  });
});
