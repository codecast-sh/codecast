import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery, internalAction } from "./functions";
import type { QueryCtx } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { isTeamMember } from "./privacy";
import { requireUser } from "./lib/auth";
import { normalizeRepository, repositoryOwner } from "./lib/gitRefs";
import { requireTeamAdmin, requireTeamMembership, effectiveTeamForResource } from "./lib/access";

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

export const getInstallationToken = internalAction({
  args: {
    installation_id: v.number(),
  },
  handler: async (ctx, args): Promise<{ token: string; expires_at: number }> => {
    const cachedToken = await ctx.runQuery(internal.githubApp.getCachedToken, {
      installation_id: args.installation_id,
    });

    if (cachedToken && cachedToken.expires_at > Date.now() + 5 * 60 * 1000) {
      return { token: cachedToken.token, expires_at: cachedToken.expires_at };
    }

    const jwt = await ctx.runAction(internal.githubApp.generateAppJWT, {});

    const response = await fetch(
      `${GITHUB_API_BASE}/app/installations/${args.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get installation token: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const expiresAt = new Date(data.expires_at).getTime();

    await ctx.runMutation(internal.githubApp.cacheToken, {
      installation_id: args.installation_id,
      token: data.token,
      expires_at: expiresAt,
    });

    return { token: data.token, expires_at: expiresAt };
  },
});

export const getCachedToken = internalQuery({
  args: {
    installation_id: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("github_installation_tokens")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();
  },
});

export const cacheToken = internalMutation({
  args: {
    installation_id: v.number(),
    token: v.string(),
    expires_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("github_installation_tokens")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        token: args.token,
        expires_at: args.expires_at,
      });
    } else {
      await ctx.db.insert("github_installation_tokens", {
        installation_id: args.installation_id,
        token: args.token,
        expires_at: args.expires_at,
        created_at: Date.now(),
      });
    }
  },
});

export const storeInstallation = internalMutation({
  args: {
    team_id: v.id("teams"),
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
    // The callback's OAuth `state` (team_id + user_id) is client-supplied and
    // unsigned, so bind an installation to a team only if the named installer
    // actually belongs to it. Blocks binding your GitHub installation to a team
    // you're not in. (Signing the state end-to-end is a follow-up.)
    if (!args.installed_by_user_id || !(await isTeamMember(ctx, args.installed_by_user_id, args.team_id))) {
      throw new Error("Installer is not a member of the target team");
    }
    const existing = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();
    // Don't let a fresh install silently re-point an installation that is
    // already bound to a different team (would move that team's repo access).
    if (existing && String(existing.team_id) !== String(args.team_id)) {
      throw new Error("Installation is already linked to another team");
    }

    // `by_account_login` is the index every repository lookup splits its owner
    // into, so the login is stored in the canonical spelling.
    const accountLogin = normalizeRepository(args.account_login);
    if (existing) {
      await ctx.db.patch(existing._id, {
        team_id: args.team_id,
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
      team_id: args.team_id,
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

export const removeInstallation = internalMutation({
  args: {
    installation_id: v.number(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();

    if (installation) {
      await ctx.db.delete(installation._id);
    }

    const token = await ctx.db
      .query("github_installation_tokens")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();

    if (token) {
      await ctx.db.delete(token._id);
    }
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
 * The team that governs an installation. Read through the access layer so an
 * installation answers the same "which team owns this record" question as every
 * other resource.
 *
 * `team_id` is required on this table and the row links no conversation, so the
 * answer today is always that team_id. An undefined answer would mean the
 * access layer had started narrowing a credential by conversation visibility,
 * which reads to the caller exactly like "nobody installed this app" — the
 * owning team would silently stop resolving its own installation. Say it.
 */
async function installationTeam(
  ctx: QueryCtx,
  installation: Doc<"github_app_installations">,
): Promise<Id<"teams">> {
  const team = await effectiveTeamForResource(ctx, installation);
  if (!team) {
    throw new Error(
      `GitHub installation ${installation.installation_id} (row ${installation._id}) resolved to no team. ` +
        `team_id is required on github_app_installations, so repair that row — and do not let a ` +
        `credential lookup be narrowed by conversation visibility.`,
    );
  }
  return team;
}

/**
 * The installation `team_id` owns for `repository`, or null.
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
      if (String(team) === String(args.team_id)) return installation;
    }
    return null;
  },
});

/**
 * The installation that lets `user_id` act on `repository`, or null.
 *
 * `user_id` is required because an internalQuery carries no identity of its own:
 * a caller that cannot name a principal cannot be scoped, and there is no safe
 * default. `team_id` narrows the search to one workspace and fails loudly if the
 * caller is not in it; omitting it searches every team the caller belongs to.
 */
export const getInstallationForRepo = internalQuery({
  args: {
    repository: v.string(),
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    // A named team is an assertion about the caller's workspace, so verify it
    // before it can narrow anything — a caller naming a team they are not in is
    // a bug or an attack, not a miss.
    if (args.team_id) {
      await requireTeamMembership(ctx, args.user_id, args.team_id);
    }

    for (const installation of await installationsCoveringRepo(ctx, args.repository)) {
      const team = await installationTeam(ctx, installation);
      if (args.team_id && String(team) !== String(args.team_id)) continue;
      if (!(await isTeamMember(ctx, args.user_id, team))) continue;
      return installation;
    }

    return null;
  },
});

export const listInstallations = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireTeamMembership(ctx, userId, args.team_id);

    return await ctx.db
      .query("github_app_installations")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();
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
    await requireTeamAdmin(ctx, userId, installation.team_id);

    await ctx.db.delete(args.installation_id);

    const token = await ctx.db
      .query("github_installation_tokens")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", installation.installation_id))
      .first();

    if (token) {
      await ctx.db.delete(token._id);
    }

    return { success: true };
  },
});

type InstallationDetails = {
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  account_id: number;
  repository_selection: "all" | "selected";
  repositories: Array<{ id: number; name: string; full_name: string }> | undefined;
  suspended_at: number | undefined;
};

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

    let repositories: Array<{ id: number; name: string; full_name: string }> | undefined;

    if (data.repository_selection === "selected") {
      const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
        installation_id: args.installation_id,
      });

      const reposResponse = await fetch(
        `${GITHUB_API_BASE}/installation/repositories?per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${tokenResult.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );

      if (reposResponse.ok) {
        const reposData = await reposResponse.json();
        repositories = reposData.repositories.map((r: any) => ({
          id: r.id,
          name: r.name,
          full_name: r.full_name,
        }));
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

export const updateInstallationRepositories = internalMutation({
  args: {
    installation_id: v.number(),
    repositories: v.array(v.object({
      id: v.number(),
      name: v.string(),
      full_name: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();

    if (installation) {
      await ctx.db.patch(installation._id, {
        repositories: args.repositories,
        updated_at: Date.now(),
      });
    }
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
