// Who an installation binds to, over the REAL install callback.
//
// The callback is a public GET that GitHub sends to whoever finishes an
// install. It used to read the Codecast user and team out of the `state`, which
// was base64 JSON anyone could write: a forged state bound an installation to
// any workspace whose ids the writer knew, and — the sharper half — a caller
// could name THEIR OWN workspace while handing the callback an installation_id
// belonging to someone else's organisation. The App's own credentials read any
// installation of the App, so fetching one proved nothing.
//
// Now the state is a nonce naming an intent this server minted for an
// authenticated caller, and the callback proves the caller controls the
// installation through GitHub's user-token flow before anything is written.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { newGithubAppInstallNonce } from "@codecast/shared/contracts";
import { sha256Hex } from "./lib/hash";
import {
  installCallbackHandler,
  createInstallIntent,
  consumeInstallIntent,
  storeInstallation,
  getInstallUrl,
} from "./githubApp";

const VICTIM = "u_victim";
const ATTACKER = "u_attacker";
const VICTIM_TEAM = "t_victim";

const INSTALLATION_ID = 4242;
const OTHER_INSTALLATION_ID = 99;

function tables() {
  return {
    users: [{ _id: VICTIM }, { _id: ATTACKER }],
    teams: [{ _id: VICTIM_TEAM, name: "Victim Team" }],
    team_memberships: [{ _id: "tm_v", user_id: VICTIM, team_id: VICTIM_TEAM, role: "admin", joined_at: 1 }],
    github_app_install_intents: [] as any[],
    github_app_installations: [] as any[],
    github_installation_tokens: [] as any[],
  };
}

const registry: Record<string, any> = {
  "githubApp:createInstallIntent": createInstallIntent,
  "githubApp:consumeInstallIntent": consumeInstallIntent,
  "githubApp:storeInstallation": storeInstallation,
};

/** The installation GitHub reports for INSTALLATION_ID — an account the caller
 *  may or may not control, which is the whole question under test. */
const INSTALLATION_DETAILS = {
  installation_id: INSTALLATION_ID,
  account_login: "victim-org",
  account_type: "Organization" as const,
  account_id: 7,
  repository_selection: "all" as const,
  repositories: undefined,
};

function actionCtx(t: Record<string, any[]>) {
  const db = makeFakeDb(t);
  const scheduled: any[] = [];
  const run = async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === "githubApp:fetchInstallationDetails") return INSTALLATION_DETAILS;
    const fn = registry[name];
    if (!fn) throw new Error(`no test handler for ${name}`);
    return (fn as any)._handler({ db }, args);
  };
  return {
    db,
    runMutation: run,
    runQuery: run,
    runAction: run,
    scheduler: { runAfter: async (_ms: number, ref: any, args: any) => { scheduled.push({ ref, args }); } },
    _scheduled: scheduled,
  } as any;
}

/**
 * GitHub, answering only for the user token it issued: `controls` is the set of
 * installation ids that user may administer, which is exactly what
 * `GET /user/installations` discloses.
 */
function stubGitHub(opts: { controls?: number[]; codeValid?: boolean } = {}) {
  const controls = opts.controls ?? [];
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json(opts.codeValid === false ? { error: "bad_verification_code" } : { access_token: "ghu_user" });
    }
    if (url.startsWith("https://api.github.com/user/installations")) {
      return Response.json({ installations: controls.map((id) => ({ id, account: { login: "victim-org" } })) });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as any;
}

const callback = (ctx: any, params: Record<string, string>) =>
  installCallbackHandler(ctx, new Request(`https://site.convex.site/api/github-app/callback?${new URLSearchParams(params)}`));

const errorOf = (res: Response) => new URL(res.headers.get("Location")!).searchParams.get("error");
const successOf = (res: Response) => new URL(res.headers.get("Location")!).searchParams.get("success");

/** A real intent, minted the way getInstallUrl mints it. */
async function mintIntent(ctx: any, over: Record<string, any> = {}): Promise<string> {
  const nonce = newGithubAppInstallNonce();
  const res = await (createInstallIntent as any)._handler(ctx, {
    nonce_hash: await sha256Hex(nonce),
    user_id: VICTIM,
    scope: "team",
    team_id: VICTIM_TEAM,
    ...over,
  });
  expect(res.ok).toBe(true);
  return nonce;
}

const realFetch = globalThis.fetch;
const savedEnv = { id: process.env.GITHUB_APP_CLIENT_ID, secret: process.env.GITHUB_APP_CLIENT_SECRET };
beforeEach(() => {
  process.env.GITHUB_APP_CLIENT_ID = "Iv1.test";
  process.env.GITHUB_APP_CLIENT_SECRET = "client-secret";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.GITHUB_APP_CLIENT_ID = savedEnv.id;
  process.env.GITHUB_APP_CLIENT_SECRET = savedEnv.secret;
});

describe("install callback: the state names no principal", () => {
  test("a forged identity state binds nothing", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    // Exactly the state the old flow accepted: someone else's user and team.
    const forged = btoa(JSON.stringify({ user_id: VICTIM, scope: "team", team_id: VICTIM_TEAM }));
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: forged, code: "c" });
    expect(errorOf(res)).toBe("missing_intent");
    expect(t.github_app_installations).toHaveLength(0);
  });

  test("a nonce nobody minted binds nothing", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const res = await callback(ctx, {
      installation_id: String(INSTALLATION_ID), setup_action: "install", state: newGithubAppInstallNonce(), code: "c",
    });
    expect(errorOf(res)).toBe("unknown_intent");
    expect(t.github_app_installations).toHaveLength(0);
  });

  test("the intent decides the workspace, whatever the URL says", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const nonce = await mintIntent(ctx);
    const res = await callback(ctx, {
      installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c",
      // Ignored: nothing in the query names a principal any more.
      user_id: ATTACKER, team_id: "t_attacker",
    });
    expect(successOf(res)).toBe("true");
    expect(t.github_app_installations).toHaveLength(1);
    expect(t.github_app_installations[0]).toMatchObject({
      team_id: VICTIM_TEAM,
      installed_by_user_id: VICTIM,
      installation_id: INSTALLATION_ID,
    });
    expect(t.github_app_installations[0].scope_user_id).toBeUndefined();
    expect(ctx._scheduled).toHaveLength(1);
  });
});

describe("install callback: the caller must control the installation", () => {
  test("an installation the caller does not administer is refused, and writes nothing", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    // The attacker's own intent — authentic — and someone else's installation.
    stubGitHub({ controls: [OTHER_INSTALLATION_ID] });
    const nonce = await mintIntent(ctx, { user_id: ATTACKER, scope: "personal", team_id: undefined });
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c" });
    expect(errorOf(res)).toBe("installer_does_not_control_installation");
    expect(t.github_app_installations).toHaveLength(0);
    // The intent survives a refusal it did not cause, so an honest retry works.
    expect(t.github_app_install_intents[0].consumed_at).toBeUndefined();
  });

  test("a callback with no user authorization code is refused", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const nonce = await mintIntent(ctx);
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce });
    expect(errorOf(res)).toBe("install_not_authorized");
    expect(t.github_app_installations).toHaveLength(0);
  });

  test("a code GitHub refuses to exchange is refused", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID], codeValid: false });
    const nonce = await mintIntent(ctx);
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "stolen" });
    expect(errorOf(res)).toBe("install_not_authorized");
    expect(t.github_app_installations).toHaveLength(0);
  });

  test("with no client pair configured the install refuses rather than binding unproven", async () => {
    delete process.env.GITHUB_APP_CLIENT_ID;
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const nonce = await mintIntent(ctx);
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c" });
    expect(errorOf(res)).toBe("install_verification_unconfigured");
    expect(t.github_app_installations).toHaveLength(0);
  });
});

describe("install intents are single use, fresh, and still authorised", () => {
  test("a replayed nonce binds once", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const nonce = await mintIntent(ctx);
    const first = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c" });
    expect(successOf(first)).toBe("true");
    const replay = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c" });
    expect(errorOf(replay)).toBe("intent_already_used");
    expect(t.github_app_installations).toHaveLength(1);
  });

  test("two callbacks racing one nonce bind once", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const nonce = await mintIntent(ctx);
    const params = { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c" };
    const [a, b] = await Promise.all([callback(ctx, params), callback(ctx, params)]);
    const outcomes = [a, b].map((r) => successOf(r) ?? errorOf(r)).sort();
    expect(outcomes).toEqual(["intent_already_used", "true"]);
    expect(t.github_app_installations).toHaveLength(1);
  });

  test("an expired intent binds nothing and is dropped", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const nonce = await mintIntent(ctx);
    t.github_app_install_intents[0].expires_at = Date.now() - 1;
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c" });
    expect(errorOf(res)).toBe("intent_expired");
    expect(t.github_app_installations).toHaveLength(0);
    expect(t.github_app_install_intents).toHaveLength(0);
  });

  test("membership is revalidated when the intent is spent, not only when it is minted", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const nonce = await mintIntent(ctx);
    t.team_memberships.length = 0;          // removed from the team meanwhile
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c" });
    expect(errorOf(res)).toBe("not_a_team_member");
    expect(t.github_app_installations).toHaveLength(0);
  });

  test("an intent for a team the caller does not belong to is never minted", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    const res = await (createInstallIntent as any)._handler(ctx, {
      nonce_hash: "h", user_id: ATTACKER, scope: "team", team_id: VICTIM_TEAM,
    });
    expect(res.ok).toBe(false);
    expect(t.github_app_install_intents).toHaveLength(0);
  });

  test("the intent row holds the nonce's hash, never the nonce", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    const nonce = await mintIntent(ctx);
    expect(t.github_app_install_intents[0].nonce_hash).toBe(await sha256Hex(nonce));
    expect(JSON.stringify(t.github_app_install_intents[0])).not.toContain(nonce);
  });
});

describe("a personal install stays the installer's own", () => {
  test("it binds to the person who started it", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const nonce = await mintIntent(ctx, { user_id: ATTACKER, scope: "personal", team_id: undefined });
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: nonce, code: "c" });
    expect(successOf(res)).toBe("true");
    expect(t.github_app_installations[0]).toMatchObject({ scope_user_id: ATTACKER, installed_by_user_id: ATTACKER });
    expect(t.github_app_installations[0].team_id).toBeUndefined();
  });

  test("it cannot re-point an installation another workspace already holds", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const theirs = await mintIntent(ctx);
    await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: theirs, code: "c" });
    const mine = await mintIntent(ctx, { user_id: ATTACKER, scope: "personal", team_id: undefined });
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: mine, code: "c" });
    expect(errorOf(res)).toBe("installation_failed");
    expect(t.github_app_installations).toHaveLength(1);
    expect(t.github_app_installations[0].team_id).toBe(VICTIM_TEAM);
  });

  test("a reinstall by the same workspace refreshes the one row", async () => {
    const t = tables();
    const ctx = actionCtx(t);
    stubGitHub({ controls: [INSTALLATION_ID] });
    const first = await mintIntent(ctx);
    await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "install", state: first, code: "c" });
    const again = await mintIntent(ctx);
    const res = await callback(ctx, { installation_id: String(INSTALLATION_ID), setup_action: "update", state: again, code: "c" });
    expect(successOf(res)).toBe("true");
    expect(t.github_app_installations).toHaveLength(1);
  });
});

describe("getInstallUrl", () => {
  const urlCtx = (t: Record<string, any[]>, me: any) => {
    const inner = actionCtx(t);
    const run = async (ref: any, args: any) => {
      if (getFunctionName(ref) === "oauthConnectors:resolveTeam") return me;
      return inner.runMutation(ref, args);
    };
    return { ...inner, runQuery: run, runMutation: run } as any;
  };

  test("a signed-in member gets a URL carrying only a nonce, and an intent to match", async () => {
    const t = tables();
    const ctx = urlCtx(t, { user_id: VICTIM, team_id: VICTIM_TEAM });
    const res = await (getInstallUrl as any)._handler(ctx, { scope: "team" });
    expect(res.ok).toBe(true);
    const state = new URL(res.url).searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    expect(t.github_app_install_intents).toHaveLength(1);
    expect(t.github_app_install_intents[0]).toMatchObject({ user_id: VICTIM, team_id: VICTIM_TEAM, scope: "team" });
    expect(t.github_app_install_intents[0].nonce_hash).toBe(await sha256Hex(state));
  });

  test("an anonymous caller gets no URL and mints no intent", async () => {
    const t = tables();
    const res = await (getInstallUrl as any)._handler(urlCtx(t, null), { scope: "team" });
    expect(res.ok).toBe(false);
    expect(t.github_app_install_intents).toHaveLength(0);
  });

  test("a team install with no team points at the personal path", async () => {
    const t = tables();
    const res = await (getInstallUrl as any)._handler(urlCtx(t, { user_id: VICTIM, team_id: null }), { scope: "team" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/yourself/);
    expect(t.github_app_install_intents).toHaveLength(0);
  });

  test("each click mints its own nonce", async () => {
    const t = tables();
    const ctx = urlCtx(t, { user_id: VICTIM, team_id: VICTIM_TEAM });
    const a = await (getInstallUrl as any)._handler(ctx, { scope: "team" });
    const b = await (getInstallUrl as any)._handler(ctx, { scope: "team" });
    expect(a.url).not.toBe(b.url);
    expect(t.github_app_install_intents).toHaveLength(2);
  });
});
