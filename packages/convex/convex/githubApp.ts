import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

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
    const existing = await ctx.db
      .query("github_app_installations")
      .withIndex("by_installation_id", (q) => q.eq("installation_id", args.installation_id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        team_id: args.team_id,
        account_login: args.account_login,
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
      account_login: args.account_login,
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

export const getInstallationForRepo = internalQuery({
  args: {
    repository: v.string(),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const [owner] = args.repository.split("/");

    let query = ctx.db.query("github_app_installations");

    if (args.team_id) {
      const teamId = args.team_id;
      const installations = await query
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();

      for (const installation of installations) {
        if (installation.account_login === owner) {
          if (installation.repository_selection === "all") {
            return installation;
          }
          if (installation.repositories?.some((r) => r.full_name === args.repository)) {
            return installation;
          }
        }
      }
    }

    const byOwner = await ctx.db
      .query("github_app_installations")
      .withIndex("by_account_login", (q) => q.eq("account_login", owner))
      .collect();

    for (const installation of byOwner) {
      if (installation.repository_selection === "all") {
        return installation;
      }
      if (installation.repositories?.some((r) => r.full_name === args.repository)) {
        return installation;
      }
    }

    return null;
  },
});

export const listInstallations = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthorized");
    }

    const installation = await ctx.db.get(args.installation_id);
    if (!installation) {
      throw new Error("Installation not found");
    }

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

export const getTokenForRepository = internalAction({
  args: {
    repository: v.string(),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<{ token: string; type: "installation" | "user" } | null> => {
    const installation = await ctx.runQuery(internal.githubApp.getInstallationForRepo, {
      repository: args.repository,
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
