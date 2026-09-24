import { v } from "convex/values";
import { action, mutation, query, internalMutation, internalQuery, internalAction } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MappedPull } from "./githubApi";
import { syncPRCommits } from "./githubWebhooks";
import type { QueryCtx } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { isTeamMember } from "./privacy";
import { requireUser } from "./lib/auth";
import { normalizeRepository, repositoryOwner } from "./lib/gitRefs";
import {
  parseOwnerRepo,
  parseGithubAppInstallState,
  newGithubAppInstallNonce,
  githubAppInstallUrlFor,
  isAppConnectionScope,
  GITHUB_INSTALL_INTENT_TTL_MS,
  type AppConnectionScope,
} from "@codecast/shared/contracts";
import { sha256Hex } from "./lib/hash";
import { activeTeamMembershipFor, requireTeamAdmin, requireTeamMembership, effectiveTeamForResource } from "./lib/access";

const GITHUB_API_BASE = "https://api.github.com";

function base64UrlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function signJWT(header: object, payload: object, privateKeyPem: string): Promise<string> {
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;

  const pemContents = privateKeyPem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  const signatureBase64 = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature))
  );

  return `${signingInput}.${signatureBase64}`;
}

export const generateAppJWT = internalAction({
  args: {},
  handler: async (): Promise<string> => {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    if (!appId || !privateKey) {
      throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
    }

    const decodedPrivateKey = atob(privateKey);

    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: "RS256",
      typ: "JWT",
    };
    const payload = {
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    };

    return signJWT(header, payload, decodedPrivateKey);
  },
});

/**
 * The permissions GitHub reported for a minted token, keeping only the entries
 * we can compare. The map decides what the token may do, so a caller that
 * needs a write (pushing a branch from a cloud host) can refuse before git
 * meets a 403 it cannot explain.
 */
export function stringPermissions(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * May a token with these permissions push? GitHub spells push access as
 * `contents: write`. Undefined means the answer is unknown — a token cached
 * before permissions were recorded — and an unknown answer must not be read
 * as a refusal.
 */
export function grantsContentsWrite(permissions: Record<string, string> | undefined): boolean | undefined {
  if (!permissions) return undefined;
  return permissions.contents === "write";
}

/**
 * The repository name GitHub wants in a scoped mint: `name`, never
 * `owner/name`. An installation belongs to one account, so the owner is
 * already decided by installation_id.
 */
export function mintRepositoryName(repository: string | undefined): string | undefined {
  return parseOwnerRepo(repository)?.split("/")[1];
}

export const getInstallationToken = internalAction({
  args: {
    installation_id: v.number(),
    /**
     * Narrow the token to one repository and to push access, as `owner/name`.
     *
     * Without it the token carries the installation's whole repository
     * selection, which on an organisation install is every repository the org
     * owns. That is right for the server's own work (issue sync walks many
     * repositories), and wrong for a credential handed to a machine: a cloud
     * host asks for the repository git named, so that is all it gets.
     */
    repository: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ token: string; expires_at: number; permissions?: Record<string, string> }> => {
    // Scoped tokens are cached apart from the installation-wide one: same
    // installation, different authority, so they must never answer for each
    // other.
    const repository = parseOwnerRepo(args.repository) ?? undefined;
    const name = mintRepositoryName(args.repository);
    if (args.repository && !name) throw new Error(`Not an owner/name repository: ${args.repository}`);
    const cachedToken = await ctx.runQuery(internal.githubApp.getCachedToken, {
      installation_id: args.installation_id,
      ...(repository ? { repository } : {}),
    });

    if (cachedToken && cachedToken.expires_at > Date.now() + 5 * 60 * 1000) {
      return {
        token: cachedToken.token,
        expires_at: cachedToken.expires_at,
        ...(cachedToken.permissions ? { permissions: cachedToken.permissions } : {}),
      };
    }

    const jwt = await ctx.runAction(internal.githubApp.generateAppJWT, {});

    // GitHub refuses a scoped mint that asks for more than the installation
    // holds (422), so a read-only App cannot yield a token this path would
    // call a push credential.
    const scoped = name ? { repositories: [name], permissions: { contents: "write" } } : undefined;
    const response = await fetch(
      `${GITHUB_API_BASE}/app/installations/${args.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(scoped ? { "Content-Type": "application/json" } : {}),
        },
        ...(scoped ? { body: JSON.stringify(scoped) } : {}),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get installation token: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const expiresAt = new Date(data.expires_at).getTime();
    const permissions = stringPermissions(data.permissions);

    await ctx.runMutation(internal.githubApp.cacheToken, {
      installation_id: args.installation_id,
      ...(repository ? { repository } : {}),
      token: data.token,
      expires_at: expiresAt,
      ...(permissions ? { permissions } : {}),
    });

    return { token: data.token, expires_at: expiresAt, ...(permissions ? { permissions } : {}) };
  },
});

export const getCachedToken = internalQuery({
  args: {
    installation_id: v.number(),
    /** Absent means the installation-wide token; a value means that repository's. */
    repository: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("github_installation_tokens")
      .withIndex("by_installation_repo", (q) =>
        q.eq("installation_id", args.installation_id).eq("repository", args.repository))
      .first();
  },
});

export const cacheToken = internalMutation({
  args: {
    installation_id: v.number(),
    repository: v.optional(v.string()),
    token: v.string(),
    expires_at: v.number(),
    permissions: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("github_installation_tokens")
      .withIndex("by_installation_repo", (q) =>
        q.eq("installation_id", args.installation_id).eq("repository", args.repository))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        token: args.token,
        expires_at: args.expires_at,
        permissions: args.permissions,
      });
    } else {
      await ctx.db.insert("github_installation_tokens", {
        installation_id: args.installation_id,
        ...(args.repository ? { repository: args.repository } : {}),
        token: args.token,
        expires_at: args.expires_at,
        ...(args.permissions ? { permissions: args.permissions } : {}),
        created_at: Date.now(),
      });
    }
  },
});

/** The scope an installation row binds to, as the resolvers compare it. */
function installationScopeKey(row: { team_id?: Id<"teams">; scope_user_id?: Id<"users"> }): string {
  return row.team_id ? `team:${row.team_id}` : row.scope_user_id ? `user:${row.scope_user_id}` : "none";
}

/* ==========================================================================
 * Install intents — who the callback is allowed to bind an installation to
 * ========================================================================== */
//
// GitHub sends the install callback to a public URL and echoes back whatever
// `state` the install link carried. That state used to name the Codecast user
// and team the installation would bind to, so anyone who could write a state
// could choose the workspace an installation landed in — their own, for
// someone else's organisation, or a colleague's team for an installation they
// controlled. Identity now comes from an intent this server minted for an
// authenticated caller; the state is only the nonce that finds it.

/** The install URL for the caller, minting the intent the callback reads back.
 *  Takes `api_token` for the same reason every other connect action does: the
 *  CLI reaches this flow, and a second URL builder is the drift that would let
 *  the two disagree about what a callback carries. */
export const getInstallUrl = action({
  args: { scope: v.optional(v.string()), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; url?: string; error?: string }> => {
    const scope: AppConnectionScope = isAppConnectionScope(args.scope) ? args.scope : "team";
    const me: any = await ctx.runQuery(internal.oauthConnectors.resolveTeam, { api_token: args.api_token });
    if (!me?.user_id) return { ok: false, error: "not signed in" };
    if (scope === "team" && !me.team_id) {
      return { ok: false, error: "Join or create a team first, or install the GitHub App for yourself" };
    }
    const nonce = newGithubAppInstallNonce();
    const intent: { ok: boolean; error?: string } = await ctx.runMutation(internal.githubApp.createInstallIntent, {
      nonce_hash: await sha256Hex(nonce),
      user_id: me.user_id,
      scope,
      team_id: scope === "team" ? me.team_id : undefined,
    });
    if (!intent.ok) return { ok: false, error: intent.error };
    return { ok: true, url: githubAppInstallUrlFor(process.env.GITHUB_APP_SLUG || "codecast-sh", nonce) };
  },
});

export const createInstallIntent = internalMutation({
  args: {
    nonce_hash: v.string(),
    user_id: v.id("users"),
    scope: v.union(v.literal("team"), v.literal("personal")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    if ((args.scope === "team") !== !!args.team_id) {
      return { ok: false, error: "An install binds to exactly one of a team or a person" };
    }
    // Membership is checked here AND when the intent is spent: an intent minted
    // an hour ago by someone since removed from the team must not still bind.
    if (args.team_id && !(await isTeamMember(ctx, args.user_id, args.team_id))) {
      return { ok: false, error: "Join or create a team first, or install the GitHub App for yourself" };
    }
    const now = Date.now();
    await ctx.db.insert("github_app_install_intents", {
      nonce_hash: args.nonce_hash,
      user_id: args.user_id,
      scope: args.scope,
      team_id: args.team_id,
      created_at: now,
      expires_at: now + GITHUB_INSTALL_INTENT_TTL_MS,
    });
    return { ok: true };
  },
});

/** Spend an intent: single use, unexpired, and its authority still current.
 *  Consuming and checking happen in one mutation, so two callbacks racing the
 *  same nonce cannot both bind. */
export const consumeInstallIntent = internalMutation({
  args: { nonce_hash: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; user_id: Id<"users">; scope: AppConnectionScope; team_id?: Id<"teams">; created_at: number }
    | { ok: false; error: string }
  > => {
    const intent = await ctx.db
      .query("github_app_install_intents")
      .withIndex("by_nonce_hash", (q) => q.eq("nonce_hash", args.nonce_hash))
      .first();
    if (!intent) return { ok: false, error: "unknown_intent" };
    if (intent.consumed_at) return { ok: false, error: "intent_already_used" };
    const now = Date.now();
    if (now > intent.expires_at) {
      await ctx.db.delete(intent._id);
      return { ok: false, error: "intent_expired" };
    }
    await ctx.db.patch(intent._id, { consumed_at: now });
    if (intent.scope === "team") {
      if (!intent.team_id || !(await isTeamMember(ctx, intent.user_id, intent.team_id))) {
        return { ok: false, error: "not_a_team_member" };
      }
    }
    return { ok: true, user_id: intent.user_id, scope: intent.scope, team_id: intent.team_id, created_at: intent.created_at };
  },
});

/** The workspace an installation is already linked to, or null. */
export const linkedInstallationScope = internalQuery({
  args: { installation_id: v.number() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();
    return row ? installationScopeKey(row) : null;
  },
});

/** How far GitHub's clock may run behind ours when we compare creation times. */
const INSTALL_CLOCK_SKEW_MS = 60_000;

/**
 * With no user token to ask GitHub with, the intent is the only proof (sd-234).
 * The installation_id is still the caller's to write, so the intent may claim
 * only an installation GitHub created after the intent was minted, or update
 * one already linked to the intent's own workspace.
 */
async function intentAloneMayClaim(
  ctx: any,
  intent: { user_id: Id<"users">; scope: AppConnectionScope; team_id?: Id<"teams">; created_at: number },
  installation: { installation_id: number; created_at?: number },
): Promise<boolean> {
  if (installation.created_at !== undefined && installation.created_at >= intent.created_at - INSTALL_CLOCK_SKEW_MS) {
    return true;
  }
  const linked: string | null = await ctx.runQuery(internal.githubApp.linkedInstallationScope, {
    installation_id: installation.installation_id,
  });
  const own = installationScopeKey(
    intent.scope === "team" ? { team_id: intent.team_id } : { scope_user_id: intent.user_id },
  );
  return linked === own;
}

/* ==========================================================================
 * The install callback
 * ========================================================================== */

const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Does the person who came back from GitHub actually control this
 * installation? The App's own credentials can read ANY installation of the
 * App, so fetching one proves nothing about the caller. GitHub's answer is the
 * user-token flow: the install redirect carries a `code` (the App requests
 * user authorization during installation), which exchanges for a token that
 * speaks for that GitHub user, and `GET /user/installations` lists only the
 * installations that user may administer.
 *
 * With no client pair configured there is no way to ask the question; the
 * callback then falls back to `intentAloneMayClaim`.
 */
export async function verifyInstallerControlsInstallation(
  installationId: number,
  code: string | null,
): Promise<{ ok: true; login?: string } | { ok: false; error: string }> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: "install_verification_unconfigured" };
  if (!code) return { ok: false, error: "install_not_authorized" };

  const tokenResponse = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = tokenResponse.ok ? (await tokenResponse.json().catch(() => null))?.access_token : null;
  if (typeof token !== "string" || !token) return { ok: false, error: "install_not_authorized" };

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  for (let page = 1; page <= 5; page++) {
    const response = await fetch(`${GITHUB_API_BASE}/user/installations?per_page=100&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, error: "install_verification_failed" };
    const data = await response.json().catch(() => null);
    const installations = Array.isArray(data?.installations) ? data.installations : [];
    const match = installations.find((i: any) => Number(i?.id) === installationId);
    if (match) return { ok: true, login: typeof match.account?.login === "string" ? match.account.login : undefined };
    if (installations.length < 100) break;
  }
  return { ok: false, error: "installer_does_not_control_installation" };
}

/** Where the callback sends the browser, with whatever it has to report. */
function installRedirect(query: string): Response {
  const site = process.env.SITE_URL || "https://codecast.sh";
  return new Response(null, {
    status: 302,
    headers: { Location: `${site}/settings/integrations/github-app${query}` },
  });
}

export async function installCallbackHandler(ctx: any, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");

  if (!installationId) return new Response("Missing installation_id", { status: 400 });
  if (setupAction !== "install" && setupAction !== "update") return installRedirect("");

  const nonce = parseGithubAppInstallState(url.searchParams.get("state"));
  if (!nonce) return installRedirect("?error=missing_intent");

  try {
    // Ownership before the intent is spent: a GitHub hiccup should cost the
    // caller a retry of the same link, not a new one.
    const proof = await verifyInstallerControlsInstallation(parseInt(installationId), url.searchParams.get("code"));
    const intentOnly = !proof.ok && proof.error === "install_verification_unconfigured";
    if (!proof.ok && !intentOnly) {
      console.warn("[github-app install] refused", { reason: proof.error, installation_id: installationId });
      return installRedirect(`?error=${proof.error}`);
    }

    const intent = await ctx.runMutation(internal.githubApp.consumeInstallIntent, {
      nonce_hash: await sha256Hex(nonce),
    });
    if (!intent.ok) {
      console.warn("[github-app install] refused", { reason: intent.error, installation_id: installationId });
      return installRedirect(`?error=${intent.error}`);
    }

    const installationDetails = await ctx.runAction(internal.githubApp.fetchInstallationDetails, {
      installation_id: parseInt(installationId),
    });
    if (intentOnly && !(await intentAloneMayClaim(ctx, intent, installationDetails))) {
      console.warn("[github-app install] refused", { reason: "install_not_fresh", installation_id: installationId });
      return installRedirect("?error=install_not_fresh");
    }

    await ctx.runMutation(internal.githubApp.storeInstallation, {
      team_id: intent.scope === "team" ? intent.team_id : undefined,
      scope_user_id: intent.scope === "personal" ? intent.user_id : undefined,
      installation_id: installationDetails.installation_id,
      account_login: installationDetails.account_login,
      account_type: installationDetails.account_type,
      account_id: installationDetails.account_id,
      repository_selection: installationDetails.repository_selection,
      repositories: installationDetails.repositories,
      installed_by_user_id: intent.user_id,
    });

    // The audit line, identifiers redacted: enough to trace a grant back to
    // the intent that authorised it, never enough to be one.
    console.log("[github-app install] bound", {
      outcome: "ok",
      scope: intent.scope,
      actor: String(intent.user_id).slice(0, 6),
      workspace: String(intent.team_id ?? intent.user_id).slice(0, 6),
      installation_id: installationDetails.installation_id,
      account_login: installationDetails.account_login,
      verified_login: proof.ok ? proof.login : undefined,
      proof: intentOnly ? "intent_only" : "user_token",
    });

    // The pull requests that already exist on the account arrive now, not
    // one webhook at a time as people happen to touch them.
    await ctx.scheduler.runAfter(0, internal.githubApp.backfillInstallationPulls, {
      installation_id: installationDetails.installation_id,
    });

    return installRedirect("?success=true");
  } catch (error) {
    console.error("Failed to process GitHub App installation:", error);
    return installRedirect("?error=installation_failed");
  }
}

export const storeInstallation = internalMutation({
  args: {
    /** Exactly one of these: the team the install binds to, or the person
     *  whose own credential it becomes (usable in every workspace they work
     *  in). */
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")),
    installation_id: v.number(),
    account_login: v.string(),
    account_type: v.union(v.literal("User"), v.literal("Organization")),
    account_id: v.number(),
    repository_selection: v.union(v.literal("all"), v.literal("selected")),
    repositories: v.optional(v.array(v.object({
      id: v.number(),
      name: v.string(),
      full_name: v.string(),
    }))),
    installed_by_user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    // The callback resolves the installer from a consumed install intent, so
    // these checks are the second reading of the same authority: a team
    // install binds only if the installer belongs to that team, and a personal
    // install binds only to the installer themself. Any future caller of this
    // mutation inherits the rule rather than being trusted.
    if (!!args.team_id === !!args.scope_user_id) {
      throw new Error("An installation binds to exactly one of a team or a person");
    }
    if (!args.installed_by_user_id) throw new Error("Installer is unknown");
    if (args.team_id && !(await isTeamMember(ctx, args.installed_by_user_id, args.team_id))) {
      throw new Error("Installer is not a member of the target team");
    }
    if (args.scope_user_id && String(args.scope_user_id) !== String(args.installed_by_user_id)) {
      throw new Error("A personal installation binds only to its installer");
    }
    const scope = { team_id: args.team_id, scope_user_id: args.scope_user_id };
    const existing = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();
    // Don't let a fresh install silently re-point an installation that is
    // already bound to a different workspace (would move that workspace's
    // repo access).
    if (existing && installationScopeKey(existing) !== installationScopeKey(scope)) {
      throw new Error("Installation is already linked to another workspace");
    }

    // `by_account_login` is the index every repository lookup splits its owner
    // into, so the login is stored in the canonical spelling.
    const accountLogin = normalizeRepository(args.account_login);
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...scope,
        account_login: accountLogin,
        account_type: args.account_type,
        account_id: args.account_id,
        repository_selection: args.repository_selection,
        repositories: args.repositories,
        updated_at: Date.now(),
      });
      return existing._id;
    }

    const now = Date.now();
    return await ctx.db.insert("github_app_installations", {
      ...scope,
      installation_id: args.installation_id,
      account_login: accountLogin,
      account_type: args.account_type,
      account_id: args.account_id,
      repository_selection: args.repository_selection,
      repositories: args.repositories,
      installed_by_user_id: args.installed_by_user_id,
      created_at: now,
      updated_at: now,
    });
  },
});

/** Drop an installation and its cached token — the one removal, whoever asks. */
export async function deleteInstallationRows(
  ctx: { db: any },
  installation: { _id?: Id<"github_app_installations">; installation_id: number },
): Promise<void> {
  if (installation._id) await ctx.db.delete(installation._id);
  // Every cached token of this installation, not just the first: the cache
  // holds one row per repository a cloud host asked for beside the
  // installation-wide row, and a row left behind would answer after the
  // installation it came from is gone.
  const tokens = await ctx.db
    .query("github_installation_tokens")
    .withIndex("by_installation_id", (q: any) => q.eq("installation_id", installation.installation_id))
    .collect();
  for (const token of tokens) await ctx.db.delete(token._id);
}

/**
 * Who may revoke an installation: a team install needs a team admin (it is
 * the team's credential, and taking it away reshapes everyone's access); a
 * personal install is its owner's alone, and nobody else may touch it.
 * Fails closed, like the team helpers it composes.
 */
export async function requireInstallationRevoker(
  ctx: { db: any },
  userId: Id<"users">,
  installation: { team_id?: Id<"teams">; scope_user_id?: Id<"users"> },
): Promise<void> {
  if (installation.team_id) {
    await requireTeamAdmin(ctx as any, userId, installation.team_id);
    return;
  }
  if (installation.scope_user_id && String(installation.scope_user_id) === String(userId)) return;
  throw new Error("Forbidden: only the owner may disconnect a personal installation");
}

/** Whether `userId` would be handed a disconnect id for this installation. */
export async function canRevokeInstallation(
  ctx: { db: any },
  userId: Id<"users">,
  installation: { team_id?: Id<"teams">; scope_user_id?: Id<"users"> },
): Promise<boolean> {
  try {
    await requireInstallationRevoker(ctx, userId, installation);
    return true;
  } catch {
    return false;
  }
}

export const removeInstallation = internalMutation({
  args: {
    installation_id: v.number(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();
    await deleteInstallationRows(ctx, installation ?? { installation_id: args.installation_id });
  },
});

// ── Resolving an installation for a repository ──
//
// An installation is a credential: resolving one is what lets a caller mint a
// token for the repositories it covers. So the question every lookup here
// answers is "which installations may this caller reach", never "which
// installation matches this owner name". The lookup this replaced ended in a
// `by_account_login` scan that ignored team_id entirely and returned the first
// match from ANY team — one team's repo work could pick up another team's
// credential. That fallback is gone; a lookup that finds nothing in scope now
// returns null.
//
// Two entry points, one predicate, because callers arrive with different
// principals: a webhook knows the team a repository belongs to and has no user,
// while a user-facing path knows the user and may not know the team.



/** Does this installation grant access to this repository right now? */
export function installationCoversRepo(
  installation: Doc<"github_app_installations">,
  repository: string,
): boolean {
  // A suspended installation still names the repository, but GitHub refuses
  // every token minted from it. Answering with it trades a clean null for a
  // failed round trip and a thrown error at the mint call.
  if (installation.suspended_at) return false;
  if (normalizeRepository(installation.account_login) !== repositoryOwner(repository)) return false;
  if (installation.repository_selection === "all") return true;
  // The list keeps GitHub's display case for the settings page; the match is canonical.
  const wanted = normalizeRepository(repository);
  return !!installation.repositories?.some((r) => normalizeRepository(r.full_name) === wanted);
}

/** Every installation that covers `repository`, before any scoping. */
async function installationsCoveringRepo(
  ctx: QueryCtx,
  repository: string,
): Promise<Doc<"github_app_installations">[]> {
  const byOwner = await ctx.db
    .query("github_app_installations")
    .withIndex("by_account_login", (q) => q.eq("account_login", repositoryOwner(repository)))
    .collect();
  return byOwner.filter((installation) => installationCoversRepo(installation, repository));
}

/**
 * The team an installation's activity routes to and serves.
 *
 * A TEAM installation routes to its team, read through the access layer so it
 * answers the same "which team owns this record" question as every other
 * resource. The row links no conversation, so the answer is always its
 * team_id; an undefined answer there would mean the access layer had started
 * narrowing a credential by conversation visibility, which reads to the
 * caller exactly like "nobody installed this app" — the owning team would
 * silently stop resolving its own installation. Say it.
 *
 * A PERSONAL installation is one person's credential, and a webhook carries
 * no "where" beyond the repository — so it routes to wherever its owner is
 * working right now: their active team, counted only with a live membership
 * (lib/access.activeTeamMembershipFor). PR rows, commits, PR triggers and
 * repository browsing in that team run through the owner's grant; switching
 * teams moves where NEW activity lands, and leaving the team ends it. An
 * owner in no team routes nowhere: the install still serves their own
 * imports and pushes, which name their workspace themselves.
 */
export async function routingTeamForInstallation(
  ctx: { db: any },
  installation: { _id?: any; installation_id: number; team_id?: Id<"teams">; scope_user_id?: Id<"users">; workspace?: string },
): Promise<Id<"teams"> | undefined> {
  if (!installation.team_id) {
    if (!installation.scope_user_id) return undefined;
    return (await activeTeamMembershipFor(ctx as any, installation.scope_user_id))?.teamId;
  }
  const team = await effectiveTeamForResource(ctx as any, installation);
  if (!team) {
    throw new Error(
      `GitHub installation ${installation.installation_id} (row ${installation._id}) resolved to no team. ` +
        `A team installation must keep its team_id, so repair that row — and do not let a ` +
        `credential lookup be narrowed by conversation visibility.`,
    );
  }
  return team;
}

const installationTeam = routingTeamForInstallation;

/** The personal installation `userId` owns that covers `repository`, or null. */
async function personalInstallationForRepo(
  ctx: QueryCtx,
  userId: Id<"users">,
  repository: string,
): Promise<Doc<"github_app_installations"> | null> {
  for (const installation of await installationsCoveringRepo(ctx, repository)) {
    if (installation.scope_user_id && String(installation.scope_user_id) === String(userId)) return installation;
  }
  return null;
}

/**
 * The installation serving `team_id` for `repository`, or null: the team's
 * own, or a member's personal one that routes there (routingTeamForInstallation).
 *
 * For server paths that already know which team the repository work belongs to
 * and have no user to check — webhook processing is the case that exists. The
 * caller is responsible for having authorized that team; this function's job is
 * that the answer never comes from outside it.
 */
export const getInstallationForRepoInTeam = internalQuery({
  args: {
    repository: v.string(),
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    for (const installation of await installationsCoveringRepo(ctx, args.repository)) {
      const team = await installationTeam(ctx, installation);
      if (team && String(team) === String(args.team_id)) return installation;
    }
    return null;
  },
});

/**
 * The personal installation that lets `user_id` act on `repository`, or null.
 * The second half of every user-facing resolution: the work's team is tried
 * first (getInstallationForRepoInTeam), and the person's own credential
 * serves when the team has none — that is what lets one personal grant follow
 * its owner into every workspace they work in.
 */
export const getPersonalInstallationForRepo = internalQuery({
  args: { repository: v.string(), user_id: v.id("users") },
  handler: async (ctx, args) => await personalInstallationForRepo(ctx, args.user_id, args.repository),
});

/**
 * The installation that lets `user_id` act on `repository`, or null.
 *
 * `user_id` is required because an internalQuery carries no identity of its own:
 * a caller that cannot name a principal cannot be scoped, and there is no safe
 * default. `team_id` narrows the search to that workspace — an install that
 * routes there (the team's own, or a member's personal one), else the caller's
 * personal one — and fails loudly if the caller is not in it. Omitting it
 * answers for the person: their personal install, else an install routing to
 * any team they belong to.
 *
 * The rule is a plain function so another server path can ask the same
 * question inside its own query (the cloud host's git credential does), and
 * the internalQuery below is the wire spelling of it. One rule, two doors.
 */
export async function installationForRepo(
  ctx: QueryCtx,
  args: { repository: string; user_id: Id<"users">; team_id?: Id<"teams"> },
): Promise<Doc<"github_app_installations"> | null> {
  // A named team is an assertion about the caller's workspace, so verify it
  // before it can narrow anything — a caller naming a team they are not in is
  // a bug or an attack, not a miss.
  if (args.team_id) {
    await requireTeamMembership(ctx, args.user_id, args.team_id);
  }

  const covering = await installationsCoveringRepo(ctx, args.repository);
  if (args.team_id) {
    for (const installation of covering) {
      const team = await installationTeam(ctx, installation);
      if (team && String(team) === String(args.team_id)) return installation;
    }
    return await personalInstallationForRepo(ctx, args.user_id, args.repository);
  }

  const personal = await personalInstallationForRepo(ctx, args.user_id, args.repository);
  if (personal) return personal;
  for (const installation of covering) {
    const team = await installationTeam(ctx, installation);
    if (!team || !(await isTeamMember(ctx, args.user_id, team))) continue;
    return installation;
  }
  return null;
}

export const getInstallationForRepo = internalQuery({
  args: {
    repository: v.string(),
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => await installationForRepo(ctx, args),
});

/**
 * The installations one workspace holds, for the surfaces that list them (the
 * GitHub card's detail, the import picker). A team's rows for its members;
 * the caller's own rows with no team named.
 */
async function installationsForScope(
  ctx: { db: any },
  scope: { team_id?: Id<"teams">; user_id: Id<"users"> },
): Promise<Doc<"github_app_installations">[]> {
  if (scope.team_id) {
    await requireTeamMembership(ctx as any, scope.user_id, scope.team_id);
    return await ctx.db
      .query("github_app_installations")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", scope.team_id))
      .collect();
  }
  return await ctx.db
    .query("github_app_installations")
    .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", scope.user_id))
    .collect();
}

export const listInstallations = query({
  args: {
    /** The team whose installations to list; absent lists the caller's personal ones. */
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return await installationsForScope(ctx, { team_id: args.team_id, user_id: userId });
  },
});

/**
 * Every installation a piece of work can import through: the work's team's,
 * plus the acting user's personal ones. Both, because the credential resolver
 * answers with either — a picker that listed only the team's repos would hide
 * repositories the person can already sync.
 */
export const installationsForWork = internalQuery({
  args: { team_id: v.optional(v.id("teams")), user_id: v.id("users") },
  handler: async (ctx, args) => {
    const personal = await installationsForScope(ctx, { user_id: args.user_id });
    if (!args.team_id) return personal;
    const team = await installationsForScope(ctx, { team_id: args.team_id, user_id: args.user_id });
    return [...team, ...personal];
  },
});

export const deleteInstallation = mutation({
  args: {
    installation_id: v.id("github_app_installations"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);

    const installation = await ctx.db.get(args.installation_id);
    if (!installation) {
      throw new Error("Installation not found");
    }
    await requireInstallationRevoker(ctx, userId, installation);
    await deleteInstallationRows(ctx, installation);
    return { success: true };
  },
});

type InstallationRepository = { id: number; name: string; full_name: string };

type InstallationDetails = {
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  account_id: number;
  repository_selection: "all" | "selected";
  repositories: InstallationRepository[] | undefined;
  suspended_at: number | undefined;
  created_at?: number;
};

/** How many repositories one install may list or backfill in one pass. */
const INSTALLATION_REPOS_CAP = 300;

/**
 * Every repository an installation token can see, in GitHub's paging. Serves
 * both the install record (a "selected" install stores its list) and the
 * backfill (an "all" install stores none, so it asks live).
 */
async function fetchInstallationRepositories(token: string, findRepository?: string): Promise<InstallationRepository[]> {
  const repositories: InstallationRepository[] = [];
  for (let page = 1; findRepository || repositories.length < INSTALLATION_REPOS_CAP; page++) {
    const response = await fetch(
      `${GITHUB_API_BASE}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to list installation repositories: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.repositories)) throw new Error("GitHub returned an invalid installation repository list");
    const batch: InstallationRepository[] = data.repositories.map((r: any) => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
    }));
    repositories.push(...batch);
    if (batch.length < 100 || (findRepository && batch.some((r) => normalizeRepository(r.full_name) === findRepository))) break;
  }
  return findRepository ? repositories : repositories.slice(0, INSTALLATION_REPOS_CAP);
}

export const fetchInstallationDetails = internalAction({
  args: {
    installation_id: v.number(),
  },
  handler: async (ctx, args): Promise<InstallationDetails> => {
    const jwt: string = await ctx.runAction(internal.githubApp.generateAppJWT, {});

    const response: Response = await fetch(
      `${GITHUB_API_BASE}/app/installations/${args.installation_id}`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch installation: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    let repositories: InstallationRepository[] | undefined;

    if (data.repository_selection === "selected") {
      const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
        installation_id: args.installation_id,
      });
      try {
        repositories = await fetchInstallationRepositories(tokenResult.token);
      } catch {
        // The install still binds without its repository list; the next
        // installation_repositories webhook or backfill fills it in.
      }
    }

    return {
      installation_id: data.id,
      account_login: data.account.login,
      account_type: data.account.type as "User" | "Organization",
      account_id: data.account.id,
      repository_selection: data.repository_selection as "all" | "selected",
      repositories,
      suspended_at: data.suspended_at ? new Date(data.suspended_at).getTime() : undefined,
      created_at: data.created_at ? new Date(data.created_at).getTime() : undefined,
    };
  },
});

/**
 * A repository token for `user_id`, or null when they can reach no installation
 * covering that repository. The principal is required and passed straight
 * through: minting a token is exactly as privileged as resolving the
 * installation, so both are scoped by the same check.
 */
export const getTokenForRepository = internalAction({
  args: {
    repository: v.string(),
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<{ token: string; type: "installation" | "user" } | null> => {
    const installation = await ctx.runQuery(internal.githubApp.getInstallationForRepo, {
      repository: args.repository,
      user_id: args.user_id,
      team_id: args.team_id,
    });

    if (installation) {
      const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
        installation_id: installation.installation_id,
      });
      return { token: tokenResult.token, type: "installation" };
    }

    return null;
  },
});

/**
 * GitHub's `installation_repositories` delivery: the person changed which
 * repositories the App may see, on GitHub's own settings page. The row follows
 * it here, so the integrations page and every repository lookup agree with
 * GitHub within one delivery. Answers the team the install serves and the
 * repositories that just became visible, so the caller can backfill exactly
 * those (a personal install routes nothing to a team and gets no backfill).
 */
export const applyInstallationRepositoriesEvent = internalMutation({
  args: {
    installation_id: v.number(),
    repository_selection: v.optional(v.union(v.literal("all"), v.literal("selected"))),
    added: v.array(v.object({ id: v.number(), name: v.string(), full_name: v.string() })),
    removed: v.array(v.object({ id: v.number(), name: v.string(), full_name: v.string() })),
  },
  handler: async (ctx, args): Promise<{ team_id: Id<"teams"> | null; added: string[] }> => {
    const installation = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();
    if (!installation) return { team_id: null, added: [] };

    const removedIds = new Set(args.removed.map((r) => r.id));
    const kept = (installation.repositories ?? []).filter((r) => !removedIds.has(r.id));
    const keptIds = new Set(kept.map((r) => r.id));
    const repositories = [...kept, ...args.added.filter((r) => !keptIds.has(r.id))];
    const selection = args.repository_selection ?? installation.repository_selection;
    const now = Date.now();
    await ctx.db.patch(installation._id, {
      repository_selection: selection,
      // An "all" install stores no list: GitHub answers for it live.
      repositories: selection === "all" ? undefined : repositories,
      last_webhook_at: now,
      updated_at: now,
    });
    return {
      team_id: installation.team_id ?? null,
      added: args.added.map((r) => normalizeRepository(r.full_name)),
    };
  },
});

export const getInstallation = internalQuery({
  args: { installation_id: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first(),
});

export const stampInstallationSync = internalMutation({
  args: { installation_id: v.number(), expected_updated_at: v.number(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const installation = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();
    if (!installation || installation.updated_at !== args.expected_updated_at) return;
    await ctx.db.patch(installation._id, { last_sync_at: Date.now(), last_error: args.error });
  },
});

/**
 * Store one pull request GitHub described (list entry or single read) for a
 * team, the way a webhook-born row ends up: the row itself, then for a newly
 * seen open one its file list and a merge-state read. The backfill and the
 * on-demand fetch share this so the two paths cannot drift.
 */
async function ingestPull(
  ctx: { runMutation: any; runAction: any; scheduler: any },
  args: {
    teamId: Id<"teams">;
    repository: string;
    pull: MappedPull;
    token: string;
    withFiles: boolean;
    mergeStateDelayMs?: number;
  },
): Promise<{ pr_id: Id<"pull_requests">; created: boolean }> {
  const { teamId, repository, pull, token } = args;
  const result: { pr_id: Id<"pull_requests">; created: boolean } = await ctx.runMutation(
    internal.pull_requests.syncPRFromGitHub,
    {
      team_id: teamId,
      github_pr_id: pull.id,
      repository,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed",
      author_github_username: pull.author_login ?? "unknown",
      author_avatar_url: pull.author_avatar_url,
      head_ref: pull.head_ref,
      base_ref: pull.base_ref,
      head_sha: pull.head_sha,
      base_sha: pull.base_sha,
      draft: pull.draft,
      requested_reviewers: pull.requested_reviewers,
      labels: pull.labels,
      assignees: pull.assignees,
      created_at: pull.created_at ?? Date.now(),
      updated_at: pull.updated_at ?? Date.now(),
      merged_at: pull.merged_at ?? undefined,
      closed_at: pull.closed_at ?? undefined,
    },
  );
  if (pull.state !== "open" || !result.created) return result;
  if (args.withFiles) {
    try {
      const files = await ctx.runAction(internal.githubApi.getPRFiles, {
        repository,
        pr_number: pull.number,
        github_access_token: token,
      });
      await ctx.runMutation(internal.pull_requests.updatePRFiles, {
        pr_id: result.pr_id,
        files: files.files,
        additions: files.additions,
        deletions: files.deletions,
        changed_files: files.changed_files,
        commits_count: files.commits_count,
        base_ref: files.base_ref,
      });
    } catch (error) {
      console.error(`Files for ${repository}#${pull.number} failed:`, error);
    }
    await syncPRCommits(ctx, result.pr_id, repository, pull.number, token);
  }
  await ctx.scheduler.runAfter(args.mergeStateDelayMs ?? 0, internal.prShepherd.refreshMergeState, {
    pr_id: result.pr_id,
    attempt: 0,
  });
  return result;
}

/**
 * Bring one pull request in on demand: a page opened for a pull request the
 * backfill window did not reach (an old closed one), in a repository one of
 * the caller's team installs covers. The row is stored for that install's
 * team, so the page's own query answers on the next push. A personal install
 * routes nothing to a team, so it cannot bring a row in.
 */
export const fetchPull = action({
  args: { repository: v.string(), number: v.number() },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false, reason: "unauthenticated" };
    const repository = normalizeRepository(args.repository);
    const installation = await ctx.runQuery(internal.githubApp.getInstallationForRepo, {
      repository,
      user_id: userId,
    });
    if (!installation?.team_id) return { ok: false, reason: "no_team_installation" };
    const { token } = await ctx.runAction(internal.githubApp.getInstallationToken, {
      installation_id: installation.installation_id,
    });
    const pull = await ctx.runAction(internal.githubApi.getPull, {
      repository,
      number: args.number,
      github_access_token: token,
    });
    if (!pull) return { ok: false, reason: "not_on_github" };
    await ingestPull(ctx, { teamId: installation.team_id, repository, pull, token, withFiles: true });
    return { ok: true };
  },
});

/** Open pull requests are paged fully up to this many pages per repository. */
const BACKFILL_OPEN_PAGES = 4;
/** How many open pull requests per install get their file list during a backfill. */
const BACKFILL_FILES_CAP = 100;

/**
 * Bring a team installation's pull requests in when the App lands on an
 * account or gains repositories. Until this ran, a pull request existed for
 * codecast only once GitHub sent a webhook about it, so every pull request
 * opened before the install answered "not in this workspace" for as long as
 * nobody touched it. Every open pull request is read (paged), plus the most
 * recently updated closed ones, so the repository's recent history is there
 * too. Rows go through pull_requests.syncPRFromGitHub, the quiet upsert: no
 * "opened" moments are replayed. Open rows then get their files and merge
 * state the same way a webhook-born row does.
 *
 * `repositories` narrows the pass to the ones just added; without it the whole
 * install is read (an "all" install lists its repositories live).
 */
export const backfillInstallationPulls = internalAction({
  args: {
    installation_id: v.number(),
    repositories: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ repositories: number; pulls: number }> => {
    const installation = await ctx.runQuery(internal.githubApp.getInstallation, {
      installation_id: args.installation_id,
    });
    // Routing only ever comes from a team install (resolveTeamForRepository);
    // a personal credential brings nothing into a team's workspace.
    if (!installation?.team_id || installation.suspended_at) return { repositories: 0, pulls: 0 };
    const teamId = installation.team_id;
    const syncStamp = { installation_id: args.installation_id, expected_updated_at: installation.updated_at };

    let pulls = 0;
    let syncedRepositories = 0;
    let repositories: string[] = [];
    try {
      const { token } = await ctx.runAction(internal.githubApp.getInstallationToken, {
        installation_id: args.installation_id,
      });
      repositories = args.repositories
        ?? (installation.repository_selection === "selected" && installation.repositories
          ? installation.repositories.map((r: InstallationRepository) => r.full_name)
          : (await fetchInstallationRepositories(token)).map((r) => r.full_name));
      repositories = repositories.slice(0, INSTALLATION_REPOS_CAP).map(normalizeRepository);

      let filesLeft = BACKFILL_FILES_CAP;
      repositoryLoop: for (const repository of repositories) {
        // One page of recently updated closed pull requests, then every open
        // page up to the cap; a short page ends the open scan.
        for (let i = 0; i <= BACKFILL_OPEN_PAGES; i++) {
          const state = i === 0 ? "closed" : "open";
          const page = i === 0 ? 1 : i;
          const current = await ctx.runQuery(internal.githubApp.getInstallation, {
            installation_id: args.installation_id,
          });
          if (!current || current.team_id !== teamId || current.suspended_at) {
            return { repositories: syncedRepositories, pulls };
          }
          if (current.repository_selection === "selected" && current.repositories && !installationCoversRepo(current, repository)) {
            continue repositoryLoop;
          }
          let batch: MappedPull[];
          try {
            ({ pulls: batch } = await ctx.runAction(internal.githubApi.listPulls, {
              repository,
              state,
              page,
              github_access_token: token,
            }));
          } catch (error) {
            if (!(error instanceof Error) || !/GitHub returned 404/.test(error.message)) throw error;
            const visible = await fetchInstallationRepositories(token, repository);
            if (visible.some((r) => normalizeRepository(r.full_name) === repository)) throw error;
            continue repositoryLoop;
          }
          for (const pull of batch) {
            pulls++;
            const withFiles = filesLeft > 0;
            const { created } = await ingestPull(ctx, {
              teamId, repository, pull, token, withFiles,
              // Spread the merge-state reads out so a large repository does
              // not burst the installation's rate limit in one second.
              mergeStateDelayMs: pulls * 500,
            });
            if (created && pull.state === "open" && withFiles) filesLeft--;
          }
          if (state === "open" && batch.length < 50) break;
        }
        syncedRepositories++;
      }
      await ctx.runMutation(internal.githubApp.stampInstallationSync, syncStamp);
    } catch (error: any) {
      await ctx.runMutation(internal.githubApp.stampInstallationSync, {
        ...syncStamp,
        error: `Backfill failed: ${error?.message ?? String(error)}`,
      });
      throw error;
    }
    return { repositories: syncedRepositories, pulls };
  },
});

export const suspendInstallation = internalMutation({
  args: {
    installation_id: v.number(),
    suspended_at: v.number(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();

    if (installation) {
      await ctx.db.patch(installation._id, {
        suspended_at: args.suspended_at,
        updated_at: Date.now(),
      });
    }
  },
});

export const unsuspendInstallation = internalMutation({
  args: {
    installation_id: v.number(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();

    if (installation) {
      await ctx.db.patch(installation._id, {
        suspended_at: undefined,
        updated_at: Date.now(),
      });
    }
  },
});
