// Publishing for a regulated team (HIPAA): a page whose session, task or
// publishing device answers to a team with regulated_data is gated to that
// team's signed-in members. Runs the real publish, serve, comment and manage
// routes and the in-app unlock queries under convex-test.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";

setDefaultTimeout(120_000);

const DEVICE = "device-mac-1";

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", { name: "Ada", email: "ada@clinic.dev" } as any);
    const member = await ctx.db.insert("users", { name: "Mo", email: "mo@clinic.dev" } as any);
    const outsider = await ctx.db.insert("users", { name: "Oz", email: "oz@other.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Clinic", invite_code: "CLINIC12", created_at: 1 } as any);
    const other = await ctx.db.insert("teams", { name: "Side", invite_code: "SIDE1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: admin, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: member, team_id: team, role: "member", joined_at: 2 } as any);
    // The outsider shares another team with the admin: a teammate, but not of Clinic.
    await ctx.db.insert("team_memberships", { user_id: admin, team_id: other, role: "member", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: outsider, team_id: other, role: "member", joined_at: 1 } as any);
    return { admin, member, outsider, team };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  await as(ids.admin).mutation(api.managedDevices.setTeamPolicy, { team_id: ids.team, policy: { regulated_data: true } });
  return { t, ...ids, as };
}

/** A device-bound api token for `user`, the device enrolled in `team` when given. */
async function token(t: any, user: Id<"users">, team?: Id<"teams">) {
  const secret = `bound_${user}`;
  await t.run(async (ctx: any) => {
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(secret), name: "mac", created_at: 1, last_used_at: 1, device_id: DEVICE });
    await ctx.db.insert("devices", { user_id: user, device_id: DEVICE, label: "mac", platform: "darwin", last_seen: 1, ...(team ? { enrolled_team_id: team } : {}) });
  });
  return presentToken(secret, DEVICE);
}

async function conversation(t: any, user: Id<"users">, team?: Id<"teams">) {
  return await t.run(async (ctx: any) =>
    ctx.db.insert("conversations", {
      user_id: user,
      agent_type: "claude_code",
      session_id: crypto.randomUUID(),
      started_at: 1,
      updated_at: 1,
      message_count: 0,
      is_private: !team,
      status: "active",
      ...(team ? { team_id: team, team_visibility: "full" } : {}),
    }),
  );
}

async function post(t: any, path: string, body: Record<string, unknown>) {
  const res = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const publish = (t: any, api_token: string, extra: Record<string, unknown> = {}) =>
  post(t, "/cli/artifacts/publish", { api_token, title: "Patient 4411 notes", content: "<h1>chart</h1>", source_path: "/w/notes.html", ...extra });

async function serve(t: any, slug: string, query = "") {
  const res = await t.fetch(`/cli/a/${slug}${query}`, { method: "GET" });
  return { status: res.status, text: await res.text() };
}

const row = (t: any, slug: string) =>
  t.run((ctx: any) => ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first());

describe("team gate on a regulated team's pages", () => {
  test("a publish from the team's session is gated by default; only members get through", async () => {
    const { t, admin, member, outsider, team, as } = await setup();
    const apiToken = await token(t, admin);
    const conv = await conversation(t, admin, team);
    const res = await publish(t, apiToken, { session_ref: String(conv) });
    expect(res.status).toBe(200);
    const slug = res.body.slug as string;
    expect((await row(t, slug)).team_gate).toBe(team);

    // An anonymous visitor gets the members-only page, which names the team and not the page.
    const anon = await serve(t, slug);
    expect(anon.status).toBe(403);
    expect(anon.text).toContain("Clinic members only");
    expect(anon.text).toContain("/pages/auth?slug=");
    expect(anon.text).not.toContain("Patient 4411");
    expect(anon.text).not.toContain("chart");
    expect((await serve(t, slug, "?meta=1")).status).toBe(403);
    expect((await serve(t, slug, "?m=guess")).status).toBe(403);

    // A signed-in non-member (a teammate of the owner elsewhere) gets nothing.
    expect(await as(outsider).query(api.artifacts.ownerUnlock, { slug })).toBeNull();
    expect((await as(outsider).query(api.artifacts.embedInfo, { pages: [{ slug }] }))[0]).toMatchObject({ locked: true });
    expect(await t.query(api.artifacts.embedInfo, { pages: [{ slug }] })).toEqual([{ slug, gated: true, locked: true, kind: "html" }]);
    expect((await t.query(api.artifacts.getShared, { slug }))?.title).toBe("Protected page");
    expect(await as(outsider).mutation(api.artifacts.mintCommentIdentity, { slug })).toMatchObject({ error: expect.stringContaining("not in Clinic") });

    // A member is handed the token, and it opens the page.
    const unlock = await as(member).query(api.artifacts.ownerUnlock, { slug });
    expect(unlock?.m).toBeTruthy();
    expect((await as(member).query(api.artifacts.embedInfo, { pages: [{ slug }] }))[0]).toMatchObject({ gated: true, m: unlock!.m });
    expect((await as(admin).query(api.artifacts.ownerUnlock, { slug }))?.m).toBe(unlock!.m);
    const opened = await serve(t, slug, `?m=${unlock!.m}`);
    expect(opened.status).toBe(200);
    expect(opened.text).toContain("chart");
  });

  test("comments and views need the member token", async () => {
    const { t, admin, member, team, as } = await setup();
    const conv = await conversation(t, admin, team);
    const { body } = await publish(t, await token(t, admin), { session_ref: String(conv) });
    const slug = body.slug as string;
    const comment = (extra: Record<string, unknown>) =>
      post(t, "/cli/artifacts/comment", { slug, author_name: "Anon", version: 1, comments: [{ text: "hi" }], ...extra });
    expect((await comment({})).body.error).toContain("regulated data");
    const m = (await as(member).query(api.artifacts.ownerUnlock, { slug }))!.m;
    expect((await comment({ m })).body.error).toBeUndefined();
    expect(await t.mutation(api.artifacts.recordView, { slug })).toEqual({ ok: false });
    expect(await t.mutation(api.artifacts.recordView, { slug, m: m! })).toEqual({ ok: true });
  });

  test("the gate cannot be removed or opened to a public edit link", async () => {
    const { t, admin, team } = await setup();
    const apiToken = await token(t, admin);
    const conv = await conversation(t, admin, team);
    const first = await publish(t, apiToken, { session_ref: String(conv) });
    const slug = first.body.slug as string;

    const linked = await publish(t, apiToken, { session_ref: String(conv), access: { edit_mode: "link" } });
    expect(linked.status).toBe(403);
    expect(linked.body.error).toContain("Clinic marks this page's data as regulated");

    // A republish from a personal session, changed or not, keeps the gate.
    const personal = await conversation(t, admin);
    expect((await publish(t, apiToken, { session_ref: String(personal), access: { password: null } })).status).toBe(200);
    expect((await publish(t, apiToken, { session_ref: String(personal), content: "<h1>v2</h1>" })).status).toBe(200);
    expect((await row(t, slug)).team_gate).toBe(team);
    expect((await serve(t, slug)).status).toBe(403);

    // The owner's manage panel cannot turn on a link editor either.
    const manage = await post(t, "/cli/artifacts/manage", { slug, owner_key: first.body.owner_key, set: { edit_mode: "link" } });
    expect(manage.status).toBe(400);
    expect(manage.body.error).toContain("regulated");
    expect((await row(t, slug)).edit_mode).toBeUndefined();
  });

  test("a device enrolled in the team gates even a personal session's page; other pages stay open", async () => {
    const { t, admin, member, team } = await setup();
    const enrolled = await publish(t, await token(t, member, team), { session_ref: String(await conversation(t, member)) });
    expect((await row(t, enrolled.body.slug)).team_gate).toBe(team);

    const open = await publish(t, await token(t, admin), { session_ref: String(await conversation(t, admin)), source_path: "/w/open.html" });
    expect((await row(t, open.body.slug)).team_gate).toBeUndefined();
    expect((await serve(t, open.body.slug)).status).toBe(200);
  });

  test("attaching an existing page to the team's task gates it", async () => {
    const { t, admin, team } = await setup();
    const apiToken = await token(t, admin);
    const { body } = await publish(t, apiToken, { session_ref: String(await conversation(t, admin)) });
    expect((await row(t, body.slug)).team_gate).toBeUndefined();
    await t.run((ctx: any) =>
      ctx.db.insert("tasks", { short_id: "ct-1", title: "Chart review", status: "open", task_type: "task", priority: "medium", source: "human", user_id: admin, team_id: team, workspace: `team:${team}`, created_at: 1, updated_at: 1 } as any),
    );
    const res = await post(t, "/cli/artifacts/attach", { api_token: apiToken, slug: body.slug, task: "ct-1" });
    expect(res.body.error).toBeUndefined();
    expect((await row(t, body.slug)).team_gate).toBe(team);
  });
});
