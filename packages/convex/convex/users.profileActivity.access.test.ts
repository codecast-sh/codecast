// Profile-surface access:
//  - getUserTasks / getUserDocs returned ALL of a target user's rows after only
//    a hide_activity check. A task/doc is visible to its owner or a member of
//    its EFFECTIVE team (canAccessTask/canAccessDoc); a row linked to a private
//    session is effectively personal.
//  - getUserActivity is a PUBLIC (unauthed) query. is_private=false means
//    TEAM-visible, not WORLD-visible; the world tier is the pinned-and-shared
//    set only (profilePublicSessionVisible), matching getPublicPinnedSessions.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getUserTasks, getUserDocs, getUserActivity } from "./users";

const OWNER = "u_owner";
const MEMBER = "u_member";
const STRANGER = "u_stranger";
const TEAM = "t_team";
const OTHER_TEAM = "t_other";

function base(): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, name: "Owner", public_profile_enabled: true },
      { _id: MEMBER, name: "Member" },
      { _id: STRANGER, name: "Stranger" },
    ],
    teams: [{ _id: TEAM, name: "Team" }, { _id: OTHER_TEAM, name: "Other" }],
    team_memberships: [
      { _id: "m_owner", user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "m_member", user_id: MEMBER, team_id: TEAM, role: "member" },
    ],
    conversations: [
      { _id: "conv_private", user_id: OWNER, team_id: TEAM, is_private: true },
    ],
    tasks: [
      { _id: "task_team", user_id: OWNER, team_id: TEAM, title: "Team task", status: "open" },
      // Team-tagged but linked to a private conversation → effectively personal.
      {
        _id: "task_private",
        user_id: OWNER,
        team_id: TEAM,
        conversation_id: "conv_private",
        title: "Private task",
        status: "open",
      },
      { _id: "task_personal", user_id: OWNER, title: "Personal task", status: "open" },
    ],
    docs: [
      { _id: "doc_team", user_id: OWNER, team_id: TEAM, title: "Team doc" },
      {
        _id: "doc_private",
        user_id: OWNER,
        team_id: TEAM,
        conversation_id: "conv_private",
        title: "Private doc",
      },
      { _id: "doc_personal", user_id: OWNER, title: "Personal doc" },
    ],
  };
}

function ctx(userId: string | null, t: Record<string, any[]>) {
  return {
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
    db: makeFakeDb(t),
  } as any;
}

describe("getUserTasks visibility", () => {
  const tasks = (uid: string | null) =>
    (getUserTasks as any)._handler(ctx(uid, base()), { user_id: OWNER });

  test("owner sees all their tasks", async () => {
    const ids = (await tasks(OWNER)).map((t: any) => t._id).sort();
    expect(ids).toEqual(["task_personal", "task_private", "task_team"]);
  });

  test("a teammate sees only genuinely team-visible tasks", async () => {
    // canAccessTask resolves the row's workspace key (effective team from the
    // linked conversation), so a task linked to a PRIVATE conversation is
    // owner-only even when team-tagged, and the owner's personal task is hidden.
    const ids = (await tasks(MEMBER)).map((t: any) => t._id).sort();
    expect(ids).toEqual(["task_team"]);
  });

  test("a stranger sees nothing", async () => {
    expect(await tasks(STRANGER)).toEqual([]);
  });
});

describe("getUserDocs visibility", () => {
  const docs = (uid: string | null) =>
    (getUserDocs as any)._handler(ctx(uid, base()), { user_id: OWNER });

  test("owner sees all their docs", async () => {
    const ids = (await docs(OWNER)).map((d: any) => d._id).sort();
    expect(ids).toEqual(["doc_personal", "doc_private", "doc_team"]);
  });

  test("a teammate sees only the team doc", async () => {
    const ids = (await docs(MEMBER)).map((d: any) => d._id);
    expect(ids).toEqual(["doc_team"]);
  });

  test("a stranger sees nothing", async () => {
    expect(await docs(STRANGER)).toEqual([]);
  });
});

describe("getUserActivity world tier", () => {
  function activityTables(): Record<string, any[]> {
    const t = base();
    t.conversations = [
      // Team-visible but NOT pinned to the public profile → must stay hidden.
      { _id: "c_team", user_id: OWNER, team_id: TEAM, is_private: false, title: "Team only" },
      // Pinned AND share-token backed → the genuine world tier.
      {
        _id: "c_public",
        user_id: OWNER,
        team_id: TEAM,
        is_private: false,
        title: "Public",
        profile_pinned_at: 100,
        share_token: "tok",
        git_root: "/Users/x/secretrepo",
      },
    ];
    return t;
  }

  test("returns only pinned+shared sessions, never merely team-visible ones", async () => {
    const rows = await (getUserActivity as any)._handler(ctx(null, activityTables()), { user_id: OWNER });
    expect(rows.map((r: any) => r.title)).toEqual(["Public"]);
  });

  test("never leaks the full project path — only the basename", async () => {
    const rows = await (getUserActivity as any)._handler(ctx(null, activityTables()), { user_id: OWNER });
    expect(rows[0].repo).toBe("secretrepo");
    expect(JSON.stringify(rows[0])).not.toContain("/Users/x");
  });

  test("public_profile_enabled off → nothing", async () => {
    const t = activityTables();
    t.users = t.users.map((u) => (u._id === OWNER ? { ...u, public_profile_enabled: false } : u));
    const rows = await (getUserActivity as any)._handler(ctx(null, t), { user_id: OWNER });
    expect(rows).toEqual([]);
  });
});
