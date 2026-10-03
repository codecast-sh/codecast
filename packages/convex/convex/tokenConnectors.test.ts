import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  TOKEN_PROVIDERS,
  TOKEN_CONNECTION_HKDF_INFO,
  TOKEN_CONNECTIONS_NOT_CONFIGURED,
  connectWithToken,
  decryptConnectionSecret,
  encryptConnectionSecret,
  getTokenCredential,
  normalizeBaseUrl,
  parseToken,
  parseTokenConfig,
  storeTokenConnection,
  tokenConnectionFor,
  tokenConnectionRow,
  validateToken,
} from "./tokenConnectors";
import { encryptRefreshToken, decryptRefreshToken } from "./googleOAuth";
import { APP_DESCRIPTORS, APP_INSTALLATION_APPS } from "@codecast/shared/contracts";

// Token connectors reuse the OAuth connectors' table, crypto and membership
// rule; these tests pin what is theirs: the config each provider accepts, the
// one validate call, the key separation, and that a stored row is confirmed,
// member-gated and never handed back with its secret.

const OWNER = "u_owner";
const TEAM = "team_1";
const KEY = "test-connection-secrets-key";

const tables = () => ({
  users: [{ _id: OWNER }, { _id: "u_stranger" }],
  teams: [{ _id: TEAM }],
  team_memberships: [{ _id: "tm_owner", user_id: OWNER, team_id: TEAM }],
  app_installations: [] as any[],
});
const dbCtx = (t: Record<string, any[]>) => ({ db: makeFakeDb(t) }) as any;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("provider table", () => {
  test("every token provider has a token-paste descriptor and is an app_installations app", () => {
    for (const id of Object.keys(TOKEN_PROVIDERS) as (keyof typeof TOKEN_PROVIDERS)[]) {
      expect(APP_DESCRIPTORS[id].connectKind).toBe("token-paste");
      expect(APP_DESCRIPTORS[id].tokenConfig?.length).toBeGreaterThan(0);
      expect(APP_INSTALLATION_APPS).toContain(id);
      // Every URL key the provider normalizes is a field its descriptor declares.
      for (const key of TOKEN_PROVIDERS[id].urlKeys) {
        expect(APP_DESCRIPTORS[id].tokenConfig!.some((f) => f.key === key)).toBe(true);
      }
    }
  });

  test("every config field has a distinct key and flag within its provider", () => {
    for (const d of Object.values(APP_DESCRIPTORS)) {
      const fields = d.tokenConfig ?? [];
      expect(new Set(fields.map((f) => f.key)).size).toBe(fields.length);
      expect(new Set(fields.map((f) => f.flag)).size).toBe(fields.length);
    }
  });
});

describe("parseToken", () => {
  test("trims a paste and refuses spaces, line breaks, and nothing", () => {
    expect(parseToken("  sntrys_abc  ")).toEqual({ ok: true, token: "sntrys_abc" });
    expect(parseToken("").ok).toBe(false);
    expect(parseToken("two words").ok).toBe(false);
    expect(parseToken("abc\ndef").ok).toBe(false);
    expect(parseToken("x".repeat(5000)).ok).toBe(false);
  });
});

describe("normalizeBaseUrl", () => {
  test("https only, no credentials, query or fragment, no trailing slash", () => {
    expect(normalizeBaseUrl("https://sentry.example.com/")).toBe("https://sentry.example.com");
    expect(normalizeBaseUrl("https://api.example.com/v2/")).toBe("https://api.example.com/v2");
    expect(normalizeBaseUrl("http://api.example.com")).toBeNull();
    expect(normalizeBaseUrl("https://user:pw@api.example.com")).toBeNull();
    expect(normalizeBaseUrl("https://api.example.com/?a=1")).toBeNull();
    expect(normalizeBaseUrl("https://api.example.com/#x")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
  });
});

describe("parseTokenConfig", () => {
  test("sentry: org required, host defaults to sentry.io", () => {
    expect(parseTokenConfig("sentry", { org: "acme" })).toEqual({ ok: true, config: { org: "acme", host: "https://sentry.io" } });
    expect(parseTokenConfig("sentry", {})).toEqual({ ok: false, error: "Organization slug is required" });
    expect(parseTokenConfig("sentry", { org: "acme", host: "https://sentry.acme.dev/" })).toEqual({
      ok: true,
      config: { org: "acme", host: "https://sentry.acme.dev" },
    });
  });

  test("sentry: a slug cannot steer the validate URL to another path", () => {
    expect(parseTokenConfig("sentry", { org: "../users" }).ok).toBe(false);
    expect(parseTokenConfig("sentry", { org: "acme/projects" }).ok).toBe(false);
  });

  test("posthog: numeric project id required, host defaults to us.posthog.com", () => {
    expect(parseTokenConfig("posthog", { project_id: "123" })).toEqual({
      ok: true,
      config: { project_id: "123", host: "https://us.posthog.com" },
    });
    expect(parseTokenConfig("posthog", { project_id: "abc" }).ok).toBe(false);
    expect(parseTokenConfig("posthog", {}).ok).toBe(false);
  });

  test("app: base_url required and https", () => {
    expect(parseTokenConfig("app", { base_url: "https://api.acme.com/" })).toEqual({
      ok: true,
      config: { base_url: "https://api.acme.com" },
    });
    expect(parseTokenConfig("app", {}).ok).toBe(false);
    const http = parseTokenConfig("app", { base_url: "http://api.acme.com" });
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.error).toMatch(/https/);
  });

  test("an unknown key is refused, so a misplaced secret never lands in the clear config", () => {
    const res = parseTokenConfig("sentry", { org: "acme", token: "sntrys_secret" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Unknown setting "token"/);
  });
});

describe("validateToken", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (res: Response | Error) => async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (res instanceof Error) throw res;
    return res;
  };
  beforeEach(() => {
    calls.length = 0;
  });

  test("sentry: GETs the organization with the bearer token and reads its name and id", async () => {
    const res = await validateToken(
      "sentry",
      "tok",
      { org: "acme", host: "https://sentry.io" },
      fakeFetch(jsonResponse(200, { id: "42", slug: "acme", name: "Acme Inc" })),
    );
    expect(res).toEqual({ ok: true, label: "Acme Inc", account_id: "42" });
    expect(calls[0].url).toBe("https://sentry.io/api/0/organizations/acme/");
    expect((calls[0].init.headers as any).Authorization).toBe("Bearer tok");
    // A token is never carried across a redirect to a host nobody named.
    expect(calls[0].init.redirect).toBe("manual");
  });

  test("posthog: GETs the project on the configured host", async () => {
    const res = await validateToken(
      "posthog",
      "phx_tok",
      { project_id: "7", host: "https://eu.posthog.com" },
      fakeFetch(jsonResponse(200, { id: 7, name: "Web" })),
    );
    expect(res).toEqual({ ok: true, label: "Web", account_id: "7" });
    expect(calls[0].url).toBe("https://eu.posthog.com/api/projects/7/");
  });

  test("app: GETs /codecast/manifest and labels the connection by the manifest name", async () => {
    const res = await validateToken(
      "app",
      "secret",
      { base_url: "https://api.acme.com" },
      fakeFetch(jsonResponse(200, { name: "Union", version: "1", readers: [], actions: [] })),
    );
    expect(res).toEqual({ ok: true, label: "Union", account_id: "https://api.acme.com" });
    expect(calls[0].url).toBe("https://api.acme.com/codecast/manifest");
  });

  test("an answer that is not the provider's shape is refused, not stored unlabeled", async () => {
    const res = await validateToken("app", "s", { base_url: "https://x.com" }, fakeFetch(jsonResponse(200, { hello: 1 })));
    expect(res.ok).toBe(false);
    const html = await validateToken(
      "sentry",
      "s",
      { org: "a", host: "https://sentry.io" },
      fakeFetch(new Response("<html>", { status: 200 })),
    );
    expect(html.ok).toBe(false);
  });

  test("refusals name the status; no message carries the token", async () => {
    const cases: [Response | Error, RegExp][] = [
      [jsonResponse(401, {}), /refused the token \(401\)/],
      [jsonResponse(403, {}), /refused the token \(403\)/],
      [jsonResponse(404, {}), /has no organization/],
      [jsonResponse(500, {}), /answered 500/],
      [new Response(null, { status: 302, headers: { location: "https://elsewhere.example/login" } }), /redirected.*elsewhere/],
      [new Error("ECONNREFUSED"), /Could not reach Sentry/],
    ];
    for (const [answer, pattern] of cases) {
      const res = await validateToken("sentry", "SECRET_TOKEN_VALUE", { org: "acme", host: "https://sentry.io" }, fakeFetch(answer));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(pattern);
        expect(res.error).not.toContain("SECRET_TOKEN_VALUE");
      }
    }
  });
});

describe("encryption", () => {
  test("round trips under the token info string, and is separated from the OAuth key family", async () => {
    const enc = await encryptConnectionSecret("sntrys_abc", KEY);
    expect(await decryptConnectionSecret(enc, KEY)).toBe("sntrys_abc");
    // Same secret, default (Google refresh-token) info: does not decrypt.
    expect(await decryptRefreshToken(enc, KEY)).toBeNull();
    // And an OAuth ciphertext does not decrypt as a token connection.
    const oauth = await encryptRefreshToken("refresh", KEY);
    expect(await decryptConnectionSecret(oauth, KEY)).toBeNull();
    expect(await decryptRefreshToken(oauth, KEY)).toBe("refresh");
    expect(TOKEN_CONNECTION_HKDF_INFO).toBe("codecast-token-connection-v1");
  });
});

describe("storeTokenConnection", () => {
  const base = {
    provider: "sentry",
    user_id: OWNER,
    team_id: TEAM,
    access_token_enc: "enc-1",
    config: { org: "acme", host: "https://sentry.io" },
    account_label: "Acme",
    account_id: "42",
  };

  test("stores a CONFIRMED row for a team member", async () => {
    const t = tables();
    const res = await (storeTokenConnection as any)._handler(dbCtx(t), base);
    expect(res.ok).toBe(true);
    const row = t.app_installations[0];
    expect(row.provider).toBe("sentry");
    expect(row.team_id).toBe(TEAM);
    expect(row.scope_user_id).toBeUndefined();
    expect(row.pending_confirm_hash).toBeUndefined();
    expect(row.config).toEqual({ org: "acme", host: "https://sentry.io" });
  });

  test("a caller who is not a member of the team stores nothing", async () => {
    const t = tables();
    const res = await (storeTokenConnection as any)._handler(dbCtx(t), { ...base, user_id: "u_stranger" });
    expect(res).toEqual({ ok: false, error: "not_a_member" });
    expect(t.app_installations).toHaveLength(0);
  });

  test("personal scope binds to the caller alone", async () => {
    const t = tables();
    const res = await (storeTokenConnection as any)._handler(dbCtx(t), { ...base, team_id: undefined, user_id: "u_stranger" });
    expect(res.ok).toBe(true);
    expect(t.app_installations[0].scope_user_id).toBe("u_stranger");
    expect(t.app_installations[0].team_id).toBeUndefined();
  });

  test("a reconnect replaces the credential whole on the same row", async () => {
    const t = tables();
    t.app_installations.push({
      _id: "ai_1", provider: "sentry", team_id: TEAM, connected_by: "u_other", access_token_enc: "old",
      config: { org: "old" }, last_error: "401", pending_confirm_hash: "h", granted_scopes: [], created_at: 1, updated_at: 1,
    });
    const res = await (storeTokenConnection as any)._handler(dbCtx(t), base);
    expect(res).toEqual({ ok: true, id: "ai_1" });
    expect(t.app_installations).toHaveLength(1);
    const row = t.app_installations[0];
    expect(row.access_token_enc).toBe("enc-1");
    expect(row.connected_by).toBe(OWNER);
    expect(row.config.org).toBe("acme");
    expect(row.last_error).toBeUndefined();
    expect(row.pending_confirm_hash).toBeUndefined();
    expect(row.created_at).toBe(1);
  });

  test("refuses a provider that is not a token connector", async () => {
    const res = await (storeTokenConnection as any)._handler(dbCtx(tables()), { ...base, provider: "linear" });
    expect(res.ok).toBe(false);
  });
});

describe("connectWithToken", () => {
  const realFetch = globalThis.fetch;
  let fetched: string[] = [];
  beforeEach(() => {
    fetched = [];
    process.env.CONNECTION_SECRETS_KEY = KEY;
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      return jsonResponse(200, { id: "42", slug: "acme", name: "Acme Inc" });
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CONNECTION_SECRETS_KEY;
  });

  const actionCtx = (t: Record<string, any[]>, me: any = { user_id: OWNER, team_id: TEAM }) => {
    const inner = dbCtx(t);
    return {
      runQuery: async () => me,
      runMutation: async (_ref: any, args: any) => (storeTokenConnection as any)._handler(inner, args),
    } as any;
  };

  test("validates, encrypts and stores; the answer carries the id and label, never the token", async () => {
    const t = tables();
    const res = await (connectWithToken as any)._handler(actionCtx(t), {
      provider: "sentry",
      token: "sntrys_SECRET",
      config: { org: "acme" },
    });
    expect(res.ok).toBe(true);
    expect(res.label).toBe("Acme Inc");
    expect(JSON.stringify(res)).not.toContain("sntrys_SECRET");
    expect(fetched).toEqual(["https://sentry.io/api/0/organizations/acme/"]);
    const row = t.app_installations[0];
    expect(row.access_token_enc).not.toContain("sntrys_SECRET");
    expect(await decryptConnectionSecret(row.access_token_enc, KEY)).toBe("sntrys_SECRET");
    expect(row.account_label).toBe("Acme Inc");
  });

  test("without CONNECTION_SECRETS_KEY it says so and calls nobody", async () => {
    delete process.env.CONNECTION_SECRETS_KEY;
    const t = tables();
    const res = await (connectWithToken as any)._handler(actionCtx(t), { provider: "sentry", token: "t", config: { org: "acme" } });
    expect(res).toEqual({ ok: false, error: TOKEN_CONNECTIONS_NOT_CONFIGURED });
    expect(res.error).toMatch(/not configured/);
    expect(fetched).toHaveLength(0);
    expect(t.app_installations).toHaveLength(0);
  });

  test("a signed-out caller and an unknown provider are refused before any call", async () => {
    expect((await (connectWithToken as any)._handler(actionCtx(tables(), null), { provider: "sentry", token: "t" })).error).toBe("not signed in");
    expect((await (connectWithToken as any)._handler(actionCtx(tables()), { provider: "linear", token: "t" })).ok).toBe(false);
    expect(fetched).toHaveLength(0);
  });

  test("team scope with no team points at the personal path", async () => {
    const res = await (connectWithToken as any)._handler(actionCtx(tables(), { user_id: OWNER, team_id: null }), {
      provider: "sentry",
      token: "t",
      config: { org: "acme" },
    });
    expect(res.error).toMatch(/personally/);
  });

  test("a refused token stores nothing", async () => {
    globalThis.fetch = (async () => jsonResponse(401, {})) as any;
    const t = tables();
    const res = await (connectWithToken as any)._handler(actionCtx(t), { provider: "sentry", token: "bad", config: { org: "acme" } });
    expect(res.ok).toBe(false);
    expect(t.app_installations).toHaveLength(0);
  });
});

describe("resolve and read", () => {
  afterEach(() => {
    delete process.env.CONNECTION_SECRETS_KEY;
  });

  test("tokenConnectionFor prefers the team's row, falls back to the person's, and returns no secret", async () => {
    const team = { _id: "ai_team", provider: "sentry", team_id: TEAM, connected_by: OWNER, access_token_enc: "ENC_TEAM", config: { org: "t" }, granted_scopes: [], created_at: 1, updated_at: 1 };
    const mine = { _id: "ai_me", provider: "sentry", scope_user_id: OWNER, connected_by: OWNER, access_token_enc: "ENC_ME", config: { org: "m" }, granted_scopes: [], created_at: 1, updated_at: 1 };
    const c = dbCtx({ app_installations: [team, mine] });
    const viaTeam = await (tokenConnectionFor as any)._handler(c, { provider: "sentry", team_id: TEAM, user_id: OWNER });
    expect(viaTeam).toMatchObject({ connection_id: "ai_team", scope: "team", config: { org: "t" } });
    expect(JSON.stringify(viaTeam)).not.toContain("ENC_TEAM");
    const viaMe = await (tokenConnectionFor as any)._handler(c, { provider: "sentry", team_id: "team_other", user_id: OWNER });
    expect(viaMe).toMatchObject({ connection_id: "ai_me", scope: "personal" });
    expect(await (tokenConnectionFor as any)._handler(c, { provider: "linear", team_id: TEAM })).toBeNull();
  });

  test("getTokenCredential decrypts a token row and refuses OAuth and pending rows", async () => {
    process.env.CONNECTION_SECRETS_KEY = KEY;
    const enc = await encryptConnectionSecret("phx_SECRET", KEY);
    const rows = [
      { _id: "ai_ph", provider: "posthog", team_id: TEAM, connected_by: OWNER, access_token_enc: enc, config: { project_id: "7", host: "https://us.posthog.com" }, granted_scopes: [], created_at: 1, updated_at: 1 },
      { _id: "ai_lin", provider: "linear", team_id: TEAM, connected_by: OWNER, access_token_enc: enc, granted_scopes: [], created_at: 1, updated_at: 1 },
      { _id: "ai_pend", provider: "sentry", team_id: TEAM, connected_by: OWNER, access_token_enc: enc, pending_confirm_hash: "h", granted_scopes: [], created_at: 1, updated_at: 1 },
    ];
    const inner = dbCtx({ app_installations: rows });
    const c = { runQuery: async (_ref: any, args: any) => (tokenConnectionRow as any)._handler(inner, args) } as any;
    expect(await (getTokenCredential as any)._handler(c, { connection_id: "ai_ph" })).toEqual({
      ok: true,
      provider: "posthog",
      token: "phx_SECRET",
      config: { project_id: "7", host: "https://us.posthog.com" },
    });
    expect((await (getTokenCredential as any)._handler(c, { connection_id: "ai_lin" })).ok).toBe(false);
    expect((await (getTokenCredential as any)._handler(c, { connection_id: "ai_pend" })).ok).toBe(false);
    expect((await (getTokenCredential as any)._handler(c, { connection_id: "ai_gone" })).ok).toBe(false);

    process.env.CONNECTION_SECRETS_KEY = "rotated-key";
    const rotated = await (getTokenCredential as any)._handler(c, { connection_id: "ai_ph" });
    expect(rotated.ok).toBe(false);
    expect(rotated.error).toMatch(/reconnect PostHog/);
  });
});
