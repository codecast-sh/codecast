// The cloud host's git credential: who may ask, which installation answers,
// and what the token path refuses.
//
// The endpoint hands a bearer credential to a machine, so the interesting
// cases are all refusals: a token that authenticates nobody, a device that is
// not a cloud host of the caller, a repository no installation the caller can
// reach covers, and an App whose contents permission is not write. Each of
// them must come back as a reason the helper can act on rather than a
// credential, because a wrong yes here pushes to somebody else's repository.

import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hostGitCredential, hostGitInstallation } from "./cloud";
import { getInstallationToken, mintRepositoryName } from "./githubApp";
import { hashToken } from "./apiTokens";

const USER = "users_1" as any;
const OTHER = "users_2" as any;
const TEAM = "teams_1" as any;
const TOKEN = "cast-token";

async function fixture(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: USER }, { _id: OTHER }],
    api_tokens: [{ _id: "tok_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    devices: [
      { _id: "dev_host", user_id: USER, device_id: "box", is_remote: true, last_seen: Date.now() },
      { _id: "dev_laptop", user_id: USER, device_id: "mac", is_remote: false, last_seen: Date.now() },
      { _id: "dev_theirs", user_id: OTHER, device_id: "theirs", is_remote: true, last_seen: Date.now() },
    ],
    team_memberships: [{ _id: "mem_1", user_id: USER, team_id: TEAM, role: "member" }],
    github_app_installations: [],
    ...extra,
  });
}

const install = (over: Record<string, any> = {}) => ({
  _id: "install_1",
  installation_id: 4242,
  account_login: "ashot",
  account_type: "Organization",
  account_id: 1,
  repository_selection: "all",
  created_at: 0,
  updated_at: 0,
  ...over,
});

/** The endpoint's query half, called the way the action calls it. */
const resolve = (db: any, args: Record<string, any> = {}, token: string | null = TOKEN) =>
  (hostGitInstallation as any)._handler(
    { db, auth: { getUserIdentity: async () => null } },
    { ...(token ? { api_token: token } : {}), device_id: "box", repository: "ashot/codecast", ...args },
  );

/** The query's answer for the fixture's installation. */
const answered = (over: Record<string, any> = {}) => ({
  installation_id: 4242,
  account_login: "ashot",
  repository: "ashot/codecast",
  viewer_github_token: null,
  viewer_github_login: null,
  ...over,
});

describe("hostGitInstallation — who may ask for a push credential", () => {
  test("an unauthenticated call is refused before anything is read", async () => {
    const db = await fixture({ github_app_installations: [install({ scope_user_id: USER })] });
    await expect(resolve(db, {}, null)).rejects.toThrow("Authentication required");
    await expect(resolve(db, {}, "not-a-token")).rejects.toThrow("Authentication required");
  });

  test("the caller's own cloud host resolves their personal installation", async () => {
    const db = await fixture({ github_app_installations: [install({ scope_user_id: USER })] });
    expect(await resolve(db)).toEqual(answered({ personal: true }));
  });

  test("a team installation answers for a member of that team, marked as not the caller's own", async () => {
    const db = await fixture({ github_app_installations: [install({ team_id: TEAM })] });
    expect(await resolve(db)).toEqual(answered({ personal: false }));
  });

  test("a laptop, another user's host, and an unknown device all get nothing", async () => {
    const db = await fixture({ github_app_installations: [install({ scope_user_id: USER })] });
    expect(await resolve(db, { device_id: "mac" })).toEqual({ reason: "device mac is not a cloud host of yours" });
    expect(await resolve(db, { device_id: "theirs" })).toEqual({ reason: "device theirs is not a cloud host of yours" });
    expect(await resolve(db, { device_id: "ghost" })).toEqual({ reason: "device ghost is not a cloud host of yours" });
  });

  test("an installation belonging to somebody else is not reachable", async () => {
    const db = await fixture({ github_app_installations: [install({ scope_user_id: OTHER })] });
    expect((await resolve(db)).reason).toContain("not installed on ashot/codecast");
  });

  test("an installation of a team the caller is not in is not reachable", async () => {
    const db = await fixture({ github_app_installations: [install({ team_id: "teams_9" as any })] });
    expect((await resolve(db)).reason).toContain("not installed on ashot/codecast");
  });

  test("a suspended installation, and one that does not list the repository, are both misses", async () => {
    const suspended = await fixture({ github_app_installations: [install({ scope_user_id: USER, suspended_at: 1 })] });
    expect((await resolve(suspended)).reason).toContain("not installed");
    const elsewhere = await fixture({
      github_app_installations: [install({
        scope_user_id: USER,
        repository_selection: "selected",
        repositories: [{ id: 1, name: "other", full_name: "ashot/other" }],
      })],
    });
    expect((await resolve(elsewhere)).reason).toContain("not installed");
    expect(await resolve(elsewhere, { repository: "ashot/other" })).toEqual(answered({ personal: true, repository: "ashot/other" }));
  });

  test("the repository is read as owner/name, case and .git aside; anything else is refused", async () => {
    const db = await fixture({ github_app_installations: [install({ scope_user_id: USER })] });
    expect(await resolve(db, { repository: "Ashot/Codecast.git" })).toEqual(answered({ personal: true }));
    expect((await resolve(db, { repository: "codecast" })).reason).toContain("is not an owner/name repository");
    expect((await resolve(db, { repository: "ashot/codecast/extra" })).reason).toContain("is not an owner/name repository");
  });

  test("a git host other than github.com has no installation to mint from", async () => {
    const db = await fixture({ github_app_installations: [install({ scope_user_id: USER })] });
    expect((await resolve(db, { host: "gitlab.com" })).reason).toContain("is not github.com");
    expect(await resolve(db, { host: "github.com" })).toEqual(answered({ personal: true }));
  });
});

describe("hostGitCredential — the credential the helper prints", () => {
  const act = (resolved: any, minted: any, args: Record<string, any> = {}) => {
    const calls: any[] = [];
    const ctx = {
      runQuery: async (_ref: any, a: any) => { calls.push(["query", a]); return resolved; },
      runAction: async (_ref: any, a: any) => { calls.push(["action", a]); return minted; },
    };
    return {
      calls,
      result: (hostGitCredential as any)._handler(ctx, { api_token: TOKEN, device_id: "box", repository: "ashot/codecast", ...args }),
    };
  };

  test("a resolved installation becomes an x-access-token credential", async () => {
    const { result, calls } = act(
      answered({ personal: true }),
      { token: "ghs_secret", expires_at: 1234, permissions: { contents: "write" } },
    );
    expect(await result).toEqual({
      username: "x-access-token",
      password: "ghs_secret",
      expires_at: 1234,
      installation_id: 4242,
    });
    // One mint, through githubApp.getInstallationToken and its shared cache,
    // asking for the one repository git named rather than the installation's
    // whole selection.
    expect(calls.filter((c) => c[0] === "action")).toHaveLength(1);
    expect(calls.find((c) => c[0] === "action")![1]).toEqual({ installation_id: 4242, repository: "ashot/codecast" });
  });

  test("a refusal from the query is passed through and mints nothing", async () => {
    const { result, calls } = act({ reason: "the codecast GitHub App is not installed on ashot/codecast for you" }, null);
    expect(await result).toEqual({ reason: "the codecast GitHub App is not installed on ashot/codecast for you" });
    expect(calls.filter((c) => c[0] === "action")).toHaveLength(0);
  });

  test("an App that cannot write the repository's contents is refused, token or not", async () => {
    const { result } = act(
      answered({ personal: true }),
      { token: "ghs_secret", expires_at: 1234, permissions: { contents: "read" } },
    );
    const answer = await result;
    expect(answer.reason).toContain("cannot write to ashot/codecast");
    expect(answer.reason).toContain("contents permission is read");
    expect(answer.password).toBeUndefined();
  });

  test("unknown permissions are a refusal, because this answer claims push access", async () => {
    // The host reports app.write from this answer, so a yes it cannot back
    // turns every push into a 403. The device key is the path meanwhile.
    const { result } = act(answered({ personal: true }), { token: "ghs_secret", expires_at: 1234 });
    const answer = await result;
    expect(answer.reason).toContain("contents permission is unknown");
    expect(answer.password).toBeUndefined();
  });

  test("a team installation mints only for somebody GitHub says may push", async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    try {
      // No linked GitHub account: the question cannot be asked, so nothing is minted.
      const unlinked = act(answered({ personal: false }), { token: "ghs_secret", expires_at: 1234, permissions: { contents: "write" } });
      expect((await unlinked.result).reason).toContain("could not confirm that you may push");
      expect(unlinked.calls.filter((c) => c[0] === "action")).toHaveLength(0);

      globalThis.fetch = (async (url: any) => {
        seen.push(String(url));
        return { ok: true, status: 200, json: async () => ({ permissions: { push: false } }) } as any;
      }) as any;
      const reader = act(answered({ personal: false, viewer_github_token: "gho_x", viewer_github_login: "reader" }), { token: "ghs_secret", expires_at: 1234, permissions: { contents: "write" } });
      const refused: any = await reader.result;
      expect(refused.reason).toContain("(reader) cannot push to ashot/codecast");
      expect(refused.password).toBeUndefined();
      expect(reader.calls.filter((c) => c[0] === "action")).toHaveLength(0);
      expect(seen).toEqual(["https://api.github.com/repos/ashot/codecast"]);

      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ permissions: { push: true } }) }) as any) as any;
      const pusher = act(answered({ personal: false, viewer_github_token: "gho_x", viewer_github_login: "pusher" }), { token: "ghs_secret", expires_at: 1234, permissions: { contents: "write" } });
      expect(await pusher.result).toEqual({ username: "x-access-token", password: "ghs_secret", expires_at: 1234, installation_id: 4242 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a mint GitHub refuses comes back as a reason, not a thrown action", async () => {
    // A scoped mint asks for `contents: write`; GitHub answers 422 when the
    // installation does not hold it.
    const ctx = {
      runQuery: async () => answered({ personal: true }),
      runAction: async () => { throw new Error("Failed to get installation token: 422 permissions not granted"); },
    };
    const answer: any = await (hostGitCredential as any)._handler(ctx, {
      api_token: TOKEN, device_id: "box", repository: "ashot/codecast",
    });
    expect(answer.reason).toContain("could not mint a push token for ashot/codecast");
    expect(answer.reason).toContain("422");
    expect(answer.password).toBeUndefined();
  });
});

describe("getInstallationToken — the one mint path, and its cache", () => {
  const ctx = (cached: any, minted?: any) => {
    const calls: string[] = [];
    const reads: any[] = [];
    return {
      calls,
      reads,
      ctx: {
        runQuery: async (_ref: any, a: any) => { calls.push("cache-read"); reads.push(a); return cached; },
        runAction: async () => { calls.push("mint-jwt"); return "jwt"; },
        runMutation: async (_ref: any, a: any) => { calls.push("cache-write"); Object.assign(minted ?? {}, a); },
      },
    };
  };

  test("the installation-wide token and a repository's are separate cache rows", async () => {
    const wide = ctx({ token: "ghs_wide", expires_at: Date.now() + 30 * 60 * 1000, permissions: { contents: "write" } });
    await (getInstallationToken as any)._handler(wide.ctx, { installation_id: 4242 });
    expect(wide.reads[0]).toEqual({ installation_id: 4242 });
    const scoped = ctx({ token: "ghs_scoped", expires_at: Date.now() + 30 * 60 * 1000, permissions: { contents: "write" } });
    await (getInstallationToken as any)._handler(scoped.ctx, { installation_id: 4242, repository: "Ashot/Codecast.git" });
    expect(scoped.reads[0]).toEqual({ installation_id: 4242, repository: "ashot/codecast" });
  });

  test("a repository that is not owner/name never reaches GitHub", async () => {
    const { ctx: c, calls } = ctx(null);
    await expect((getInstallationToken as any)._handler(c, { installation_id: 4242, repository: "codecast" }))
      .rejects.toThrow("Not an owner/name repository");
    expect(calls).toEqual([]);
  });

  test("the name GitHub is asked to scope to is the bare repository name", () => {
    expect(mintRepositoryName("Ashot/Codecast.git")).toBe("codecast");
    expect(mintRepositoryName("ashot/code.cast")).toBe("code.cast");
    expect(mintRepositoryName("codecast")).toBeUndefined();
    expect(mintRepositoryName(undefined)).toBeUndefined();
  });

  test("a live cached token is reused, with its permissions, and no JWT is signed", async () => {
    const { ctx: c, calls } = ctx({
      token: "ghs_cached",
      expires_at: Date.now() + 30 * 60 * 1000,
      permissions: { contents: "write" },
    });
    expect(await (getInstallationToken as any)._handler(c, { installation_id: 4242 })).toEqual({
      token: "ghs_cached",
      expires_at: expect.any(Number),
      permissions: { contents: "write" },
    });
    expect(calls).toEqual(["cache-read"]);
  });

  test("a token about to expire is not reused", async () => {
    const { ctx: c, calls } = ctx({ token: "ghs_cached", expires_at: Date.now() + 60 * 1000 });
    await expect((getInstallationToken as any)._handler(c, { installation_id: 4242 })).rejects.toThrow();
    // It got past the cache and tried to mint (no GITHUB_APP_ID here).
    expect(calls).toContain("mint-jwt");
  });
});
