import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { inheritedChildPrivacy } from "./privacy";
import { spawnSessionCore } from "./spawn";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./conversations.ts": () => import("./conversations"),
  "./notifications.ts": () => import("./notifications"),
};

const TOKEN = "subagent-privacy-jason";

// jx713dn: Jason's Strategy Advisor (jx702nf) was shared with the team, but the
// worker it spawned in the same unmapped home folder resolved private from its
// path, so teammates saw "Not available to you." on the worker card.
async function sharedParentInUnmappedFolder(parentFields: Record<string, unknown> = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const team = await ctx.db.insert("teams", { name: "union", created_at: now, invite_code: "union" } as any);
    const jason = await ctx.db.insert("users", { name: "Jason", emailVerificationTime: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: jason, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: jason, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const parent = await ctx.db.insert("conversations", {
      user_id: jason, team_id: team, is_private: false, agent_type: "claude_code", session_id: "parent-session",
      project_path: "/Users/jasonbenn", started_at: now, updated_at: now, message_count: 0, status: "active",
      ...parentFields,
    } as any);
    return { team, jason, parent };
  });
  return { t, ids };
}

describe("a worker shares as its parent does", () => {
  test("a daemon-synced subagent of a shared parent is shared with the parent's team", async () => {
    const { t, ids } = await sharedParentInUnmappedFolder();
    const id = await t.mutation(api.conversations.createConversation, {
      user_id: ids.jason, agent_type: "claude_code", session_id: "worker-session",
      project_path: "/Users/jasonbenn", parent_conversation_id: ids.parent, api_token: TOKEN,
    } as any);
    const row: any = await t.run((ctx) => ctx.db.get(id as any));
    expect(row.is_private).toBe(false);
    expect(String(row.team_id)).toBe(String(ids.team));
    expect(row.is_subagent).toBe(true);
  });

  test("a cast spawn --subagent worker of a shared parent is shared with the parent's team", async () => {
    const { t, ids } = await sharedParentInUnmappedFolder();
    const row: any = await t.run(async (ctx) => {
      const { conversationId } = await spawnSessionCore(ctx, ids.jason, {
        projectPath: "/Users/jasonbenn",
        subagentFields: { parent_conversation_id: ids.parent, is_subagent: true },
      });
      return ctx.db.get(conversationId);
    });
    expect(row.is_private).toBe(false);
    expect(String(row.team_id)).toBe(String(ids.team));
  });

  test("a parent locked private keeps its worker locked private", async () => {
    const { t, ids } = await sharedParentInUnmappedFolder({ is_private: true, team_visibility: "private" });
    const id = await t.mutation(api.conversations.createConversation, {
      user_id: ids.jason, agent_type: "claude_code", session_id: "worker-session",
      project_path: "/Users/jasonbenn", parent_conversation_id: ids.parent, api_token: TOKEN,
    } as any);
    const row: any = await t.run((ctx) => ctx.db.get(id as any));
    expect(row.is_private).toBe(true);
    expect(row.team_visibility).toBe("private");
  });
});

describe("inheritedChildPrivacy", () => {
  const owner = "u1" as any;
  const team = "t1" as any;

  test("another owner's parent passes nothing down", () => {
    expect(inheritedChildPrivacy({ user_id: "u2" as any, team_id: team, is_private: false }, owner)).toBeNull();
    expect(inheritedChildPrivacy(null, owner)).toBeNull();
  });

  test("a parent shared with nobody (no team) yields a private worker", () => {
    expect(inheritedChildPrivacy({ user_id: owner, is_private: false }, owner)).toMatchObject({ is_private: true, team_id: undefined });
  });

  test("a private parent on a team keeps the team for routing", () => {
    expect(inheritedChildPrivacy({ user_id: owner, team_id: team, is_private: true }, owner)).toMatchObject({ is_private: true, team_id: team, auto_shared: undefined });
  });
});
