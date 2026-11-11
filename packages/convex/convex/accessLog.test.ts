// The access log under convex-test: an open of a regulated team's
// conversation writes one row and a repeat inside the window writes none; a
// team without regulated mode writes nothing; staff reads land in the team
// their arguments name; only a team's admins read its log.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { ACCESS_REPEAT_WINDOW_MS } from "./lib/accessLog";
import { mTokenFor } from "./lib/artifactGates";
import { hashToken } from "./apiTokens";
import { presentToken } from "@platform/auth/convex";

setDefaultTimeout(120_000);

const PAGE = { numItems: 50, cursor: null };

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", { name: "Ada", email: "ada@clinic.dev" } as any);
    const member = await ctx.db.insert("users", { name: "Mo", email: "mo@clinic.dev" } as any);
    const otherAdmin = await ctx.db.insert("users", { name: "Bo", email: "bo@plain.dev" } as any);
    const regulated = await ctx.db.insert("teams", { name: "Clinic", invite_code: "CLINIC12", created_at: 1, policy: { regulated_data: true } } as any);
    const plain = await ctx.db.insert("teams", { name: "Plain", invite_code: "PLAIN123", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: admin, team_id: regulated, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: member, team_id: regulated, role: "member", joined_at: 2 } as any);
    await ctx.db.insert("team_memberships", { user_id: otherAdmin, team_id: plain, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: member, team_id: plain, role: "member", joined_at: 2 } as any);
    return { admin, member, otherAdmin, regulated, plain };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, as };
}

async function conversation(t: any, user: Id<"users">, team: Id<"teams">) {
  return await t.run(async (ctx: any) =>
    ctx.db.insert("conversations", {
      user_id: user,
      agent_type: "claude_code",
      session_id: crypto.randomUUID(),
      started_at: 1,
      updated_at: 1,
      message_count: 0,
      is_private: false,
      status: "active",
      team_id: team,
      short_id: "jx7abcd",
    }),
  );
}

const rows = (t: any) => t.run(async (ctx: any) => ctx.db.query("access_log").collect());

describe("access log", () => {
  test("an open of a regulated team's conversation writes one row; a repeat inside the window writes none", async () => {
    const { t, admin, member, regulated, as } = await setup();
    const conv = await conversation(t, admin, regulated);
    const open = { conversation_id: conv, action: "open" as const, client: "web" as const };
    expect(await as(member).mutation(api.accessLog.noteConversationAccess, open)).toBe(true);
    expect(await as(member).mutation(api.accessLog.noteConversationAccess, { ...open, client: "desktop" })).toBe(false);
    const written = await rows(t);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ team_id: regulated, actor_user_id: member, action: "open", object_table: "conversations", object_id: String(conv), object_short_id: "jx7abcd", client: "web" });

    // Past the window the same open is a new entry; another person's is their own.
    await t.run(async (ctx: any) => ctx.db.patch(written[0]._id, { at: written[0].at - ACCESS_REPEAT_WINDOW_MS - 1 }));
    expect(await as(member).mutation(api.accessLog.noteConversationAccess, open)).toBe(true);
    expect(await as(admin).mutation(api.accessLog.noteConversationAccess, open)).toBe(true);
    expect(await rows(t)).toHaveLength(3);
  });

  test("a team without regulated mode writes zero rows, from every touchpoint", async () => {
    const { t, member, otherAdmin, plain, as } = await setup();
    const conv = await conversation(t, otherAdmin, plain);
    expect(await as(member).mutation(api.accessLog.noteConversationAccess, { conversation_id: conv, action: "open", client: "web" })).toBe(false);
    expect(await as(member).mutation(api.accessLog.noteConversationAccess, { conversation_id: conv, action: "download", client: "mobile", detail: "a.pdf" })).toBe(false);
    // A staff read naming the plain team's conversation lands in no team's log.
    await t.mutation(internal.accessLog.recordStaffRun, { actor: "staff@codecast.sh on mac", fn: "conversations:inspect", args_json: JSON.stringify({ id: conv }) });
    const written = await rows(t);
    expect(written.filter((r: any) => r.team_id)).toHaveLength(0);
  });

  test("a person who cannot read the conversation records nothing", async () => {
    const { t, admin, otherAdmin, regulated, as } = await setup();
    const conv = await conversation(t, admin, regulated);
    expect(await as(otherAdmin).mutation(api.accessLog.noteConversationAccess, { conversation_id: conv, action: "open", client: "web" })).toBe(false);
    expect(await rows(t)).toHaveLength(0);
  });

  test("a staff read lands in the regulated team its arguments name, with who ran what", async () => {
    const { t, admin, regulated } = await setup();
    const conv = await conversation(t, admin, regulated);
    await t.mutation(internal.accessLog.recordStaffRun, { actor: "ashot@codecast.sh on mbp", fn: "conversations:inspectConversation", args_json: JSON.stringify({ id: conv }) });
    const written = await rows(t);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ team_id: regulated, actor_label: "ashot@codecast.sh on mbp", action: "staff_read", client: "script", object_id: String(conv) });
    expect(written[0].detail).toContain("conversations:inspectConversation");
  });

  test("only a team's admins read its log, newest first", async () => {
    const { t, admin, member, otherAdmin, regulated, plain, as } = await setup();
    const conv = await conversation(t, admin, regulated);
    await as(member).mutation(api.accessLog.noteConversationAccess, { conversation_id: conv, action: "open", client: "web" });
    await as(member).mutation(api.accessLog.noteConversationAccess, { conversation_id: conv, action: "download", client: "web", detail: "scan.pdf" });

    const page = await as(admin).query(api.accessLog.listForTeam, { team_id: regulated, paginationOpts: PAGE });
    expect(page.page.map((r: any) => r.action)).toEqual(["download", "open"]);
    expect(page.page[0]).toMatchObject({ actor: "Mo", object_short_id: "jx7abcd", detail: "scan.pdf" });

    await expect(as(member).query(api.accessLog.listForTeam, { team_id: regulated, paginationOpts: PAGE })).rejects.toThrow();
    await expect(as(otherAdmin).query(api.accessLog.listForTeam, { team_id: regulated, paginationOpts: PAGE })).rejects.toThrow();
    // Team B's admin reads team B's log, which holds none of team A's rows.
    expect((await as(otherAdmin).query(api.accessLog.listForTeam, { team_id: plain, paginationOpts: PAGE })).page).toHaveLength(0);
  });
  test("a regulated team's page opened by a signed-in reader names them; a link holder is recorded once", async () => {
    const { t, admin, member, regulated } = await setup();
    const { slug, m, token } = await t.run(async (ctx: any) => {
      const storage_id = await ctx.storage.store(new Blob(["<p>hi</p>"]));
      const row = { slug: "pg7abc12", user_id: admin, title: "Labs", storage_id, size: 9, version: 1, created_at: 1, updated_at: 1, owner_key: "ok_secret", team_gate: regulated };
      const id = await ctx.db.insert("artifacts", row as any);
      await ctx.db.insert("artifact_identities", { token: "idtok", user_id: member, artifact_id: id, created_at: 1 });
      return { slug: row.slug, m: await mTokenFor(row as any, String(member)), token: "idtok" };
    });
    expect((await t.mutation(api.artifacts.recordView, { slug, m: m! })).ok).toBe(true);
    await t.mutation(api.artifacts.recordView, { slug, m: m! });
    await t.mutation(api.artifacts.recordView, { slug, m: m!, identity_token: token });
    // Without the member token the page does not open, and nothing is recorded.
    await t.mutation(api.artifacts.recordView, { slug });
    const written = await rows(t);
    expect(written.map((r: any) => [r.actor_user_id ?? r.actor_label, r.client, r.object_short_id])).toEqual([
      ["Page link holder", "page", slug],
      [member, "page", slug],
    ]);
  });
  test("a CLI read records once across its pages; an export records once", async () => {
    const { t, admin, member, regulated } = await setup();
    const conv = await conversation(t, admin, regulated);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("api_tokens", { user_id: member, token_hash: await hashToken("bound_clisecret"), name: "mac", created_at: 1, last_used_at: 1, device_id: "dev-1" });
    });
    const api_token = presentToken("bound_clisecret", "dev-1");
    for (let page = 0; page < 3; page++) {
      await t.mutation(internal.accessLog.recordCliConversation, { api_token, conversation_id: "jx7abcd", action: "open" });
    }
    await t.mutation(internal.accessLog.recordCliConversation, { api_token, conversation_id: String(conv), action: "export" });
    await t.mutation(internal.accessLog.recordCliConversation, { api_token: "bogus", conversation_id: String(conv), action: "open" });
    const written = await rows(t);
    expect(written.map((r: any) => [r.actor_user_id, r.action, r.client])).toEqual([
      [member, "open", "cli"],
      [member, "export", "cli"],
    ]);
  });
});
