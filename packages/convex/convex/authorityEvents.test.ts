// Audit or deny: an authority change writes its authority_events row in the
// same transaction. These drive the writer and the chokepoints directly on a
// convex-test db and read the table back.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { patchConversationVisibility } from "./lib/access";
import { recordAuthorityEvent } from "./lib/authorityEvents";
import { claimShareToken } from "./publicShare";
import { sha256Hex } from "./lib/hash";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./permissions.ts": () => import("./permissions"),
  "./conversations.ts": () => import("./conversations"),
  "./teams.ts": () => import("./teams"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: 1, created_by: undefined as any } as any);
    const owner = await ctx.db.insert("users", { email: "o@x", name: "Owner", team_id: team } as any);
    const other = await ctx.db.insert("users", { email: "p@x", name: "Other" } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
    const conv = await ctx.db.insert("conversations", {
      session_id: "s1", user_id: owner, team_id: team, is_private: true, title: "x", created_at: 1, updated_at: 1,
    } as any);
    return { team, owner, other, conv };
  });
  const events = () => t.run((ctx) => ctx.db.query("authority_events").collect());
  return { t, ids, events };
}

describe("recordAuthorityEvent", () => {
  test("stamps workspace from the conversation's visibility and hashes the token", async () => {
    const { t, ids, events } = await setup();
    await t.run(async (ctx) => {
      const conv = (await ctx.db.get(ids.conv))!;
      await recordAuthorityEvent(ctx, { kind: "share_link_minted", actor_user_id: ids.owner, conversation: conv, share_token: "tok", share_table: "conversations" });
      await recordAuthorityEvent(ctx, { kind: "share_link_minted", actor_user_id: ids.owner, conversation: { ...conv, is_private: false }, share_token: "tok" });
      await recordAuthorityEvent(ctx, { kind: "team_member_added", actor_user_id: ids.owner, team_id: ids.team, target_user_id: ids.other });
    });
    const rows = await events();
    expect(rows.map((r) => r.workspace)).toEqual([`user:${ids.owner}`, `team:${ids.team}`, `team:${ids.team}`]);
    expect(rows[0].share_token_hash).toBe(await sha256Hex("tok"));
    expect(JSON.stringify(rows)).not.toContain('"tok"');
    expect(rows[0].team_id).toBe(ids.team);
    expect(rows[2].target_user_id).toBe(ids.other);
  });
});

describe("chokepoints write their audit row in the same transaction", () => {
  test("patchConversationVisibility records before and after", async () => {
    const { t, ids, events } = await setup();
    await t.run(async (ctx) => {
      await patchConversationVisibility(ctx, (await ctx.db.get(ids.conv))!, { is_private: false, team_visibility: "full" });
    });
    const [row] = await events();
    expect(row.kind).toBe("conversation_visibility_changed");
    expect(row.actor_user_id).toBe(ids.owner);
    expect(row.conversation_id).toBe(ids.conv);
    expect(row.detail).toEqual({ before: { is_private: true, team_visibility: undefined }, after: { is_private: false, team_visibility: "full" } });
    expect(row.workspace).toBe(`team:${ids.team}`);
  });

  test("a permission answered records the decision", async () => {
    const { t, ids, events } = await setup();
    const { api } = await import("./_generated/api");
    const asOwner = t.withIdentity({ subject: `${ids.owner}|x` } as any);
    const permission = await t.run((ctx) =>
      ctx.db.insert("pending_permissions", {
        conversation_id: ids.conv, session_id: "s1", tool_name: "Bash", tool_input: {}, status: "pending", created_at: 1,
        permission_request_id: "pr1", owner_user_id: ids.owner,
      } as any),
    );
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: permission, status: "approved" });
    const [row] = await events();
    expect(row.kind).toBe("permission_answered");
    expect(row.actor_user_id).toBe(ids.owner);
    expect(row.detail.after).toEqual({ status: "approved", permission_id: permission });
    expect(row.detail.before.tool_name).toBe("Bash");
  });

  test("claimShareToken records mint and revoke, and refuses an anonymous change", async () => {
    const { t, ids, events } = await setup();
    await t.run(async (ctx) => {
      const conv = (await ctx.db.get(ids.conv))!;
      await claimShareToken(ctx, "conversations", conv, "11111111-1111-4111-8111-111111111111", ids.owner);
      await claimShareToken(ctx, "conversations", (await ctx.db.get(ids.conv))!, null, ids.owner);
      await expect(claimShareToken(ctx, "conversations", (await ctx.db.get(ids.conv))!, "22222222-2222-4222-8222-222222222222")).rejects.toThrow(/needs the person/);
    });
    expect((await events()).map((r) => r.kind)).toEqual(["share_link_minted", "share_link_revoked"]);
  });

  test("pinToProfile mints through claimShareToken and audits it", async () => {
    const { t, ids, events } = await setup();
    const { api } = await import("./_generated/api");
    await t.withIdentity({ subject: `${ids.owner}|x` } as any).mutation(api.conversations.pinToProfile, { conversation_id: ids.conv });
    const [row] = await events();
    expect(row.kind).toBe("share_link_minted");
    expect(row.conversation_id).toBe(ids.conv);
  });

  test("creating a team records the creator's admin membership", async () => {
    const { t, ids, events } = await setup();
    const { api } = await import("./_generated/api");
    await t.withIdentity({ subject: `${ids.other}|x` } as any).mutation(api.teams.createTeam, { name: "New" } as any);
    const row = (await events()).find((r) => r.kind === "team_member_added");
    expect(row?.actor_user_id).toBe(ids.other);
    expect(row?.detail.after).toEqual({ role: "admin", how: "Created the team" });
  });
});
