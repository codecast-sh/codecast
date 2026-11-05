// A profile feed shows only what the viewer may read. The task, doc and team
// activity overlay used to filter by the team_id argument alone, so anyone
// signed in could read the titles of another person's personal tasks and docs
// by passing their user id (found by the replay judge, 2026-11-05).
import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { getUserProfileFeed } from "./users";

const OWNER = "u_owner" as any;
const MEMBER = "u_member" as any;
const STRANGER = "u_stranger" as any;
const TEAM = "t_team" as any;
const OTHER_TEAM = "t_other" as any;

function tables(): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, _creationTime: 1, name: "Owner" },
      { _id: MEMBER, _creationTime: 2, name: "Member" },
      { _id: STRANGER, _creationTime: 3, name: "Stranger" },
    ],
    teams: [
      { _id: TEAM, _creationTime: 4, name: "Team" },
      { _id: OTHER_TEAM, _creationTime: 4, name: "Other" },
    ],
    team_memberships: [
      { _id: "m_owner", _creationTime: 5, user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "m_member", _creationTime: 6, user_id: MEMBER, team_id: TEAM, role: "member" },
      { _id: "m_owner2", _creationTime: 6, user_id: OWNER, team_id: OTHER_TEAM, role: "member" },
    ],
    conversations: [],
    messages: [],
    tasks: [
      { _id: "task_personal", _creationTime: 10, user_id: OWNER, title: "Personal task", status: "open", workspace: `user:${OWNER}`, created_at: 10, updated_at: 10 },
      { _id: "task_team", _creationTime: 11, user_id: OWNER, team_id: TEAM, title: "Team task", status: "open", workspace: `team:${TEAM}`, created_at: 11, updated_at: 11 },
    ],
    docs: [
      { _id: "doc_personal", _creationTime: 12, user_id: OWNER, title: "Personal doc", workspace: `user:${OWNER}`, created_at: 12, updated_at: 12 },
      { _id: "doc_team", _creationTime: 13, user_id: OWNER, team_id: TEAM, title: "Team doc", workspace: `team:${TEAM}`, created_at: 13, updated_at: 13 },
    ],
    team_activity_events: [
      { _id: "ev_team", _creationTime: 14, actor_user_id: OWNER, team_id: TEAM, event_type: "commit_pushed", title: "Team commit", timestamp: 14 },
      { _id: "ev_other", _creationTime: 15, actor_user_id: OWNER, team_id: OTHER_TEAM, event_type: "commit_pushed", title: "Other team commit", timestamp: 15 },
    ],
  };
}

function ctx(userId: string) {
  return {
    auth: { async getUserIdentity() { return { subject: `${userId}|session` }; } },
    db: makeFakeDb(tables(), { indexes: schemaIndexes(schema as any) }),
  } as any;
}

async function titles(viewer: string, args: Record<string, any> = {}): Promise<string[]> {
  const res = await (getUserProfileFeed as any)._handler(ctx(viewer), { user_id: OWNER, paginationOpts: { numItems: 30, cursor: null }, ...args });
  return res.page.map((i: any) => i.entity_title ?? i.preview).sort();
}

describe("profile feed access", () => {
  test("a stranger reads none of the owner's tasks, docs or team activity", async () => {
    const seen = await titles(STRANGER);
    expect(seen.filter((t) => /task|doc|commit/i.test(t))).toEqual([]);
  });

  test("a teammate reads the team's rows, never the owner's personal ones or another team's", async () => {
    const seen = await titles(MEMBER);
    expect(seen).not.toContain("Personal task");
    expect(seen).not.toContain("Personal doc");
    expect(seen).not.toContain("Other team commit");
    expect(seen).toContain("Team task");
    expect(seen).toContain("Team doc");
  });

  test("the owner reads all of their own rows", async () => {
    const seen = await titles(OWNER);
    for (const t of ["Personal task", "Personal doc", "Team task", "Team doc"]) expect(seen).toContain(t);
  });
});
