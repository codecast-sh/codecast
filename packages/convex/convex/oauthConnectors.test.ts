import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { PROVIDERS, storeConnection, finishConfirm, deleteConnection } from "./oauthConnectors";

// The generic connector shares Google's security design; these tests pin the
// PROVIDER TABLE (a new connector must be a config, not a fork) and the
// two-phase confirm on the shared table.

const OWNER = "u_owner";
const TEAM = "team_1";
const ctx = (t: Record<string, any[]>) => ({ db: makeFakeDb(t) }) as any;

describe("PROVIDERS", () => {
  test("every provider is fully specified", () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(p.authorizeUrl.startsWith("https://")).toBe(true);
      expect(p.tokenUrl.startsWith("https://")).toBe(true);
      expect(p.env.clientId).toMatch(/_OAUTH_CLIENT_ID$/);
      expect(p.env.clientSecret).toMatch(/_OAUTH_CLIENT_SECRET$/);
      expect(["body", "basic"]).toContain(p.tokenAuth);
    }
  });

  test("scopes stay minimal — no write scopes beyond what an agent needs", () => {
    // Linear: read + create issues/comments. Never admin, never delete.
    expect(PROVIDERS.linear.scopes).toEqual(["read", "issues:create", "comments:create"]);
    // Notion: access is per-page the user shares; the OAuth has no scope string.
    expect(PROVIDERS.notion.scopes).toEqual([]);
  });
});

describe("storeConnection + finishConfirm", () => {
  const base = {
    provider: "linear",
    user_id: OWNER,
    team_id: TEAM,
    account_label: "Acme",
    access_token_enc: "enc-token",
    granted_scopes: ["read"],
    pending_confirm_hash: "hash-1",
  };
  const t0 = () => ({
    users: [{ _id: OWNER }],
    teams: [{ _id: TEAM }],
    app_installations: [] as any[],
  });

  test("a stored row is PENDING until confirmed with the right token by the right user", async () => {
    const t = t0();
    const c = ctx(t);
    const stored = await (storeConnection as any)._handler(c, base);
    expect(stored.ok).toBe(true);
    expect(t.app_installations[0].pending_confirm_hash).toBe("hash-1");

    // Wrong token: still pending, not deleted (the real browser may still confirm).
    const wrong = await (finishConfirm as any)._handler(c, { user_id: OWNER, installation_id: stored.id, token_hash: "nope" });
    expect(wrong.ok).toBe(false);
    expect(t.app_installations[0].pending_confirm_hash).toBe("hash-1");

    // Wrong user with the right token: refused — the relay-attack case.
    const relay = await (finishConfirm as any)._handler(c, { user_id: "u_attacker", installation_id: stored.id, token_hash: "hash-1" });
    expect(relay.ok).toBe(false);

    // Right user, right token: confirmed.
    const ok = await (finishConfirm as any)._handler(c, { user_id: OWNER, installation_id: stored.id, token_hash: "hash-1" });
    expect(ok.ok).toBe(true);
    expect(t.app_installations[0].pending_confirm_hash).toBeUndefined();
  });

  test("re-connecting the same team upserts one row, never two", async () => {
    const t = t0();
    const c = ctx(t);
    await (storeConnection as any)._handler(c, base);
    await (storeConnection as any)._handler(c, { ...base, access_token_enc: "enc-token-2", pending_confirm_hash: "hash-2" });
    expect(t.app_installations).toHaveLength(1);
    expect(t.app_installations[0].access_token_enc).toBe("enc-token-2");
  });

  test("an expired pending row is deleted on confirm, not left as a live grant", async () => {
    const t = t0();
    t.app_installations.push({
      _id: "ai_old", provider: "linear", team_id: TEAM, connected_by: OWNER, access_token_enc: "enc",
      granted_scopes: [], pending_confirm_hash: "h", pending_expires_at: 1, created_at: 1, updated_at: 1,
    });
    const res = await (finishConfirm as any)._handler(ctx(t), { user_id: OWNER, installation_id: "ai_old", token_hash: "h" });
    expect(res.ok).toBe(false);
    expect(t.app_installations).toHaveLength(0);
  });

  test("any team member may disconnect; a non-member may not", async () => {
    const t = {
      ...t0(),
      users: [{ _id: OWNER }, { _id: "u_member" }, { _id: "u_stranger" }],
      team_memberships: [{ _id: "tm1", team_id: TEAM, user_id: "u_member" }],
      app_installations: [{ _id: "ai_1", provider: "linear", team_id: TEAM, connected_by: OWNER, access_token_enc: "enc", granted_scopes: [], created_at: 1, updated_at: 1 }],
    };
    const c = ctx(t);
    const outsider = await (deleteConnection as any)._handler(c, { user_id: "u_stranger", installation_id: "ai_1" });
    expect(outsider.ok).toBe(false);
    expect(t.app_installations).toHaveLength(1);
    const member = await (deleteConnection as any)._handler(c, { user_id: "u_member", installation_id: "ai_1" });
    expect(member.ok).toBe(true);
    expect(t.app_installations).toHaveLength(0);
  });
});
