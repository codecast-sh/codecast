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

// The message half reads the per-send log, so what a program queued in the
// person's name (a restart notice, a trigger brief) never shows as typed, and
// every page of "load more" holds the next sends instead of the next sessions.
describe("profile feed messages", () => {
  function sendTables(): Record<string, any[]> {
    const t = tables();
    t.conversations = [
      { _id: "c_team", _creationTime: 20, user_id: OWNER, team_id: TEAM, is_private: false, team_visibility: "full", title: "Team session", message_count: 3, started_at: 20, updated_at: 30 },
      { _id: "c_private", _creationTime: 21, user_id: OWNER, team_id: TEAM, is_private: true, title: "Private session", message_count: 1, started_at: 21, updated_at: 31 },
    ];
    t.messages = [
      { _id: "m_restart", _creationTime: 40, conversation_id: "c_team", role: "user", timestamp: 40, content: "Your agent process exited while this work was still in progress, and codecast restarted the session." },
    ];
    t.user_sends = Array.from({ length: 5 }, (_, i) => ({
      _id: `s_${i}`, _creationTime: 50 + i, user_id: OWNER, team_id: TEAM, conversation_id: "c_team", message_id: `m_${i}`, timestamp: 50 + i, words: 2, text: `typed ${i}`, clipped: false,
    }));
    t.user_sends.push({ _id: "s_private", _creationTime: 60, user_id: OWNER, team_id: TEAM, conversation_id: "c_private", message_id: "m_p", timestamp: 60, words: 2, text: "private typed", clipped: false });
    return t;
  }
  const run = (viewer: string, paginationOpts: any) =>
    (getUserProfileFeed as any)._handler(
      { auth: ctx(viewer).auth, db: makeFakeDb(sendTables(), { indexes: schemaIndexes(schema as any) }) },
      { user_id: OWNER, team_id: TEAM, paginationOpts },
    );
  const messages = (res: any) => res.page.filter((i: any) => i.type === "message").map((i: any) => i.preview);

  test("shows logged sends only, never a machine message in the transcript", async () => {
    const res = await run(OWNER, { numItems: 10, cursor: null });
    expect(messages(res)).toEqual(["private typed", "typed 4", "typed 3", "typed 2", "typed 1", "typed 0"]);
  });

  test("load more continues through older sends", async () => {
    const first = await run(OWNER, { numItems: 3, cursor: null });
    expect(messages(first)).toEqual(["private typed", "typed 4", "typed 3"]);
    expect(first.isDone).toBe(false);
    const second = await run(OWNER, { numItems: 3, cursor: first.continueCursor });
    expect(messages(second)).toEqual(["typed 2", "typed 1", "typed 0"]);
  });

  test("a teammate never sees a send into a private session", async () => {
    const res = await run(MEMBER, { numItems: 10, cursor: null });
    expect(messages(res)).not.toContain("private typed");
    expect(messages(res)).toContain("typed 4");
  });
});
