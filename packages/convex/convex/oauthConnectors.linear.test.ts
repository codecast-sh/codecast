import { afterEach, describe, expect, test } from "bun:test";
import { PROVIDERS, callbackHandler } from "./oauthConnectors";
import { signStateWith } from "./lib/hmac";

const OWNER = "u_owner";
const TEAM = "team_1";

describe("Linear profile", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const respondWith = (data: any) => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data }))) as any;
  };
  const org = { id: "org_1", name: "Acme", urlKey: "acme" };

  test("returns the label, the org id and the app user id", async () => {
    respondWith({ organization: org, viewer: { id: "app_1" } });
    expect(await PROVIDERS.linear.profile("tok")).toEqual({ label: "Acme", id: "org_1", appUserId: "app_1" });
  });

  test("a null viewer keeps the org label and id", async () => {
    respondWith({ organization: org, viewer: null });
    expect(await PROVIDERS.linear.profile("tok")).toEqual({ label: "Acme", id: "org_1" });
  });

  test("the callback hands the profile's app user id to storeConnection", async () => {
    const saved = { id: process.env.LINEAR_OAUTH_CLIENT_ID, secret: process.env.LINEAR_OAUTH_CLIENT_SECRET };
    process.env.LINEAR_OAUTH_CLIENT_ID = "linear-client-id";
    process.env.LINEAR_OAUTH_CLIENT_SECRET = "linear-client-secret";
    globalThis.fetch = (async (url: any) => {
      if (String(url) === "https://api.linear.app/oauth/token") {
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 86400, scope: "read,write,comments:create,app:assignable" }));
      }
      return new Response(JSON.stringify({ data: { organization: org, viewer: { id: "app_1" } } }));
    }) as any;
    let captured: any;
    const runMutation = async (_fn: any, args: any) => {
      captured = args;
      return { ok: true, id: "ai_1" };
    };
    try {
      const state = await signStateWith("linear-client-secret", {
        provider: "linear", user_id: OWNER, scope: "team", team_id: TEAM, nonce: "n1", ts: Date.now(),
      });
      const resp = await callbackHandler({ runMutation }, new Request(`https://convex.codecast.sh/cb?code=c&state=${encodeURIComponent(state)}`));
      expect(resp.status).toBe(302);
      expect(captured.app_user_id).toBe("app_1");
      expect(captured.account_id).toBe("org_1");
    } finally {
      for (const [key, value] of [["LINEAR_OAUTH_CLIENT_ID", saved.id], ["LINEAR_OAUTH_CLIENT_SECRET", saved.secret]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
