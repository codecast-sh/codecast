// The consent screen's two calls (app/oauth/authorize): what it shows, and
// Allow, which stores a one-time code for the agent to exchange at /oauth/token
// (mcpAuth.exchangeCode). Its own module because consent writes no connection
// row: the grant is born at the exchange, and Settings learns of it from
// mcpAuth.listConnections. docs/architecture/agent-mcp.md.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { MCP_READ_SCOPE } from "@codecast/shared/contracts";
import { hashToken } from "./apiTokens";
import { CODE_TTL_MS, newGrantSecret, redirectHost } from "./mcpAuth";

// Off unless the deployment turned OAuth on (mcpHttp oauthEnabled), so a
// deployment without it mints no codes.
const oauthOff = () => process.env.MCP_OAUTH_ENABLED !== "1";

type ConsentRequest = { client_id: string; redirect_uri: string };

async function checkRequest(ctx: { db: any }, req: ConsentRequest): Promise<{ ok: true; client: Doc<"mcp_clients"> } | { ok: false; error: string }> {
  const client = await ctx.db.query("mcp_clients").withIndex("by_client_id", (q: any) => q.eq("client_id", req.client_id)).first();
  if (!client) return { ok: false, error: "This agent is not registered. Start the connection again from the agent." };
  if (!client.redirect_uris.includes(req.redirect_uri)) return { ok: false, error: "This agent asked to return somewhere it did not register." };
  return { ok: true, client };
}

/** What the consent screen shows: who is asking and where it returns. Never redirects on its own. */
export const consentInfo = query({
  args: { client_id: v.string(), redirect_uri: v.string() },
  handler: async (ctx, args) => {
    if (oauthOff()) return { error: "Connecting agents is not on for this deployment yet." };
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in first" };
    const checked = await checkRequest(ctx, args);
    if (!checked.ok) return { error: checked.error };
    const user = await ctx.db.get(userId);
    const teams = [];
    for (const m of await ctx.db.query("team_memberships").withIndex("by_user_id", (q) => q.eq("user_id", userId)).collect()) {
      const team = await ctx.db.get(m.team_id);
      if (team) teams.push(team.name);
    }
    return {
      workspaces: ["Personal", ...teams],
      client_name: checked.client.client_name,
      redirect_host: redirectHost(args.redirect_uri),
      account: { name: user?.name ?? null, email: user?.email ?? null },
    };
  },
});

/** Allow: a one-time code bound to this client, return address, PKCE challenge and person. */
export const approve = mutation({
  args: {
    client_id: v.string(),
    redirect_uri: v.string(),
    code_challenge: v.string(),
    code_challenge_method: v.string(),
    scope: v.optional(v.string()),
    resource: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ code: string } | { error: string }> => {
    if (oauthOff()) return { error: "Connecting agents is not on for this deployment yet." };
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in first" };
    const checked = await checkRequest(ctx, args);
    if (!checked.ok) return { error: checked.error };
    if (args.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(args.code_challenge)) {
      return { error: "This agent did not send a valid PKCE challenge." };
    }
    const code = newGrantSecret("cmca_");
    await ctx.db.insert("mcp_auth_codes", {
      code_hash: await hashToken(code),
      client_id: args.client_id,
      user_id: userId,
      redirect_uri: args.redirect_uri,
      code_challenge: args.code_challenge,
      scope: MCP_READ_SCOPE,
      resource: args.resource,
      expires_at: Date.now() + CODE_TTL_MS,
    });
    return { code };
  },
});

