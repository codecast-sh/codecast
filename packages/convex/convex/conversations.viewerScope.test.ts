import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  getConversationPublic,
  getConversationWithMeta,
  getTeamUnreadCount,
  listConversations,
  searchConversationTitles,
} from "./conversations";
import { getCurrentUser } from "./users";

// What a conversation read hands a viewer is decided by who the viewer is,
// never by an id the caller names: a team id they do not belong to, a fork
// whose parent they cannot open, a share link that is not a seat on the team.

const VICTIM = "users_victim" as any;
const MATE = "users_mate" as any;
const OUTSIDER = "users_outsider" as any;
const VTEAM = "teams_victim" as any;
const OTEAM = "teams_outsider" as any;

function fixture() {
  return makeFakeDb({
    users: [
      {
        _id: VICTIM, name: "", email: "victim.person@corp.test", team_id: VTEAM, active_team_id: VTEAM,
        github_access_token: "gho_secret", encryption_master_key: "mk", push_token: "pt", voip_push_token: "vpt", email_unsub_token: "ut",
      },
      { _id: MATE, name: "Mate", email: "mate@corp.test", team_id: VTEAM, active_team_id: VTEAM },
      { _id: OUTSIDER, name: "Out", email: "out@x.test", team_id: OTEAM, active_team_id: OTEAM },
    ],
    teams: [{ _id: VTEAM, name: "Victim Co" }, { _id: OTEAM, name: "Outsider Co" }],
    team_memberships: [
      { _id: "tm_v", team_id: VTEAM, user_id: VICTIM, role: "admin", visibility: "full" },
      { _id: "tm_m", team_id: VTEAM, user_id: MATE, role: "member", visibility: "full" },
      { _id: "tm_o", team_id: OTEAM, user_id: OUTSIDER, role: "admin", visibility: "full" },
    ],
    conversations: [
      {
        _id: "shared", user_id: VICTIM, team_id: VTEAM, is_private: false, title: "prod database rotation",
        session_id: "s-shared", agent_type: "claude_code", status: "active", started_at: 1, updated_at: 10, message_count: 2,
        share_token: "tok-shared", owner_device_id: "dev-victim", cc_account: "victim@corp.test", draft_message: "unsent",
        git_remote_url: "https://victim:ghp_abc@github.com/corp/app.git", git_branch: "main", project_path: "/Users/victim/app",
      },
      // A private parent with a link of its own, and a fork of it the mate can open.
      { _id: "parent", user_id: VICTIM, is_private: true, title: "Private parent", share_token: "tok-parent", session_id: "s-p", agent_type: "claude_code", status: "active", started_at: 1, updated_at: 1, message_count: 1 },
      { _id: "fork", user_id: VICTIM, team_id: VTEAM, is_private: false, forked_from: "parent", title: "Fork", session_id: "s-f", agent_type: "claude_code", status: "active", started_at: 2, updated_at: 2, message_count: 1 },
    ],
    messages: [],
  });
}

const ctx = (db: any, user: string | null) => ({
  db,
  auth: { getUserIdentity: async () => (user ? { subject: `${user}|session` } : null) },
  scheduler: { runAfter: async () => null },
});
const run = (fn: any, c: any, args: any) => fn._handler(c, args);

describe("a team id the caller does not belong to scopes to nothing", () => {
  test("listConversations team feed", async () => {
    const db = fixture();
    const stranger = await run(listConversations, ctx(db, OUTSIDER), { filter: "team", activeTeamId: VTEAM });
    expect(stranger.conversations).toEqual([]);
    const mate = await run(listConversations, ctx(db, MATE), { filter: "team", activeTeamId: VTEAM });
    expect(mate.conversations.map((c: any) => c.title)).toContain("prod database rotation");
  });

  test("searchConversationTitles", async () => {
    const db = fixture();
    const stranger = await run(searchConversationTitles, ctx(db, OUTSIDER), { query: "rotation", activeTeamId: VTEAM });
    expect(stranger.results).toEqual([]);
    const mate = await run(searchConversationTitles, ctx(db, MATE), { query: "rotation", activeTeamId: VTEAM });
    expect(mate.results.length).toBe(1);
  });

  test("getTeamUnreadCount", async () => {
    const db = fixture();
    expect(await run(getTeamUnreadCount, ctx(db, OUTSIDER), { teamId: VTEAM })).toBe(0);
    expect(await run(getTeamUnreadCount, ctx(db, MATE), { teamId: VTEAM })).toBeGreaterThan(0);
  });
});

describe("a fork names its parent's share link only to who can open the parent", () => {
  test("a teammate on the fork gets no parent token; the owner does", async () => {
    const db = fixture();
    const mate = await run(getConversationWithMeta, ctx(db, MATE), { conversation_id: "fork" });
    expect(mate.forked_from_details.title).toBe("Private parent");
    expect(mate.forked_from_details.share_token).toBeUndefined();
    const owner = await run(getConversationWithMeta, ctx(db, VICTIM), { conversation_id: "fork" });
    expect(owner.forked_from_details.share_token).toBe("tok-parent");
  });
});

describe("a share-link viewer gets the transcript, not the owner's setup", () => {
  for (const [name, fn] of [["getConversationPublic", getConversationPublic], ["getConversationWithMeta", getConversationWithMeta]] as const) {
    test(name, async () => {
      const db = fixture();
      const r = await run(fn, ctx(db, null), { conversation_id: "shared", share_token: "tok-shared" });
      const conv = r.conversation ?? r;
      expect(conv.access_level ?? r.access_level).toBe("shared");
      // What the share view draws stays.
      expect(conv.title).toBe("prod database rotation");
      expect(conv.git_branch).toBe("main");
      expect(conv.project_path).toBe("/Users/victim/app");
      // The name the UI would have drawn from the email, without the email.
      expect(conv.user).toEqual({ name: "victim.person", avatar_url: null });
      for (const k of ["team_id", "owner_device_id", "cc_account", "draft_message"]) expect(conv[k]).toBeUndefined();
      expect(conv.git_remote_url).toBe("https://github.com/corp/app.git");

      const mate = await run(fn, ctx(db, MATE), { conversation_id: "shared" });
      const mconv = mate.conversation ?? mate;
      expect(mconv.user.email).toBe("victim.person@corp.test");
      expect(mconv.owner_device_id).toBe("dev-victim");
    });
  }
});

describe("getCurrentUser carries no credentials", () => {
  test("tokens and keys stay on the server", async () => {
    const db = fixture();
    const me = await run(getCurrentUser, ctx(db, VICTIM), {});
    expect(me.email).toBe("victim.person@corp.test");
    for (const k of ["github_access_token", "encryption_master_key", "push_token", "voip_push_token", "email_unsub_token"]) {
      expect(me[k]).toBeUndefined();
    }
  });
});
