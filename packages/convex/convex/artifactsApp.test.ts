// Installed apps on the server (docs/architecture/installed-apps.md): the
// manifest a publish records per version, the icon and ?app=1 on the page
// route, and the team apps policy. Runs the real publish and serve routes
// under convex-test.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { monogramPng } from "./lib/appIcon";

setDefaultTimeout(120_000);

const PNG_MAGIC = [137, 80, 78, 71];

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ada", email: "ada@acme.dev" } as any);
    const mate = await ctx.db.insert("users", { name: "Mo", email: "mo@acme.dev" } as any);
    const stranger = await ctx.db.insert("users", { name: "Oz", email: "oz@else.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1, visibility: "full" } as any);
    await ctx.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: 2, visibility: "full" } as any);
    return { owner, mate, stranger, team };
  });
  const secret = `tok_${ids.owner}`;
  await t.run(async (ctx) => {
    await ctx.db.insert("api_tokens", { user_id: ids.owner, token_hash: await hashToken(secret), name: "mac", created_at: 1, last_used_at: 1, device_id: "dev1" } as any);
    await ctx.db.insert("devices", { user_id: ids.owner, device_id: "dev1", label: "mac", platform: "darwin", last_seen: 1 } as any);
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, api_token: presentToken(secret, "dev1"), as };
}

async function publish(t: any, body: Record<string, unknown>) {
  const res = await t.fetch("/cli/artifacts/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** A conversation in the team's workspace, so a page published from it is a team page. */
const teamConversation = (t: any, user: Id<"users">, team: Id<"teams">) =>
  t.run((ctx: any) => ctx.db.insert("conversations", {
    user_id: user, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
    message_count: 0, is_private: false, status: "active", team_id: team, team_visibility: "full",
  }));

const row = (t: any, slug: string) => t.run((ctx: any) => ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first());
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const html = (s: string) => b64(new TextEncoder().encode(s));

describe("publishing the manifest", () => {
  test("records the parsed manifest on the page, snapshots it per version, and a changed manifest is a new version", async () => {
    const { t, api_token } = await setup();
    const app = { name: "Vitals", window: { width: 50 }, permissions: ["menu-bar", "notifications"] };
    const first = await publish(t, { api_token, title: "Vitals", content: "<h1>v</h1>", source_path: "/w/v.html", data: { app } });
    expect(first.status).toBe(200);
    const slug = first.body.slug as string;
    // Clamped, in catalog order; an app-only declaration sets up no live data.
    expect((await row(t, slug)).app).toEqual({ name: "Vitals", window: { width: 200 }, permissions: ["notifications", "menu-bar"] });
    expect(first.body.data).toBeUndefined();

    const same = await publish(t, { api_token, title: "Vitals", content: "<h1>v</h1>", source_path: "/w/v.html", data: { app } });
    expect(same.body.unchanged).toBe(true);

    const more = await publish(t, { api_token, title: "Vitals", content: "<h1>v</h1>", source_path: "/w/v.html", data: { app: { ...app, permissions: ["agent"] } } });
    expect(more.body.version).toBe(2);
    expect((await row(t, slug)).app.permissions).toEqual(["agent"]);
    const history = await t.run((ctx: any) => ctx.db.query("artifact_versions").collect());
    expect(history.map((h: any) => [h.version, h.app?.permissions])).toEqual([[1, ["notifications", "menu-bar"]]]);

    // A version without the block clears it; a rollback brings v1's back.
    const bare = await publish(t, { api_token, title: "Vitals", content: "<h1>v</h1>", source_path: "/w/v.html" });
    expect(bare.body.version).toBe(3);
    expect((await row(t, slug)).app).toBeUndefined();
    const rolled = await t.fetch("/cli/artifacts/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token, target: slug, version: 1 }) });
    expect(rolled.status).toBe(200);
    expect((await row(t, slug)).app.permissions).toEqual(["notifications", "menu-bar"]);
  });

  test("a bad manifest refuses the publish with the reason and stores nothing", async () => {
    const { t, api_token } = await setup();
    const res = await publish(t, { api_token, title: "X", content: "<h1>x</h1>", data: { app: { permissions: ["camera"] } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`cast-data.json: "app.permissions": unknown permission "camera"`);
    expect(await t.run((ctx: any) => ctx.db.query("artifacts").collect())).toHaveLength(0);
  });

  test("a declared icon must be a PNG in the bundle", async () => {
    const { t, api_token } = await setup();
    const files = [{ path: "index.html", content_b64: html("<h1>b</h1>") }];
    const missing = await publish(t, { api_token, title: "B", kind: "bundle", files, data: { app: { icon: "icon.png" } } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain(`"app.icon" names icon.png`);
  });

  test("live data beside the app block still publishes its queries", async () => {
    const { t, api_token } = await setup();
    const res = await publish(t, { api_token, title: "D", content: "<h1>d</h1>", data: { app: { name: "D" }, state: { votes: { write: "anyone" } } } });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toEqual(["votes"]);
    expect((await row(t, res.body.slug)).app).toEqual({ name: "D" });
  });
});

describe("the icon route", () => {
  test("serves the bundle's declared PNG, else a generated PNG tile at the asked size", async () => {
    const { t, api_token } = await setup();
    const png = monogramPng("Declared", "declared", 512);
    const files = [{ path: "index.html", content_b64: html("<h1>b</h1>") }, { path: "img/icon.png", content_b64: b64(png) }];
    const declared = await publish(t, { api_token, title: "B", kind: "bundle", files, data: { app: { icon: "img/icon.png" } } });
    const res = await t.fetch(`/cli/a/${declared.body.slug}?icon=512`);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);

    const plain = await publish(t, { api_token, title: "Weekly vitals", content: "<h1>v</h1>" });
    const gen = await t.fetch(`/cli/a/${plain.body.slug}?icon=1024`);
    const bytes = new Uint8Array(await gen.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual(PNG_MAGIC);
    // IHDR: width and height 1024, colour type 6 (RGBA, so the corners are transparent).
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20), bytes[25]]).toEqual([1024, 1024, 6]);
  });

  test("stays behind the page's password like the page", async () => {
    const { t, api_token } = await setup();
    const res = await publish(t, { api_token, title: "P", content: "<h1>p</h1>", access: { password: "hunter2" } });
    expect((await t.fetch(`/cli/a/${res.body.slug}?icon=512`)).status).toBe(404);
    expect((await t.fetch(`/cli/a/${res.body.slug}?app=1`)).status).toBe(403);
  });
});

describe("?app=1 and appInfo", () => {
  test("resolves the manifest, the icons, and the viewer's relation and policy", async () => {
    const { t, api_token, owner, mate, stranger, team, as } = await setup();
    const conv = await teamConversation(t, owner, team);
    const res = await publish(t, { api_token, title: "Vitals", content: "<h1>v</h1>", session_ref: String(conv), data: { app: { permissions: ["full-access"] } } });
    const slug = res.body.slug as string;

    const anon = await (await t.fetch(`/cli/a/${slug}?app=1`)).json();
    expect(anon).toMatchObject({
      slug, title: "Vitals", version: 1,
      app: { name: "Vitals", icon: null, permissions: ["full-access"], window: { width: 1024, height: 768 } },
      owner: { name: "Ada" },
      relation: "anonymous",
      // A team page: installs on, full access off until an admin turns it on.
      policy: { install: true, fullAccess: false },
    });
    expect(anon.icons["512"]).toMatch(new RegExp(`/${slug}\\?icon=512$`));

    // A signed-in host's auth token identifies it over HTTP.
    expect((await (await as(mate).fetch(`/cli/a/${slug}?app=1`)).json()).relation).toBe("team");

    // The signed-in app asks the query; the gallery's rule decides the relation.
    expect((await as(owner).query(api.artifacts.appInfo, { slug })) as any).toMatchObject({ relation: "owner" });
    expect((await as(mate).query(api.artifacts.appInfo, { slug })) as any).toMatchObject({ relation: "team" });
    expect((await as(stranger).query(api.artifacts.appInfo, { slug })) as any).toMatchObject({ relation: "other" });

    // Only an admin sets the policy, and appInfo reads it.
    await expect(as(mate).mutation(api.teams.setAppsPolicy, { team_id: team, full_access: true })).rejects.toThrow("Only admins");
    await as(owner).mutation(api.teams.setAppsPolicy, { team_id: team, full_access: true });
    expect(((await as(mate).query(api.artifacts.appInfo, { slug })) as any).policy).toEqual({ install: true, fullAccess: true });
    await as(owner).mutation(api.teams.setAppsPolicy, { team_id: team, install: false });
    expect(((await as(mate).query(api.artifacts.appInfo, { slug })) as any).policy).toEqual({ install: false, fullAccess: true });
  });

  test("a personal page allows both, and a team that turned installs off still stops its members", async () => {
    const { t, api_token, owner, team, as } = await setup();
    const res = await publish(t, { api_token, title: "Mine", content: "<h1>m</h1>" });
    expect(((await as(owner).query(api.artifacts.appInfo, { slug: res.body.slug })) as any).policy).toEqual({ install: true, fullAccess: true });
    await as(owner).mutation(api.teams.setAppsPolicy, { team_id: team, install: false });
    expect(((await as(owner).query(api.artifacts.appInfo, { slug: res.body.slug })) as any).policy).toEqual({ install: false, fullAccess: true });
  });

  test("an identity token minted for the page identifies the viewer over HTTP", async () => {
    const { t, api_token, stranger, as } = await setup();
    const res = await publish(t, { api_token, title: "X", content: "<h1>x</h1>" });
    const minted = (await as(stranger).mutation(api.artifacts.mintCommentIdentity, { slug: res.body.slug })) as { token: string };
    const info = await (await t.fetch(`/cli/a/${res.body.slug}?app=1&i=${minted.token}`)).json();
    expect(info.relation).toBe("other");
  });

  test("the query applies the page's gates and hands back the keys a host stores", async () => {
    const { t, api_token, owner, stranger, as } = await setup();
    const res = await publish(t, { api_token, title: "P", content: "<h1>p</h1>", access: { password: "hunter2" } });
    const slug = res.body.slug as string;
    expect(await as(stranger).query(api.artifacts.appInfo, { slug })).toEqual({ error: "This page is password protected" });
    const mine = (await as(owner).query(api.artifacts.appInfo, { slug })) as any;
    expect(mine.gate.k).toBeTruthy();
    expect(mine.icons["1024"]).toContain(`k=${mine.gate.k}`);
    // The handed key opens the HTTP route too.
    expect((await t.fetch(`/cli/a/${slug}?app=1&k=${mine.gate.k}`)).status).toBe(200);
  });
});
