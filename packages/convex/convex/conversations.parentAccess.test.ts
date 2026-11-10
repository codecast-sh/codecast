import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import {
  createConversation,
  debugConversationVisibility,
  getConversationTree,
  linkPlanHandoff,
  setParentConversation,
} from "./conversations";

// A conversation id is not a grant. These paths took one from the caller and
// linked to it, dismissed it, or described it without asking whose it was.

const ME = "users_me" as any;
const THEM = "users_them" as any;
const TEAM = "teams_one" as any;
const TOKEN = "tok-me";

async function fixture() {
  return makeFakeDb({
    users: [{ _id: ME, team_id: TEAM, email: "me@x.test" }, { _id: THEM, team_id: TEAM, email: "them@x.test" }],
    team_memberships: [
      { _id: "tm_1", team_id: TEAM, user_id: ME, role: "member", visibility: "full" },
      { _id: "tm_2", team_id: TEAM, user_id: THEM, role: "member", visibility: "full" },
    ],
    teams: [{ _id: TEAM, name: "One" }],
    api_tokens: [{ _id: "at_me", user_id: ME, token_hash: await hashToken(TOKEN), last_used_at: Date.now() }],
    conversations: [
      { _id: "mine", user_id: ME, session_id: "s-mine", is_private: true, title: "Mine", status: "active", started_at: 1, updated_at: 1, message_count: 0 },
      { _id: "mine_child", user_id: ME, session_id: "s-child", is_private: true, title: "Child", status: "active", started_at: 1, updated_at: 1, message_count: 0 },
      { _id: "theirs", user_id: THEM, session_id: "s-theirs", is_private: true, title: "Their secret", status: "active", started_at: 1, updated_at: 1, message_count: 3, project_path: "/Users/them/secret" },
      // A shared root with one shared fork (mine) and one private fork (theirs).
      { _id: "root", user_id: THEM, team_id: TEAM, is_private: false, title: "Shared root", status: "active", started_at: 1, updated_at: 1, message_count: 1 },
      { _id: "fork_mine", user_id: ME, team_id: TEAM, is_private: false, forked_from: "root", title: "My fork", status: "active", started_at: 2, updated_at: 2, message_count: 1 },
      { _id: "fork_private", user_id: THEM, team_id: TEAM, is_private: true, forked_from: "root", title: "Their private fork", status: "active", started_at: 3, updated_at: 3, message_count: 1 },
      // A private root of theirs with a shared fork I can open.
      { _id: "root_private", user_id: THEM, team_id: TEAM, is_private: true, title: "Their private root", status: "active", started_at: 1, updated_at: 1, message_count: 1 },
      { _id: "fork_shared", user_id: THEM, team_id: TEAM, is_private: false, forked_from: "root_private", title: "Shared fork", status: "active", started_at: 2, updated_at: 2, message_count: 1 },
    ],
    messages: [],
    session_owners: [],
    directory_team_mappings: [],
    rate_limits: [],
    devices: [],
    deleted_sessions: [],
  });
}
const ctx = (db: any, user: string | null = ME) => ({
  db,
  auth: { getUserIdentity: async () => (user ? { subject: `${user}|session` } : null) },
  scheduler: { runAfter: async () => null },
});
const run = (fn: any, c: any, args: any) => fn._handler(c, args);
const flat = (node: any): string[] => [node.title, ...node.children.flatMap(flat)];

describe("getConversationTree judges every node", () => {
  test("a private fork of a shared root is left out", async () => {
    const db = await fixture();
    const r = await run(getConversationTree, ctx(db), { conversation_id: "fork_mine" });
    expect(flat(r.tree).sort()).toEqual(["My fork", "Shared root"]);
    // Its owner still sees it.
    const theirs = await run(getConversationTree, ctx(db, THEM), { conversation_id: "root" });
    expect(flat(theirs.tree).sort()).toEqual(["My fork", "Shared root", "Their private fork"]);
  });

  test("the walk up stops below an ancestor the caller cannot open", async () => {
    const db = await fixture();
    const r = await run(getConversationTree, ctx(db), { conversation_id: "fork_shared" });
    expect(flat(r.tree)).toEqual(["Shared fork"]);
  });
});

describe("parent links need an owned parent", () => {
  test("linkPlanHandoff and setParentConversation refuse someone else's conversation", async () => {
    const db = await fixture();
    await expect(run(linkPlanHandoff, ctx(db), { parent_conversation_id: "theirs", child_conversation_id: "mine_child" })).rejects.toThrow("Parent not found");
    await expect(run(setParentConversation, ctx(db), { conversation_id: "mine_child", parent_conversation_id: "theirs", api_token: TOKEN })).rejects.toThrow("Not found");
    expect((await db.get("mine_child")).parent_conversation_id).toBeUndefined();
  });

  test("the caller's own parent links", async () => {
    const db = await fixture();
    await run(linkPlanHandoff, ctx(db), { parent_conversation_id: "mine", child_conversation_id: "mine_child" });
    expect(await db.get("mine_child")).toMatchObject({ parent_conversation_id: "mine", parent_message_uuid: "plan-handoff" });
    const db2 = await fixture();
    await run(setParentConversation, ctx(db2), { conversation_id: "mine_child", parent_conversation_id: "mine", api_token: TOKEN });
    expect((await db2.get("mine_child")).parent_conversation_id).toBe("mine");
  });

  test("createConversation cannot dismiss or nest under someone else's conversation by naming it", async () => {
    const db = await fixture();
    const id = await run(createConversation, ctx(db), {
      user_id: ME, agent_type: "claude_code", session_id: "s-new", api_token: TOKEN,
      parent_conversation_id: "theirs", parent_message_uuid: "plan-handoff",
    });
    const theirs = await db.get("theirs");
    expect(theirs.status).toBe("active");
    expect(theirs.inbox_dismissed_at).toBeUndefined();
    expect((await db.get(id)).parent_conversation_id).toBeUndefined();
  });

  test("createConversation's plan handoff still completes the caller's own session", async () => {
    const db = await fixture();
    const id = await run(createConversation, ctx(db), {
      user_id: ME, agent_type: "claude_code", session_id: "s-new", api_token: TOKEN,
      parent_conversation_id: "mine", parent_message_uuid: "plan-handoff",
    });
    expect(await db.get("mine")).toMatchObject({ status: "completed" });
    expect((await db.get(id)).parent_conversation_id).toBe("mine");
  });
});

describe("debugConversationVisibility", () => {
  test("answers the owner and staff, nobody else", async () => {
    const db = await fixture();
    expect(await run(debugConversationVisibility, ctx(db), { conversation_id: "theirs" })).toEqual({ error: "Conversation not found" });
    const own = await run(debugConversationVisibility, ctx(db, THEM), { conversation_id: "theirs" });
    expect(own.convOwner.email).toBe("them@x.test");
    db._tables.users.find((u: any) => u._id === ME).staff = true;
    const staff = await run(debugConversationVisibility, ctx(db), { conversation_id: "theirs" });
    expect(staff.convOwner.email).toBe("them@x.test");
  });
});
