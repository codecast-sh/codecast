// Codecast for outside agents: the /mcp read tools answer exactly what the
// account can read in the app, and the OAuth path (register, consent, code,
// token, refresh, disconnect) holds its rules. docs/architecture/agent-mcp.md.
import { beforeAll, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { disconnectCore, redirectUriAllowed, s256 } from "./mcpAuth";
import { pageSlug } from "./mcpTools";
import { htmlToText } from "./lib/htmlText";
import { MCP_ROUTES } from "@codecast/shared/contracts";

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
    await session("jxfull1", { is_private: false, team_visibility: "full" });
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
