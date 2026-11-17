// Codecast for outside agents: the /mcp read tools answer exactly what the
// account can read in the app, and the OAuth path (register, consent, code,
// token, refresh, disconnect) holds its rules. docs/architecture/agent-mcp.md.
import { beforeAll, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { REGISTER_GLOBAL_PER_HOUR, REGISTER_PER_HOUR, disconnectCore, redirectUriAllowed, s256 } from "./mcpAuth";
import { pageSlug } from "./mcpTools";
import { accountAdmission, pageAdmission } from "./artifacts";
import { kTokenFor } from "./lib/artifactGates";
import { htmlToText } from "./lib/htmlText";
import { MCP_CALLER_IP_HEADER, MCP_CALLER_SIG_HEADER, MCP_ROUTES, signCallerAddress } from "@codecast/shared/contracts/agentAccess";

beforeAll(() => {
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_PUBLIC_ORIGIN = "https://codecast.test";
});

const OWNER_TOKEN = "owner-cast-token-" + "x".repeat(20);
const TEAMMATE_TOKEN = "teammate-cast-token-" + "y".repeat(20);

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { name: "Owner", email: "owner@x.test" } as any);
    const teammate = await ctx.db.insert("users", { name: "Teammate" } as any);
    const stranger = await ctx.db.insert("users", { name: "Stranger" } as any);
    const T = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "t" } as any);
    const O = await ctx.db.insert("teams", { name: "Other", created_at: now, invite_code: "o" } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: T, role: "admin", joined_at: now, visibility: "full" } as any);
    await ctx.db.insert("team_memberships", { user_id: teammate, team_id: T, role: "member", joined_at: now, visibility: "full" } as any);
    await ctx.db.insert("team_memberships", { user_id: stranger, team_id: O, role: "admin", joined_at: now } as any);
    for (const [user_id, token] of [[owner, OWNER_TOKEN], [teammate, TEAMMATE_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id, token_hash: await hashToken(token), name: "laptop", created_at: now, last_used_at: now });
    }

    const placements = {
      team: { user_id: owner, team_id: T, workspace: `team:${T}` },
      private: { user_id: owner, team_id: T, workspace: `user:${owner}` },
      personal: { user_id: owner, workspace: `user:${owner}` },
      other: { user_id: stranger, team_id: O, workspace: `team:${O}` },
    };
    const docs: Record<string, string> = {};
    let n = 0;
    for (const [place, p] of Object.entries(placements)) {
      const base = { ...p, title: `${place} row`, created_at: now, updated_at: now + n };
      await ctx.db.insert("tasks", { ...base, short_id: `ct-${place}`, task_type: "task", priority: "medium", source: "human", status: "open", description: `${place} task body` } as any);
      docs[place] = await ctx.db.insert("docs", { ...base, content: `${place} doc body`, doc_type: "note", source: "human" } as any);
      await ctx.db.insert("plans", { ...base, short_id: `pl-${place}`, status: "active", source: "human", goal: `${place} goal` } as any);
      n++;
    }

    // Sessions: the owner's team sessions at each visibility, one private.
    const session = (short_id: string, extra: Record<string, unknown>) =>
      ctx.db.insert("conversations", {
        user_id: owner, team_id: T, agent_type: "claude_code", session_id: `s-${short_id}`, short_id,
        started_at: now, updated_at: now, message_count: 3, status: "active",
        title: `${short_id} title`, idle_summary: `${short_id} summary`, thread_state: `${short_id} state`,
        project_path: "/src/app", ...extra,
      } as any);
    const teamSession = await session("jxfull1", { is_private: false, team_visibility: "full" });
    await session("jxsumm1", { is_private: false, team_visibility: "summary" });
    await session("jxmini1", { is_private: false, team_visibility: "minimal" });
    await session("jxpriv1", { is_private: true });

    // Pages: an open one by a stranger, one gated to team T, one behind a password.
    const page = async (slug: string, user_id: any, extra: Record<string, unknown>, html: string) => {
      const storage_id = await ctx.storage.store(new Blob([html], { type: "text/html" }));
      await ctx.db.insert("artifacts", { slug, user_id, title: `${slug} title`, storage_id, size: html.length, owner_key: `ok-${slug}`, version: 1, created_at: now, updated_at: now, ...extra } as any);
    };
    await page("openpage01", stranger, {}, "<html><head><style>x{}</style></head><body><h1>Open page</h1><p>Hello &amp; welcome</p><script>evil()</script></body></html>");
    await page("teampage01", owner, { team_gate: T }, "<p>Team only words</p>");
    await page("passpage01", stranger, { password_hash: "abc" }, "<p>Secret words</p>");
    await page("ownpass001", owner, { password_hash: "abc" }, "<p>Owner secret words</p>");
    // The owner's pages a teammate sees in the gallery: one behind a password,
    // one behind the email wall, one expired (owner's too).
    await page("tmpass0001", owner, { password_hash: "abc", session_conversation_id: teamSession }, "<p>Teammate must not read</p>");
    await page("tmemail001", owner, { email_gate: true, session_conversation_id: teamSession }, "<p>Email walled</p>");
    await page("expired001", owner, { expires_at: now - 1000 }, "<p>Gone</p>");
    return { owner, teammate, stranger, T, docs };
  });
}

async function rpc(t: ReturnType<typeof convexTest>, token: string | null, method: string, params?: unknown) {
  const res = await t.fetch("/cli/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, headers: res.headers, body: res.status === 200 ? await res.json() : await res.text() };
}

async function tool(t: ReturnType<typeof convexTest>, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(t, token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  const result = (r.body as any).result;
  return { isError: result.isError as boolean, data: result.structuredContent ?? result.content[0].text };
}

describe("mcp read tools", () => {
  test("no bearer is a 401 that points at the OAuth metadata", async () => {
    const t = convexTest(schema, allModules);
    const r = await rpc(t, null, "initialize", {});
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('resource_metadata="https://codecast.test/.well-known/oauth-protected-resource"');
  });

  test("initialize and tools/list speak MCP", async () => {
    const t = convexTest(schema, allModules);
    await seed(t);
    const init = await rpc(t, OWNER_TOKEN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect((init.body as any).result.protocolVersion).toBe("2025-06-18");
    const list = await rpc(t, OWNER_TOKEN, "tools/list");
    const names = (list.body as any).result.tools.map((x: any) => x.name);
    expect(names).toContain("read_page");
    expect((list.body as any).result.tools.every((x: any) => x.annotations.readOnlyHint)).toBe(true);
  });

  test("whoami names every workspace", async () => {
    const t = convexTest(schema, allModules);
    await seed(t);
    const { data } = await tool(t, OWNER_TOKEN, "whoami");
    expect(data.workspaces.map((w: any) => w.name)).toEqual(["personal", "Acme"]);
  });

  test("lists follow the workspace rule, and the filter narrows to one", async () => {
    const t = convexTest(schema, allModules);
    await seed(t);
    const titles = async (token: string, name: string, args: Record<string, unknown> = {}) => {
      const { data } = await tool(t, token, name, args);
      return (data.tasks ?? data.docs ?? data.plans).map((r: any) => r.title).sort();
    };
    for (const name of ["list_tasks", "list_docs", "list_plans"]) {
      expect(await titles(OWNER_TOKEN, name)).toEqual(["personal row", "private row", "team row"]);
      expect(await titles(OWNER_TOKEN, name, { workspace: "Acme" })).toEqual(["team row"]);
      expect(await titles(OWNER_TOKEN, name, { workspace: "personal" })).toEqual(["personal row", "private row"]);
      expect(await titles(TEAMMATE_TOKEN, name)).toEqual(["team row"]);
    }
    const bad = await tool(t, TEAMMATE_TOKEN, "list_tasks", { workspace: "Other" });
    expect(bad.isError).toBe(true);
  });

  test("reads refuse what the account cannot see", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    expect((await tool(t, TEAMMATE_TOKEN, "read_doc", { id: `doc:${ids.docs.team}` })).data.content).toBe("team doc body");
    expect((await tool(t, TEAMMATE_TOKEN, "read_doc", { id: `doc:${ids.docs.private}` })).data).toEqual({ found: false });
    expect((await tool(t, TEAMMATE_TOKEN, "read_task", { id: "ct-team" })).data.description).toBe("team task body");
    expect((await tool(t, TEAMMATE_TOKEN, "read_task", { id: "ct-personal" })).data).toEqual({ found: false });
    expect((await tool(t, TEAMMATE_TOKEN, "read_plan", { id: "pl-other" })).data).toEqual({ found: false });
  });

  test("a session shows a teammate only what its card shows", async () => {
    const t = convexTest(schema, allModules);
    await seed(t);
    const full = (await tool(t, TEAMMATE_TOKEN, "read_session", { id: "jxfull1" })).data;
    expect(full.summary).toBe("jxfull1 summary");
    const summary = (await tool(t, TEAMMATE_TOKEN, "read_session", { id: "jxsumm1" })).data;
    expect(summary.title).toBe("jxsumm1 title");
    expect(summary.summary).toBeUndefined();
    expect(summary.state).toBeUndefined();
    const minimal = (await tool(t, TEAMMATE_TOKEN, "read_session", { id: "jxmini1" })).data;
    expect(minimal.title).toBeUndefined();
    expect(minimal.project).toBe("app");
    expect((await tool(t, TEAMMATE_TOKEN, "read_session", { id: "jxpriv1" })).data).toEqual({ found: false });
    // The owner sees all of their own.
    expect((await tool(t, OWNER_TOKEN, "read_session", { id: "jxsumm1" })).data.summary).toBe("jxsumm1 summary");
    const listed = (await tool(t, TEAMMATE_TOKEN, "list_sessions")).data.sessions.map((s: any) => s.id).sort();
    expect(listed).toEqual(["jxfull1", "jxmini1", "jxsumm1"]);
  });

  test("pages open as far as they open to the account in a browser", async () => {
    const t = convexTest(schema, allModules);
    await seed(t);
    const open = (await tool(t, TEAMMATE_TOKEN, "read_page", { page: "https://codecast.sh/a/openpage01" })).data;
    expect(open.text).toContain("# Open page");
    expect(open.text).toContain("Hello & welcome");
    expect(open.text).not.toContain("evil");
    expect((await tool(t, TEAMMATE_TOKEN, "read_page", { page: "teampage01" })).data.text).toBe("Team only words");
    expect((await tool(t, TEAMMATE_TOKEN, "read_page", { page: "passpage01" })).data.locked).toBe(true);
    expect((await tool(t, OWNER_TOKEN, "read_page", { page: "ownpass001" })).data.text).toBe("Owner secret words");
    expect((await tool(t, OWNER_TOKEN, "read_page", { page: "nopage0000" })).data).toEqual({ found: false });
  });

  test("gates hold for owners and teammates as in the browser", async () => {
    const t = convexTest(schema, allModules);
    await seed(t);
    // Expired: the browser answers 410 to everyone, the owner included.
    expect((await tool(t, OWNER_TOKEN, "read_page", { page: "expired001" })).data.locked).toBe(true);
    // Both pages are in the teammate's gallery (a team-visible session published them).
    const listed = (await tool(t, TEAMMATE_TOKEN, "list_pages")).data.pages.map((p: any) => p.title);
    expect(listed).toEqual(expect.arrayContaining(["tmpass0001 title", "tmemail001 title"]));
    // A teammate is handed no password or email key (unlockKeys), so those walls hold.
    expect((await tool(t, TEAMMATE_TOKEN, "read_page", { page: "tmpass0001" })).data.locked).toBe(true);
    expect((await tool(t, TEAMMATE_TOKEN, "read_page", { page: "tmemail001" })).data.locked).toBe(true);
    // The owner holds both keys.
    expect((await tool(t, OWNER_TOKEN, "read_page", { page: "tmpass0001" })).data.text).toBe("Teammate must not read");
    expect((await tool(t, OWNER_TOKEN, "read_page", { page: "tmemail001" })).data.text).toBe("Email walled");
  });

  test("the shared admission rule holds the gates on both paths (account and in-page)", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const bySlug = (ctx: any, slug: string) => ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
    await t.run(async (ctx) => {
      // CLI page state and MCP read_page: accountAdmission.
      expect((await accountAdmission(ctx, await bySlug(ctx, "expired001"), ids.owner)).blocked).toBeTruthy();
      expect((await accountAdmission(ctx, await bySlug(ctx, "tmpass0001"), ids.teammate)).blocked).toBeTruthy();
      expect((await accountAdmission(ctx, await bySlug(ctx, "tmpass0001"), ids.owner)).blocked).toBeNull();
      expect((await accountAdmission(ctx, await bySlug(ctx, "teampage01"), ids.teammate)).blocked).toBeNull();
    });
    // Comments and page state from inside a page: pageAdmission, signed in as the teammate.
    await t.withIdentity({ subject: `${ids.teammate}|s` }).run(async (ctx) => {
      const page = await bySlug(ctx, "tmpass0001");
      expect((await pageAdmission(ctx, page, {})).blocked).toBeTruthy();
      // The page they opened by typing the password echoes its k: admitted, as in the browser.
      expect((await pageAdmission(ctx, page, { k: await kTokenFor(page.password_hash, page.slug) })).blocked).toBeNull();
      expect((await pageAdmission(ctx, await bySlug(ctx, "expired001"), {})).blocked).toBeTruthy();
    });
  });

  test("in-app replies reach gated pages for the owner and workspace teammates; reads stay shut", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    // The expired page is the owner's and in the teammate's gallery too.
    await t.run(async (ctx) => {
      const exp = await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", "expired001")).first();
      const conv = await ctx.db.query("conversations").withIndex("by_short_id", (q) => q.eq("short_id", "jxfull1")).first();
      await ctx.db.patch(exp!._id, { session_conversation_id: conv!._id });
    });
    const reply = (who: any, slug: string, fromApp = true) =>
      t.withIdentity({ subject: `${who}|s` }).mutation(api.artifacts.submitComments, {
        slug, author_name: "", deliver: false, comments: [{ text: "reply" }], ...(fromApp ? { from_app: true } : {}),
      });
    // Teammate from Threads on password- and email-gated pages: admitted.
    expect((await reply(ids.teammate, "tmpass0001")) as any).not.toHaveProperty("error");
    expect((await reply(ids.teammate, "tmemail001")) as any).not.toHaveProperty("error");
    // Owner on their expired page: admitted. Teammate on it: not.
    expect((await reply(ids.owner, "expired001")) as any).not.toHaveProperty("error");
    expect((await reply(ids.teammate, "expired001")) as any).toHaveProperty("error");
    // Not from the app (a page's own call without its keys): still refused.
    expect((await reply(ids.teammate, "tmpass0001", false)) as any).toHaveProperty("error");
    // A stranger from the app: refused.
    expect((await reply(ids.stranger, "tmpass0001")) as any).toHaveProperty("error");
    // Reads stay shut: read_page and the shared admission page state uses.
    expect((await tool(t, TEAMMATE_TOKEN, "read_page", { page: "tmpass0001" })).data.locked).toBe(true);
    await t.run(async (ctx) => {
      const page = await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", "tmpass0001")).first();
      expect((await accountAdmission(ctx, page!, ids.teammate)).blocked).toBeTruthy();
    });
  });

  test("a cast token reading through MCP is recorded", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    await tool(t, OWNER_TOKEN, "whoami");
    const conns = await t.withIdentity({ subject: `${ids.owner}|s` }).query(api.mcpAuth.listConnections, {});
    expect(conns.map((c) => [c.kind, c.name])).toEqual([["cast_token", "laptop"]]);
  });
});

describe("mcp oauth", () => {
  const REDIRECT = "http://127.0.0.1:43123/callback";
  const VERIFIER = "v".repeat(50);

  async function connect(t: ReturnType<typeof convexTest>, owner: any) {
    const reg = await t.fetch("/cli/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT] }) });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as any;
    const asOwner = t.withIdentity({ subject: `${owner}|s` });
    const info = await asOwner.query(api.mcpConsent.consentInfo, { client_id, redirect_uri: REDIRECT });
    expect(info).toMatchObject({ client_name: "Claude Code", redirect_host: "this computer" });
    const approved = await asOwner.mutation(api.mcpConsent.approve, { client_id, redirect_uri: REDIRECT, code_challenge: await s256(VERIFIER), code_challenge_method: "S256" });
    if (!("code" in approved)) throw new Error(approved.error);
    return { client_id, code: approved.code, asOwner };
  }

  const tokenCall = (t: ReturnType<typeof convexTest>, params: Record<string, string>) =>
    t.fetch("/cli/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });

  test("discovery documents name the endpoints", async () => {
    const t = convexTest(schema, allModules);
    const meta = (await (await t.fetch("/.well-known/oauth-authorization-server")).json()) as any;
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.registration_endpoint).toBe("https://codecast.test/oauth/register");
    const res = (await (await t.fetch("/.well-known/oauth-protected-resource")).json()) as any;
    expect(res.resource).toBe("https://codecast.test/mcp");
  });

  test("code, token, read, refresh, reuse and disconnect", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const { client_id, code, asOwner } = await connect(t, ids.owner);

    // A wrong verifier burns the code.
    expect((await tokenCall(t, { grant_type: "authorization_code", code, code_verifier: "w".repeat(50), client_id, redirect_uri: REDIRECT })).status).toBe(400);
    expect((await tokenCall(t, { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id, redirect_uri: REDIRECT })).status).toBe(400);

    const second = await connect(t, ids.owner);
    const ok = await tokenCall(t, { grant_type: "authorization_code", code: second.code, code_verifier: VERIFIER, client_id: second.client_id, redirect_uri: REDIRECT });
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as any;
    expect(tokens.access_token.startsWith("cmcp_")).toBe(true);

    expect((await tool(t, tokens.access_token, "read_doc", { id: `doc:${ids.docs.private}` })).data.content).toBe("private doc body");
    expect((await tool(t, tokens.access_token, "read_doc", { id: `doc:${ids.docs.other}` })).data).toEqual({ found: false });

    // A grant token is not a cast token.
    await expect(t.query(api.docs.get, { api_token: tokens.access_token, id: ids.docs.private as any })).rejects.toThrow();

    const refreshed = (await (await tokenCall(t, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: second.client_id })).json()) as any;
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect((await rpc(t, tokens.access_token, "tools/list")).status).toBe(401);
    expect((await rpc(t, refreshed.access_token, "tools/list")).status).toBe(200);

    // Replaying the rotated refresh token ends the grant.
    expect((await tokenCall(t, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: second.client_id })).status).toBe(400);
    expect((await rpc(t, refreshed.access_token, "tools/list")).status).toBe(401);

    // Disconnect from settings.
    const third = await connect(t, ids.owner);
    const fresh = (await (await tokenCall(t, { grant_type: "authorization_code", code: third.code, code_verifier: VERIFIER, client_id: third.client_id, redirect_uri: REDIRECT })).json()) as any;
    expect((await rpc(t, fresh.access_token, "tools/list")).status).toBe(200);
    const conns = await asOwner.query(api.mcpAuth.listConnections, {});
    // Each connect registered a new client, so each holds its own grant; the third is the live one.
    expect(conns.filter((c) => c.kind === "grant").length).toBe(1);
    const grant = conns.find((c) => c.kind === "grant")!;
    expect(grant.name).toBe("Claude Code");
    await t.run((ctx) => disconnectCore(ctx, ids.owner, "grant", grant._id));
    expect((await rpc(t, fresh.access_token, "tools/list")).status).toBe(401);
    void client_id;
  });

  test("connecting the same agent again replaces its grant", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const { client_id, code, asOwner } = await connect(t, ids.owner);
    const first = (await (await tokenCall(t, { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id, redirect_uri: REDIRECT })).json()) as any;
    const again = await asOwner.mutation(api.mcpConsent.approve, { client_id, redirect_uri: REDIRECT, code_challenge: await s256(VERIFIER), code_challenge_method: "S256" });
    if (!("code" in again)) throw new Error(again.error);
    const second = (await (await tokenCall(t, { grant_type: "authorization_code", code: again.code, code_verifier: VERIFIER, client_id, redirect_uri: REDIRECT })).json()) as any;
    expect((await rpc(t, first.access_token, "tools/list")).status).toBe(401);
    expect((await rpc(t, second.access_token, "tools/list")).status).toBe(200);
    expect((await asOwner.query(api.mcpAuth.listConnections, {})).filter((c) => c.kind === "grant").length).toBe(1);
  });

  test("approve refuses an unregistered return address and a plain challenge", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const reg = (await (await t.fetch("/cli/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "x", redirect_uris: [REDIRECT] }) })).json()) as any;
    const asOwner = t.withIdentity({ subject: `${ids.owner}|s` });
    const elsewhere = await asOwner.mutation(api.mcpConsent.approve, { client_id: reg.client_id, redirect_uri: "https://evil.test/cb", code_challenge: await s256(VERIFIER), code_challenge_method: "S256" });
    expect("error" in elsewhere).toBe(true);
    const plain = await asOwner.mutation(api.mcpConsent.approve, { client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: VERIFIER, code_challenge_method: "plain" });
    expect("error" in plain).toBe(true);
  });
});

describe("abuse limits", () => {
  test("registration is limited per caller address, keyed on the rightmost forwarded address", async () => {
    const t = convexTest(schema, allModules);
    const reg = (xff: string) => t.fetch("/cli/oauth/register", { method: "POST", headers: { "x-forwarded-for": xff }, body: JSON.stringify({ client_name: "x", redirect_uris: ["http://127.0.0.1:1/cb"] }) });
    let last = 0;
    for (let i = 0; i <= REGISTER_PER_HOUR; i++) last = (await reg(`10.0.${i >> 8}.${i & 255}, 198.51.100.7`)).status;
    // A rotating spoofed first hop does not buy a fresh window.
    expect(last).toBe(429);
  });

  test("through codecast.sh, registration is limited per signed caller address, not per proxy", async () => {
    process.env.MCP_FORWARD_SECRET = "fwd-secret";
    try {
      const t = convexTest(schema, allModules);
      // Every request arrives from the web server's address; the signed caller differs.
      const reg = async (caller: string, sig?: string) =>
        (await t.fetch("/cli/oauth/register", {
          method: "POST",
          headers: { "x-forwarded-for": "198.51.100.7", [MCP_CALLER_IP_HEADER]: caller, [MCP_CALLER_SIG_HEADER]: sig ?? (await signCallerAddress("fwd-secret", caller)) },
          body: JSON.stringify({ client_name: "x", redirect_uris: ["http://127.0.0.1:1/cb"] }),
        })).status;
      let last = 0;
      for (let i = 0; i <= REGISTER_PER_HOUR; i++) last = await reg("203.0.113.1");
      expect(last).toBe(429);
      // Another caller behind the same proxy still registers.
      expect(await reg("203.0.113.2")).toBe(201);
      // A forged signature is ignored: the request counts against the proxy's own address.
      expect(await reg("203.0.113.3", "forged")).toBe(201);
    } finally {
      delete process.env.MCP_FORWARD_SECRET;
    }
  });

  test("a global ceiling backs the per-address limit", async () => {
    const t = convexTest(schema, allModules);
    await t.run((ctx) => ctx.db.insert("ip_rate_limits", { key: "mcp_register:all", count: REGISTER_GLOBAL_PER_HOUR, window_start: Date.now() } as any));
    const res = await t.fetch("/cli/oauth/register", { method: "POST", headers: { "x-forwarded-for": "192.0.2.50" }, body: JSON.stringify({ client_name: "x", redirect_uris: ["http://127.0.0.1:1/cb"] }) });
    expect(res.status).toBe(429);
  });

  test("approve is limited per person", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const redirect = "http://127.0.0.1:1/cb";
    const reg = (await (await t.fetch("/cli/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "x", redirect_uris: [redirect] }) })).json()) as any;
    const as = t.withIdentity({ subject: `${ids.owner}|s` });
    let refused = false;
    for (let i = 0; i < 80 && !refused; i++) {
      const out = await as.mutation(api.mcpConsent.approve, { client_id: reg.client_id, redirect_uri: redirect, code_challenge: await s256("v".repeat(50)), code_challenge_method: "S256" });
      refused = "error" in out;
    }
    expect(refused).toBe(true);
  });

  test("/mcp refuses an oversized batch and limits calls per connection", async () => {
    const t = convexTest(schema, allModules);
    await seed(t);
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const big = await t.fetch("/cli/mcp", { method: "POST", headers: { Authorization: `Bearer ${OWNER_TOKEN}` }, body: JSON.stringify(batch) });
    expect(big.status).toBe(400);
    let status = 200;
    for (let i = 0; i < 400 && status === 200; i++) status = (await rpc(t, OWNER_TOKEN, "ping")).status;
    expect(status).toBe(429);
  });

  test("the sweep removes expired codes, unapproved clients past a day and lapsed grants, by index", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert("mcp_clients", { client_id: "stale", client_name: "s", redirect_uris: ["http://127.0.0.1:1/cb"], created_at: old });
      await ctx.db.insert("mcp_clients", { client_id: "kept", client_name: "k", redirect_uris: ["http://127.0.0.1:1/cb"], created_at: old, approved_at: old });
      await ctx.db.insert("mcp_auth_codes", { code_hash: "h", client_id: "kept", user_id: ids.owner, redirect_uri: "x", code_challenge: "c", scope: "read", expires_at: old });
      await ctx.db.insert("mcp_grants", { user_id: ids.owner, client_id: "kept", client_name: "k", redirect_host: "h", scope: "read", created_at: old, access_hash: "a", access_expires_at: old, refresh_hash: "r", refresh_expires_at: old });
    });
    await t.mutation(internal.mcpAuth.sweep, {});
    await t.run(async (ctx) => {
      expect((await ctx.db.query("mcp_clients").collect()).map((c) => c.client_id)).toEqual(["kept"]);
      expect(await ctx.db.query("mcp_auth_codes").collect()).toEqual([]);
      expect(await ctx.db.query("mcp_grants").collect()).toEqual([]);
    });
  });
});

describe("consent identity", () => {
  test("names the return host first and flags an https host this person has not connected before", async () => {
    const t = convexTest(schema, allModules);
    const ids = await seed(t);
    const redirect = "https://agent.example/cb";
    const reg = (await (await t.fetch("/cli/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect] }) })).json()) as any;
    const as = t.withIdentity({ subject: `${ids.owner}|s` });
    const first = await as.query(api.mcpConsent.consentInfo, { client_id: reg.client_id, redirect_uri: redirect });
    expect(first).toMatchObject({ redirect_host: "agent.example", client_name: "Claude", new_host: true });
    await t.run((ctx) => ctx.db.insert("mcp_grants", { user_id: ids.owner, client_id: reg.client_id, client_name: "Claude", redirect_host: "agent.example", scope: "read", created_at: 1, access_hash: "a", access_expires_at: Date.now() + 1e6, refresh_hash: "r", refresh_expires_at: Date.now() + 1e9 }));
    const again = await as.query(api.mcpConsent.consentInfo, { client_id: reg.client_id, redirect_uri: redirect });
    expect(again).toMatchObject({ new_host: false });
  });
});

describe("routes", () => {
  test("every public MCP path codecast.sh forwards has a backend route", async () => {
    const t = convexTest(schema, allModules);
    for (const backend of Object.values(MCP_ROUTES)) {
      const method = backend.includes("well-known") ? "GET" : "POST";
      const res = await t.fetch(backend, { method, body: method === "POST" ? "{}" : undefined });
      expect({ backend, status: res.status }).not.toEqual({ backend, status: 404 });
    }
  });
});

describe("pure helpers", () => {
  test("redirect URIs", () => {
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriAllowed("http://localhost:3000/cb")).toBe(true);
    expect(redirectUriAllowed("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(redirectUriAllowed("http://evil.test/cb")).toBe(false);
    expect(redirectUriAllowed("javascript:alert(1)")).toBe(false);
    expect(redirectUriAllowed("https://x.test/cb#frag")).toBe(false);
  });
  test("page refs", () => {
    expect(pageSlug("https://codecast.sh/a/abcDEF123?v=2")).toBe("abcDEF123");
    expect(pageSlug("abcDEF123")).toBe("abcDEF123");
    expect(pageSlug("https://codecast.sh/docs/x")).toBe(null);
  });
  test("html to text", () => {
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });
});
