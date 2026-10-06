// Regression guard for the 2026-08-02 sweep.
//
// This deployment has NO global auth gate: every exported query/mutation/action
// is callable by anyone who knows the deployment URL. Two public queries were
// returning the RAW `users` row, and that row carries github_access_token,
// encryption_master_key and push_token alongside the profile fields — so a
// single unauthenticated call yielded another user's GitHub credentials.
// Verified exploitable against production before the fix.
//
// These tests assert the shape, not the implementation: whatever a public
// function returns for a user, the secret-bearing fields must never be in it.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getUserByUsername } from "./users";
import { getUserByGithubId } from "./teams";
import * as commits from "./commits";
import { getCommitBySha } from "./commits";
import { analyzeMessageRoles } from "./migrations";
import { listConnections } from "./appConnections";
import { cliConnectToken } from "./integrations";
import * as tokenConnectors from "./tokenConnectors";
import * as appConnector from "./sources/app";

// Every field on `users` that must never cross a public boundary.
const SECRET_FIELDS = [
  "github_access_token",
  "encryption_master_key",
  "push_token",
  "email",
  "alternate_emails",
] as const;

const VICTIM = "u_victim";
const STRANGER = "u_stranger";

function ctx(userId: string | null, tables: Record<string, any[]>) {
  return {
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
  } as any;
}

function tables(extra: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    users: [
      {
        _id: VICTIM,
        name: "Victim",
        username: "victim",
        github_username: "victim-gh",
        github_id: "12345",
        public_profile_enabled: true,
        github_avatar_url: "https://example.invalid/a.png",
        // The secrets that share the row:
        github_access_token: "gho_REAL_TOKEN_VALUE",
        encryption_master_key: "MASTER_KEY_VALUE",
        push_token: "PUSH_TOKEN_VALUE",
        email: "victim@example.invalid",
        alternate_emails: ["alt@example.invalid"],
      },
      { _id: STRANGER, name: "Stranger" },
    ],
    teams: [],
    team_memberships: [],
    ...extra,
  };
}

function assertNoSecrets(returned: unknown, label: string) {
  expect(returned).toBeTruthy();
  const keys = Object.keys(returned as Record<string, unknown>);
  for (const field of SECRET_FIELDS) {
    expect(`${label} leaked ${field}: ${keys.includes(field)}`).toBe(`${label} leaked ${field}: false`);
  }
  // Belt and braces: the literal secret values must not appear anywhere in the
  // serialized payload, even under a renamed or nested key.
  const serialized = JSON.stringify(returned);
  for (const secret of ["gho_REAL_TOKEN_VALUE", "MASTER_KEY_VALUE", "PUSH_TOKEN_VALUE"]) {
    expect(`${label} contains ${secret}: ${serialized.includes(secret)}`).toBe(
      `${label} contains ${secret}: false`,
    );
  }
}

describe("public functions never return the raw users row", () => {
  test("getUserByUsername by github username withholds every secret", async () => {
    const r = await (getUserByUsername as any)._handler(ctx(null, tables()), { username: "victim-gh" });
    assertNoSecrets(r, "getUserByUsername(username)");
    // The profile page still gets what it renders.
    expect(r.name).toBe("Victim");
    expect(r.github_username).toBe("victim-gh");
    expect(r.github_avatar_url).toBe("https://example.invalid/a.png");
  });

  test("getUserByUsername by user_id withholds every secret", async () => {
    const r = await (getUserByUsername as any)._handler(ctx(null, tables()), { user_id: VICTIM });
    assertNoSecrets(r, "getUserByUsername(user_id)");
  });

  test("getUserByUsername by display-name fallback withholds every secret", async () => {
    // The third lookup path — the take(200) scan matching on `name`.
    const r = await (getUserByUsername as any)._handler(ctx(null, tables()), { username: "Victim" });
    assertNoSecrets(r, "getUserByUsername(name fallback)");
  });

  test("getUserByGithubId withholds every secret", async () => {
    const r = await (getUserByGithubId as any)._handler(ctx(null, tables()), { github_id: "12345" });
    assertNoSecrets(r, "getUserByGithubId");
    expect(r.github_username).toBe("victim-gh");
  });
});

describe("commits are not world-readable or world-destroyable", () => {
  test("clearAllCommits no longer exists as a callable mutation", () => {
    // It took no arguments, had no auth check, and deleted the whole table.
    expect("clearAllCommits" in commits).toBe(false);
  });

  test("a commit is not served to a signed-in user with no access to its conversation", async () => {
    const t = tables({
      commits: [{ _id: "c1", sha: "abc", timestamp: 2, conversation_id: "conv_1", files: [{ patch: "SECRET DIFF" }] }],
      conversations: [{ _id: "conv_1", user_id: VICTIM, is_private: true }],
    });
    const r = await (getCommitBySha as any)._handler(ctx(STRANGER, t), { sha: "abc" });
    expect(r).toBeNull();

    const own = await (getCommitBySha as any)._handler(ctx(VICTIM, t), { sha: "abc" });
    expect(own?.sha).toBe("abc");
  });

  test("an unattributable commit (no conversation_id) is withheld rather than served", async () => {
    // syncRepositoryCommits creates rows with no conversation_id, so there is
    // nothing to authorize against. Fail closed until `commits` gets an owner.
    const t = tables({ commits: [{ _id: "c1", sha: "abc", timestamp: 2, files: [{ patch: "SECRET DIFF" }] }] });
    expect(await (getCommitBySha as any)._handler(ctx(VICTIM, t), { sha: "abc" })).toBeNull();
  });
});

describe("migration helpers are not public", () => {
  test("analyzeMessageRoles is internal, so it is not callable from the client API", () => {
    expect((analyzeMessageRoles as any).isPublic).toBeFalsy();
  });
});

// Token connections (external-data.md X1, X11): the pasted token, its
// ciphertext and the non-secret config never cross a public boundary. The
// only public entry, connectWithToken (and cliConnectToken over it), answers
// with an id and a label; everything that reads a credential is internal.
describe("token connections never return their secret", () => {
  const TOKEN_ENC = "v1.TOKEN_CIPHERTEXT_IV.TOKEN_CIPHERTEXT_BODY";
  const tokenRow = {
    _id: "ai_sentry",
    provider: "sentry",
    team_id: "team_1",
    connected_by: VICTIM,
    access_token_enc: TOKEN_ENC,
    config: { org: "acme-private-org", host: "https://sentry.io" },
    account_label: "Acme",
    granted_scopes: [],
    created_at: 1,
    updated_at: 1,
  };

  test("listConnections reports a token connection without its ciphertext or config", async () => {
    const t = tables({
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "tm_1", user_id: VICTIM, team_id: "team_1", role: "member", joined_at: 1 }],
      slack_installations: [],
      github_app_installations: [],
      app_installations: [tokenRow],
      api_tokens: [],
    });
    t.users[0].team_id = "team_1";
    const r = await (listConnections as any)._handler(ctx(VICTIM, t), {});
    const sentry = r.apps.find((a: any) => a.id === "sentry" && a.scope === "team");
    expect(sentry.status).toBe("connected");
    expect(sentry.detail).toBe("Acme");
    const serialized = JSON.stringify(r);
    for (const leaked of ["access_token_enc", "TOKEN_CIPHERTEXT", "acme-private-org", "config"]) {
      expect(`listConnections contains ${leaked}: ${serialized.includes(leaked)}`).toBe(`listConnections contains ${leaked}: false`);
    }
  });

  test("cliConnectToken answers with an id and a label, never the token", async () => {
    const c = {
      runAction: async () => ({ ok: true, id: "ai_sentry", label: "Acme" }),
    } as any;
    const r = await (cliConnectToken as any)._handler(c, {
      api_token: "t",
      provider: "sentry",
      token: "sntrys_PASTED_SECRET",
      config: { org: "acme" },
    });
    expect(r).toEqual({ ok: true, id: "ai_sentry", label: "Acme" });
    expect(JSON.stringify(r)).not.toContain("sntrys_PASTED_SECRET");
  });

  test("every function that reads or writes a token credential is internal", () => {
    for (const name of ["getTokenCredential", "tokenConnectionRow", "tokenConnectionFor", "storeTokenConnection"] as const) {
      expect(`${name} public: ${!!(tokenConnectors[name] as any).isPublic}`).toBe(`${name} public: false`);
    }
    expect((tokenConnectors.connectWithToken as any).isPublic).toBe(true);
  });

  test("the app connector's credential-adjacent functions are internal", () => {
    // callContext and sourceForPoll hand back a connection id that
    // readTokenCredential turns into a secret; recordCall writes the audit.
    for (const name of ["callContext", "sourceForPoll", "recordCall", "storeManifest", "recordWatchPolls", "pollSource", "refreshSourceManifest"] as const) {
      expect(`${name} public: ${!!(appConnector[name] as any).isPublic}`).toBe(`${name} public: false`);
    }
  });
});
